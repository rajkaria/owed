import "server-only";
import { getRequests, settleFromChain, type RequestRow } from "../requests";
import type { ReportedTransaction } from "./payload";
import * as store from "./store";

// W3-A paid-request webhooks: what /api/hooks/helius does with a delivery, after answering it.
// The body is used for one thing only: picking which requests to re-check (the Owed requests whose
// reference key the reported transaction carries). Whether a request is paid is decided by the normal
// settle path (lib/requests.ts settleFromChain: the chain's own record of the reference, strict
// validation, paid written once), never by the body. A forged or stale body can only cause a re-check.

export interface DeliveryDeps {
  sleep: (ms: number) => Promise<void>;
  /** Pause before re-checking a request the chain doesn't show as paid yet (settleFromChain re-checks an id at most every 3 s). */
  retryMs: number;
  attempts: number;
  chainBudgetMs: number;
}

/** About 16 s of re-checks at most: Helius delivers at confirmation, and the RPC (Helius first) has it by then. */
export const deliveryTiming: DeliveryDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryMs: 3100,
  attempts: 5,
  chainBudgetMs: 4000,
};

export interface DeliveryResult {
  signature: string;
  outcome: store.DeliveryOutcome | "duplicate";
  requestIds: string[];
  /** Requests that were open when the delivery arrived and are paid after its re-check. */
  markedPaid: string[];
}

const isOpen = (r: RequestRow) => r.status === "open" || r.status === "underpaid";

async function processOne(tx: ReportedTransaction, deps: DeliveryDeps): Promise<DeliveryResult> {
  const result: DeliveryResult = { signature: tx.signature, outcome: "duplicate", requestIds: [], markedPaid: [] };
  if (!(await store.claimDelivery(tx.signature, tx.payload))) return result;
  try {
    result.requestIds = await store.requestIdsForReferences(tx.keys);
    if (result.requestIds.length === 0) {
      result.outcome = "no_request";
    } else {
      let rows = [...(await getRequests(result.requestIds)).values()];
      const wasOpen = new Set(rows.filter(isOpen).map((r) => r.id));
      for (let attempt = 0; attempt < deps.attempts && rows.some(isOpen); attempt++) {
        if (attempt > 0) await deps.sleep(deps.retryMs);
        try {
          rows = await settleFromChain(rows, { deadline: Date.now() + deps.chainBudgetMs });
        } catch (e) {
          console.warn(`helius: ${tx.signature.slice(0, 8)}… chain check failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      result.markedPaid = rows.filter((r) => r.status === "paid" && wasOpen.has(r.id)).map((r) => r.id);
      result.outcome = rows.some(isOpen) ? "open" : "paid";
    }
    await store.finishDelivery(tx.signature, result.outcome as store.DeliveryOutcome, result.requestIds, result.markedPaid);
    return result;
  } catch (e) {
    // Leave it retryable by a later delivery of the same transaction.
    await store.finishDelivery(tx.signature, "open", result.requestIds, []).catch(() => undefined);
    throw e;
  }
}

/** Re-check every request the delivery's transactions reference; log each transaction once. */
export async function processDelivery(txs: readonly ReportedTransaction[], overrides: Partial<DeliveryDeps> = {}): Promise<DeliveryResult[]> {
  const deps = { ...deliveryTiming, ...overrides };
  // A delivery normally reports one transaction; a batch is worked 4 at a time so it can't flood the RPC.
  const results: DeliveryResult[] = new Array(txs.length);
  let next = 0;
  const worker = async () => {
    while (next < txs.length) {
      const i = next++;
      results[i] = await processOne(txs[i], deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, txs.length) }, worker));
  for (const r of results) {
    if (r.outcome === "duplicate") continue;
    const paid = r.markedPaid.length ? `, marked paid: ${r.markedPaid.join(" ")}` : "";
    console.log(`helius: ${r.signature.slice(0, 8)}… ${r.outcome}, requests: ${r.requestIds.join(" ") || "none"}${paid}`);
  }
  return results;
}
