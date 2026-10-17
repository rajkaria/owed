import "server-only";
import { errorResponse, json } from "../http";
import { requestIdFor, VERIFIED_ID_LENGTH } from "../ids";
import { fromAtomic } from "../money";
import type { RequestRow } from "../requests";
import type { SettlementCheck } from "./chain";
import { FacilitatorError, type Facilitator, type Supported } from "./facilitator";
import type { Store } from "./store";
import { handleBaseX402, type BaseX402Extras } from "../evm/x402"; // W3-B
import { inspectTransaction, transactionMismatch } from "./svm";
import {
  b64, decodePayment, EXPOSED_HEADERS, HEADER_PAYMENT_V1, HEADER_PAYMENT_V2, HEADER_REQUIRED, mismatch,
  NETWORK_V1, NETWORK_V2, paymentRequired, requirementsV1, requirementsV2, type SettleResponse, type Terms,
} from "./wire";

// GET|POST /x/<id>: pay an Owed request over x402. Unpaid: 402 with both x402 generations.
// With a payment: local checks -> facilitator /verify -> per-request lock -> /settle ->
// the chain must show the credit before the request is marked paid (paid_rail = 'x402').
// Paid (on any rail): 200 with the receipt, and no payment is taken.

export interface X402Deps {
  load(id: string): Promise<RequestRow | null>;
  /** Settle against the chain (Solana Pay reference scan, pending x402 receipts); never throws. */
  refresh(row: RequestRow, budgetMs: number): Promise<RequestRow>;
  facilitator: Facilitator;
  store: Store;
  waitForSettlement(signature: string, t: Terms, deadline: number): Promise<SettlementCheck>;
  now(): number;
}

const REFRESH_BUDGET_MS = 2000;
const EXPIRED = "This request has expired and no longer takes payments. Ask the requester for a new link."; // W3-C
const VERIFY_ON_CHAIN_MS = 8000;
const MAX_BODY_BYTES = 64 * 1024;

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": EXPOSED_HEADERS,
};

function termsOf(row: RequestRow): Terms {
  return { id: row.id, recipient: row.recipient, amountAtomic: row.amountAtomic };
}

function settleHeaders(s: SettleResponse): Record<string, string> {
  const value = b64(s);
  return { "PAYMENT-RESPONSE": value, "X-PAYMENT-RESPONSE": value };
}

function conflict(message: string, status = 409): Response {
  return json({ error: { code: "invalid_input", message } }, { status, headers: BASE_HEADERS });
}

export function receiptBody(row: RequestRow, base: string, status: "paid" | "settled", settled?: { signature: string; payer: string | null }) {
  const signature = settled?.signature ?? row.paidSignature;
  return {
    paid: true,
    status,
    id: row.id,
    amount: fromAtomic(row.amountAtomic, row.token),
    token: row.token,
    recipient: row.recipient,
    rail: settled ? "x402" : (row.paidRail ?? "solana_pay"),
    payer: settled?.payer ?? row.paidPayer,
    signature,
    paid_at: settled ? null : row.paidAt,
    explorer_url: signature ? `https://solscan.io/tx/${signature}` : null,
    link: `${base}/r/${row.id}`,
  };
}

function receipt(row: RequestRow, base: string, headers: Record<string, string> = {}): Response {
  return json(receiptBody(row, base, "paid"), { headers: { ...BASE_HEADERS, ...headers } });
}

async function challenge(t: Terms, resourceUrl: string, supported: Supported, error: string, extra: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  const c = paymentRequired(t, resourceUrl, supported.feePayers, error);
  return json({ ...c.v1, ...body }, { status: 402, headers: { ...BASE_HEADERS, [HEADER_REQUIRED]: c.header, ...extra } });
}

export async function handleX402(req: Request, id: string, base: string, deps: X402Deps & BaseX402Extras): Promise<Response> {
  if (req.method === "POST") {
    // PayBox may send a JSON body (≤ 64 KiB) with the paid request; it is not used.
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return errorResponse("invalid_input", "request body is too large", BASE_HEADERS);
  }

  let row = await deps.load(id);
  if (!row) return errorResponse("not_found", "no request with this id", BASE_HEADERS);
  // W3-B Base requests: USDC on Base pays over x402 on eip155:8453 (lib/evm/x402.ts).
  if (row.chain === "base") return handleBaseX402(req, row, base, deps);
  if (row.token !== "USDC") {
    return conflict(`x402 pays USDC requests only; this request is in ${row.token}. Pay it with Solana Pay at ${base}/r/${row.id}`, 400);
  }
  if (row.id.length !== VERIFIED_ID_LENGTH) {
    return conflict(`This older link can't be paid over x402. Pay it with Solana Pay at ${base}/r/${row.id}`, 400);
  }
  const t = termsOf(row);
  // The id is a hash of the payment terms; a row whose terms don't hash to its id is never served.
  if (requestIdFor({ recipient: row.recipient, token: row.token, amountAtomic: row.amountAtomic, reference: row.reference }) !== row.id) {
    console.error(`x402: request ${row.id} terms do not hash to its id`);
    return errorResponse("upstream_unavailable", "this request's payment terms don't match its id", BASE_HEADERS);
  }

  // W3-C: an expired or cancelled request may still have been paid (before it ended, or from a kept link).
  if (row.status === "open" || row.status === "expired" || row.status === "cancelled") row = await deps.refresh(row, REFRESH_BUDGET_MS);
  if (row.status === "paid") return receipt(row, base);
  if (row.status === "underpaid") return conflict(`This request already received a partial payment. Ask the requester for a new link.`);
  if (row.status === "cancelled") return conflict("This request was cancelled by the requester.");
  if (row.status === "expired") return conflict(EXPIRED); // W3-C: no challenge, no settlement

  const resourceUrl = `${base}/x/${row.id}`;
  let supported: Supported;
  try {
    supported = await deps.facilitator.supported();
  } catch (e) {
    console.error(`x402: ${e instanceof Error ? e.message : String(e)}`);
    return errorResponse("upstream_unavailable", "the x402 facilitator is unavailable, try again shortly", BASE_HEADERS);
  }

  const headerValue = req.headers.get(HEADER_PAYMENT_V2) ?? req.headers.get(HEADER_PAYMENT_V1);
  if (!headerValue) return challenge(t, resourceUrl, supported, "PAYMENT-SIGNATURE or X-PAYMENT header is required");

  // Local checks: nothing below reaches /verify or /settle unless it pays exactly this request.
  const parsed = decodePayment(headerValue);
  if (typeof parsed === "string") return challenge(t, resourceUrl, supported, parsed);
  const claimed = mismatch(parsed, t);
  if (claimed) return challenge(t, resourceUrl, supported, claimed);
  const tx = inspectTransaction(parsed.transaction);
  if (typeof tx === "string") return challenge(t, resourceUrl, supported, tx);
  const wrong = transactionMismatch(tx, t);
  if (wrong) return challenge(t, resourceUrl, supported, wrong);
  if (!supported.signers.has(tx.feePayer)) return challenge(t, resourceUrl, supported, "payment transaction's fee payer is not this facilitator's");

  // The requirements we hand the facilitator are ours, with the fee payer the payer signed for.
  const requirements = parsed.version === 2 ? requirementsV2(t, tx.feePayer) : requirementsV1(t, resourceUrl, tx.feePayer);
  const network = parsed.version === 2 ? NETWORK_V2 : NETWORK_V1;

  let verified;
  try {
    verified = await deps.facilitator.verify(parsed.version, parsed.payload, requirements);
  } catch (e) {
    return errorResponse("upstream_unavailable", `the x402 facilitator is unavailable: ${e instanceof Error ? e.message : "error"}`, BASE_HEADERS);
  }
  if (!verified.isValid) return challenge(t, resourceUrl, supported, verified.invalidReason ?? "payment_invalid");

  const lock = await deps.store.begin({
    requestId: row.id, version: parsed.version, network, amountAtomic: t.amountAtomic,
    payer: tx.transfer?.authority ?? verified.payer ?? null, feePayer: tx.feePayer,
  });
  if (!lock.ok) {
    const fresh = await deps.load(row.id);
    if (fresh?.status === "paid") return receipt(fresh, base);
    // W3-C: cancelled or expired while this payment was being verified; nothing was settled.
    if (fresh?.status === "cancelled") return conflict("This request was cancelled by the requester. Nothing was taken from this payment.");
    if (fresh?.status === "expired") return conflict(`${EXPIRED} Nothing was taken from this payment.`);
    return conflict("Another payment for this request is being settled. Nothing was taken from this one; check the request before paying again.");
  }

  let settled: SettleResponse;
  try {
    settled = await deps.facilitator.settle(parsed.version, parsed.payload, requirements);
  } catch (e) {
    const reason = e instanceof FacilitatorError ? e.message : "settlement error";
    await deps.store.fail(lock.receiptId, "unknown", reason);
    return errorResponse(
      "upstream_unavailable",
      `the facilitator did not confirm the settlement (${reason}); check ${base}/r/${row.id} before paying again`,
      BASE_HEADERS,
    );
  }
  if (!settled.success || !settled.transaction) {
    await deps.store.fail(lock.receiptId, "failed", settled.errorReason ?? "settlement_failed");
    return challenge(t, resourceUrl, supported, settled.errorReason ?? "settlement_failed", settleHeaders(settled), { settlement: settled });
  }

  const payer = settled.payer ?? verified.payer ?? tx.transfer?.authority ?? null;
  await deps.store.settled(lock.receiptId, settled.transaction, payer);
  const onChain = await deps.waitForSettlement(settled.transaction, t, deps.now() + VERIFY_ON_CHAIN_MS);
  const headers = { ...BASE_HEADERS, ...settleHeaders({ ...settled, network }) };

  if (onChain.status === "verified") {
    const marked = await deps.store.verified({ id: lock.receiptId, requestId: row.id }, onChain.credit);
    if (!marked) console.warn(`x402: request ${row.id} was settled by another payment before ${settled.transaction} landed`);
    const paidRow = (await deps.load(row.id)) ?? row;
    if (paidRow.status === "paid") return json(receiptBody(paidRow, base, "paid"), { headers });
  }
  if (onChain.status === "mismatch") {
    await deps.store.fail(lock.receiptId, "mismatch", onChain.reason);
    console.error(`x402: request ${row.id} settlement ${settled.transaction}: ${onChain.reason}`);
    return json(
      { error: { code: "upstream_unavailable", message: `The facilitator reported a settlement the chain doesn't show paying this request (${onChain.reason}). The request is still open.` } },
      { status: 502, headers },
    );
  }
  // Settled but not yet visible on chain: the request flips to paid on the next status check.
  return json(receiptBody(row, base, "settled", { signature: settled.transaction, payer }), { headers });
}
