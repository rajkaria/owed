import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { ApiError } from "@/lib/http";
import { checkSnsForPage, parseSnsName, requireSnsName, resolveSnsName, type SnsResult, type SnsRpc } from "@/lib/sns";

// W3-S. The plugin and the server must resolve every name the same way, so this suite replays the plugin's
// fixtures (real mainnet accounts, plugin/test/fixtures/sns) and name vectors, and checks that the shared core
// of web/lib/sns.ts is plugin/src/sns.ts's, byte for byte.
const pluginRoot = new URL("../../plugin/", import.meta.url);
const fixturesDir = new URL("test/fixtures/sns/", pluginRoot);

interface SnsFixture {
  input: string;
  sdk: { wallet?: string; error?: string };
  owed?: string;
  result: Record<string, unknown>;
  calls: Array<{ method: string; params: unknown[]; result: unknown }>;
}
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(new URL(f, fixturesDir), "utf8")) as SnsFixture) }));
const vectors = JSON.parse(readFileSync(new URL("test/fixtures/sns-vectors.json", pluginRoot), "utf8")) as {
  valid: Array<{ input: string; name: string; labels: string[]; warnings: string[] }>;
  invalid: Array<{ input: string; code: string }>;
  sol_message: string;
};

function replay(f: Pick<SnsFixture, "calls">): SnsRpc {
  return async (method, params) => {
    const k = JSON.stringify({ method, params });
    const hit = f.calls.find((c) => JSON.stringify({ method: c.method, params: c.params }) === k);
    if (!hit) throw new Error(`unrecorded RPC call ${k}`);
    return structuredClone(hit.result);
  };
}

const core = (text: string) => {
  const start = text.indexOf("// ---- SNS core start");
  const end = text.indexOf("// ---- SNS core end");
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
};

test("the resolver core is the plugin's, byte for byte", () => {
  const plugin = readFileSync(new URL("src/sns.ts", pluginRoot), "utf8");
  const web = readFileSync(new URL("../lib/sns.ts", import.meta.url), "utf8");
  assert.equal(core(web), core(plugin));
});

test("fixtures: every captured mainnet name resolves exactly as in the plugin", async () => {
  assert.ok(fixtures.length >= 19);
  for (const f of fixtures) assert.deepEqual(await resolveSnsName(f.input, replay(f)), f.result, f.file);
});

test("name vectors: the same names pass and fail as in the plugin", () => {
  for (const v of vectors.valid) {
    const r = parseSnsName(v.input);
    assert.ok(r.ok, v.input);
    assert.equal(r.name, v.name);
    assert.deepEqual(r.warnings, v.warnings);
  }
  for (const v of vectors.invalid) {
    const r = parseSnsName(v.input);
    assert.equal(!r.ok && r.code, v.code, JSON.stringify(v.input));
  }
  const sol = parseSnsName("raj.sol");
  assert.equal(!sol.ok && sol.message, vectors.sol_message);
});

const resolveFrom = (file: string) => {
  const f = fixtures.find((x) => x.file === file)!;
  return (name: string) => resolveSnsName(name, replay(f));
};
const BONFIDA = "Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v";

test("requireSnsName: stores the normalized name only when it points to the recipient", async () => {
  assert.deepEqual(await requireSnsName("Bonfida.sns", BONFIDA, resolveFrom("bonfida.json")), { name: "bonfida.sns", source: "owner" });

  await assert.rejects(requireSnsName("bonfida.sns", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", resolveFrom("bonfida.json")),
    (e) => e instanceof ApiError && e.code === "invalid_input" && /points to Fw1ETan.* not to the recipient 9WzDX/.test(e.message));
  await assert.rejects(requireSnsName("raj.sol", BONFIDA, (n) => resolveSnsName(n, async () => { throw new Error("no RPC expected"); })),
    (e) => e instanceof ApiError && e.code === "invalid_input" && /\.sol name/.test(e.message));
  await assert.rejects(requireSnsName("sns-ip-5-wallet-1.sns", BONFIDA, resolveFrom("ip5-tokenized.json")),
    (e) => e instanceof ApiError && e.code === "invalid_input" && /tokenized/.test(e.message));
  const down = async (): Promise<SnsResult> => ({ ok: false, name: "bonfida.sns", code: "unavailable", message: "Solana couldn't be read." });
  await assert.rejects(requireSnsName("bonfida.sns", BONFIDA, down), (e) => e instanceof ApiError && e.code === "upstream_unavailable");
});

test("checkSnsForPage: verified, moved or unchecked; never verified for another wallet", async () => {
  const verified = await checkSnsForPage("bonfida.sns", BONFIDA, resolveFrom("bonfida.json"));
  assert.equal(verified?.state, "verified");
  const moved = await checkSnsForPage("bonfida.sns", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", resolveFrom("bonfida.json"));
  assert.equal(moved?.state, "moved");
  assert.equal(moved?.state === "moved" && moved.wallet, BONFIDA);
  const gone = await checkSnsForPage("owed-sns-fixture-unregistered-7f3a.sns", BONFIDA, resolveFrom("unregistered.json"));
  assert.equal(gone?.state, "moved");
  const unchecked = await checkSnsForPage("bonfida.sns", BONFIDA, async () => ({ ok: false, name: "bonfida.sns", code: "unavailable", message: "x" }));
  assert.equal(unchecked?.state, "unchecked");
  assert.equal(await checkSnsForPage("bоnfida.sns", BONFIDA), null); // a stored lookalike is never shown
});
