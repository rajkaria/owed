import "server-only";
import { rpcBatch, type RpcOptions } from "../solana";
import { creditFromTransaction, type Credit, type ParsedTransaction } from "../validate";
import { recipientUsdcAccount } from "./svm";
import { USDC_MINT, type Terms } from "./wire";

// Trust the chain, not the facilitator: an x402 settlement counts only when the settled
// transaction is confirmed, error-free and credits the recipient's USDC by at least the
// requested amount. Same balance-delta rule as the Solana Pay check (lib/validate.ts).

export type SettlementCheck =
  | { status: "verified"; credit: Credit }
  | { status: "pending" }
  | { status: "mismatch"; reason: string };

export async function checkSettlement(signature: string, t: Terms, rpc: RpcOptions = {}): Promise<SettlementCheck> {
  const [tx] = (await rpcBatch(
    [{
      method: "getTransaction",
      // Mainnet carries v1 transactions; asking for at most v0 makes the node refuse them.
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
    }],
    rpc,
  )) as (ParsedTransaction | null)[];
  if (!tx) return { status: "pending" };
  if (tx.transaction.signatures[0] !== signature) return { status: "mismatch", reason: "RPC returned a different transaction" };
  if (tx.meta?.err != null) return { status: "mismatch", reason: "settlement transaction failed on chain" };
  // x402 transactions carry no Solana Pay reference; every USDC transfer names the USDC
  // mint, so it stands in for the reference key that creditFromTransaction looks for.
  const credit = creditFromTransaction(tx, { reference: USDC_MINT, recipient: t.recipient, token: "USDC" });
  if (!credit) return { status: "mismatch", reason: "settlement transaction did not credit the recipient" };
  if (credit.amountAtomic < t.amountAtomic) {
    return { status: "mismatch", reason: `settlement credited ${credit.amountAtomic} of ${t.amountAtomic} atomic USDC` };
  }
  return { status: "verified", credit };
}

const LANDED_SCAN_LIMIT = 20;
const LANDED_TX_LIMIT = 6;

/**
 * After a /settle timeout: did this payer's x402 transfer land anyway? Scans the recipient's USDC
 * account for a confirmed transaction since the attempt began, fee-paid by the facilitator,
 * moving the payer's tokens, crediting the recipient in full. Null if none is found.
 */
export async function findLandedSettlement(
  q: { recipient: string; payer: string; feePayer: string; amountAtomic: bigint; sinceUnix: number },
  rpc: RpcOptions = {},
): Promise<Credit | null> {
  const [sigs] = (await rpcBatch(
    [{ method: "getSignaturesForAddress", params: [recipientUsdcAccount(q.recipient), { limit: LANDED_SCAN_LIMIT, commitment: "confirmed" }] }],
    rpc,
  )) as ({ signature: string; err: unknown; blockTime?: number | null }[] | null)[];
  const candidates = (sigs ?? [])
    .filter((s) => s.err == null && (s.blockTime ?? 0) >= q.sinceUnix)
    .reverse() // oldest first
    .slice(0, LANDED_TX_LIMIT);
  for (const s of candidates) {
    const [tx] = (await rpcBatch(
      [{ method: "getTransaction", params: [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }],
      rpc,
    )) as (ParsedTransaction | null)[];
    if (!tx || tx.meta?.err != null) continue;
    const first = tx.transaction.message.accountKeys[0];
    if ((typeof first === "string" ? first : first?.pubkey) !== q.feePayer) continue;
    const credit = creditFromTransaction(tx, { reference: USDC_MINT, recipient: q.recipient, token: "USDC" });
    if (credit && credit.payer === q.payer && credit.amountAtomic >= q.amountAtomic) return credit;
  }
  return null;
}

/** Poll until the settled transaction is visible at `confirmed`, or the deadline passes. */
export async function waitForSettlement(
  signature: string,
  t: Terms,
  { deadline, intervalMs = 800, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }:
    { deadline: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
  check: typeof checkSettlement = checkSettlement,
): Promise<SettlementCheck> {
  for (;;) {
    let result: SettlementCheck;
    try {
      result = await check(signature, t, { deadline });
    } catch {
      result = { status: "pending" }; // RPC unavailable: treat as not yet visible
    }
    if (result.status !== "pending" || Date.now() + intervalMs >= deadline) return result;
    await sleep(intervalMs);
  }
}
