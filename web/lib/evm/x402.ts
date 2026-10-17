import "server-only";
import { errorResponse, json } from "../http";
import { requestIdFor, VERIFIED_ID_LENGTH } from "../ids";
import { fromAtomic } from "../money";
import type { RequestRow } from "../requests";
import type { X402Deps } from "../x402/handler";
import { b64, EXPOSED_HEADERS, HEADER_PAYMENT_V1, HEADER_PAYMENT_V2, HEADER_REQUIRED, MAX_TIMEOUT_SECONDS, type SettleResponse } from "../x402/wire";
import { FacilitatorError, type Supported } from "../x402/facilitator";
import { isHexAddress, sameEvmAddress } from "./address";
import { BASE_CAIP2, BASE_USDC, basescanTx, isTxHash } from "./base";
import { getReceipt, type BaseRpcOptions } from "./rpc";

// x402 on Base for Owed's Base requests (sprint W3-B): /x/<id> of a Base request asks for an
// `exact` USDC payment on eip155:8453 (x402 v2) and "base" (v1). The payer signs an EIP-3009
// transferWithAuthorization; the facilitator submits it and pays the gas. Same order as the Solana
// rail (lib/x402/handler.ts): local checks -> /verify -> per-request lock -> /settle -> the Base
// receipt must show the USDC Transfer to the recipient before the request is marked paid.

export const NETWORK_BASE_V1 = "base";
/** EIP-712 domain of USDC on Base, which EIP-3009 signatures commit to. */
export const USDC_EIP712 = { name: "USD Coin", version: "2" } as const;
const VERIFY_ON_CHAIN_MS = 8000;
const POLL_MS = 1000;
const MAX_HEADER_CHARS = 16 * 1024;

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": EXPOSED_HEADERS,
};

export interface BaseTerms {
  id: string;
  recipient: string;
  amountAtomic: bigint;
}

export function describeBase(t: BaseTerms): string {
  return `Owed request ${t.id}: ${fromAtomic(t.amountAtomic, "USDC")} USDC on Base to ${t.recipient}`;
}

export function requirementsBaseV2(t: BaseTerms) {
  return {
    scheme: "exact" as const, network: BASE_CAIP2, amount: t.amountAtomic.toString(), asset: BASE_USDC, payTo: t.recipient,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { ...USDC_EIP712 },
  };
}

export function requirementsBaseV1(t: BaseTerms, resourceUrl: string) {
  return {
    scheme: "exact" as const, network: NETWORK_BASE_V1, maxAmountRequired: t.amountAtomic.toString(), asset: BASE_USDC, payTo: t.recipient,
    resource: resourceUrl, description: describeBase(t), mimeType: "application/json", maxTimeoutSeconds: MAX_TIMEOUT_SECONDS, extra: { ...USDC_EIP712 },
  };
}

/** The 402 challenge: v2 document for the PAYMENT-REQUIRED header, v1 document for the body. */
export function paymentRequiredBase(t: BaseTerms, resourceUrl: string, error: string, v1: boolean) {
  const v2doc = {
    x402Version: 2, error,
    resource: { url: resourceUrl, description: describeBase(t), mimeType: "application/json", serviceName: "Owed" },
    accepts: [requirementsBaseV2(t)],
  };
  const v1doc = { x402Version: 1, error, accepts: v1 ? [requirementsBaseV1(t, resourceUrl)] : [] };
  return { header: b64(v2doc), v2: v2doc, v1: v1doc };
}

export interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export type ParsedBasePayment =
  | { version: 2; payload: Record<string, unknown>; accepted: Record<string, unknown>; authorization: Authorization }
  | { version: 1; payload: Record<string, unknown>; network: string; scheme: string; authorization: Authorization };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130,4000}$/;

function authorizationOf(payload: unknown): Authorization | string {
  if (!isObject(payload)) return "payment has no EVM payload";
  if (typeof payload.signature !== "string" || !SIGNATURE.test(payload.signature)) return "payment has no EIP-3009 signature";
  const a = payload.authorization;
  if (!isObject(a)) return "payment has no EIP-3009 authorization";
  const { from, to, value, validAfter, validBefore, nonce } = a;
  if (!isHexAddress(from) || !isHexAddress(to)) return "authorization from/to must be 0x addresses";
  if (typeof value !== "string" || !UINT.test(value)) return "authorization value must be a decimal string";
  if (typeof validAfter !== "string" || !UINT.test(validAfter) || typeof validBefore !== "string" || !UINT.test(validBefore)) return "authorization validity must be decimal strings";
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return "authorization nonce must be 32 bytes";
  return { from, to, value, validAfter, validBefore, nonce };
}

/** Decode a PAYMENT-SIGNATURE / X-PAYMENT header carrying an EVM `exact` payment. */
export function decodeBasePayment(headerValue: string): ParsedBasePayment | string {
  const value = headerValue.trim();
  if (value.length > MAX_HEADER_CHARS) return "payment header is too large";
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return "payment header is not base64 JSON";
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return "payment header is not base64 JSON";
  }
  if (!isObject(decoded)) return "payment header is not an x402 payment";
  const authorization = authorizationOf(decoded.payload);
  if (typeof authorization === "string") return authorization;
  if (decoded.x402Version === 2) {
    if (!isObject(decoded.accepted)) return "v2 payment is missing `accepted`";
    return { version: 2, payload: decoded as Record<string, unknown>, accepted: decoded.accepted, authorization };
  }
  if (decoded.x402Version === 1) {
    if (typeof decoded.scheme !== "string" || typeof decoded.network !== "string") return "v1 payment is missing scheme or network";
    return { version: 1, payload: decoded as Record<string, unknown>, network: decoded.network, scheme: decoded.scheme, authorization };
  }
  return `unsupported x402Version ${JSON.stringify(decoded.x402Version ?? null)}`;
}

/** Does the payment pay exactly this request, now? Runs before any facilitator call. */
export function baseMismatch(p: ParsedBasePayment, t: BaseTerms, nowSeconds: number): string | null {
  if (p.version === 1) {
    if (p.scheme !== "exact") return "v1 payment scheme does not match this request";
    if (p.network !== NETWORK_BASE_V1) return "v1 payment network does not match this request";
  } else {
    const a = p.accepted;
    if (a.scheme !== "exact") return "accepted.scheme does not match this request";
    if (a.network !== BASE_CAIP2) return "accepted.network does not match this request";
    if (a.amount !== t.amountAtomic.toString()) return "accepted.amount does not match this request";
    if (typeof a.asset !== "string" || !sameEvmAddress(a.asset, BASE_USDC)) return "accepted.asset does not match this request";
    if (typeof a.payTo !== "string" || !sameEvmAddress(a.payTo, t.recipient)) return "accepted.payTo does not match this request";
  }
  const auth = p.authorization;
  if (!sameEvmAddress(auth.to, t.recipient)) return "authorization pays another address";
  if (auth.value !== t.amountAtomic.toString()) return "authorization amount does not match this request";
  if (sameEvmAddress(auth.from, t.recipient)) return "a request can't be paid by its own recipient";
  if (BigInt(auth.validAfter) > BigInt(nowSeconds)) return "authorization is not valid yet";
  if (BigInt(auth.validBefore) <= BigInt(nowSeconds + 6)) return "authorization expires too soon";
  return null;
}

export type BaseSettlementCheck =
  | { status: "verified"; credit: { signature: string; payer: string; amountAtomic: bigint; at: string; slot: number } }
  | { status: "pending" }
  | { status: "mismatch"; reason: string };

/** Trust Base, not the facilitator: the receipt must succeed and carry the USDC Transfer from the payer to the recipient. */
export async function checkBaseSettlement(
  txHash: string, t: BaseTerms, payer: string, o: BaseRpcOptions = {}, now: () => number = Date.now,
): Promise<BaseSettlementCheck> {
  let receipt;
  try {
    receipt = await getReceipt(txHash, o);
  } catch {
    return { status: "pending" };
  }
  if (!receipt) return { status: "pending" };
  if (receipt.status !== "success") return { status: "mismatch", reason: "settlement transaction reverted on Base" };
  const credit = receipt.logs.find((l) => sameEvmAddress(l.to, t.recipient) && sameEvmAddress(l.from, payer) && l.value === t.amountAtomic);
  if (!credit) return { status: "mismatch", reason: "settlement transaction did not move the USDC to the recipient" };
  const at = new Date((credit.blockTimestamp ?? Math.floor(now() / 1000)) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { status: "verified", credit: { signature: txHash.toLowerCase(), payer: credit.from, amountAtomic: credit.value, at, slot: receipt.blockNumber } };
}

export async function waitForBaseSettlement(txHash: string, t: BaseTerms, payer: string, deadline: number, o: BaseRpcOptions = {}): Promise<BaseSettlementCheck> {
  for (;;) {
    const r = await checkBaseSettlement(txHash, t, payer, { ...o, deadline, timeoutMs: 2500 });
    if (r.status !== "pending" || Date.now() + POLL_MS >= deadline) return r;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export interface BaseX402Extras {
  waitForBaseSettlement?: (txHash: string, t: BaseTerms, payer: string, deadline: number) => Promise<BaseSettlementCheck>;
}

export function baseReceiptBody(row: RequestRow, base: string, status: "paid" | "settled", settled?: { signature: string; payer: string | null }) {
  const signature = settled?.signature ?? row.paidSignature;
  return {
    paid: true, status, id: row.id, chain: "base", amount: fromAtomic(row.amountAtomic, "USDC"), token: "USDC", recipient: row.recipient,
    rail: settled ? "x402" : (row.paidRail ?? "base_transfer"), payer: settled?.payer ?? row.paidPayer, signature,
    paid_at: settled ? null : row.paidAt, explorer_url: signature && isTxHash(signature) ? basescanTx(signature) : null, link: `${base}/r/${row.id}`,
  };
}

function conflict(message: string, status = 409): Response {
  return json({ error: { code: "invalid_input", message } }, { status, headers: BASE_HEADERS });
}

function settleHeaders(s: SettleResponse): Record<string, string> {
  const value = b64(s);
  return { "PAYMENT-RESPONSE": value, "X-PAYMENT-RESPONSE": value };
}

/** /x/<id> for a Base request. `row` is loaded and on Base. */
export async function handleBaseX402(req: Request, row: RequestRow, base: string, deps: X402Deps & BaseX402Extras): Promise<Response> {
  if (row.token !== "USDC" || row.id.length !== VERIFIED_ID_LENGTH) return conflict(`This request can't be paid over x402. Pay it from a Base wallet at ${base}/r/${row.id}`, 400);
  const t: BaseTerms = { id: row.id, recipient: row.recipient, amountAtomic: row.amountAtomic };
  if (requestIdFor({ recipient: row.recipient, token: "USDC", amountAtomic: row.amountAtomic, reference: row.reference, chain: "base" }) !== row.id) {
    console.error(`x402: Base request ${row.id} terms do not hash to its id`);
    return errorResponse("upstream_unavailable", "this request's payment terms don't match its id", BASE_HEADERS);
  }
  if (row.status === "open") row = await deps.refresh(row, 2000);
  if (row.status === "paid") return json(baseReceiptBody(row, base, "paid"), { headers: BASE_HEADERS });
  if (row.status === "underpaid") return conflict("This request already received a partial payment. Ask the requester for a new link.");
  if (row.status === "cancelled") return conflict("This request was cancelled by the requester.");
  // Anything else that isn't open (W3-C's expired, say) takes no payment.
  if (row.status !== "open") return conflict(`This request can't be paid (status: ${String(row.status)}).`);

  const resourceUrl = `${base}/x/${row.id}`;
  let supported: Supported;
  try {
    supported = await deps.facilitator.supported();
  } catch (e) {
    console.error(`x402 (Base): ${e instanceof Error ? e.message : String(e)}`);
    return errorResponse("upstream_unavailable", `the x402 facilitator is unavailable, try again shortly or pay from a Base wallet at ${base}/r/${row.id}`, BASE_HEADERS);
  }
  if (!supported.base?.v2) {
    return errorResponse("upstream_unavailable", `the x402 facilitator doesn't settle Base payments right now; pay from a Base wallet at ${base}/r/${row.id}`, BASE_HEADERS);
  }
  const challenge = (error: string, extra: Record<string, string> = {}, body: Record<string, unknown> = {}) => {
    const c = paymentRequiredBase(t, resourceUrl, error, supported.base?.v1 === true);
    return json({ ...c.v1, ...body }, { status: 402, headers: { ...BASE_HEADERS, [HEADER_REQUIRED]: c.header, ...extra } });
  };

  const headerValue = req.headers.get(HEADER_PAYMENT_V2) ?? req.headers.get(HEADER_PAYMENT_V1);
  if (!headerValue) return challenge("PAYMENT-SIGNATURE or X-PAYMENT header is required");
  const parsed = decodeBasePayment(headerValue);
  if (typeof parsed === "string") return challenge(parsed);
  const wrong = baseMismatch(parsed, t, Math.floor(deps.now() / 1000));
  if (wrong) return challenge(wrong);
  if (parsed.version === 1 && !supported.base?.v1) return challenge("pay with x402 v2 on eip155:8453");

  const requirements = parsed.version === 2 ? requirementsBaseV2(t) : requirementsBaseV1(t, resourceUrl);
  const network = parsed.version === 2 ? BASE_CAIP2 : NETWORK_BASE_V1;
  const payer = parsed.authorization.from;

  let verified;
  try {
    verified = await deps.facilitator.verify(parsed.version, parsed.payload, requirements);
  } catch (e) {
    return errorResponse("upstream_unavailable", `the x402 facilitator is unavailable: ${e instanceof Error ? e.message : "error"}`, BASE_HEADERS);
  }
  if (!verified.isValid) return challenge(verified.invalidReason ?? "payment_invalid");

  const lock = await deps.store.begin({ requestId: row.id, version: parsed.version, network, amountAtomic: t.amountAtomic, payer, feePayer: null });
  if (!lock.ok) {
    const fresh = await deps.load(row.id);
    if (fresh?.status === "paid") return json(baseReceiptBody(fresh, base, "paid"), { headers: BASE_HEADERS });
    return conflict("Another payment for this request is being settled. Nothing was taken from this one; check the request before paying again.");
  }

  let settled: SettleResponse;
  try {
    settled = await deps.facilitator.settle(parsed.version, parsed.payload, requirements);
  } catch (e) {
    const reason = e instanceof FacilitatorError ? e.message : "settlement error";
    await deps.store.fail(lock.receiptId, "unknown", reason);
    return errorResponse("upstream_unavailable", `the facilitator did not confirm the settlement (${reason}); check ${base}/r/${row.id} before paying again`, BASE_HEADERS);
  }
  const txHash = settled.transaction?.toLowerCase() ?? "";
  if (!settled.success || !isTxHash(txHash)) {
    await deps.store.fail(lock.receiptId, "failed", settled.errorReason ?? "settlement_failed");
    return challenge(settled.errorReason ?? "settlement_failed", settleHeaders(settled), { settlement: settled });
  }

  await deps.store.settled(lock.receiptId, txHash, payer);
  const wait = deps.waitForBaseSettlement ?? ((h, terms, p, deadline) => waitForBaseSettlement(h, terms, p, deadline));
  const onChain = await wait(txHash, t, payer, deps.now() + VERIFY_ON_CHAIN_MS);
  const headers = { ...BASE_HEADERS, ...settleHeaders({ ...settled, transaction: txHash, network }) };
  if (onChain.status === "verified") {
    const marked = await deps.store.verified({ id: lock.receiptId, requestId: row.id }, onChain.credit);
    if (!marked) console.warn(`x402: Base request ${row.id} was settled by another payment before ${txHash} landed`);
    const paidRow = (await deps.load(row.id)) ?? row;
    if (paidRow.status === "paid") return json(baseReceiptBody(paidRow, base, "paid"), { headers });
  }
  if (onChain.status === "mismatch") {
    await deps.store.fail(lock.receiptId, "mismatch", onChain.reason);
    console.error(`x402: Base request ${row.id} settlement ${txHash}: ${onChain.reason}`);
    return json(
      { error: { code: "upstream_unavailable", message: `The facilitator reported a settlement Base doesn't show paying this request (${onChain.reason}). The request is still open.` } },
      { status: 502, headers },
    );
  }
  // Settled but not yet visible: the Base log scan marks it paid over x402 on a later status check.
  return json(baseReceiptBody(row, base, "settled", { signature: txHash, payer }), { headers });
}
