import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseJsonExact } from "@/lib/solana";
import { findPayments, type PaymentQuery } from "@/lib/validate";

// Real mainnet RPC recordings captured by W1-B (plugin/test/fixtures/chain, copied as is,
// publicnode, 2026-10-17), replayed by a local JSON-RPC server. The same cases pin the
// plugin's direct-RPC check, so the API and the plugin's offline fallback agree.

interface RecordedCall {
  method: string;
  params: unknown[];
  result: unknown;
}
const fixture = (name: string) =>
  parseJsonExact(readFileSync(new URL(`fixtures/chain/${name}.json`, import.meta.url), "utf8")) as {
    query: { reference?: string; signature?: string };
    calls: RecordedCall[];
  };

const SOL_PAY = fixture("sol-reference-payment");
const USDC_KEY = fixture("usdc-appended-key-transfers");
const FAILED = fixture("failed-usdc-transfer");
const UNUSED = fixture("unused-reference");

const SOL_REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const SOL_SIG = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";
const SOL_PAYER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"; // off-curve program wallet
const USDC_REF = "Ef4piUis5ttTWrkJDeU4hNPDN4MZh4KmonkDHSwgnnTg";
const OLDEST = "2zsb1Wk1RP7npYZf9sPFUkPDuF4wGMaFVivDbxVDpaCgfkB4nfY19iuu4cHJjdw5MDcodBu8APEJHhsNbuRDpuMK";
const MIDDLE = "3ZdwwA4rYiiXodsuZ7374PEahd9iXeiq1VSvVXz17acEcpv1XhV45hu2gPZCXgun4gbm3Sh7vS72NS59rzTsmD2a";
// Fee payer of these transactions is a relayer; the USDC moved belongs to another wallet.
// W1-B's chain.ts reports the fee payer; the API reports the owner of the moved tokens.
const OLDEST_OWNER = "iksxPfWrHBzj7iZfD3Up3ft5Mz5DSGwm328v2349Zcc";
const GAQ = "GAqbB5TDD6G6KSZwtuTMicuKiyZH9XwkanBkdDs2FLie"; // credited 387 (oldest), 141101 (middle), 155588 (newest)
const V83 = "83v8iPyZihDEjDdY8RdZddyZNyUtXngz69Lgo9Kt5d6d"; // credited 2719385 (middle)
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";

// --- replay server -----------------------------------------------------------------
let recorded: RecordedCall[] = [];
let log: string[] = [];
const keyOf = (method: string, params: unknown[]) => `${method} ${String(params[0])}`;
const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(x.toString()) : x));

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const answer = (m: { id: number; method: string; params: unknown[] }) => {
      log.push(keyOf(m.method, m.params).slice(0, m.method.length + 9));
      const hit = recorded.find((c) => keyOf(c.method, c.params) === keyOf(m.method, m.params));
      return hit
        ? { jsonrpc: "2.0", id: m.id, result: hit.result }
        : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `unrecorded call ${keyOf(m.method, m.params)}` } };
    };
    res.end(toJson(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const rpc = { urls: [`http://127.0.0.1:${(server.address() as AddressInfo).port}`] };
after(() => server.close());
beforeEach(() => {
  log = [];
});

const check = async (calls: RecordedCall[], q: PaymentQuery) => {
  recorded = calls;
  return (await findPayments([q], rpc))[0];
};
const sigsCall = (f: { calls: RecordedCall[] }) => f.calls.find((c) => c.method === "getSignaturesForAddress")!;

// --- cases ---------------------------------------------------------------------------
test("SOL (v1 transaction): the exact amount is paid, with payer, signature and time", async () => {
  const r = await check(SOL_PAY.calls, { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 3_027_000n });
  assert.equal(r.status, "paid");
  assert.equal(r.payment?.signature, SOL_SIG);
  assert.equal(r.payment?.payer, SOL_PAYER);
  assert.equal(r.payment?.amountAtomic, 3_027_000n);
  assert.match(r.payment!.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test("a link without an amount: any credit is paid", async () => {
  const r = await check(SOL_PAY.calls, { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: null });
  assert.equal(r.status, "paid");
  assert.equal(r.payment?.amountAtomic, 3_027_000n);
});

test("one lamport short is underpaid and reports what arrived", async () => {
  const r = await check(SOL_PAY.calls, { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 3_027_001n });
  assert.equal(r.status, "underpaid");
  assert.equal(r.payment?.amountAtomic, 3_027_000n);
  assert.equal(r.payment?.signature, SOL_SIG);
});

test("the reference on a transfer to someone else is ignored", async () => {
  assert.deepEqual(await check(SOL_PAY.calls, { reference: SOL_REF, recipient: SOL_PAYER, token: "SOL", amountAtomic: 1n }), { status: "open" });
});

test("a SOL transfer does not satisfy a USDC request", async () => {
  assert.deepEqual(await check(SOL_PAY.calls, { reference: SOL_REF, recipient: SOL_PAYEE, token: "USDC", amountAtomic: 1n }), { status: "open" });
});

test("USDC with the reference appended to transferChecked: oldest full payment wins", async () => {
  const r = await check(USDC_KEY.calls, { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 387n });
  assert.equal(r.status, "paid");
  assert.equal(r.payment?.signature, OLDEST);
  assert.equal(r.payment?.amountAtomic, 387n);
  assert.equal(r.payment?.payer, OLDEST_OWNER);
});

test("USDC: an earlier underpayment does not hide a later full payment", async () => {
  const r = await check(USDC_KEY.calls, { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 141_101n });
  assert.equal(r.status, "paid");
  assert.equal(r.payment?.signature, MIDDLE);
  assert.equal(r.payment?.amountAtomic, 141_101n);
});

test("USDC: no single transaction covers the amount -> underpaid, oldest partial reported", async () => {
  const r = await check(USDC_KEY.calls, { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 200_000n });
  assert.equal(r.status, "underpaid");
  assert.equal(r.payment?.signature, OLDEST);
  assert.equal(r.payment?.amountAtomic, 387n);
});

test("USDC: another owner credited in the same transactions, into a non-associated account", async () => {
  const r = await check(USDC_KEY.calls, { reference: USDC_REF, recipient: V83, token: "USDC", amountAtomic: 2_719_385n });
  assert.equal(r.status, "paid");
  assert.equal(r.payment?.signature, MIDDLE);
});

test("USDC: references on transfers that never credit the recipient leave the request open", async () => {
  assert.deepEqual(await check(USDC_KEY.calls, { reference: USDC_REF, recipient: TEAM, token: "USDC", amountAtomic: 1n }), { status: "open" });
  assert.equal(log.length, 11); // the signature list plus all ten transactions
});

test("an unused reference is open after one call", async () => {
  assert.deepEqual(
    await check(UNUSED.calls, { reference: UNUSED.query.reference!, recipient: TEAM, token: "USDC", amountAtomic: 1n }),
    { status: "open" },
  );
  assert.equal(log.length, 1);
});

test("signatures already settling another request are not fetched or counted", async () => {
  const r = await check(SOL_PAY.calls, {
    reference: SOL_REF,
    recipient: SOL_PAYEE,
    token: "SOL",
    amountAtomic: 1n,
    excludeSignatures: new Set([SOL_SIG]),
  });
  assert.deepEqual(r, { status: "open" });
  assert.equal(log.length, 1);
});

test("signatures the list marks as failed are never fetched", async () => {
  const list = structuredClone(sigsCall(SOL_PAY));
  (list.result as { err: unknown }[])[0].err = { InstructionError: [0, "Custom"] };
  assert.deepEqual(await check([list], { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n }), { status: "open" });
  assert.equal(log.length, 1);
});

test("a fetched transaction with meta.err (real failed USDC transfer) is skipped", async () => {
  const failedSig = FAILED.query.signature!;
  const list: RecordedCall = { ...sigsCall(SOL_PAY), result: [{ signature: failedSig, err: null }] };
  const r = await check([list, FAILED.calls[0]], { reference: SOL_REF, recipient: SOL_PAYER, token: "USDC", amountAtomic: 1n });
  assert.deepEqual(r, { status: "open" });
});

test("a transaction the node cannot return yet (null) is skipped", async () => {
  const nullTx: RecordedCall = { ...SOL_PAY.calls.find((c) => c.method === "getTransaction")!, result: null };
  assert.deepEqual(await check([sigsCall(SOL_PAY), nullTx], { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n }), {
    status: "open",
  });
});

test("many requests: one signature batch, transactions fetched once each", async () => {
  recorded = [...SOL_PAY.calls, ...USDC_KEY.calls, ...UNUSED.calls];
  const results = await findPayments(
    [
      { reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 3_027_000n },
      { reference: USDC_REF, recipient: GAQ, token: "USDC", amountAtomic: 141_101n },
      { reference: USDC_REF, recipient: V83, token: "USDC", amountAtomic: 2_719_385n },
      { reference: UNUSED.query.reference!, recipient: TEAM, token: "USDC", amountAtomic: 1n },
    ],
    rpc,
  );
  assert.deepEqual(
    results.map((r) => r.status),
    ["paid", "paid", "paid", "open"],
  );
  // 4 signature lookups in one batch + 11 distinct transactions, the shared ones fetched once.
  assert.equal(log.filter((l) => l.startsWith("getSignaturesForAddress")).length, 4);
  assert.equal(log.filter((l) => l.startsWith("getTransaction")).length, 11);
});

test("an RPC error on any call fails the check instead of reporting open", async () => {
  recorded = [sigsCall(SOL_PAY)]; // the transaction itself is unrecorded -> RPC error
  await assert.rejects(findPayments([{ reference: SOL_REF, recipient: SOL_PAYEE, token: "SOL", amountAtomic: 1n }], rpc), /RPC unavailable/);
});
