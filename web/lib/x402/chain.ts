import "server-only";
import { rpcBatch, type RpcOptions } from "../solana";
import { creditFromTransaction, type Credit, type ParsedTransaction } from "../validate";
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
