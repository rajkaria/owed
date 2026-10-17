import "server-only";
import type { RequestRow } from "../requests";
import type { RpcOptions } from "../solana";
import { checkSettlement } from "./chain";
import { SETTLED_GIVE_UP_SECONDS, store, type Store } from "./store";

// Status checks (POST /api/v1/status, GET /requests/:id, the pay page) call this before the
// reference scan: an x402 payment the facilitator settled but the chain hadn't shown yet is
// confirmed here, so the request flips to paid without anyone calling /x/<id> again.

/** Returns the ids of requests marked paid. Never throws: a status check must not fail because of x402. */
export async function settlePendingX402(
  rows: readonly RequestRow[],
  rpc: RpcOptions = {},
  deps: { store: Store; check: typeof checkSettlement } = { store, check: checkSettlement },
): Promise<Set<string>> {
  const paid = new Set<string>();
  const open = new Map(rows.filter((r) => r.status === "open" && r.token === "USDC").map((r) => [r.id, r]));
  if (open.size === 0) return paid;
  try {
    const receipts = await deps.store.pending([...open.keys()]);
    await Promise.all(receipts.map(async (receipt) => {
      const row = open.get(receipt.requestId);
      if (!row || !receipt.signature) return;
      const result = await deps.check(receipt.signature, { id: row.id, recipient: row.recipient, amountAtomic: row.amountAtomic }, rpc);
      if (result.status === "verified") {
        if (await deps.store.verified(receipt, result.credit)) paid.add(row.id);
      } else if (result.status === "mismatch") {
        await deps.store.fail(receipt.id, "mismatch", result.reason);
      } else if (receipt.ageSeconds > SETTLED_GIVE_UP_SECONDS) {
        await deps.store.fail(receipt.id, "mismatch", "settlement transaction never appeared on chain");
      }
    }));
  } catch (e) {
    console.warn(`x402 pending check skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  return paid;
}
