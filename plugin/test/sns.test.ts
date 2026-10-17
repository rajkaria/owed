import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decide, looksLikeSnsName, NAME_PROGRAM_ID, parseSnsName, pointsTo, rawAccount, resolveSnsName, snsKeys, type SnsRpc,
} from "../src/sns.ts";

// W3-S. Real mainnet accounts (test/fixtures/sns, captured by capture-sns.mjs) replayed through the resolver;
// each fixture also records what SNS's own SDK returns for the name, and Owed must agree with it except where
// it is stricter on purpose. web/test/sns.test.ts replays the same files through web/lib/sns.ts.

interface SnsFixture {
  input: string;
  note: string;
  sdk: { wallet?: string; error?: string; rule?: string };
  owed?: string;
  result: Record<string, unknown>;
  calls: Array<{ method: string; params: unknown[]; result: unknown }>;
}

const dir = fileURLToPath(new URL("./fixtures/sns/", import.meta.url));
const fixtures = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as SnsFixture) }));
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/sns-vectors.json", import.meta.url)), "utf8")) as {
  valid: Array<{ input: string; name: string; labels: string[]; warnings: string[] }>;
  invalid: Array<{ input: string; code: string }>;
  sol_message: string;
};

/** An RPC that answers exactly the recorded calls and fails the test on any other. */
function replay(f: Pick<SnsFixture, "calls">, edit?: (result: any) => unknown): { rpc: SnsRpc; asked: string[] } {
  const asked: string[] = [];
  const rpc: SnsRpc = async (method, params) => {
    const k = JSON.stringify({ method, params });
    asked.push(k);
    const hit = f.calls.find((c) => JSON.stringify({ method: c.method, params: c.params }) === k);
    if (!hit) throw new Error(`unrecorded RPC call ${k}`);
    const copy = structuredClone(hit.result);
    return edit ? edit(copy) : copy;
  };
  return { rpc, asked };
}

test("fixtures: every captured mainnet name resolves exactly as recorded, in one getMultipleAccounts call", async () => {
  assert.ok(fixtures.length >= 19);
  for (const f of fixtures) {
    const { rpc, asked } = replay(f);
    assert.deepEqual(await resolveSnsName(f.input, rpc), f.result, f.file);
    assert.equal(asked.length, 1, f.file);
  }
});

test("fixtures: Owed agrees with SNS's own SDK, except where it is stricter on purpose", async () => {
  for (const f of fixtures) {
    const r = await resolveSnsName(f.input, replay(f).rpc);
    if (f.owed) {
      assert.equal(r.ok, false, f.file);
      assert.equal(!r.ok && r.code, f.owed, f.file);
    } else if (f.sdk.wallet) {
      assert.equal(r.ok && r.wallet, f.sdk.wallet, f.file);
    } else if (f.sdk.error) {
      assert.equal(r.ok, false, f.file);
    }
  }
  // Every SNS-IP 5 rule is covered.
  const sources = new Set(fixtures.map((f) => (f.result.ok ? f.result.source : f.result.code)));
  for (const s of ["sol_record_v2", "sol_record_v1", "owner", "tokenized", "bad_record", "no_wallet", "not_found"]) assert.ok(sources.has(s), s);
});

test("bonfida.sns: the owner, with the sentence the tools show", async () => {
  const f = fixtures.find((x) => x.file === "bonfida.json")!;
  const r = await resolveSnsName("Bonfida.SNS", replay(f).rpc);
  assert.ok(r.ok);
  assert.equal(r.name, "bonfida.sns");
  assert.equal(pointsTo(r.name, r.wallet, r.source), "bonfida.sns points to Fw1E…Lb1v (its owner)");
});

test("names: normalized, NFC, lower-case; lookalikes, mixed scripts, invisible characters and .sol refused", () => {
  for (const v of vectors.valid) {
    const r = parseSnsName(v.input);
    assert.ok(r.ok, v.input);
    assert.equal(r.name, v.name, v.input);
    assert.deepEqual(r.labels, v.labels, v.input);
    assert.deepEqual(r.warnings, v.warnings, v.input);
  }
  for (const v of vectors.invalid) {
    const r = parseSnsName(v.input);
    assert.equal(r.ok, false, JSON.stringify(v.input));
    assert.equal(!r.ok && r.code, v.code, JSON.stringify(v.input));
    // Refusals never echo a non-ASCII character back (it could be the lookalike itself).
    assert.ok(!r.ok && /^[\x20-\x7e]*$/.test(r.message), JSON.stringify(v.input));
  }
  const sol = parseSnsName("raj.sol");
  assert.equal(!sol.ok && sol.message, vectors.sol_message);
});

test(".sol and invalid names never reach the RPC", async () => {
  for (const input of ["raj.sol", "bоnfida.sns", "bonfida"]) {
    const r = await resolveSnsName(input, async () => { throw new Error("no RPC expected"); });
    assert.equal(r.ok, false);
    assert.equal(r.name, null);
  }
});

test("looksLikeSnsName: names, not addresses, ids or links", () => {
  for (const s of ["bonfida.sns", "raj.sol", "Sub.Name.SNS."]) assert.ok(looksLikeSnsName(s), s);
  for (const s of ["FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", "AbCdEf123456", "https://getowed.xyz/r/abc.sns", "solana:x.sns?amount=1", ".sns.com"]) {
    assert.ok(!looksLikeSnsName(s), s);
  }
});

test("RPC failure, off-shape or short answers: unavailable, never a wallet", async () => {
  const f = fixtures.find((x) => x.file === "bonfida.json")!;
  const cases: Array<SnsRpc> = [
    async () => { throw new Error("timeout"); },
    async () => null,
    async () => ({ value: [] }),
    replay(f, (res) => ({ ...res, value: res.value.slice(0, 3) })).rpc,
  ];
  for (const rpc of cases) {
    const r = await resolveSnsName("bonfida.sns", rpc);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "unavailable");
  }
});

/** The four raw accounts of a fixture, for byte-level tampering. */
function accountsOf(file: string) {
  const f = fixtures.find((x) => x.file === file)!;
  const [nftRecord, v1, v2, domain] = (f.calls[0]!.result as { value: unknown[] }).value.map(rawAccount);
  const parsed = parseSnsName(f.input);
  assert.ok(parsed.ok);
  return { name: parsed.name, keys: snsKeys(parsed.labels), accounts: { nftRecord: nftRecord!, v1: v1!, v2: v2!, domain: domain! } };
}

test("tampered records are refused, never paid", () => {
  const { name, keys, accounts } = accountsOf("ip5-record-v2.json");
  assert.equal((decide(name, keys, accounts) as { wallet: string }).wallet, "AxwzQXhZNJb9zLyiHUQA12L2GL7CxvUNrp6neee6r3cA");

  // The record's wallet changed without a new right-of-association signature.
  const swapped = Buffer.from(accounts.v2!.data);
  swapped[swapped.length - 1] ^= 1;
  const r1 = decide(name, keys, { ...accounts, v2: { ...accounts.v2!, data: swapped } });
  assert.equal(!r1.ok && r1.code, "bad_record");

  // Truncated content.
  const r2 = decide(name, keys, { ...accounts, v2: { ...accounts.v2!, data: accounts.v2!.data.subarray(0, accounts.v2!.data.length - 1) } });
  assert.equal(!r2.ok && r2.code, "bad_record");

  // A record account not owned by the name program.
  const r3 = decide(name, keys, { ...accounts, v2: { ...accounts.v2!, owner: "11111111111111111111111111111111" } });
  assert.equal(!r3.ok && r3.code, "bad_record");

  // A name account not owned by the name program.
  const r4 = decide(name, keys, { ...accounts, domain: { ...accounts.domain!, owner: "11111111111111111111111111111111" } });
  assert.equal(!r4.ok && r4.code, "bad_record");
  assert.equal(accounts.domain!.owner, NAME_PROGRAM_ID);
});

test("a v1 record whose signature doesn't verify falls back to the owner; a valid one is used", () => {
  const good = accountsOf("ip5-record-v1.json");
  const r = decide(good.name, good.keys, good.accounts);
  assert.ok(r.ok);
  assert.equal(r.source, "sol_record_v1");
  const forged = Buffer.from(good.accounts.v1!.data);
  forged[96] ^= 1; // the wallet, so the owner's signature no longer covers it
  const f = decide(good.name, good.keys, { ...good.accounts, v1: { ...good.accounts.v1!, data: forged } });
  assert.ok(f.ok);
  assert.equal(f.source, "owner");
});

test("an inactive NFT record (tag 3) is ignored; an active one (tag 2) is refused", () => {
  const { name, keys, accounts } = accountsOf("bonfida.json");
  assert.equal(accounts.nftRecord!.data[0], 3);
  assert.ok(decide(name, keys, accounts).ok);
  const active = Buffer.from(accounts.nftRecord!.data);
  active[0] = 2;
  const r = decide(name, keys, { ...accounts, nftRecord: { ...accounts.nftRecord!, data: active } });
  assert.equal(!r.ok && r.code, "tokenized");
});

test("subdomains derive under their parent with a \\0 prefix (SNS's own vectors)", async () => {
  const keys = snsKeys(["sub-1", "wallet-guide-3"]);
  const f = fixtures.find((x) => x.file === "guide-subdomain-1.json")!;
  assert.deepEqual((f.calls[0]!.params[0] as string[])[3], keys.domain);
  const r = await resolveSnsName("sub-1.wallet-guide-3.sns", replay(f).rpc);
  assert.ok(r.ok);
  assert.equal(r.wallet, "Hf4daCT4tC2Vy9RCe9q8avT68yAsNJ1dQe6xiQqyGuqZ");
  assert.match(r.warnings[0]!, /subdomain of wallet-guide-3\.sns/);
});
