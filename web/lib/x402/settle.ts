import "server-only";
import type { RequestRow } from "../requests";
import type { RpcOptions } from "../solana";
import { checkSettlement, findLandedSettlement } from "./chain";
import { SETTLED_GIVE_UP_SECONDS, store, type Receipt, type Store } from "./store";

// Status checks (POST /api/v1/status, GET /requests/:id, the pay page, /x/<id>) call this before
// the reference scan, because x402 payments carry no reference:
// - settled: the facilitator returned a transaction the chain hadn't shown yet; confirm it now.
// - unknown: /settle timed out; if the payer's transfer landed anyway, find it and settle from it,
//   so the request never shows open (inviting a second payment) while the money has arrived.

export interface PendingDeps {
  store: Store;
  check: typeof checkSettlement;
  findLanded: typeof findLandedSettlement;
}

const defaults: PendingDeps = { store, check: checkSettlement, findLanded: findLandedSettlement };

/** True if the request is now paid. */
async function settleOne(receipt: Receipt, row: RequestRow, rpc: RpcOptions, deps: PendingDeps): Promise<boolean> {
  if (receipt.state === "unknown") {
    if (!receipt.payer || !receipt.feePayer) return false;
    const credit = await deps.findLanded({
      recipient: row.recipient, payer: receipt.payer, feePayer: receipt.feePayer, amountAtomic: row.amountAtomic,
      sinceUnix: receipt.createdUnix - 60,
    }, rpc);
    if (!credit) return false;
    await deps.store.settled(receipt.id, credit.signature, credit.payer);
    return deps.store.verified(receipt, credit);
  }
  if (!receipt.signature) return false;
  const result = await deps.check(receipt.signature, { id: row.id, recipient: row.recipient, amountAtomic: row.amountAtomic }, rpc);
  if (result.status === "verified") return deps.store.verified(receipt, result.credit);
  if (result.status === "mismatch") await deps.store.fail(receipt.id, "mismatch", result.reason);
  else if (receipt.ageSeconds > SETTLED_GIVE_UP_SECONDS) await deps.store.fail(receipt.id, "mismatch", "settlement transaction never appeared on chain");
  return false;
}

/** Returns the ids of requests marked paid. Never throws: a status check must not fail because of x402. */
export async function settlePendingX402(rows: readonly RequestRow[], rpc: RpcOptions = {}, deps: PendingDeps = defaults): Promise<Set<string>> {
  const paid = new Set<string>();
  const open = new Map(rows.filter((r) => r.status === "open" && r.token === "USDC").map((r) => [r.id, r]));
  if (open.size === 0) return paid;
  let receipts: Receipt[];
  try {
    receipts = await deps.store.pending([...open.keys()]);
  } catch (e) {
    console.warn(`x402 pending check skipped: ${e instanceof Error ? e.message : String(e)}`);
    return paid;
  }
  await Promise.all(receipts.map(async (receipt) => {
    const row = open.get(receipt.requestId);
    if (!row) return;
    try {
      if (await settleOne(receipt, row, rpc, deps)) paid.add(row.id);
    } catch (e) {
      // One receipt (an RPC error, a landed transaction another receipt already claimed) never blocks the rest.
      console.warn(`x402 receipt ${receipt.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }));
  return paid;
}
