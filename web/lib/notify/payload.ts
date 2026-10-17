import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// W3-A paid-request webhooks: reading a Helius delivery, before anything is re-checked. Kept free of
// the request/chain modules so /api/hooks/helius can answer within Helius's 1 s even on a cold start;
// the re-check (lib/notify/webhook.ts) loads after the response.

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
