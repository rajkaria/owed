import { fromAtomic, USDC_MINT } from "../money";

// x402 on the wire, no I/O. Ported from the paybox-x402-spike (api/x402.ts) for one
// rail: USDC on Solana mainnet, `exact` scheme. Every 402 carries both generations:
//   v2: base64 PaymentRequired in the PAYMENT-REQUIRED header (CAIP-2 network, `amount`)
//   v1: the JSON body {x402Version:1, accepts:[{network:"solana", maxAmountRequired, ...}]}
// Payments arrive as PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1); the settlement goes back
// in PAYMENT-RESPONSE and X-PAYMENT-RESPONSE. Spec: github.com/coinbase/x402 specs/.

export const NETWORK_V2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const NETWORK_V1 = "solana";
export { USDC_MINT };
/** How long the payer's signed transaction may wait for settlement. */
export const MAX_TIMEOUT_SECONDS = 300;
/** A Solana transaction is at most 1,232 bytes; base64 plus the JSON around it stays far below this. */
export const MAX_PAYMENT_HEADER_CHARS = 16 * 1024;

export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_V2 = "payment-signature";
export const HEADER_PAYMENT_V1 = "x-payment";
export const EXPOSED_HEADERS = "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE";

/** What an x402 payment for one Owed request must pay. USDC only. */
export interface Terms {
  id: string;
  recipient: string;
  amountAtomic: bigint;
}

export interface RequirementsV2 {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string };
}

export interface RequirementsV1 {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { feePayer: string };
}

export interface PaymentRequiredV2 {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType: string; serviceName: string };
  accepts: RequirementsV2[];
}

export interface PaymentRequiredV1 {
  x402Version: 1;
  error: string;
  accepts: RequirementsV1[];
}

export interface PaymentPayloadV2 {
  x402Version: 2;
  accepted: Record<string, unknown>;
  payload: { transaction: string };
  resource?: unknown;
  extensions?: unknown;
}

export interface PaymentPayloadV1 {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: { transaction: string };
}

export type ParsedPayment =
  | { version: 2; payload: PaymentPayloadV2; transaction: string }
  | { version: 1; payload: PaymentPayloadV1; transaction: string };

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

export function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

/** Fixed text built from the terms only: requester-written words never reach x402 clients. */
export function describe(t: Terms): string {
  if (t.id.length === 14) return `Owed pot ${t.id}: a contribution of ${fromAtomic(t.amountAtomic, "USDC")} USDC to ${t.recipient}`; // F7 pots
  return `Owed request ${t.id}: ${fromAtomic(t.amountAtomic, "USDC")} USDC to ${t.recipient}`;
}

export function requirementsV2(t: Terms, feePayer: string): RequirementsV2 {
  return {
    scheme: "exact",
    network: NETWORK_V2,
    amount: t.amountAtomic.toString(),
    asset: USDC_MINT,
    payTo: t.recipient,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { feePayer },
  };
}

export function requirementsV1(t: Terms, resourceUrl: string, feePayer: string): RequirementsV1 {
  return {
    scheme: "exact",
    network: NETWORK_V1,
    maxAmountRequired: t.amountAtomic.toString(),
    asset: USDC_MINT,
    payTo: t.recipient,
    resource: resourceUrl,
    description: describe(t),
    mimeType: "application/json",
    // No `outputSchema`: PayAI's v1 /verify rejects `null` there (spike finding).
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { feePayer },
  };
}

export interface FeePayers {
  v1: string;
  v2: string;
}

/** The 402 challenge: v2 document for the header, v1 document for the body. */
export function paymentRequired(t: Terms, resourceUrl: string, feePayers: FeePayers, error: string) {
  const v2: PaymentRequiredV2 = {
    x402Version: 2,
    error,
    resource: { url: resourceUrl, description: describe(t), mimeType: "application/json", serviceName: "Owed" },
    accepts: [requirementsV2(t, feePayers.v2)],
  };
  const v1: PaymentRequiredV1 = { x402Version: 1, error, accepts: [requirementsV1(t, resourceUrl, feePayers.v1)] };
  return { header: b64(v2), v2, v1 };
}

const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function transactionOf(payload: unknown): string | null {
  if (!isObject(payload) || typeof payload.transaction !== "string") return null;
  const tx = payload.transaction;
  return tx.length > 0 && tx.length <= 4096 && BASE64.test(tx) ? tx : null;
}

/** Decode a PAYMENT-SIGNATURE / X-PAYMENT header. Returns the payment, or why it can't be used. */
export function decodePayment(headerValue: string): ParsedPayment | string {
  const value = headerValue.trim();
  if (value.length > MAX_PAYMENT_HEADER_CHARS) return "payment header is too large";
  if (!BASE64.test(value)) return "payment header is not base64 JSON";
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return "payment header is not base64 JSON";
  }
  if (!isObject(decoded)) return "payment header is not an x402 payment";
  const transaction = transactionOf(decoded.payload);
  if (decoded.x402Version === 2) {
    if (!isObject(decoded.accepted)) return "v2 payment is missing `accepted`";
    if (!transaction) return "payment has no Solana transaction";
    return { version: 2, payload: decoded as unknown as PaymentPayloadV2, transaction };
  }
  if (decoded.x402Version === 1) {
    if (typeof decoded.scheme !== "string" || typeof decoded.network !== "string") return "v1 payment is missing scheme or network";
    if (!transaction) return "payment has no Solana transaction";
    return { version: 1, payload: decoded as unknown as PaymentPayloadV1, transaction };
  }
  return `unsupported x402Version ${JSON.stringify(decoded.x402Version ?? null)}`;
}

/**
 * Does the payment claim to pay exactly this request? Exact, case-sensitive comparison:
 * base58 addresses differ by case. Runs before any facilitator call.
 */
export function mismatch(p: ParsedPayment, t: Terms): string | null {
  if (p.version === 1) {
    if (p.payload.scheme !== "exact") return "v1 payment scheme does not match this request";
    if (p.payload.network !== NETWORK_V1) return "v1 payment network does not match this request";
    return null;
  }
  const want: Record<string, string> = {
    scheme: "exact",
    network: NETWORK_V2,
    amount: t.amountAtomic.toString(),
    asset: USDC_MINT,
    payTo: t.recipient,
  };
  const got = p.payload.accepted;
  const field = Object.keys(want).find((k) => got[k] !== want[k]);
  return field ? `accepted.${field} does not match this request` : null;
}
