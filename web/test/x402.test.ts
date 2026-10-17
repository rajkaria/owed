import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requestIdFor } from "@/lib/ids";
import type { RequestRow } from "@/lib/requests";
import { parseJsonExact } from "@/lib/solana";
import type { Credit, ParsedTransaction } from "@/lib/validate";
import { checkSettlement, waitForSettlement, type SettlementCheck } from "@/lib/x402/chain";
import { clearSupportedCache, FacilitatorError, makeFacilitator, parseSupported, type Facilitator, type Supported } from "@/lib/x402/facilitator";
import { handleX402, type X402Deps } from "@/lib/x402/handler";
import { settlePendingX402 } from "@/lib/x402/settle";
import type { Receipt, Store } from "@/lib/x402/store";
import { inspectTransaction, recipientUsdcAccount, transactionMismatch } from "@/lib/x402/svm";
import { x402UrlFor } from "@/lib/x402/url";
import { decodePayment, mismatch, NETWORK_V1, NETWORK_V2, paymentRequired, USDC_MINT, type Terms } from "@/lib/x402/wire";

// Fixtures (test/fixtures/x402/): payments.json holds x402 payments built by the official
// @x402/svm client from an empty throwaway key for preview request 4tHguZSCqHmE, and that
// request's live 402. supported.json is PayAI's GET /supported. settled-tx.json is a real
// mainnet USDC settlement PayAI's fee payer co-signed. Re-capture with capture.mjs.
interface PaymentsFixture {
  request: { id: string; recipient: string; amountAtomic: string; reference: string };
  payer: string;
  challenge: { status: number; paymentRequired: string; body: unknown };
  headers: Record<"honestV2" | "tamperedAcceptedAmount" | "tamperedTxAmount" | "honestV1", string>;
}
const fx = <T>(name: string) => parseJsonExact(readFileSync(new URL(`fixtures/x402/${name}`, import.meta.url), "utf8")) as T;
const payments = fx<PaymentsFixture>("payments.json");
const supportedJson = fx<{ kinds: Array<{ network: string }> }>("supported.json");
const settled = fx<{ signature: string; recipient: string; amountAtomic: string; payer: string; feePayer: string; tx: ParsedTransaction }>("settled-tx.json");

const RECIPIENT = payments.request.recipient;
const REFERENCE = payments.request.reference;
const ID = payments.request.id;
const FEE_PAYER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BASE = "https://owed.example";
const TERMS: Terms = { id: ID, recipient: RECIPIENT, amountAtomic: 10_000n };
const SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";

const txOf = (header: string) => JSON.parse(Buffer.from(header, "base64").toString()).payload.transaction as string;
const fromB64 = (v: string | null) => JSON.parse(Buffer.from(v!, "base64").toString());

function row(over: Partial<RequestRow> = {}): RequestRow {
  return {
    id: ID, kind: "single", recipient: RECIPIENT, token: "USDC", mint: USDC_MINT, decimals: 6, amountAtomic: 10_000n, reference: REFERENCE,
    payerName: null, forText: "x402 rail check", note: null, requesterName: "Owed x402 check", flags: [], status: "open",
    paidSignature: null, paidPayer: null, paidAmountAtomic: null, paidAt: null, paidRail: null, source: "web", createdAt: "2026-10-17T07:26:32Z",
    ...over,
  };
}

test("fixture request id is the hash of its terms", () => {
  assert.equal(requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 10_000n, reference: REFERENCE }), ID);
});

// ---- wire ----

test("402 challenge: v2 header and v1 body pay exactly the request, with the facilitator's fee payer", () => {
  const c = paymentRequired(TERMS, `${BASE}/x/${ID}`, { v1: FEE_PAYER, v2: FEE_PAYER }, "required");
  const v2 = fromB64(c.header);
  assert.deepEqual(v2.accepts, [{ scheme: "exact", network: NETWORK_V2, amount: "10000", asset: USDC_MINT, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } }]);
  assert.equal(v2.x402Version, 2);
  assert.equal(v2.resource.url, `${BASE}/x/${ID}`);
  assert.equal(c.v1.accepts[0].network, NETWORK_V1);
  assert.equal(c.v1.accepts[0].maxAmountRequired, "10000");
  assert.equal("outputSchema" in c.v1.accepts[0], false);
  // Only the terms reach x402 clients; requester-written text never does.
  assert.equal(c.v1.accepts[0].description, `Owed request ${ID}: 0.01 USDC to ${RECIPIENT}`);
});

test("the live preview challenge is exactly what paymentRequired builds", () => {
  const live = payments.challenge;
  assert.equal(live.status, 402);
  const url = fromB64(live.paymentRequired).resource.url as string;
  const c = paymentRequired(TERMS, url, { v1: FEE_PAYER, v2: FEE_PAYER }, "PAYMENT-SIGNATURE or X-PAYMENT header is required");
  assert.deepEqual(fromB64(live.paymentRequired), c.v2);
  assert.deepEqual(live.body, c.v1);
});

test("decodePayment reads both generations and names what's wrong otherwise", () => {
  const v2 = decodePayment(payments.headers.honestV2);
  assert.ok(typeof v2 !== "string" && v2.version === 2);
  const v1 = decodePayment(payments.headers.honestV1);
  assert.ok(typeof v1 !== "string" && v1.version === 1);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  assert.equal(decodePayment("not base64!"), "payment header is not base64 JSON");
  assert.equal(decodePayment(enc([1])), "payment header is not an x402 payment");
  assert.equal(decodePayment(enc({ x402Version: 3 })), "unsupported x402Version 3");
  assert.equal(decodePayment(enc({ x402Version: 2, payload: { transaction: "AAAA" } })), "v2 payment is missing `accepted`");
  assert.equal(decodePayment(enc({ x402Version: 1, scheme: "exact", network: "solana", payload: {} })), "payment has no Solana transaction");
  assert.equal(decodePayment("A".repeat(16 * 1024 + 1)), "payment header is too large");
});

test("mismatch: every claimed term must equal the request's, case-sensitively", () => {
  const p = decodePayment(payments.headers.honestV2);
  assert.ok(typeof p !== "string");
  assert.equal(mismatch(p, TERMS), null);
  assert.equal(mismatch(decodePayment(payments.headers.tamperedAcceptedAmount) as never, TERMS), "accepted.amount does not match this request");
  for (const [field, value] of [["payTo", RECIPIENT.toLowerCase()], ["payTo", OTHER], ["asset", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"], ["network", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"], ["scheme", "upto"]]) {
    const tampered = { ...p, payload: { ...p.payload, accepted: { ...(p.payload as { accepted: object }).accepted, [field]: value } } } as typeof p;
    assert.equal(mismatch(tampered, TERMS), `accepted.${field} does not match this request`, field);
  }
  const v1 = decodePayment(payments.headers.honestV1);
  assert.ok(typeof v1 !== "string");
  assert.equal(mismatch(v1, TERMS), null);
  assert.equal(mismatch({ ...v1, payload: { ...v1.payload, network: "solana-devnet" } } as typeof v1, TERMS), "v1 payment network does not match this request");
});

// ---- svm ----

test("inspectTransaction reads the official client's transaction: fee payer, transferChecked to the recipient's ATA", () => {
  const tx = inspectTransaction(txOf(payments.headers.honestV2));
  assert.ok(typeof tx !== "string");
  assert.equal(tx.feePayer, FEE_PAYER);
  assert.equal(tx.transferCount, 1);
  assert.deepEqual(tx.transfer, { mint: USDC_MINT, destination: recipientUsdcAccount(RECIPIENT), authority: payments.payer, amountAtomic: 10_000n, decimals: 6 });
  assert.equal(transactionMismatch(tx, TERMS), null);
  const v1 = inspectTransaction(txOf(payments.headers.honestV1));
  assert.ok(typeof v1 !== "string" && transactionMismatch(v1, TERMS) === null);
});

test("transactionMismatch catches a tampered amount, another recipient, and the fee payer's own funds", () => {
  const cheap = inspectTransaction(txOf(payments.headers.tamperedTxAmount));
  assert.ok(typeof cheap !== "string");
  assert.equal(transactionMismatch(cheap, TERMS), "payment transaction sends 0.000001 USDC; this request is 0.01 USDC");
  const tx = inspectTransaction(txOf(payments.headers.honestV2));
  assert.ok(typeof tx !== "string");
  assert.equal(transactionMismatch(tx, { ...TERMS, recipient: OTHER }), "payment transaction does not pay this request's recipient");
  assert.equal(transactionMismatch({ ...tx, transfer: { ...tx.transfer!, mint: OTHER } }, TERMS), "payment transaction does not send USDC");
  assert.equal(transactionMismatch({ ...tx, transfer: { ...tx.transfer!, authority: FEE_PAYER } }, TERMS), "payment transaction moves the fee payer's own funds");
  assert.equal(transactionMismatch({ ...tx, transferCount: 2, transfer: null }, TERMS), "payment transaction has more than one token transfer");
  assert.equal(transactionMismatch({ ...tx, transferCount: 0, transfer: null }, TERMS), null, "unreadable shapes are left to the facilitator");
  assert.equal(inspectTransaction("AAAA"), "payment transaction could not be decoded");
});

// ---- facilitator ----

test("parseSupported reads PayAI's real /supported: Solana mainnet exact fee payer in both generations", () => {
  const s = parseSupported(supportedJson);
  assert.deepEqual(s.feePayers, { v1: FEE_PAYER, v2: FEE_PAYER });
  assert.ok(s.signers.has(FEE_PAYER));
  const noSolana = { ...supportedJson, kinds: supportedJson.kinds.filter((k: { network: string }) => k.network !== NETWORK_V2) };
  assert.throws(() => parseSupported(noSolana), FacilitatorError);
  assert.throws(() => parseSupported({}), FacilitatorError);
});

test("facilitator client: /supported cached 5 min, verify/settle bodies and answers", async () => {
  clearSupportedCache();
  const calls: Array<{ url: string; body: unknown }> = [];
  let settleAnswer: Response = Response.json({ success: true, transaction: SIG, network: NETWORK_V2, payer: OTHER });
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/supported")) return Response.json(supportedJson);
    if (url.endsWith("/verify")) return Response.json({ isValid: false, invalidReason: "invalid_exact_svm_transaction_simulation_failed" }, { status: 400 });
    return settleAnswer;
  }) as typeof globalThis.fetch;
  let now = 1_000_000;
  const f = makeFacilitator({ url: "https://facilitator.example", fetch, now: () => now });
  await f.supported();
  await f.supported();
  assert.equal(calls.length, 1);
  now += 5 * 60_000;
  await f.supported();
  assert.equal(calls.length, 2);
  assert.deepEqual(await f.verify(2, { p: 1 }, { r: 1 }), { isValid: false, invalidReason: "invalid_exact_svm_transaction_simulation_failed" });
  assert.deepEqual(calls[2].body, { x402Version: 2, paymentPayload: { p: 1 }, paymentRequirements: { r: 1 } });
  assert.deepEqual(await f.settle(2, {}, {}), { success: true, errorReason: undefined, payer: OTHER, transaction: SIG, network: NETWORK_V2 });
  settleAnswer = new Response("<html>bad gateway</html>", { status: 502 });
  const failed = await f.settle(1, {}, {});
  assert.equal(failed.success, false);
  assert.match(failed.errorReason!, /facilitator_settle_http_502/);
  clearSupportedCache();
});

// ---- chain ----

function withRpc(result: unknown, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ jsonrpc: "2.0", id: 0, result })) as typeof globalThis.fetch;
  return fn().finally(() => { globalThis.fetch = real; });
}

test("checkSettlement on a real PayAI-settled mainnet transaction: verified by the recipient's USDC delta", async () => {
  const t = { id: "x", recipient: settled.recipient, amountAtomic: BigInt(settled.amountAtomic) };
  const opts = { urls: ["https://rpc.example"] };
  await withRpc(settled.tx, async () => {
    const ok = await checkSettlement(settled.signature, t, opts);
    assert.equal(ok.status, "verified");
    const credit = (ok as { credit: Credit }).credit;
    assert.equal(credit.amountAtomic, BigInt(settled.amountAtomic));
    assert.equal(credit.payer, settled.payer);
    assert.equal(credit.signature, settled.signature);
    assert.deepEqual(await checkSettlement(settled.signature, { ...t, amountAtomic: t.amountAtomic + 1n }, opts),
      { status: "mismatch", reason: `settlement credited ${settled.amountAtomic} of ${t.amountAtomic + 1n} atomic USDC` });
    assert.deepEqual(await checkSettlement(settled.signature, { ...t, recipient: OTHER }, opts),
      { status: "mismatch", reason: "settlement transaction did not credit the recipient" });
    assert.deepEqual(await checkSettlement(SIG, t, opts), { status: "mismatch", reason: "RPC returned a different transaction" });
  });
  await withRpc({ ...settled.tx, meta: { ...settled.tx.meta!, err: { InstructionError: [2, "Custom"] } } }, async () => {
    assert.deepEqual(await checkSettlement(settled.signature, t, opts), { status: "mismatch", reason: "settlement transaction failed on chain" });
  });
  await withRpc(null, async () => {
    assert.deepEqual(await checkSettlement(settled.signature, t, opts), { status: "pending" });
  });
});

test("waitForSettlement polls until the transaction is visible, then stops", async () => {
  const answers: SettlementCheck[] = [{ status: "pending" }, { status: "pending" }, { status: "mismatch", reason: "x" }];
  let calls = 0;
  const result = await waitForSettlement(SIG, TERMS, { deadline: Date.now() + 10_000, intervalMs: 1, sleep: async () => {} }, async () => answers[calls++]!);
  assert.deepEqual(result, { status: "mismatch", reason: "x" });
  assert.equal(calls, 3);
  const late = await waitForSettlement(SIG, TERMS, { deadline: Date.now() + 5, intervalMs: 50, sleep: async () => {} }, async () => ({ status: "pending" }));
  assert.deepEqual(late, { status: "pending" });
});

// ---- handler ----

interface World {
  deps: X402Deps;
  log: string[];
  rows: Map<string, RequestRow>;
  receipts: Array<{ id: string; state: string; signature?: string; error?: string }>;
  verifyAnswer: { isValid: boolean; invalidReason?: string; payer?: string };
  settleAnswer: (() => Promise<{ success: boolean; transaction: string; network: string; payer?: string; errorReason?: string }>);
  chain: SettlementCheck;
  lockBusy: boolean;
  supportedDown: boolean;
}

function world(start: RequestRow = row()): World {
  const w = {
    log: [] as string[],
    rows: new Map([[start.id, start]]),
    receipts: [] as World["receipts"],
    verifyAnswer: { isValid: true, payer: payments.payer },
    settleAnswer: async () => ({ success: true, transaction: SIG, network: NETWORK_V2, payer: payments.payer }),
    chain: { status: "verified", credit: { signature: SIG, payer: payments.payer, amountAtomic: 10_000n, at: "2026-10-17T08:00:00Z", slot: 1 } } as SettlementCheck,
    lockBusy: false,
    supportedDown: false,
  } as World;
  const supported: Supported = parseSupported(supportedJson);
  const facilitator: Facilitator = {
    url: "https://facilitator.example",
    supported: async () => { w.log.push("supported"); if (w.supportedDown) throw new FacilitatorError("facilitator /supported timed out"); return supported; },
    verify: async (version, payload, requirements) => { w.log.push(`verify v${version} ${JSON.stringify(requirements)}`); void payload; return w.verifyAnswer; },
    settle: async (version) => { w.log.push(`settle v${version}`); return w.settleAnswer(); },
  };
  const store: Store = {
    begin: async (input) => {
      w.log.push(`begin ${input.requestId} payer=${input.payer} feePayer=${input.feePayer}`);
      if (w.lockBusy) return { ok: false, holder: null };
      w.receipts.push({ id: String(w.receipts.length + 1), state: "settling" });
      return { ok: true, receiptId: String(w.receipts.length) };
    },
    fail: async (id, state, error) => { w.log.push(`fail ${state}`); Object.assign(w.receipts[Number(id) - 1]!, { state, error }); },
    settled: async (id, signature) => { w.log.push("settled"); Object.assign(w.receipts[Number(id) - 1]!, { state: "settled", signature }); },
    verified: async (receipt, credit) => {
      w.log.push("verified");
      w.receipts[Number(receipt.id) - 1]!.state = "verified";
      const r = w.rows.get(receipt.requestId)!;
      if (r.status !== "open") return false;
      w.rows.set(r.id, { ...r, status: "paid", paidSignature: credit.signature, paidPayer: credit.payer, paidAmountAtomic: credit.amountAtomic, paidAt: credit.at, paidRail: "x402" });
      return true;
    },
    pending: async () => [],
  };
  w.deps = {
    load: async (id) => w.rows.get(id) ?? null,
    refresh: async (r) => { w.log.push("refresh"); return w.rows.get(r.id) ?? r; },
    facilitator, store,
    waitForSettlement: async () => w.chain,
    now: () => Date.now(),
  };
  return w;
}

const req = (headers: Record<string, string> = {}, init: RequestInit = {}) => new Request(`${BASE}/x/${ID}`, { headers, ...init });
const facilitatorMoneyCalls = (w: World) => w.log.filter((l) => l.startsWith("verify") || l.startsWith("settle"));

test("handler: unpaid GET -> 402 with both generations, and no verify/settle", async () => {
  const w = world();
  const res = await handleX402(req(), ID, BASE, w.deps);
  assert.equal(res.status, 402);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("access-control-expose-headers")!, /PAYMENT-REQUIRED/);
  const v2 = fromB64(res.headers.get("payment-required"));
  assert.equal(v2.accepts[0].payTo, RECIPIENT);
  assert.equal(v2.accepts[0].amount, "10000");
  const body = await res.json();
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts[0].resource, `${BASE}/x/${ID}`);
  assert.deepEqual(facilitatorMoneyCalls(w), []);
  assert.deepEqual(w.receipts, []);
});

test("handler: a tampered amount gets a 402 before any verify or settle call", async () => {
  for (const [header, reason] of [
    [payments.headers.tamperedAcceptedAmount, "accepted.amount does not match this request"],
    [payments.headers.tamperedTxAmount, "payment transaction sends 0.000001 USDC; this request is 0.01 USDC"],
  ]) {
    const w = world();
    const res = await handleX402(req({ "payment-signature": header }), ID, BASE, w.deps);
    assert.equal(res.status, 402);
    assert.equal(fromB64(res.headers.get("payment-required")).error, reason);
    assert.equal((await res.json()).error, reason);
    assert.deepEqual(facilitatorMoneyCalls(w), []);
    assert.deepEqual(w.receipts, []);
  }
});

test("handler: with a warm /supported cache a tampered payment makes no facilitator call at all", async () => {
  const w = world();
  await handleX402(req(), ID, BASE, w.deps); // warms the route's facilitator in production; here, counts calls
  const before = w.log.length;
  const res = await handleX402(req({ "payment-signature": payments.headers.tamperedAcceptedAmount }), ID, BASE, w.deps);
  assert.equal(res.status, 402);
  // The double re-answers /supported from memory like the real client's 5-minute cache: only the lookup is logged.
  assert.deepEqual(w.log.slice(before).filter((l) => l !== "supported" && l !== "refresh"), []);
});

test("handler: honest payment -> verify with our requirements -> lock -> settle -> chain verified -> 200 paid over x402", async () => {
  const w = world();
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 200);
  const verify = w.log.find((l) => l.startsWith("verify v2"))!;
  const requirements = JSON.parse(verify.slice("verify v2 ".length));
  assert.deepEqual(requirements, { scheme: "exact", network: NETWORK_V2, amount: "10000", asset: USDC_MINT, payTo: RECIPIENT, maxTimeoutSeconds: 300, extra: { feePayer: FEE_PAYER } });
  assert.deepEqual(w.log.filter((l) => !l.startsWith("verify")), ["refresh", "supported", `begin ${ID} payer=${payments.payer} feePayer=${FEE_PAYER}`, "settle v2", "settled", "verified"]);
  const body = await res.json();
  assert.equal(body.status, "paid");
  assert.equal(body.rail, "x402");
  assert.equal(body.signature, SIG);
  assert.equal(body.explorer_url, `https://solscan.io/tx/${SIG}`);
  assert.deepEqual(fromB64(res.headers.get("payment-response")), { success: true, transaction: SIG, network: NETWORK_V2, payer: payments.payer });
  assert.equal(res.headers.get("x-payment-response"), res.headers.get("payment-response"));
  assert.equal(w.rows.get(ID)!.status, "paid");
  assert.equal(w.rows.get(ID)!.paidRail, "x402");
  assert.equal(w.receipts[0]!.state, "verified");
});

test("handler: v1 X-PAYMENT goes through the v1 requirements", async () => {
  const w = world();
  const res = await handleX402(req({ "x-payment": payments.headers.honestV1 }), ID, BASE, w.deps);
  assert.equal(res.status, 200);
  const requirements = JSON.parse(w.log.find((l) => l.startsWith("verify v1"))!.slice("verify v1 ".length));
  assert.equal(requirements.network, "solana");
  assert.equal(requirements.maxAmountRequired, "10000");
  assert.equal(requirements.resource, `${BASE}/x/${ID}`);
  assert.equal(w.log.includes("settle v1"), true);
});

test("handler: facilitator says invalid -> 402 with its reason, no lock, no settle", async () => {
  const w = world();
  w.verifyAnswer = { isValid: false, invalidReason: "invalid_exact_svm_transaction_simulation_failed" };
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, "invalid_exact_svm_transaction_simulation_failed");
  assert.equal(w.log.some((l) => l.startsWith("begin") || l.startsWith("settle")), false);
});

test("handler: a second payment while one is settling is refused before settle", async () => {
  const w = world();
  w.lockBusy = true;
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error.message, /being settled/);
  assert.equal(w.log.some((l) => l.startsWith("settle")), false);
});

test("handler: settlement refused -> receipt failed, 402 with the settlement response", async () => {
  const w = world();
  w.settleAnswer = async () => ({ success: false, transaction: "", network: NETWORK_V2, errorReason: "insufficient_funds" });
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 402);
  assert.equal(fromB64(res.headers.get("payment-response")).errorReason, "insufficient_funds");
  assert.deepEqual(w.receipts, [{ id: "1", state: "failed", error: "insufficient_funds" }]);
  assert.equal(w.rows.get(ID)!.status, "open");
});

test("handler: settlement timeout -> receipt unknown (lock held), 503 telling the payer to check before paying again", async () => {
  const w = world();
  w.settleAnswer = async () => { throw new FacilitatorError("facilitator /settle timed out"); };
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, new RegExp(`check ${BASE}/r/${ID} before paying again`));
  assert.equal(w.receipts[0]!.state, "unknown");
});

test("handler: the chain disagrees with the facilitator -> 502, request stays open", async () => {
  const w = world();
  w.chain = { status: "mismatch", reason: "settlement transaction did not credit the recipient" };
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 502);
  assert.equal(w.receipts[0]!.state, "mismatch");
  assert.equal(w.rows.get(ID)!.status, "open");
});

test("handler: settled but not yet on chain -> 200 status settled; the request flips on a later status check", async () => {
  const w = world();
  w.chain = { status: "pending" };
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "settled");
  assert.equal(body.signature, SIG);
  assert.equal(w.receipts[0]!.state, "settled");
  assert.equal(w.rows.get(ID)!.status, "open");
});

test("handler: an already-paid request answers 200 with its receipt and takes no payment", async () => {
  const paid = row({ status: "paid", paidSignature: SIG, paidPayer: OTHER, paidAmountAtomic: 10_000n, paidAt: "2026-10-17T08:00:00Z", paidRail: "solana_pay" });
  const w = world(paid);
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("payment-response"), null);
  const body = await res.json();
  assert.deepEqual([body.paid, body.status, body.rail, body.signature, body.link], [true, "paid", "solana_pay", SIG, `${BASE}/r/${ID}`]);
  assert.deepEqual(w.log, []);
});

test("handler: refusals for SOL, older ids, tampered rows, underpaid, cancelled, facilitator down and big bodies", async () => {
  const solRef = REFERENCE;
  const solId = requestIdFor({ recipient: RECIPIENT, token: "SOL", amountAtomic: 10_000n, reference: solRef });
  let w = world(row({ id: solId, token: "SOL", mint: null, decimals: 9 }));
  let res = await handleX402(req(), solId, BASE, w.deps);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /USDC requests only/);

  w = world(row({ id: "4tHguZSCqH" }));
  res = await handleX402(req(), "4tHguZSCqH", BASE, w.deps);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /older link/);

  w = world(row({ recipient: OTHER }));
  res = await handleX402(req(), ID, BASE, w.deps);
  assert.equal(res.status, 503);
  assert.deepEqual(w.log, []);

  for (const status of ["underpaid", "cancelled"] as const) {
    w = world(row({ status }));
    res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
    assert.equal(res.status, 409, status);
    assert.deepEqual(facilitatorMoneyCalls(w), []);
  }

  w = world();
  w.supportedDown = true;
  res = await handleX402(req(), ID, BASE, w.deps);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "upstream_unavailable");

  w = world();
  res = await handleX402(req({ "content-type": "application/json" }, { method: "POST", body: JSON.stringify({ pad: "x".repeat(64 * 1024) }) }), ID, BASE, w.deps);
  assert.equal(res.status, 400);

  assert.equal((await handleX402(req(), "nope", BASE, world().deps)).status, 404);
});

test("handler: a payment whose fee payer isn't the facilitator's is refused locally", async () => {
  const w = world();
  const sup = parseSupported(supportedJson);
  w.deps.facilitator = { ...w.deps.facilitator, supported: async () => ({ ...sup, signers: new Set([OTHER]) }) };
  const res = await handleX402(req({ "payment-signature": payments.headers.honestV2 }), ID, BASE, w.deps);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, "payment transaction's fee payer is not this facilitator's");
  assert.deepEqual(facilitatorMoneyCalls(w), []);
});

test("x402UrlFor: USDC requests with 12-char ids only", () => {
  assert.equal(x402UrlFor(BASE, { id: ID, token: "USDC" }), `${BASE}/x/${ID}`);
  assert.equal(x402UrlFor(BASE, { id: ID, token: "SOL" }), null);
  assert.equal(x402UrlFor(BASE, { id: "4tHguZSCqH", token: "USDC" }), null);
});

// ---- pending settlements (status checks) ----

test("settlePendingX402 confirms settled receipts the chain now shows, gives up on old ones, never throws", async () => {
  const receipt = (over: Partial<Receipt>): Receipt => ({
    id: "1", requestId: ID, state: "settled", x402Version: 2, network: NETWORK_V2, amountAtomic: 10_000n, payer: OTHER, signature: SIG,
    createdAt: "2026-10-17T08:00:00Z", settledAt: "2026-10-17T08:00:02Z", ageSeconds: 5, ...over,
  });
  const credit: Credit = { signature: SIG, payer: OTHER, amountAtomic: 10_000n, at: "2026-10-17T08:00:03Z", slot: 9 };
  const log: string[] = [];
  const store = (receipts: Receipt[]): Store => ({
    begin: async () => { throw new Error("unused"); },
    settled: async () => { throw new Error("unused"); },
    fail: async (id, state, error) => { log.push(`fail ${id} ${state} ${error}`); },
    verified: async (r) => { log.push(`verified ${r.id}`); return true; },
    pending: async (ids) => { log.push(`pending ${ids.join(",")}`); return receipts; },
  });
  const paidRow = row({ id: "otherPaidId1", status: "paid" });

  let paid = await settlePendingX402([row(), paidRow], {}, { store: store([receipt({})]), check: async () => ({ status: "verified", credit }) });
  assert.deepEqual([...paid], [ID]);
  assert.deepEqual(log.splice(0), [`pending ${ID}`, "verified 1"]);

  paid = await settlePendingX402([row()], {}, { store: store([receipt({})]), check: async () => ({ status: "mismatch", reason: "nope" }) });
  assert.equal(paid.size, 0);
  assert.deepEqual(log.splice(0), [`pending ${ID}`, "fail 1 mismatch nope"]);

  await settlePendingX402([row()], {}, { store: store([receipt({ ageSeconds: 601 })]), check: async () => ({ status: "pending" }) });
  assert.deepEqual(log.splice(0), [`pending ${ID}`, "fail 1 mismatch settlement transaction never appeared on chain"]);

  await settlePendingX402([row()], {}, { store: store([receipt({})]), check: async () => ({ status: "pending" }) });
  assert.deepEqual(log.splice(0), [`pending ${ID}`]);

  // Nothing open: no query at all. A broken store (e.g. migration not applied yet): no throw.
  assert.equal((await settlePendingX402([paidRow], {}, { store: store([]), check: async () => ({ status: "pending" }) })).size, 0);
  assert.deepEqual(log, []);
  const broken = { ...store([]), pending: async () => { throw new Error('relation "x402_receipts" does not exist'); } };
  assert.equal((await settlePendingX402([row()], {}, { store: broken, check: async () => ({ status: "pending" }) })).size, 0);
});
