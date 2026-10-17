import { USDC_MINT } from "../money";
import { creditFromTransaction, type Credit, type ParsedTransaction } from "../validate";
import { MOONPAY_CURRENCY } from "./config";
import type { MoonpayTx } from "./transaction";

// The attribution state machine for a card purchase. MoonPay's onramp delivery is a plain USDC transfer
// from MoonPay's wallet: no Solana Pay reference, so the reference scan can't see it. MoonPay's word
// (webhook or API) only says *which* Solana transaction to look at; the chain decides:
//
//   pending ──(MoonPay names a crypto transaction)──> sent ──(chain: credits recipient ≥ owed)──> verified
//      │                                               │──(chain: credits recipient < owed)──> underpaid
//      └──(MoonPay: failed)──> failed                  └──(chain: anything else)──────────────> mismatch
//
// verified and underpaid mark the request (paid_rail 'moonpay_card'); mismatch and failed never do.
// Pure: no I/O, so every edge is unit-tested (test/moonpay.test.ts).

export type PurchaseState = "pending" | "failed" | "sent" | "verified" | "underpaid" | "mismatch";

export interface CardRequest {
  id: string;
  recipient: string;
  token: string;
  chain?: string;
  amountAtomic: bigint;
}

export type Assessment =
  | { state: "ignore"; reason: string }
  | { state: "pending" }
  | { state: "failed"; reason: string }
  | { state: "sent"; signature: string };

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** What a MoonPay report means for this request, before the chain is asked anything. */
export function assess(tx: MoonpayTx, req: CardRequest): Assessment {
  if (tx.externalTransactionId !== req.id) return { state: "ignore", reason: "externalTransactionId is not this request" };
  if ((req.chain ?? "solana") !== "solana" || req.token !== "USDC") return { state: "ignore", reason: "not a USDC request on Solana" };
  if (tx.walletAddress !== req.recipient) return { state: "ignore", reason: "MoonPay delivers to a different wallet" };
  if (tx.currencyCode !== null && tx.currencyCode !== MOONPAY_CURRENCY) return { state: "ignore", reason: `currency ${tx.currencyCode} is not ${MOONPAY_CURRENCY}` };
  // A named transaction is always checked, whatever MoonPay's status says: the chain is the source of truth.
  if (tx.cryptoTransactionId && SIGNATURE_RE.test(tx.cryptoTransactionId)) return { state: "sent", signature: tx.cryptoTransactionId };
  if (tx.status === "failed") return { state: "failed", reason: tx.failureReason ?? "MoonPay reports the purchase failed" };
  return { state: "pending" };
}

/** States nothing MoonPay says can move a purchase out of. `failed` isn't one: a later report naming a transaction is still checked. */
export function isFinal(state: PurchaseState): boolean {
  return state === "verified" || state === "underpaid" || state === "mismatch";
}

/**
 * Whether an incoming report changes what is stored. Reports arrive out of order and more than once
 * (MoonPay retries webhooks; polls repeat), so an older updatedAt never overwrites a newer one, and a
 * final state is never left.
 */
export function shouldApply(
  stored: { state: PurchaseState; signature: string | null; moonpayUpdatedAt: string | null } | null,
  incoming: Exclude<Assessment, { state: "ignore" }>,
  incomingUpdatedAt: string | null,
): boolean {
  if (!stored) return true;
  if (isFinal(stored.state)) return false;
  if (stored.state === "sent" && incoming.state !== "sent") return false; // a named transaction is never forgotten
  if (stored.moonpayUpdatedAt && incomingUpdatedAt && Date.parse(incomingUpdatedAt) < Date.parse(stored.moonpayUpdatedAt)) return false;
  if (stored.state === incoming.state && (incoming.state !== "sent" || incoming.signature === stored.signature)) return false;
  return true;
}

export type ChainVerdict =
  | { state: "sent" } // not visible on chain yet
  | { state: "verified"; credit: Credit }
  | { state: "underpaid"; credit: Credit }
  | { state: "mismatch"; reason: string };

/**
 * Judge MoonPay's delivery transaction as the chain returned it (getTransaction, jsonParsed): confirmed,
 * error-free, after the payer opened the card checkout, and crediting the recipient's USDC. At least
 * the owed amount is verified; a smaller credit is real money that arrived, so it is underpaid.
 */
export function judgeTransaction(
  tx: ParsedTransaction | null,
  signature: string,
  terms: { recipient: string; amountAtomic: bigint; notBeforeUnix: number },
): ChainVerdict {
  if (!tx) return { state: "sent" };
  if (tx.transaction.signatures[0] !== signature) return { state: "mismatch", reason: "RPC returned a different transaction" };
  if (tx.meta?.err != null) return { state: "mismatch", reason: "the transaction failed on chain" };
  const blockTime = tx.blockTime == null ? null : Number(tx.blockTime);
  if (blockTime !== null && blockTime < terms.notBeforeUnix) {
    return { state: "mismatch", reason: "the transaction is older than the card checkout" };
  }
  // No reference to look for: every USDC transfer names the USDC mint, which stands in for it (as for x402).
  const credit = creditFromTransaction(tx, { reference: USDC_MINT, recipient: terms.recipient, token: "USDC" });
  if (!credit) return { state: "mismatch", reason: "the transaction did not credit the recipient's USDC" };
  return credit.amountAtomic >= terms.amountAtomic ? { state: "verified", credit } : { state: "underpaid", credit };
}

/** A transaction MoonPay named that the chain still doesn't show after this long is given up on. */
export const SENT_GIVE_UP_SECONDS = 24 * 3600;
/** Checkouts are polled at most this often per request, and only for this long after the widget was opened. */
export const POLL_EVERY_SECONDS = 15;
export const POLL_FOR_SECONDS = 24 * 3600;
/** A checkout may have been opened a little before the first one we recorded (clock skew between hosts). */
export const NOT_BEFORE_SLACK_SECONDS = 120;
