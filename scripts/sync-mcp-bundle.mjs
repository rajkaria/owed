#!/usr/bin/env node
// Copies the PayBox plugin bundle into the web app, where POST /api/mcp runs it (decision D4: the remote MCP
// endpoint runs the exact bundle PayBox's sandbox runs, never a re-implementation).
//
//   node scripts/sync-mcp-bundle.mjs              # cd plugin && pnpm run build, then copy
//   node scripts/sync-mcp-bundle.mjs --no-build   # copy plugin/dist/plugin.mjs as it is
//   node scripts/sync-mcp-bundle.mjs --from F     # copy another build of plugin.mjs (e.g. a CI artifact)
//
// Writes, byte for byte:
//   web/mcp/owed-plugin.mjs        the bundle (sha256 equal to the build it came from)
//   web/mcp/owed-plugin.meta.json  its digest, size, protocol version, server identity and tool names, read
//                                  from the bundle itself with one offline tools/list (no timestamps, so
//                                  re-running on the same build changes nothing)
// scripts/check-mcp-bundle.mjs fails CI when the copy and a fresh build differ.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_DIR = join(ROOT, "plugin");
export const BUILT = join(PLUGIN_DIR, "dist", "plugin.mjs");
export const TARGET = join(ROOT, "web", "mcp", "owed-plugin.mjs");
export const META = join(ROOT, "web", "mcp", "owed-plugin.meta.json");

/** Same limits the PayBox portal applies to an upload. */
const MAX_BYTES = 10 * 1024 * 1024;
const LIST_BUDGET_MS = 10_000;
const MAX_STDOUT = 256 * 1024;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rel = (path) => relative(process.cwd(), path) || ".";

export class BundleScriptError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The bundle's bytes, refusing what the portal would refuse. */
export function readBundle(path) {
  if (!existsSync(path)) throw new BundleScriptError(`${rel(path)} does not exist: build the plugin first (cd plugin && pnpm build)`, 2);
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new BundleScriptError(`${rel(path)} is ${bytes.length} bytes; a bundle is 1..${MAX_BYTES}`);
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) throw new BundleScriptError(`${rel(path)} is not valid UTF-8`);
  return bytes;
}

/** The protocol revision the plugin speaks (the PayBox starter's), e.g. "2026-07-28". */
export function pluginProtocolVersion() {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, "starter-version.json"), "utf8")).protocolVersion;
}

/**
 * One stateless tools/list against a bundle, the way PayBox discovers tools: a fresh process, a clean environment,
 * one request carrying the per-request _meta envelope, no network needed.
 */
export function listTools(bundlePath, protocolVersion = pluginProtocolVersion()) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd: dirname(bundlePath),
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", NODE_ENV: "production", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new BundleScriptError(`tools/list took more than ${LIST_BUDGET_MS} ms`)), LIST_BUDGET_MS);
    child.on("error", (error) => finish(new BundleScriptError(`could not start node: ${error.message}`)));
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT) finish(new BundleScriptError(`tools/list wrote more than ${MAX_STDOUT} bytes`));
    });
    child.on("close", () => finish(new BundleScriptError(`the bundle exited before answering tools/list${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`)));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return finish(new BundleScriptError(`the bundle wrote non-JSON to stdout: ${line.slice(0, 120)}`)); }
      if (message?.id !== 1) return; // notifications
      if (message.error) return finish(new BundleScriptError(`tools/list failed: ${message.error.code} ${message.error.message}`));
      const tools = message.result?.tools;
      if (!Array.isArray(tools) || tools.some((tool) => typeof tool?.name !== "string")) return finish(new BundleScriptError("tools/list returned no tools array"));
      if (message.result.nextCursor != null) return finish(new BundleScriptError("tools/list is paginated; teach this script to follow nextCursor"));
      finish(null, { tools: tools.map((tool) => tool.name), server: message.result._meta?.["io.modelcontextprotocol/serverInfo"] ?? null });
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": protocolVersion,
        "io.modelcontextprotocol/clientInfo": { name: "owed-sync-mcp-bundle", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
    })}\n`);
  });
}

/** What web/mcp/owed-plugin.meta.json must hold for these bundle bytes. */
export async function describeBundle(bundlePath, bytes) {
  const protocolVersion = pluginProtocolVersion();
  const { tools, server } = await listTools(bundlePath, protocolVersion);
  if (!server?.name || !server?.version) throw new BundleScriptError("tools/list carried no io.modelcontextprotocol/serverInfo");
  return {
    $comment: "Written by scripts/sync-mcp-bundle.mjs from the bundle next to it. Do not edit; re-run the script.",
    file: "owed-plugin.mjs",
    bytes: bytes.length,
    sha256: sha256(bytes),
    protocolVersion,
    server: { name: server.name, version: server.version },
    tools,
  };
}

export const metaJson = (meta) => `${JSON.stringify(meta, null, 2)}\n`;

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function build() {
  console.error("cd plugin && pnpm run build");
  const run = spawnSync("pnpm", ["run", "build"], { cwd: PLUGIN_DIR, stdio: ["ignore", "inherit", "inherit"] });
  if (run.error) throw new BundleScriptError(`could not run pnpm (${run.error.code ?? run.error.message}): put pnpm 11 on PATH`, 2);
  if (run.status !== 0) throw new BundleScriptError(`plugin build failed (exit ${run.status ?? run.signal})`);
}

export async function sync({ from, skipBuild = false } = {}) {
  const source = from ? resolve(from) : BUILT;
  if (!from && !skipBuild) build();
  const bytes = readBundle(source);
  const meta = await describeBundle(source, bytes);
  writeAtomic(TARGET, bytes);
  writeAtomic(META, metaJson(meta));
  const copied = readFileSync(TARGET);
  if (sha256(copied) !== meta.sha256) throw new BundleScriptError(`${rel(TARGET)} does not match ${rel(source)} after the copy`);
  return { source, meta };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-build") options.skipBuild = true;
    else if (arg === "--from") options.from = argv[++i];
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new BundleScriptError(`unknown argument ${arg} (try --help)`, 2);
  }
  if ("from" in options && !options.from) throw new BundleScriptError("--from needs a file", 2);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("usage: node scripts/sync-mcp-bundle.mjs [--no-build | --from <plugin.mjs>]");
    return;
  }
  const { source, meta } = await sync(options);
  console.log(`${rel(TARGET)} ← ${rel(source)} · ${meta.bytes} bytes · sha256 ${meta.sha256}`);
  console.log(`${rel(META)} · ${meta.server.name} ${meta.server.version} · MCP ${meta.protocolVersion} · ${meta.tools.length} tools: ${meta.tools.join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`sync-mcp-bundle: ${error.message}`);
    process.exit(error instanceof BundleScriptError ? error.exitCode : 1);
  });
}
