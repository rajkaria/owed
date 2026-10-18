import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import { BUNDLE_LIMITS, BundleError, bundleEnv, bundleExecutor, bundlePath, createSlots, readBundleMeta, runBundle } from "@/lib/mcp/bundle";
import { MODERN_PROTOCOL_VERSION } from "@/lib/mcp/protocol";
import { createMcpHandler } from "@/lib/mcp/server";

// The bundle executor (lib/mcp/bundle.ts) against small fake plugins, then the real committed bundle
// (web/mcp/owed-plugin.mjs) end to end through the handler. Nothing here needs the network: a guard preload refuses
// every socket the bundle opens, and pay_link's one Solana RPC call is answered from a recorded mainnet fixture.

const WEB = fileURLToPath(new URL("../", import.meta.url));
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const BUNDLE = join(WEB, "mcp", "owed-plugin.mjs");
const META = readBundleMeta(BUNDLE);
const OFFLINE = ["--import", `${pathToFileURL(join(REPO, "e2e", "lib", "net-guard.mjs")).href}?policy=none`];
const BASE = "https://www.getowed.xyz";
/** Real-bundle runs get more than PayBox's 10 s so a loaded machine can't flake them; the budget itself is tested above. */
const SLOW_OK = 30_000;
const ELEVEN = ["ask_for_money", "check_payments", "pay_link", "verify_payee", "split_bill", "create_invoice", "write_reminder", "who_owes_me", "cancel_request", "ask_every_month", "match_payments"];
const exec = promisify(execFile);

const dir = mkdtempSync(join(tmpdir(), "owed-mcp-test-"));
/** A fake plugin: reads one request line, then runs `body` with `request` and `reply(result)` in scope. */
function fake(name: string, body: string): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const reply = (result, id) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.once("line", async (line) => { const request = JSON.parse(line); ${body} });
`);
  return path;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid: number) {
  for (let i = 0; i < 100 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

// ------------------------------------------------------------------------------------------ executor, fake plugins

test("the plugin gets a clean env (no server secrets, no NODE_OPTIONS) and one 2026-07-28 request with an envelope", async () => {
  const saved = { secret: process.env.OWED_TEST_SECRET, options: process.env.NODE_OPTIONS };
  process.env.OWED_TEST_SECRET = "s3cret";
  process.env.NODE_OPTIONS = "--require /nonexistent/owed-test.cjs"; // inherited, it would crash the child
  try {
    const path = fake("echo", "reply({ env: process.env, request, cwd: process.cwd(), argv: process.execArgv }, request.id);");
    const { message } = await runBundle({ method: "tools/call", params: { name: "pay_link", arguments: { a: 1 } } }, { bundlePath: path, baseUrl: "https://owed.test" });
    assert.ok("result" in message);
    const echoed = message.result as { env: Record<string, string>; request: unknown; cwd: string; argv: string[] };
    assert.deepEqual(Object.keys(echoed.env).filter((k) => !k.startsWith("__CF")).sort(), ["NODE_ENV", "NO_COLOR", "OWED_BASE_URL", "PATH"]);
    assert.equal(echoed.env.OWED_BASE_URL, "https://owed.test");
    assert.equal(echoed.env.NODE_ENV, "production");
    assert.deepEqual(echoed.argv, []);
    assert.deepEqual(echoed.request, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "pay_link", arguments: { a: 1 },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": { name: "owed-remote-mcp", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
  } finally {
    if (saved.secret === undefined) delete process.env.OWED_TEST_SECRET; else process.env.OWED_TEST_SECRET = saved.secret;
    if (saved.options === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved.options;
  }
  assert.deepEqual(Object.keys(bundleEnv(BASE)).sort(), ["NODE_ENV", "NO_COLOR", "OWED_BASE_URL", "PATH"]);
});

test("a plugin that never answers is killed at the budget (timeout)", async () => {
  // It reports its pid as soon as it starts; the budget leaves room for a slow start on a loaded machine.
  const path = join(dir, "hang.mjs");
  writeFileSync(path, "process.stderr.write(`PID ${process.pid}\\n`); setInterval(() => {}, 1000);\n");
  const started = Date.now();
  const error = await runBundle({ method: "tools/call" }, { bundlePath: path, baseUrl: BASE, timeoutMs: 4000 }).catch((e) => e);
  assert.ok(error instanceof BundleError);
  assert.equal(error.kind, "timeout");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 3900 && elapsed < 8000, `${elapsed} ms`);
  const pid = Number(error.stderr.match(/PID (\d+)/)?.[1]);
  assert.ok(pid > 0, error.stderr);
  assert.ok(await waitDead(pid), "the plugin process was killed");
  assert.equal(BUNDLE_LIMITS.timeoutMs, 10_000);
});

test("processes the plugin starts die with it (process group)", async () => {
  const path = fake("grandchild", `const { spawn } = await import("node:child_process");
const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
reply({ grandchild: sleeper.pid }, request.id);`);
  const { message } = await runBundle({ method: "tools/call" }, { bundlePath: path, baseUrl: BASE });
  const pid = (message as unknown as { result: { grandchild: number } }).result.grandchild;
  assert.ok(pid > 0);
  assert.ok(await waitDead(pid), "the grandchild was killed with the group");
});

test("stdout over 256 KiB, an early exit, non-JSON and a wrong id are failures, not answers", async () => {
  const cases: Array<[string, string, string]> = [
    ["flood", "process.stdout.write('x'.repeat(300 * 1024));", "output_limit"],
    ["exit", "process.exit(3);", "exited"],
    ["garbage", "process.stdout.write('hello\\n');", "protocol"],
    ["wrong-id", "reply({}, 99);", "protocol"],
    ["both", "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {}, error: { code: 1, message: 'x' } }) + '\\n');", "protocol"],
  ];
  for (const [name, body, kind] of cases) {
    const error = await runBundle({ method: "tools/call" }, { bundlePath: fake(name, body), baseUrl: BASE }).catch((e) => e);
    assert.ok(error instanceof BundleError, name);
    assert.equal(error.kind, kind, name);
  }
  const missing = await runBundle({ method: "tools/list" }, { bundlePath: join(dir, "missing.mjs"), baseUrl: BASE }).catch((e) => e);
  assert.ok(missing instanceof BundleError && missing.kind === "exited");
});

test("notifications before the answer are skipped, and an answer split across writes is read whole", async () => {
  const path = fake("chatty", `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } }) + "\\n");
const out = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }], big: "y".repeat(100000) } }) + "\\n";
process.stdout.write(out.slice(0, 10)); setTimeout(() => process.stdout.write(out.slice(10)), 50);`);
  const { message } = await runBundle({ method: "tools/call" }, { bundlePath: path, baseUrl: BASE });
  assert.ok("result" in message);
  assert.equal((message.result.big as string).length, 100000);
});

test("slots cap concurrent plugin processes; a call that waits too long is refused as busy", async () => {
  const slow = () => new Promise<string>((r) => setTimeout(() => r("done"), 150));
  const slots = createSlots(2, 1000);
  const results = await Promise.all([slots.run(slow), slots.run(slow), slots.run(slow)]);
  assert.deepEqual(results, ["done", "done", "done"]);
  assert.equal(slots.active, 0);
  const tight = createSlots(1, 20);
  const [first, second] = await Promise.allSettled([tight.run(slow), tight.run(slow)]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(((second as PromiseRejectedResult).reason as BundleError).kind, "busy");
  assert.equal(tight.active, 0);
});

// ------------------------------------------------------------------------------------------- the committed bundle

test("web/mcp/owed-plugin.meta.json describes the committed bundle", () => {
  const bytes = readFileSync(BUNDLE);
  assert.equal(META.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(META.bytes, bytes.length);
  assert.equal(META.file, "owed-plugin.mjs");
  assert.equal(META.protocolVersion, MODERN_PROTOCOL_VERSION, "the bundle moved protocol revision: update lib/mcp/protocol.ts");
  assert.equal(META.server.name, "owed");
  assert.equal(bundlePath(WEB), BUNDLE);
  assert.equal(bundlePath(REPO), BUNDLE, "found from the repo root too");
});

test("real bundle, no network: tools/list returns every tool (11+), as the meta file lists them", async () => {
  const { message, stderr } = await runBundle({ method: "tools/list" }, { bundlePath: BUNDLE, baseUrl: BASE, nodeArgs: OFFLINE, timeoutMs: SLOW_OK });
  assert.ok("result" in message, JSON.stringify(message));
  const tools = message.result.tools as Array<{ name: string; inputSchema: { type: string }; outputSchema?: { type?: string } }>;
  assert.ok(tools.length >= 11);
  for (const name of ELEVEN) assert.ok(tools.some((t) => t.name === name), name);
  assert.deepEqual(tools.map((t) => t.name), META.tools);
  assert.equal(message.result.resultType, "complete");
  assert.ok(!stderr.includes("OWED_E2E_NET"), `network during discovery: ${stderr}`);
  // Legacy clients get these schemas as they are, which is only right while every root is an object.
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.outputSchema?.type ?? "object", "object", tool.name);
  }
});

function realHandler(nodeArgs: readonly string[]) {
  return createMcpHandler({ execute: bundleExecutor({ bundlePath: BUNDLE, baseUrl: BASE, nodeArgs, timeoutMs: SLOW_OK }), server: META.server, log: () => undefined });
}
async function rpc(handler: ReturnType<typeof createMcpHandler>, body: unknown, headers: Record<string, string> = {}) {
  const res = await handler.post(new Request(`${BASE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}

test("real bundle through the handler, no network: initialize, tools/list (legacy view), check_payments refuses a bad id", async () => {
  const handler = realHandler(OFFLINE);
  const init = await rpc(handler, { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.equal(init.json.result.serverInfo.version, META.server.version);
  const list = await rpc(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
  assert.equal(list.json.result.tools.length, META.tools.length);
  assert.equal(list.json.result.resultType, undefined);
  assert.equal(list.json.result._meta, undefined);
  // check_payments with an id that isn't an Owed or Solana Pay link answers "invalid" without touching the network.
  const call = await rpc(handler, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_payments", arguments: { requests: ["not-a-real-id!!"] } } }, { "mcp-protocol-version": "2025-06-18" });
  assert.equal(call.status, 200);
  assert.notEqual(call.json.result.isError, true);
  assert.equal(call.json.result.structuredContent.results[0].status, "invalid");
  assert.match(call.json.result.content[0].text, /1 invalid/);
  // An unknown tool is the bundle's own error.
  const unknown = await rpc(handler, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(unknown.json.error.code, -32602);
});

// A preload that answers Solana JSON-RPC from a recorded fixture (its path in the module URL, since the plugin's env
// is clean) and refuses everything else, so pay_link builds a real proposal offline.
const RPC_FIXTURE = join(REPO, "plugin", "test", "fixtures", "chain", "readiness-usdc-existing-recipient.json");
const STUB = join(dir, "rpc-stub.mjs");
writeFileSync(STUB, `import { readFileSync } from "node:fs";
const fixture = JSON.parse(readFileSync(new URL(import.meta.url).searchParams.get("fixture"), "utf8"));
globalThis.fetch = async (input, init = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const hit = body && fixture.calls.find((c) => c.method === body.method && JSON.stringify(c.params) === JSON.stringify(body.params));
  if (!hit) throw new TypeError("fetch failed (unrecorded call)");
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: hit.result }), { status: 200, headers: { "content-type": "application/json" } });
};
`);
const STUBBED = [...OFFLINE, "--import", `${pathToFileURL(STUB).href}?fixture=${encodeURIComponent(RPC_FIXTURE)}`];
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const SENDER = "FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT"; // the fixture's funded wallet
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
const PAY = { link: `solana:${TEAM}?amount=1&spl-token=${USDC}&reference=${REFERENCE}`, sender: SENDER };

test("real bundle: tools/call pay_link through /api/mcp returns the same io.paybox/transactionProposal as the bundle itself", async () => {
  const direct = await runBundle({ method: "tools/call", params: { name: "pay_link", arguments: PAY } }, { bundlePath: BUNDLE, baseUrl: BASE, nodeArgs: STUBBED, timeoutMs: SLOW_OK });
  assert.ok("result" in direct.message, JSON.stringify(direct.message));
  const handler = realHandler(STUBBED);
  const viaModern = await rpc(handler, {
    jsonrpc: "2.0", id: "pay", method: "tools/call",
    params: { name: "pay_link", arguments: PAY, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
  }, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "pay_link" });
  const viaLegacy = await rpc(handler, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "pay_link", arguments: PAY } }, { "mcp-protocol-version": "2025-06-18" });

  // expiresAt is "now + 4 minutes" in each process; everything else must be identical.
  const sameExceptExpiry = (value: Record<string, unknown>) => JSON.parse(JSON.stringify(value).replace(/"expiresAt":"[^"]+"/g, '"expiresAt":"…"'));
  assert.equal(viaModern.status, 200);
  assert.deepEqual(sameExceptExpiry(viaModern.json.result), sameExceptExpiry(direct.message.result));
  const { resultType: _r, _meta: _m, ...legacyView } = direct.message.result;
  void _r; void _m;
  assert.deepEqual(sameExceptExpiry(viaLegacy.json.result), sameExceptExpiry(legacyView));

  // And it is a real, unsigned 1 USDC transfer to the team wallet's USDC account, paid by the sender.
  const proposal = viaLegacy.json.result.structuredContent["io.paybox/transactionProposal"];
  assert.equal(proposal.kind, "solana");
  assert.equal(proposal.chain, "solana:mainnet");
  const tx = Transaction.from(Buffer.from(proposal.transaction.transactionBase64, "base64"));
  assert.equal(tx.feePayer?.toBase58(), SENDER);
  assert.ok(tx.signatures.every((s) => s.signature === null || s.signature.every((b) => b === 0)), "unsigned");
  const transfer = tx.instructions.find((ix) => ix.programId.toBase58() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  assert.ok(transfer, "an SPL token instruction");
  const teamAta = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(TEAM), true).toBase58();
  assert.ok(transfer.keys.some((k) => k.pubkey.toBase58() === teamAta), "pays the team wallet's USDC account");
  assert.ok(transfer.keys.some((k) => k.pubkey.toBase58() === REFERENCE && !k.isWritable && !k.isSigner), "carries the reference, read-only");
  assert.equal(transfer.data[0], 12, "transferChecked");
  assert.equal(transfer.data.readBigUInt64LE(1), 1_000_000n, "1 USDC");
});

// --------------------------------------------------------------------------------------------- route and config

test("the route: thin wiring, Node runtime, 30 s, 405 for GET/DELETE, initialize and tools/list from the real bundle", async () => {
  const route = await import("@/app/api/mcp/route");
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.maxDuration, 30);
  for (const res of [route.GET(), route.DELETE()]) {
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  }
  assert.equal(route.OPTIONS().status, 204);
  const post = (body: unknown) => route.POST(new Request(`${BASE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const init = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json();
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.serverInfo, { name: "owed", title: "Owed", version: META.server.version });
  const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), META.tools);
});

test("next.config.ts ships the bundle and its meta file with /api/mcp", async () => {
  const { default: config } = await import("@/next.config");
  const includes = config.outputFileTracingIncludes?.["/api/mcp"] ?? [];
  assert.ok(includes.includes("./mcp/owed-plugin.mjs"));
  assert.ok(includes.includes("./mcp/owed-plugin.meta.json"));
  for (const path of includes) readFileSync(join(WEB, path)); // each listed file exists
});

test("scripts/check-mcp-bundle.mjs passes on the committed bundle and fails on drift", async () => {
  const script = join(REPO, "scripts", "check-mcp-bundle.mjs");
  const ok = await exec(process.execPath, [script, "--built", BUNDLE], { cwd: REPO });
  assert.match(ok.stdout, /check-mcp-bundle: ok/);
  const drifted = join(dir, "plugin.mjs");
  writeFileSync(drifted, Buffer.concat([readFileSync(BUNDLE), Buffer.from("\n// drift\n")]));
  const failed = await exec(process.execPath, [script, "--built", drifted], { cwd: REPO }).catch((e) => e);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /differs from/);
  assert.match(failed.stderr, /sync-mcp-bundle/);
  const missing = await exec(process.execPath, [script, "--built", join(dir, "none.mjs")], { cwd: REPO }).catch((e) => e);
  assert.equal(missing.code, 2);
});
