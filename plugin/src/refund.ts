// F8 invoices: refunds, the pure parts. The wallet a paid request paid sends all or part of it back to the wallet that
// paid: it signs "Owed refund <amount> <token> of <request id> to <payer> for <recipient> at <ISO time>", Owed's server
// stores a pending refund with a fresh reference (web/lib/refunds.ts), and refund_payment proposes ONE unsigned transfer
// recipient -> payer that carries it, with the memo owed-refund:<id>. The refund counts only once the chain shows it.
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { USDC_MINT, type Token } from "./money.js";

export const REFUND_MEMO_PREFIX = "owed-refund:";
/** The signed message is valid this long (the server's rule, lib/verify-signature.ts). */
export const REFUND_MESSAGE_VALID_MS = 5 * 60_000;
const MAX_SKEW_MS = 60_000;

export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** Everything before " at <time>". `amount` must be the canonical decimal (fromAtomic of its atomic units). */
export function refundLead(amount: string, token: Token, requestId: string, payer: string, recipient: string): string {
  return `Owed refund ${amount} ${token} of ${requestId} to ${payer} for ${recipient}`;
}

export function refundMessage(amount: string, token: Token, requestId: string, payer: string, recipient: string, nowMs: number): string {
  return `${refundLead(amount, token, requestId, payer, recipient)} at ${isoSeconds(nowMs)}`;
}

const MESSAGE_RE = /^Owed refund ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) (USDC|SOL) of ([1-9A-HJ-NP-Za-km-z]{12}) to ([1-9A-HJ-NP-Za-km-z]{32,44}) for ([1-9A-HJ-NP-Za-km-z]{32,44}) at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)$/;

export interface SignedRefund {
  amount: string;
  token: Token;
  requestId: string;
  payer: string;
  recipient: string;
  /** Epoch ms of the time in the message. */
  at: number;
}

/** The terms a signed refund message names, or null when it isn't one. */
export function parseRefundMessage(message: string): SignedRefund | null {
  const m = MESSAGE_RE.exec(message);
  if (!m) return null;
  const at = Date.parse(m[6]!);
  if (!Number.isFinite(at)) return null;
  return { amount: m[1]!, token: m[2] as Token, requestId: m[3]!, payer: m[4]!, recipient: m[5]!, at };
}

/** null when the message is fresh (at most 5 minutes old, not ahead of the clock), else why not. */
export function freshness(at: number, now: number): string | null {
  if (now - at > REFUND_MESSAGE_VALID_MS) return "That signed message is more than 5 minutes old.";
  if (at - now > MAX_SKEW_MS) return "That signed message is dated in the future.";
  return null;
}

export interface RefundTerms {
  requestId: string;
  payer: string;
  token: Token;
  amountAtomic: bigint;
  reference: string;
}

/** A refund id commits to the request, the payer, the token, the amount and the reference (web/lib/refunds.ts the same). */
export function refundIdFor(t: RefundTerms): string {
  const asset = t.token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256").update(`owed-refund:v1\n${t.requestId}\n${t.payer}\n${asset}\n${t.amountAtomic}\n${t.reference}`, "utf8").digest();
  return bs58.encode(digest).slice(-12);
}

export function refundMemo(id: string): string {
  return `${REFUND_MEMO_PREFIX}${id}`;
}
