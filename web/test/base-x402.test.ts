import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toChecksumAddress } from "@/lib/evm/address";
import { BASE_USDC } from "@/lib/evm/base";
import { baseMismatch, checkBaseSettlement, decodeBasePayment, type BaseSettlementCheck } from "@/lib/evm/x402";
import { requestIdFor } from "@/lib/ids";
import { parseJsonExact } from "@/lib/solana";
import type { RequestRow } from "@/lib/requests";
import { FacilitatorError, parseSupported, type Facilitator, type Supported } from "@/lib/x402/facilitator";
import { handleX402, type X402Deps } from "@/lib/x402/handler";
import type { Store } from "@/lib/x402/store";
import { replay, settlement } from "./evm-helpers.ts";

// W3-B: x402 on Base through /x/<id>. The request's terms are those of a real PayAI settlement on
// Base (test/fixtures/evm/x402-settlement.json: 1 USDC transferWithAuthorization to 0xA21f…3eE9),
// so the chain check runs against its real receipt. PayAI's real /supported lists exact on eip155:8453.

const supportedJson = parseJsonExact(readFileSync(new URL("fixtures/x402/supported.json", import.meta.url), "utf8"));
const transfer = settlement.transfers[0]!;
const RECIPIENT = toChecksumAddress(transfer.to);
const PAYER = toChecksumAddress(transfer.from);
const AMOUNT = BigInt(transfer.value); // 1 USDC
const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
const ID = requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: AMOUNT, reference: REFERENCE, chain: "base" });
const BASE = "https://owed.example";
const NOW = Date.parse("2026-10-17T15:00:00Z");
const nowS = Math.floor(NOW / 1000);

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: ID, kind: "single", recipient: RECIPIENT, token: "USDC", mint: BASE_USDC, decimals: 6, amountAtomic: AMOUNT, reference: REFERENCE,
    payerName: null, forText: null, note: null, requesterName: null, flags: [], status: "open", paidSignature: null, paidPayer: null,
    paidAmountAtomic: null, paidAt: null, paidRail: null, source: "web", createdAt: "2026-10-17T14:00:00Z", chain: "base", chainCursor: null, ...over,
  };
}

const auth = (over: Record<string, string> = {}) => ({
  from: PAYER, to: RECIPIENT, value: AMOUNT.toString(), validAfter: String(nowS - 600), validBefore: String(nowS + 300),
  nonce: `0x${"ab".repeat(32)}`, ...over,
});
const SIGNATURE = `0x${"11".repeat(65)}`;
const accepted = (over: Record<string, unknown> = {}) => ({
  scheme: "exact", network: "eip155:8453", amount: AMOUNT.toString(), asset: BASE_USDC, payTo: RECIPIENT, maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" }, ...over,
});
const v2Header = (a = auth(), acc = accepted()) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: acc, payload: { signature: SIGNATURE, authorization: a } })).toString("base64");
const v1Header = (a = auth(), network = "base") => Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network, payload: { signature: SIGNATURE, authorization: a } })).toString("base64");
const fromB64 = (v: string | null) => JSON.parse(Buffer.from(v!, "base64").toString("utf8"));

interface World {
  deps: X402Deps & { waitForBaseSettlement: (h: string, t: unknown, p: string, d: number) => Promise<BaseSettlementCheck> };
  log: string[];
  rows: Map<string, RequestRow>;
  receipts: Array<{ state: string; signature?: string; payer?: string | null }>;
  supported: Supported;
  verifyAnswer: { isValid: boolean; invalidReason?: string };
  settleTx: string;
}

function world(start: RequestRow = row()): World {
  const w = {
    log: [] as string[], rows: new Map([[start.id, start]]), receipts: [] as World["receipts"],
    supported: parseSupported(supportedJson), verifyAnswer: { isValid: true }, settleTx: settlement.hash,
  } as World;
  const facilitator: Facilitator = {
    url: "https://facilitator.example",
    supported: async () => { w.log.push("supported"); return w.supported; },
    verify: async (version, _payload, requirements) => { w.log.push(`verify v${version} ${JSON.stringify(requirements)}`); return w.verifyAnswer; },
    settle: async (version) => { w.log.push(`settle v${version}`); return { success: true, transaction: w.settleTx, network: "eip155:8453", payer: PAYER }; },
  };
  const store: Store = {
    begin: async (input) => { w.log.push(`begin ${input.network} payer=${input.payer}`); w.receipts.push({ state: "settling", payer: input.payer }); return { ok: true, receiptId: String(w.receipts.length) }; },
    fail: async (id, state) => { w.log.push(`fail ${state}`); w.receipts[Number(id) - 1]!.state = state; },
    settled: async (id, signature, payer) => { w.log.push("settled"); Object.assign(w.receipts[Number(id) - 1]!, { state: "settled", signature, payer }); },
    verified: async (receipt, credit) => {
      w.log.push("verified");
      w.receipts[Number(receipt.id) - 1]!.state = "verified";
      const r = w.rows.get(receipt.requestId)!;
      w.rows.set(r.id, { ...r, status: "paid", paidSignature: credit.signature, paidPayer: credit.payer, paidAmountAtomic: credit.amountAtomic, paidAt: credit.at, paidRail: "x402" });
      return true;
    },
    pending: async () => [],
  };
  w.deps = {
    load: async (id) => w.rows.get(id) ?? null,
    refresh: async (r) => { w.log.push("refresh"); return w.rows.get(r.id) ?? r; },
    facilitator, store,
    waitForSettlement: async () => { throw new Error("the Solana chain check must not run for a Base request"); },
    // The real receipt check, replaying the real settlement's receipt.
    waitForBaseSettlement: (h, t, p) => checkBaseSettlement(h, t as never, p, replay(settlement.exchanges)),
    now: () => NOW,
  };
  return w;
}
const req = (headers: Record<string, string> = {}) => new Request(`${BASE}/x/${ID}`, { headers });
const moneyCalls = (w: World) => w.log.filter((l) => l.startsWith("verify") || l.startsWith("settle"));

test("PayAI's real /supported settles exact on Base in both generations", () => {
  assert.deepEqual(parseSupported(supportedJson).base, { v1: true, v2: true });
});

test("Base /x: unpaid GET -> 402 asking for exact USDC on eip155:8453 (v2 header) and base (v1 body)", async () => {
  const w = world();
  const res = await handleX402(req(), ID, BASE, w.deps);
  assert.equal(res.status, 402);
  const v2 = fromB64(res.headers.get("payment-required"));
  assert.deepEqual(v2.accepts, [{ scheme: "exact", network: "eip155:8453", amount: "1000000", asset: BASE_USDC, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }]);
  assert.match(v2.resource.description, /1 USDC on Base to 0xA21f/);
  const body = await res.json();
  assert.equal(body.accepts[0].network, "base");
  assert.equal(body.accepts[0].maxAmountRequired, "1000000");
  assert.equal(body.accepts[0].resource, `${BASE}/x/${ID}`);
  assert.deepEqual(moneyCalls(w), []);
});

test("Base /x: honest v2 payment -> verify with our requirements -> lock -> settle -> real receipt -> 200 paid over x402", async () => {
  const w = world();
  const res = await handleX402(req({ "payment-signature": v2Header() }), ID, BASE, w.deps);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual([body.paid, body.status, body.chain, body.rail, body.signature, body.payer], [true, "paid", "base", "x402", settlement.hash, PAYER]);
  assert.equal(body.explorer_url, `https://basescan.org/tx/${settlement.hash}`);
  assert.equal(w.log[0], "refresh");
  assert.match(w.log.find((l) => l.startsWith("verify"))!, /"network":"eip155:8453".*"payTo":"0xA21f/);
  assert.deepEqual(w.log.filter((l) => !l.startsWith("verify")), ["refresh", "supported", `begin eip155:8453 payer=${PAYER}`, "settle v2", "settled", "verified"]);
  assert.equal(w.rows.get(ID)!.paidRail, "x402");
  assert.equal(fromB64(res.headers.get("payment-response")).transaction, settlement.hash);
  // v1 X-PAYMENT goes through the v1 requirements.
  const w1 = world();
  const r1 = await handleX402(req({ "x-payment": v1Header() }), ID, BASE, w1.deps);
  assert.equal(r1.status, 200);
  assert.match(w1.log.find((l) => l.startsWith("verify"))!, /^verify v1 .*"network":"base"/);
});

test("Base /x: tampered or stale payments get a 402 before any facilitator money call", async () => {
  const bad: Array<[string, string]> = [
    ["pays another address", v2Header(auth({ to: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" }))],
    ["another amount", v2Header(auth({ value: "999999" }))],
    ["accepted another payTo", v2Header(auth(), accepted({ payTo: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" }))],
    ["accepted another network", v2Header(auth(), accepted({ network: "eip155:1" }))],
    ["accepted another asset", v2Header(auth(), accepted({ asset: "0x4200000000000000000000000000000000000006" }))],
    ["expired", v2Header(auth({ validBefore: String(nowS + 3) }))],
    ["not yet valid", v2Header(auth({ validAfter: String(nowS + 60) }))],
    ["self-payment", v2Header(auth({ from: RECIPIENT }))],
    ["v1 on another network", v1Header(auth(), "ethereum")],
    ["a Solana payment", Buffer.from(JSON.stringify({ x402Version: 2, accepted: accepted(), payload: { transaction: "AAAA" } })).toString("base64")],
    ["not base64 JSON", "!!!"],
  ];
  for (const [what, header] of bad) {
    const w = world();
    const res = await handleX402(req({ "payment-signature": header }), ID, BASE, w.deps);
    assert.equal(res.status, 402, what);
    assert.deepEqual(moneyCalls(w), [], what);
    assert.ok(fromB64(res.headers.get("payment-required")).error.length > 0, what);
  }
});

test("Base /x: a settlement Base doesn't show paying this request -> 502, request stays open", async () => {
  // Same real receipt, but this request asks for 2 USDC: the transfer in the receipt doesn't pay it.
  const two = row({ amountAtomic: 2_000_000n, id: requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 2_000_000n, reference: REFERENCE, chain: "base" }) });
  const w = world(two);
  const a = auth({ value: "2000000" });
  const res = await handleX402(new Request(`${BASE}/x/${two.id}`, { headers: { "payment-signature": v2Header(a, accepted({ amount: "2000000" })) } }), two.id, BASE, w.deps);
  assert.equal(res.status, 502);
  assert.equal(w.rows.get(two.id)!.status, "open");
  assert.equal(w.receipts[0]!.state, "mismatch");
});

test("Base /x: refusals for a facilitator without Base, facilitator down, a paid request, and a row whose terms don't hash", async () => {
  const noBase = world();
  noBase.supported = { ...noBase.supported, base: { v1: false, v2: false } };
  const r1 = await handleX402(req(), ID, BASE, noBase.deps);
  assert.equal(r1.status, 503);
  assert.match((await r1.json()).error.message, /doesn't settle Base payments right now; pay from a Base wallet at https:\/\/owed\.example\/r\//);

  const down = world();
  down.deps.facilitator = { ...down.deps.facilitator, supported: async () => { throw new FacilitatorError("facilitator /supported timed out"); } };
  assert.equal((await handleX402(req(), ID, BASE, down.deps)).status, 503);

  const paid = world(row({ status: "paid", paidSignature: settlement.hash, paidPayer: PAYER, paidAmountAtomic: AMOUNT, paidAt: "2026-10-17T14:05:00Z", paidRail: "base_transfer" }));
  const r3 = await handleX402(req({ "payment-signature": v2Header() }), ID, BASE, paid.deps);
  const b3 = await r3.json();
  assert.deepEqual([r3.status, b3.rail, b3.explorer_url], [200, "base_transfer", `https://basescan.org/tx/${settlement.hash}`]);
  assert.deepEqual(moneyCalls(paid), []);

  const forged = world(row({ amountAtomic: AMOUNT + 1n }));
  assert.equal((await handleX402(req(), ID, BASE, forged.deps)).status, 503);
});

test("decodeBasePayment and baseMismatch on their own", () => {
  const p = decodeBasePayment(v2Header());
  assert.ok(typeof p !== "string");
  assert.equal(baseMismatch(p, { id: ID, recipient: RECIPIENT, amountAtomic: AMOUNT }, nowS), null);
  assert.equal(baseMismatch(p, { id: ID, recipient: RECIPIENT.toLowerCase(), amountAtomic: AMOUNT }, nowS), null, "addresses compare case-insensitively");
  assert.match(String(decodeBasePayment(Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload: { signature: "0x12", authorization: auth() } })).toString("base64"))), /signature/);
  assert.match(String(decodeBasePayment(Buffer.from(JSON.stringify({ x402Version: 3, payload: { signature: SIGNATURE, authorization: auth() } })).toString("base64"))), /unsupported x402Version 3/);
});
