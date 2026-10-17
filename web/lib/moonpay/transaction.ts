import { createHmac, timingSafeEqual } from "node:crypto";

// What MoonPay tells us about a Buy transaction, from a webhook (transaction_created / _updated /
// _failed, body {type, data: BuyTransaction}) or from GET /v1/transactions/ext/{externalTransactionId}.
// None of it marks a request paid: it only names the Solana transaction to check on chain
// (lib/moonpay/attribution.ts). Pure: no I/O.

export type MoonpayStatus = "waitingPayment" | "pending" | "waitingAuthorization" | "failed" | "completed";
const STATUSES: readonly string[] = ["waitingPayment", "pending", "waitingAuthorization", "failed", "completed"];

export interface MoonpayTx {
  /** MoonPay's transaction id. */
  id: string;
  status: MoonpayStatus;
  /** Ours: the Owed request id the widget URL carried. */
  externalTransactionId: string | null;
  walletAddress: string;
  /** e.g. "usdc_sol" (data.currency.code). */
  currencyCode: string | null;
  /** The Solana signature of MoonPay's delivery, once sent. */
  cryptoTransactionId: string | null;
  /** Crypto amount MoonPay reports (a JSON number): display and logs only, never trusted for money. */
  quoteCurrencyAmount: number | null;
  updatedAt: string | null;
  failureReason: string | null;
}

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** One BuyTransaction object, or null if it isn't one. */
export function parseMoonpayTx(value: unknown): MoonpayTx | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  const id = str(t.id, 100);
  const status = str(t.status, 40);
  const walletAddress = str(t.walletAddress, 100);
  if (!id || !status || !STATUSES.includes(status) || !walletAddress) return null;
  const currency = t.currency && typeof t.currency === "object" ? (t.currency as Record<string, unknown>) : null;
  const updatedAt = str(t.updatedAt, 40);
  return {
    id,
    status: status as MoonpayStatus,
    externalTransactionId: str(t.externalTransactionId, 100),
    walletAddress,
    currencyCode: str(currency?.code, 40),
    cryptoTransactionId: str(t.cryptoTransactionId, 120),
    quoteCurrencyAmount: typeof t.quoteCurrencyAmount === "number" && Number.isFinite(t.quoteCurrencyAmount) ? t.quoteCurrencyAmount : null,
    updatedAt: updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null,
    failureReason: str(t.failureReason, 300),
  };
}

/** The transactions in a by-external-id answer (documented as an array; a single object is accepted too). */
export function parseMoonpayList(value: unknown): MoonpayTx[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(parseMoonpayTx).filter((t): t is MoonpayTx => t !== null);
}

export const WEBHOOK_TYPES = ["transaction_created", "transaction_updated", "transaction_failed"] as const;

/** The Buy transaction a webhook body carries, or null for any other event. */
export function parseWebhookBody(body: unknown): MoonpayTx | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.type !== "string" || !(WEBHOOK_TYPES as readonly string[]).includes(b.type)) return null;
  return parseMoonpayTx(b.data);
}

/** Webhook replays are harmless (every outcome is re-checked on chain and writes are idempotent), so the window is generous for MoonPay's retries. */
export const WEBHOOK_TOLERANCE_SECONDS = 3600;

/**
 * Moonpay-Signature-V2: "t=<unix seconds>,s=<hex HMAC-SHA256 of `${t}.${raw body}` keyed with the webhook key>".
 * Constant-time compare; false on anything malformed, stale (more than an hour either side) or wrong.
 */
export function verifyWebhookSignature(
  header: string | null,
  rawBody: string,
  webhookKey: string,
  nowMs: number = Date.now(),
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (!header || !webhookKey || header.length > 300) return false;
  const parts = new Map<string, string>();
  for (const element of header.split(",")) {
    const i = element.indexOf("=");
    if (i > 0) parts.set(element.slice(0, i).trim(), element.slice(i + 1).trim());
  }
  const t = parts.get("t");
  const s = parts.get("s");
  if (!t || !/^\d{1,12}$/.test(t) || !s || !/^[0-9a-f]{64}$/i.test(s)) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", webhookKey).update(`${t}.${rawBody}`, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(s, "hex"));
}
