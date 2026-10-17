// The harness against the real bundle (when built) and against small fake plugins that each break one PayBox
// sandbox rule. Blocked connections never leave the machine: the guard refuses them before any socket opens.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs, runE2E } from "../plugin-e2e.mjs";

const BUNDLE = fileURLToPath(new URL("../../plugin/dist/plugin.mjs", import.meta.url));
const dirs = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

/** A minimal stateless MCP 2026-07-28 server with one tool, "probe". `startup` runs at module load, `call` per call. */
async function fakePlugin({ startup = "", call = "return { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "owed-e2e-fake-"));
  dirs.push(dir);
  const file = join(dir, "plugin.mjs");
  await writeFile(file, `
import { createInterface } from "node:readline";
${startup}
const tools = [{
  name: "probe", title: "Probe", description: "Test tool.",
  inputSchema: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false },
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
  annotations: { readOnlyHint: true },
}];
async function callTool(args) { ${call} }
createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  const result = request.method === "tools/list" ? { tools } : await callTool(request.params.arguments);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { resultType: "complete", ...result } }) + "\\n");
});
`);
  return file;
}

test("real bundle: lists tools and calls the sample tool", { skip: !existsSync(BUNDLE) && "plugin/dist/plugin.mjs not built" }, async () => {
  const listed = await runE2E({ artifact: BUNDLE });
  assert.deepEqual(listed.failures, []);
  assert.ok(listed.tools.length >= 1);
  const tool = listed.tools.find((entry) => entry.name === "echo");
  if (!tool) return; // echo is removed once the real tools land; the CI sample step covers them
  const report = await runE2E({ artifact: BUNDLE, tool: "echo", arguments: { message: "hello paybox" }, expects: ["message=hello paybox"], expectTexts: ["hello"] });
  assert.deepEqual(report.failures, []);
  assert.equal(report.call.structuredContent.message, "hello paybox");
  assert.ok(report.call.ms < 10_000);
});

test("a well-behaved fake plugin passes", async () => {
  const report = await runE2E({ artifact: await fakePlugin(), tool: "probe", arguments: {} });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.warnings, []);
});

test("network at startup fails discovery", async () => {
  const report = await runE2E({ artifact: await fakePlugin({ startup: "fetch('https://owed-omega.vercel.app/').catch(() => {});\nawait new Promise((r) => setTimeout(r, 50));" }) });
  assert.match(report.failures.join("\n"), /network during startup\/tool discovery: owed-omega\.vercel\.app:443/);
});

test("unlisted hosts and plain HTTP are blocked during a call", async () => {
  const artifact = await fakePlugin({ call: `
    const outcomes = [];
    for (const url of ["https://example.com/", "http://owed-omega.vercel.app/"]) {
      try { await fetch(url); outcomes.push("reached"); } catch (error) { outcomes.push(error.cause?.code ?? error.message); }
    }
    return { content: [{ type: "text", text: outcomes.join(",") }], structuredContent: { ok: true } };` });
  const report = await runE2E({ artifact, tool: "probe", arguments: {} });
  const failures = report.failures.join("\n");
  assert.match(failures, /blocked example\.com:443: host is not in the configured host list/);
  assert.match(failures, /blocked owed-omega\.vercel\.app:80: only HTTPS is allowed/);
  assert.equal(report.call.text, "ECONNREFUSED,ECONNREFUSED");
  const none = await runE2E({ artifact, tool: "probe", arguments: {}, hosts: "none" });
  assert.match(none.failures.join("\n"), /no network is allowed/);
});

test("a bundle that leaves Error.stack broken after startup fails discovery", async () => {
  // What bigint-buffer's \`bindings\` does inside an ESM bundle without __filename: swaps prepareStackTrace, throws, never restores.
  const startup = "Error.prepareStackTrace = () => { throw new ReferenceError('__filename is not defined'); };";
  const report = await runE2E({ artifact: await fakePlugin({ startup }) });
  assert.match(report.failures.join(), /reading an error's \.stack throws ReferenceError: __filename is not defined.*define them in the bundle banner/);
});

test("--down simulates an outage without failing the run", async () => {
  const call = `
    try { await fetch("https://owed-omega.vercel.app/api/v1/requests"); return { content: [{ type: "text", text: "reached" }], structuredContent: { ok: false } }; }
    catch (error) { return { content: [{ type: "text", text: error.cause?.code ?? error.message }], structuredContent: { ok: true } }; }`;
  const report = await runE2E({ artifact: await fakePlugin({ call }), tool: "probe", arguments: {}, down: ["owed-omega.vercel.app"], expects: ["ok=true"] });
  assert.deepEqual(report.failures, []);
  assert.equal(report.call.text, "ECONNREFUSED");
  assert.deepEqual(report.call.network.map(({ host, simulated }) => ({ host, simulated })), [{ host: "owed-omega.vercel.app", simulated: true }]);
});

test("stdout noise, bad structuredContent, slow and chatty plugins fail", async () => {
  const noisy = await runE2E({ artifact: await fakePlugin({ startup: "console.log('booting');" }) });
  assert.match(noisy.failures.join(), /non-JSON to stdout: "booting"/);

  const badOutput = await runE2E({ artifact: await fakePlugin({ call: "return { content: [], structuredContent: { ok: 'yes' } };" }), tool: "probe", arguments: {} });
  assert.match(badOutput.failures.join(), /does not match the output schema: \/ok must be boolean/);

  const slow = await runE2E({ artifact: await fakePlugin({ call: "await new Promise(() => {});" }), tool: "probe", arguments: {}, budgetMs: 1500 });
  assert.match(slow.failures.join(), /tools\/call failed \(timeout\): Process exceeded 1500 ms/);

  const huge = await runE2E({ artifact: await fakePlugin({ call: "return { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }], structuredContent: { ok: true } };" }), tool: "probe", arguments: {} });
  assert.match(huge.failures.join(), /stdout exceeded 262144 bytes/);

  const errored = await runE2E({ artifact: await fakePlugin({ call: "return { isError: true, content: [{ type: 'text', text: 'refused' }] };" }), tool: "probe", arguments: {} });
  assert.match(errored.failures.join(), /isError: true: refused/);
  const expected = await runE2E({ artifact: await fakePlugin({ call: "return { isError: true, content: [{ type: 'text', text: 'refused' }] };" }), tool: "probe", arguments: {}, expectError: true, expectTexts: ["refused"], expectNoProposal: true });
  assert.deepEqual(expected.failures, []);
});

test("arguments are checked against the input schema before the call", async () => {
  const report = await runE2E({ artifact: await fakePlugin(), tool: "probe", arguments: { n: "1" } });
  assert.match(report.failures.join(), /\/n must be integer/);
  assert.equal(report.call, null);
});

test("CLI parsing", () => {
  const options = parseArgs(["dist/plugin.mjs", "ask_for_money", "{}", "--hosts", "A.example,b.example", "--expect", "mode=offline", "--env", "K=a=b", "--max-ms", "3000"]);
  assert.deepEqual(options.positional, ["dist/plugin.mjs", "ask_for_money", "{}"]);
  assert.deepEqual(options.hosts, ["a.example", "b.example"]);
  assert.deepEqual(options.expects, ["mode=offline"]);
  assert.deepEqual(options.env, { K: "a=b" });
  assert.equal(options.maxMs, 3000);
  assert.equal(parseArgs(["x", "--hosts", "none"]).hosts, "none");
  assert.deepEqual(parseArgs(["x", "--down", "Owed-Omega.vercel.app"]).down, ["owed-omega.vercel.app"]);
  assert.throws(() => parseArgs(["x", "--expect", "nope"]), /PATH=VALUE/);
  assert.throws(() => parseArgs(["x", "--bogus"]), /unknown option/);
});

test("--broker adds the header to HTTPS fetches to that exact host only, like a PayBox brokered secret", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owed-e2e-broker-"));
  dirs.push(dir);
  const secret = join(dir, "key");
  await writeFile(secret, "s3cret-value-for-test\n");
  const call = `
    const seen = [];
    for (const url of ["https://broker.invalid/api/v1/address/abc", "https://other.invalid/x"]) {
      try { await fetch(url, { headers: { accept: "application/json" } }); } catch (error) { seen.push(error.cause?.code ?? error.message); }
    }
    return { content: [{ type: "text", text: JSON.stringify({ env: Object.keys(process.env).filter((k) => /KEY|SECRET/i.test(k)), argv: process.argv.join(" ").includes("s3cret") }) }], structuredContent: { ok: true } };`;
  const report = await runE2E({ artifact: await fakePlugin({ call }), tool: "probe", arguments: {}, hosts: ["broker.invalid", "other.invalid"], brokers: [{ host: "broker.invalid", header: "X-API-Key", file: secret }] });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.call.brokered, [{ host: "broker.invalid", header: "X-API-Key", method: "GET", path: "/api/v1/address/abc" }]);
  assert.deepEqual(JSON.parse(report.call.text), { env: [], argv: false }, "the plugin's env and argv never carry the value");
  assert.doesNotMatch(JSON.stringify(report), /s3cret-value-for-test/, "the report never carries the value");
  assert.deepEqual(report.call.brokers, ["X-API-Key → broker.invalid"]);

  const leak = await runE2E({ artifact: await fakePlugin({ call: "return { content: [{ type: 'text', text: 'key is s3cret-value-for-test' }], structuredContent: { ok: true } };" }), tool: "probe", arguments: {}, brokers: [{ host: "broker.invalid", header: "X-API-Key", file: secret }] });
  assert.match(leak.failures.join(), /output contains the value brokered as X-API-Key for broker\.invalid/);
});

test("default call hosts include public.chainalysis.com (W2-E sanctions screen)", async () => {
  const report = await runE2E({ artifact: await fakePlugin(), tool: "probe", arguments: {} });
  assert.ok(report.call.hosts.includes("public.chainalysis.com"));
  assert.ok(report.call.hosts.includes("cloudflare-dns.com"));
});

test("--broker parsing: HOST:HEADER=@FILE only, never an inline value", () => {
  assert.deepEqual(parseArgs(["x", "--broker", "Public.Chainalysis.com:X-API-Key=@/tmp/k"]).brokers, [{ host: "public.chainalysis.com", header: "X-API-Key", file: "/tmp/k" }]);
  assert.throws(() => parseArgs(["x", "--broker", "public.chainalysis.com:X-API-Key=inline-secret"]), (error) => /HOST:HEADER=@FILE/.test(error.message) && !error.message.includes("inline-secret"));
});
