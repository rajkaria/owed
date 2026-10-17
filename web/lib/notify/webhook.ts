import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { getRequests, settleFromChain, type RequestRow } from "../requests";
import * as store from "./store";

// W3-A paid-request webhooks: what /api/hooks/helius does with a delivery.
// The body is used for one thing only: picking which requests to re-check (the Owed requests whose
// reference key the reported transaction carries). Whether a request is paid is decided by the normal
// settle path (lib/requests.ts settleFromChain: the chain's own record of the reference, strict
// validation, paid written once), never by the body. A forged or stale body can only cause a re-check.

/** Constant-time check of the Authorization header Helius echoes (our authHeader, optionally "Bearer "-prefixed). */
export function authorized(header: string | null, secret: string | null): boolean {
  if (!secret || !header) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  const given = digest(header.trim());
  const plain = timingSafeEqual(given, digest(secret));
  const bearer = timingSafeEqual(given, digest(`Bearer ${secret}`));
  return plain || bearer;
}

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Helius batches deliveries; anything past this is ignored (it would be a malformed body). */
export const MAX_TRANSACTIONS = 100;
const MAX_KEYS = 512;
const MAX_PAYLOAD = 64 * 1024;

export interface ReportedTransaction {
  signature: string;
  /** Every base58 key-shaped string in the item: account keys, lookup-table addresses, token accounts. */
  keys: string[];
  /** The delivered item as JSON, kept in the delivery log when it is at most 64 KB. */
  payload: string | null;
}

function signatureOf(item: Record<string, unknown>): string | null {
  const tx = item.transaction as { signatures?: unknown[] } | undefined;
  for (const candidate of [tx?.signatures?.[0], item.signature]) {
    if (typeof candidate === "string" && SIGNATURE.test(candidate)) return candidate;
  }
  return null;
}

function collectKeys(value: unknown, into: Set<string>, depth: number): void {
  if (into.size >= MAX_KEYS || depth > 8) return;
  if (typeof value === "string") {
    if (KEY.test(value)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, into, depth + 1);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectKeys(v, into, depth + 1);
  }
}

/**
 * The transactions a delivery reports, by signature. Reads Helius's raw format (getTransaction-shaped
 * items: `transaction.signatures`, `transaction.message.accountKeys`, `meta.loadedAddresses`) and
 * its enhanced format (`signature`, `accountData[].account`) alike, by collecting every key-shaped string.
 */
export function reportedTransactions(body: unknown): ReportedTransaction[] {
  const items = (Array.isArray(body) ? body : [body]).slice(0, MAX_TRANSACTIONS);
  const bySignature = new Map<string, { keys: Set<string>; payload: string | null }>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const signature = signatureOf(item as Record<string, unknown>);
    if (!signature) continue;
    const entry = bySignature.get(signature) ?? { keys: new Set<string>(), payload: null };
    collectKeys(item, entry.keys, 0);
    if (entry.payload === null) {
      const json = JSON.stringify(item);
      // jsonb refuses \u0000; such an item (never seen from Helius) is logged without its payload.
      entry.payload = json.length <= MAX_PAYLOAD && !json.includes("\\u0000") ? json : null;
    }
    bySignature.set(signature, entry);
  }
  return [...bySignature].map(([signature, { keys, payload }]) => ({ signature, keys: [...keys], payload }));
}

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
  const results = await Promise.all(txs.map((tx) => processOne(tx, deps)));
  for (const r of results) {
    if (r.outcome === "duplicate") continue;
    const paid = r.markedPaid.length ? `, marked paid: ${r.markedPaid.join(" ")}` : "";
    console.log(`helius: ${r.signature.slice(0, 8)}… ${r.outcome}, requests: ${r.requestIds.join(" ") || "none"}${paid}`);
  }
  return results;
}
