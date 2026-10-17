#!/usr/bin/env node
// Drives a built PayBox plugin bundle over MCP stdio the way PayBox does: a fresh process per operation, a clean
// environment, one stateless MCP 2026-07-28 request (no initialize), a 10 s budget, 256 KiB of stdout, 16 KiB of
// stderr. It lists the tools, optionally calls one, validates arguments and structuredContent against the tool's own
// JSON Schemas (Ajv 2020, same options as the starter's conformance), enforces the sandbox network rule (none during
// discovery; HTTPS to exact hosts during a call) and decodes any Solana proposal it returns.
//
//   node e2e/plugin-e2e.mjs <dist/plugin.mjs> [tool] [json-args | @file.json] [options]   (see --help)
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseSolanaPayUrl } from "../contract/shapes.mjs";
import { inspectProposal, PROPOSAL_KEY } from "./lib/solana-tx.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "../plugin");
const NET_GUARD = pathToFileURL(join(HERE, "lib/net-guard.mjs"));
const DEFAULT_BASE_URL = "https://owed-omega.vercel.app";
const RPC_HOSTS = ["solana-rpc.publicnode.com", "api.mainnet-beta.solana.com"];
// W2-H verified payee: the plugin reads _owed TXT records over DNS-over-HTTPS itself (same list as the portal).
const DOH_HOSTS = ["cloudflare-dns.com", "dns.google"];
// W2-E sanctions screen: Chainalysis's API, with X-API-Key as a PayBox brokered header (see --broker).
const SCREEN_HOSTS = ["public.chainalysis.com"];
export const LIMITS = { budgetMs: 10_000, stdoutBytes: 256 * 1024, stderrBytes: 16 * 1024, artifactBytes: 10 * 1024 * 1024, contentItems: 128, toolPages: 16 };

const USAGE = `usage: node e2e/plugin-e2e.mjs <dist/plugin.mjs> [tool] [json-args | @file.json] [options]

  no tool              list tools only
  --sample             call the tool and arguments in plugin/paybox-plugin.json
  --base-url URL       OWED_BASE_URL for the plugin (default: $OWED_BASE_URL, else unset → plugin default)
  --hosts LIST         hosts the call may reach over HTTPS, comma-separated, or "none" / "any"
                       (default: the Owed host + ${[...RPC_HOSTS, ...DOH_HOSTS, ...SCREEN_HOSTS].join(", ")})
  --down LIST          hosts to refuse as a simulated outage (not a failure), e.g. the Owed host for row 8
  --broker H:NAME=@F   add header NAME to the plugin's HTTPS fetches to host H, its value read from file F, the way
                       PayBox brokers a secret (repeatable). The value never enters the plugin's env, argv or this
                       report, and the run fails if the tool's output contains it (PayBox withholds such output).
                       e.g. --broker public.chainalysis.com:X-API-Key=@$HOME/.config/owed/chainalysis-api-key
  --no-guard           launch without the network guard or stack probe (pure PayBox launch)
  --env KEY=VALUE      extra plugin env var (repeatable)
  --budget-ms N        per-process budget (default ${LIMITS.budgetMs}, the PayBox limit)
  --max-ms N           fail if tools/call takes longer than N ms
  --expect PATH=VALUE  structuredContent field equals VALUE (repeatable; "proposal.<path>" reads the decoded tx)
  --expect-text STR    text content contains STR (repeatable)
  --expect-error       the call must return isError: true
  --allow-error        accept isError either way
  --expect-no-proposal structuredContent must not contain a PayBox proposal
  --sender ADDR        fee payer the proposal must use (default: arguments.sender)
  --no-input-check     send arguments even if they fail the input schema
  --print PATH         print only this field (stdout), everything else goes to stderr
  --json               print one JSON report on stdout`;

// ----------------------------------------------------------------------------------------------- helpers

class HarnessError extends Error {
  constructor(message, code = "harness_failed", extra = {}) {
    super(message);
    Object.assign(this, { code }, extra);
  }
}

function loadPluginTools() {
  const require = createRequire(join(PLUGIN_DIR, "package.json"));
  let Ajv;
  try {
    Ajv = require("ajv/dist/2020.js").default;
  } catch {
    throw new HarnessError("ajv not found: run `pnpm install --frozen-lockfile` in plugin/ first", "setup_failed");
  }
  return {
    compile(schema, label) {
      try {
        return new Ajv({ strict: false, validateFormats: false, logger: false, allErrors: true }).compile(schema);
      } catch (error) {
        throw new HarnessError(`${label} is not valid, self-contained JSON Schema 2020-12: ${error.message}`, "schema_invalid");
      }
    },
    ataFor() {
      try {
        const { PublicKey } = require("@solana/web3.js");
        const programs = { token: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), ata: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") };
        return (owner, mint) => PublicKey.findProgramAddressSync(
          [new PublicKey(owner).toBuffer(), programs.token.toBuffer(), new PublicKey(mint).toBuffer()], programs.ata,
        )[0].toBase58();
      } catch {
        return null;
      }
    },
  };
}

const ajvErrors = (validate) => (validate.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message}${error.params?.additionalProperty ? `: ${error.params.additionalProperty}` : ""}`);

export function getPath(value, path) {
  return path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)
    .reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), value);
}

function matches(actual, raw) {
  if (actual !== null && typeof actual !== "object" && String(actual) === raw) return true;
  try { return JSON.stringify(actual) === JSON.stringify(JSON.parse(raw)); } catch { return false; }
}

// ----------------------------------------------------------------------------------------------- one operation

/** Spawns the bundle once and sends one MCP request, exactly like the starter's conformance runOperation. */
async function runOperation(artifact, operation, { env, guard, budgetMs, protocolVersion, version }) {
  const { withProcess } = await import(pathToFileURL(join(PLUGIN_DIR, "scripts/process.mjs")).href);
  const home = await mkdtemp(join(tmpdir(), "owed-e2e-"));
  const query = guard && `policy=${guard.policy}&hosts=${encodeURIComponent(guard.hosts.join(","))}&down=${encodeURIComponent(guard.down.join(","))}`
    + (guard.brokers?.length ? `&broker=${encodeURIComponent(JSON.stringify(guard.brokers.map(({ host, header, file }) => ({ host, header, file }))))}` : "");
  const args = guard ? ["--import", `${NET_GUARD.href}?${query}`, artifact] : [artifact];
  const trace = { network: [], brokered: [], stack: null, stderr: "", stdoutBytes: 0, stderrBytes: 0, ms: 0 };
  const started = performance.now();
  try {
    const message = await withProcess(process.execPath, args, {
      cwd: dirname(artifact),
      env: { HOME: home, NODE_ENV: "production", NO_COLOR: "1", PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...env },
    }, async (child, closed, stop) => {
      let pending = "";
      child.stdout.on("data", (chunk) => {
        trace.stdoutBytes += chunk.byteLength;
        if (trace.stdoutBytes > LIMITS.stdoutBytes) stop(`plugin stdout exceeded ${LIMITS.stdoutBytes} bytes`, "limit_exceeded");
      });
      child.stderr.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          if (line.startsWith("OWED_E2E_NET ")) {
            try { trace.network.push(JSON.parse(line.slice(13))); } catch { /* partial line from a killed process */ }
            continue;
          }
          if (line.startsWith("OWED_E2E_BROKER ")) {
            try { trace.brokered.push(JSON.parse(line.slice(16))); } catch { /* partial line from a killed process */ }
            continue;
          }
          if (line.startsWith("OWED_E2E_STACK ")) {
            try { trace.stack = JSON.parse(line.slice(15)); } catch { /* partial line from a killed process */ }
            continue;
          }
          trace.stderr += `${line}\n`;
          trace.stderrBytes += Buffer.byteLength(line) + 1;
          if (trace.stderrBytes > LIMITS.stderrBytes) stop(`plugin stderr exceeded ${LIMITS.stderrBytes} bytes`, "limit_exceeded");
        }
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      try {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0", id: 2, method: operation.method,
          params: { ...operation.params, _meta: {
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
            "io.modelcontextprotocol/clientInfo": { name: "owed-plugin-e2e", version },
            "io.modelcontextprotocol/clientCapabilities": {},
          } },
        })}\n`);
        for await (const line of lines) {
          let parsed;
          try { parsed = JSON.parse(line); } catch { throw new HarnessError(`plugin wrote non-JSON to stdout: ${JSON.stringify(line.slice(0, 120))}`, "protocol_invalid"); }
          if (parsed?.jsonrpc !== "2.0" || typeof parsed !== "object" || Array.isArray(parsed)) throw new HarnessError("plugin returned an invalid JSON-RPC message", "protocol_invalid");
          if (!("id" in parsed)) continue; // notifications (logging, progress) are allowed
          if (parsed.id !== 2) throw new HarnessError("plugin response id did not match the request", "protocol_invalid");
          if (("result" in parsed) === ("error" in parsed)) throw new HarnessError("plugin response must contain exactly one of result or error", "protocol_invalid");
          if ("error" in parsed) throw new HarnessError(`plugin returned JSON-RPC error ${parsed.error?.code}: ${parsed.error?.message}`, "tool_failed");
          if (parsed.result?.resultType !== "complete") throw new HarnessError("MCP 2026-07-28 resultType must be \"complete\"", "protocol_invalid");
          // The guard reports the stack probe on stderr just before this response; give the pipe a moment to deliver it.
          for (let waited = 0; guard && trace.stack === null && waited < 500; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
          return parsed;
        }
        await closed;
        throw new HarnessError("plugin exited before returning an MCP response", "startup_failed");
      } finally {
        lines.close();
      }
    }, budgetMs);
    trace.ms = Math.round(performance.now() - started);
    return { message, trace };
  } catch (error) {
    trace.ms = Math.round(performance.now() - started);
    throw Object.assign(error instanceof HarnessError ? error : new HarnessError(error.message, error.code ?? "harness_failed"), { trace });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------------------------- the run

export async function runE2E(options) {
  const report = { ok: false, artifact: null, tools: [], list: null, call: null, failures: [], warnings: [] };
  const fail = (message) => report.failures.push(message);
  const warn = (message) => report.warnings.push(message);
  const plugin = loadPluginTools();
  const release = JSON.parse(await readFile(join(PLUGIN_DIR, "starter-version.json"), "utf8"));
  const budgetMs = options.budgetMs ?? LIMITS.budgetMs;
  const env = { ...(options.baseUrl ? { OWED_BASE_URL: options.baseUrl } : {}), ...options.env };
  const ownHost = new URL(options.baseUrl ?? DEFAULT_BASE_URL).hostname;
  const hosts = options.hosts ?? [ownHost, ...RPC_HOSTS, ...DOH_HOSTS, ...SCREEN_HOSTS];
  const down = options.down ?? [];
  const brokers = (options.brokers ?? []).map((b) => ({ ...b, value: readBrokerValue(b) }));
  if (brokers.length && options.guard === false) throw new HarnessError("--broker needs the network guard (it adds the header); drop --no-guard", "usage");
  const callGuard = options.guard === false ? null : { policy: hosts === "none" || hosts === "any" ? hosts : "allow", hosts: Array.isArray(hosts) ? hosts : [], down, brokers };
  const listGuard = options.guard === false ? null : { policy: "none", hosts: [], down: [] };
  const operationOptions = { env, budgetMs, protocolVersion: release.protocolVersion, version: release.version };

  // Artifact: the same limits the portal applies.
  const artifact = resolve(options.artifact);
  let bytes;
  try { bytes = await readFile(artifact); } catch { throw new HarnessError(`cannot read ${artifact}: build the plugin first (cd plugin && pnpm build)`, "artifact_invalid"); }
  report.artifact = { path: artifact, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  if (basename(artifact) !== "plugin.mjs") warn("the portal only accepts a file named plugin.mjs");
  if (!bytes.length || bytes.length > LIMITS.artifactBytes) fail(`bundle is ${bytes.length} bytes; the portal accepts 1..${LIMITS.artifactBytes}`);
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) fail("bundle is not valid UTF-8");

  // tools/list: fresh process per page, no network at all (startup + discovery must be offline).
  const tools = [];
  let cursor;
  const listStarted = performance.now();
  try {
    for (let page = 0; page < LIMITS.toolPages; page += 1) {
      const { message, trace } = await runOperation(artifact, { method: "tools/list", params: cursor === undefined ? {} : { cursor } }, { ...operationOptions, guard: listGuard });
      for (const attempt of trace.network) fail(`network during startup/tool discovery: ${attempt.host ?? attempt.path}:${attempt.port ?? ""} (PayBox forbids it)`);
      if (page === 0 && trace.stack && !trace.stack.ok) {
        fail(`after startup, reading an error's .stack throws ${trace.stack.error}: any error path will crash the plugin (exit 1, the whole minified line on stderr)${/__filename|__dirname/.test(trace.stack.error) ? ". A CommonJS dependency needs __filename/__dirname: define them in the bundle banner" : ""}`);
      }
      const result = message.result;
      if (!Array.isArray(result?.tools)) throw new HarnessError("tools/list result must contain a tools array", "tool_catalog_invalid");
      for (const tool of result.tools) {
        if (typeof tool?.name !== "string" || !tool.name || tools.some((seen) => seen.name === tool.name)) throw new HarnessError("tool names must be non-empty and unique", "tool_catalog_invalid");
        if (tool.inputSchema === null || typeof tool.inputSchema !== "object") throw new HarnessError(`${tool.name}: inputSchema must be an object`, "tool_catalog_invalid");
        plugin.compile(tool.inputSchema, `${tool.name} inputSchema`);
        if (tool.outputSchema !== undefined) plugin.compile(tool.outputSchema, `${tool.name} outputSchema`);
        const schemaBytes = Buffer.byteLength(JSON.stringify(tool.inputSchema)) + Buffer.byteLength(JSON.stringify(tool.outputSchema ?? ""));
        if (schemaBytes > 64 * 1024) fail(`${tool.name}: schemas are ${schemaBytes} bytes (> 64 KiB)`);
        if (!tool.description) warn(`${tool.name}: no description (the agent decides when to call a tool from it)`);
        if (!tool.annotations) warn(`${tool.name}: no annotations (readOnlyHint/destructiveHint/idempotentHint/openWorldHint)`);
        tools.push(tool);
      }
      if (result.nextCursor == null) break;
      cursor = result.nextCursor;
    }
  } catch (error) {
    fail(`tools/list failed: ${error.message}`);
    report.list = { ms: Math.round(performance.now() - listStarted), stderr: error.trace?.stderr ?? "" };
    return finish(report);
  }
  report.list = { ms: Math.round(performance.now() - listStarted) };
  report.tools = tools.map((tool) => ({ name: tool.name, title: tool.title ?? null, annotations: tool.annotations ?? null, outputSchema: tool.outputSchema !== undefined }));
  if (!options.tool) return finish(report);

  // tools/call
  const tool = tools.find((entry) => entry.name === options.tool);
  if (!tool) {
    fail(`tool ${options.tool} is not in tools/list (have: ${tools.map((entry) => entry.name).join(", ")})`);
    return finish(report);
  }
  const args = options.arguments ?? {};
  const validateInput = plugin.compile(tool.inputSchema, `${tool.name} inputSchema`);
  if (!validateInput(args)) {
    const problems = ajvErrors(validateInput).join("; ");
    if (options.inputCheck !== false) {
      fail(`arguments do not match ${tool.name}'s input schema: ${problems}`);
      return finish(report);
    }
    warn(`arguments do not match the input schema (sent anyway): ${problems}`);
  }
  const call = { tool: tool.name, arguments: args, hosts: !callGuard || callGuard.policy === "any" ? "any" : callGuard.hosts, down, brokers: brokers.map(({ host, header }) => `${header} → ${host}`) };
  report.call = call;
  let message;
  let trace;
  try {
    ({ message, trace } = await runOperation(artifact, { method: "tools/call", params: { name: tool.name, arguments: args } }, { ...operationOptions, guard: callGuard }));
  } catch (error) {
    Object.assign(call, { ms: error.trace?.ms, network: error.trace?.network ?? [], stderr: error.trace?.stderr ?? "" });
    fail(`tools/call failed (${error.code}): ${error.message}`);
    for (const attempt of call.network.filter((entry) => !entry.allowed && !entry.simulated)) fail(`blocked ${attempt.host ?? attempt.path}:${attempt.port ?? ""}: ${attempt.reason}`);
    if (/__filename is not defined|__dirname is not defined/.test(call.stderr)) fail("the plugin crashed on ReferenceError: __filename/__dirname is not defined (define them in the bundle banner)");
    return finish(report);
  }
  const result = message.result;
  // PayBox withholds any output that contains a brokered credential's value.
  const output = JSON.stringify(message);
  for (const b of brokers) if (b.value && (output.includes(b.value) || trace.stderr.includes(b.value))) fail(`the tool's output contains the value brokered as ${b.header} for ${b.host} (PayBox withholds such output)`);
  Object.assign(call, {
    ms: trace.ms, network: trace.network, brokered: trace.brokered, stderr: trace.stderr, stdoutBytes: trace.stdoutBytes,
    isError: result.isError === true, content: result.content, structuredContent: result.structuredContent,
  });
  for (const attempt of trace.network.filter((entry) => !entry.allowed && !entry.simulated)) {
    fail(`blocked ${attempt.host ?? attempt.path}:${attempt.port ?? ""}: ${attempt.reason}${callGuard?.policy === "allow" ? ` (allowed: ${callGuard.hosts.join(", ")})` : ""}`);
  }
  if (!Array.isArray(result.content)) fail("result.content must be an array");
  else if (result.content.length > LIMITS.contentItems) fail(`result.content has ${result.content.length} items (> ${LIMITS.contentItems})`);
  if (result.isError !== undefined && typeof result.isError !== "boolean") fail("result.isError must be a boolean");
  if (options.maxMs && trace.ms > options.maxMs) fail(`tools/call took ${trace.ms} ms (> --max-ms ${options.maxMs})`);
  const text = (Array.isArray(result.content) ? result.content : []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
  call.text = text;

  if (call.isError) {
    if (!options.expectError && !options.allowError) fail(`tool returned isError: true: ${text.slice(0, 300)}`);
  } else {
    if (options.expectError) fail("expected isError: true, got a successful result");
    if (tool.outputSchema !== undefined) {
      const validateOutput = plugin.compile(tool.outputSchema, `${tool.name} outputSchema`);
      if (!("structuredContent" in result)) fail("tool declares an outputSchema but returned no structuredContent");
      else if (!validateOutput(result.structuredContent)) fail(`structuredContent does not match the output schema: ${ajvErrors(validateOutput).join("; ")}`);
    }
  }

  // Proposal: decode the transaction and, when we know what is being paid, check it pays exactly that.
  const hasProposal = Boolean(result.structuredContent?.[PROPOSAL_KEY]);
  if (options.expectNoProposal && hasProposal) fail("expected no PayBox proposal, but the tool returned one");
  if (hasProposal) {
    const expected = await expectedPayment(args, options.baseUrl ?? DEFAULT_BASE_URL, warn);
    const inspection = inspectProposal(result.structuredContent, { sender: options.sender ?? args.sender, expected, ataFor: plugin.ataFor() });
    call.proposal = { ...inspection.summary, expectedFrom: expected?.source ?? null };
    for (const error of inspection.errors) fail(`proposal: ${error}`);
    for (const warning of inspection.warnings) warn(`proposal: ${warning}`);
  }

  for (const expectation of options.expects ?? []) {
    const split = expectation.indexOf("=");
    const path = expectation.slice(0, split);
    const raw = expectation.slice(split + 1);
    const actual = path.startsWith("proposal.") ? getPath(call.proposal, path.slice(9)) : getPath(result.structuredContent, path);
    if (!matches(actual, raw)) fail(`expected ${path} = ${raw}, got ${JSON.stringify(actual)}`);
  }
  for (const needle of options.expectTexts ?? []) if (!text.includes(needle)) fail(`text does not contain ${JSON.stringify(needle)}`);
  return finish(report);
}

/** --broker values come from files only, so they never sit in argv, shell history or the plugin's environment. */
function readBrokerValue({ host, header, file }) {
  let value;
  try { value = readFileSync(file, "utf8").trim(); } catch { throw new HarnessError(`--broker ${host}:${header}: cannot read ${file}`, "usage"); }
  if (!value) throw new HarnessError(`--broker ${host}:${header}: ${file} is empty`, "usage");
  if (/[\r\n]/.test(value)) throw new HarnessError(`--broker ${host}:${header}: ${file} must hold one line`, "usage");
  return value;
}

function finish(report) {
  report.ok = report.failures.length === 0;
  return report;
}

/** What the paid link asks for: parsed from a solana: URL, or fetched from the Owed API for an Owed link/id. */
async function expectedPayment(args, baseUrl, warn) {
  const link = typeof args.link === "string" ? args.link.trim() : null;
  if (!link) return null;
  const fromUrl = (url, source) => {
    const parsed = parseSolanaPayUrl(url);
    if (!parsed.ok || parsed.kind !== "transfer") return null;
    return { source, recipient: parsed.recipient, amount: parsed.amount ?? args.amount ?? null, token: parsed.token, splToken: parsed.splToken, references: parsed.references, memo: parsed.memo };
  };
  if (link.startsWith("solana:")) return fromUrl(link, "solana: URL");
  const id = link.match(/(?:^|\/r\/)([1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?)(?:[/?#]|$)/)?.[1];
  if (!id) return null;
  const origin = /^https?:\/\//.test(link) ? new URL(link).origin : new URL(baseUrl).origin;
  try {
    const res = await fetch(`${origin}/api/v1/requests/${id}`, { signal: AbortSignal.timeout(5000), headers: { "user-agent": "owed-plugin-e2e/1" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const request = await res.json();
    return fromUrl(request.solana_pay_url, `GET ${origin}/api/v1/requests/${id}`);
  } catch (error) {
    warn(`could not resolve ${id} to cross-check the proposal: ${error.message}`);
    return null;
  }
}

// ----------------------------------------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const options = { expects: [], expectTexts: [], env: {}, positional: [] };
  const take = (index, flag) => {
    if (index >= argv.length) throw new HarnessError(`${flag} needs a value`, "usage");
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--sample": options.sample = true; break;
      case "--base-url": options.baseUrl = take(++index, arg); break;
      case "--hosts": {
        const value = take(++index, arg);
        options.hosts = value === "none" || value === "any" ? value : value.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
        break;
      }
      case "--no-guard": options.guard = false; break;
      case "--down": options.down = take(++index, arg).split(",").map((host) => host.trim().toLowerCase()).filter(Boolean); break;
      case "--broker": {
        const value = take(++index, arg);
        const match = /^([a-z0-9.-]+):([A-Za-z0-9-]+)=@(.+)$/i.exec(value);
        if (!match) throw new HarnessError(`--broker needs HOST:HEADER=@FILE (the value is read from a file, never given inline), got ${value.replace(/=.*/, "=…")}`, "usage");
        (options.brokers ??= []).push({ host: match[1].toLowerCase(), header: match[2], file: match[3] });
        break;
      }
      case "--env": {
        const [key, ...rest] = take(++index, arg).split("=");
        options.env[key] = rest.join("=");
        break;
      }
      case "--budget-ms": options.budgetMs = Number.parseInt(take(++index, arg), 10); break;
      case "--max-ms": options.maxMs = Number.parseInt(take(++index, arg), 10); break;
      case "--expect": options.expects.push(take(++index, arg)); break;
      case "--expect-text": options.expectTexts.push(take(++index, arg)); break;
      case "--expect-error": options.expectError = true; break;
      case "--allow-error": options.allowError = true; break;
      case "--expect-no-proposal": options.expectNoProposal = true; break;
      case "--sender": options.sender = take(++index, arg); break;
      case "--no-input-check": options.inputCheck = false; break;
      case "--print": options.print = take(++index, arg); break;
      case "--json": options.json = true; break;
      case "--help": case "-h": options.help = true; break;
      default:
        if (arg.startsWith("--")) throw new HarnessError(`unknown option ${arg}`, "usage");
        options.positional.push(arg);
    }
  }
  for (const expectation of options.expects) if (!expectation.includes("=")) throw new HarnessError(`--expect needs PATH=VALUE, got ${expectation}`, "usage");
  return options;
}

async function resolveCall(options) {
  const [artifact, tool, rawArgs] = options.positional;
  if (!artifact) throw new HarnessError("missing <dist/plugin.mjs>", "usage");
  options.artifact = artifact;
  if (options.sample) {
    if (tool) throw new HarnessError("--sample and an explicit tool are mutually exclusive", "usage");
    const sample = JSON.parse(await readFile(join(PLUGIN_DIR, "paybox-plugin.json"), "utf8"));
    options.tool = sample.tool;
    options.arguments = sample.arguments;
    return options;
  }
  options.tool = tool;
  if (tool) {
    const text = rawArgs === undefined ? "{}" : rawArgs.startsWith("@") ? await readFile(rawArgs.slice(1), "utf8") : rawArgs;
    try { options.arguments = JSON.parse(text); } catch (error) { throw new HarnessError(`arguments are not JSON: ${error.message}`, "usage"); }
  }
  return options;
}

function formatReport(report) {
  const out = [];
  const kib = (value) => `${(value / 1024).toFixed(1)} KiB`;
  if (report.artifact) out.push(`plugin-e2e · ${report.artifact.path} · ${report.artifact.bytes} bytes · sha256 ${report.artifact.sha256.slice(0, 16)}…`);
  if (report.list) {
    out.push(`tools/list · fresh process, no network · ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"} · ${report.list.ms} ms`);
    for (const tool of report.tools) {
      const hints = Object.entries(tool.annotations ?? {}).filter(([, value]) => value === true).map(([key]) => key.replace(/Hint$/, ""));
      out.push(`  ${tool.name.padEnd(18)} ${(tool.title ?? "").padEnd(28)} ${hints.join(" ") || "-"}${tool.outputSchema ? " · outputSchema" : ""}`);
    }
  }
  const call = report.call;
  if (call) {
    out.push(`tools/call ${call.tool} · ${call.ms ?? "?"} ms · hosts: ${Array.isArray(call.hosts) ? call.hosts.join(", ") || "none" : call.hosts}`);
    for (const attempt of call.network ?? []) out.push(`  network ${attempt.allowed ? "ok     " : attempt.simulated ? "DOWN   " : "BLOCKED"} ${attempt.host ?? attempt.path}:${attempt.port ?? ""}${attempt.tls ? " tls" : ""}${attempt.reason ? ` (${attempt.reason})` : ""}`);
    for (const b of call.brokered ?? []) out.push(`  broker  ${b.header} added to ${b.method} https://${b.host}${b.path}`);
    if (call.text) out.push(...call.text.split("\n").map((line) => `  text  ${line}`));
    if (call.structuredContent !== undefined) out.push(`  structuredContent ${JSON.stringify(call.structuredContent, null, 2).replace(/\n/g, "\n  ")}`);
    if (call.proposal) {
      const proposal = call.proposal;
      out.push(`  proposal ${proposal.bytes} bytes · fee payer ${proposal.feePayer} · ${proposal.instructions?.join(" → ")}`);
      if (proposal.transfer) out.push(`    pays ${proposal.transfer.amount} ${proposal.transfer.token} (${proposal.transfer.atomic} atomic) to ${proposal.transfer.destination}${proposal.transfer.destinationOwner ? ` (owner ${proposal.transfer.destinationOwner})` : ""} · ${proposal.transfer.references.length} reference(s)${proposal.memo ? ` · memo ${JSON.stringify(proposal.memo)}` : ""}`);
      if (proposal.expectedFrom) out.push(`    matched against ${proposal.expectedFrom}`);
    }
    if (call.stdoutBytes !== undefined) out.push(`  limits: ${call.ms}/${LIMITS.budgetMs} ms · stdout ${kib(call.stdoutBytes)}/${kib(LIMITS.stdoutBytes)}${call.isError ? " · isError" : ""}`);
    if (call.stderr) out.push(...call.stderr.trimEnd().split("\n").slice(-20).map((line) => `  stderr ${line}`));
  }
  for (const warning of report.warnings) out.push(`WARN  ${warning}`);
  for (const failure of report.failures) out.push(`FAIL  ${failure}`);
  out.push(report.ok ? "PASS" : "FAILED");
  return out.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(USAGE);
      process.exit(0);
    }
    await resolveCall(options);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    const report = await runE2E(options);
    if (options.json) console.log(JSON.stringify(report));
    else if (options.print) {
      console.error(formatReport(report));
      const value = getPath(options.print.startsWith("proposal.") ? report.call?.proposal : report.call?.structuredContent, options.print.replace(/^proposal\./, ""));
      if (report.ok && value !== undefined) console.log(typeof value === "string" ? value : JSON.stringify(value));
    } else console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`plugin-e2e could not run (${error.code ?? "error"}): ${error.message}`);
    process.exitCode = 1;
  }
}
