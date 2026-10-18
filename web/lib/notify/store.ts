import "server-only";
import { sql } from "../db";

// W3-A paid-request webhooks: storage (migration 0006). notify_webhooks is the Helius webhook each
// deployment registered; helius_deliveries logs every transaction Helius reported and what came of it.

/** Well below Helius's 100,000 addresses per webhook; the newest open requests win. */
export const WATCH_LIMIT = 10_000;
/** Requests older than this stop being watched (status checks still settle them). */
const WATCH_DAYS = 30;

/**
 * Reference keys the webhook should watch: every open or underpaid Solana request, newest first, capped. Sorted.
 * F7 pots: a contribution is minted per QR scan and many are never paid, so it leaves the watch once it expires (at most
 * 24 hours after minting); a late payment to one is still recorded by status reads and the board.
 */
export async function watchedReferences(limit = WATCH_LIMIT): Promise<string[]> {
  const rows = await sql(
    `select reference from requests
      where status in ('open', 'underpaid') and chain = 'solana' and created_at > now() - interval '${WATCH_DAYS} days'
        and (pot_id is null or expires_at > now())
      order by created_at desc
      limit $1`,
    [limit],
  );
  return rows.map((r) => r.reference!).sort();
}

/** Requests (any status) whose reference key is one of these, oldest first, at most 20. */
export async function requestIdsForReferences(keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await sql(`select id from requests where reference = any($1::text[]) order by created_at limit 20`, [keys]);
  return rows.map((r) => r.id!);
}

// ---------------------------------------------------------------- the Helius webhook per deployment

export async function storedWebhook(key: string): Promise<string | null> {
  const rows = await sql(`select helius_id from notify_webhooks where url = $1`, [key]);
  return rows[0]?.helius_id ?? null;
}

/** Remember `heliusId` for `key` unless another instance got there first; returns the id that won. */
export async function rememberWebhook(key: string, heliusId: string): Promise<string> {
  const rows = await sql(
    `insert into notify_webhooks (url, helius_id) values ($1, $2) on conflict (url) do nothing returning helius_id`,
    [key, heliusId],
  );
  return rows[0]?.helius_id ?? (await storedWebhook(key)) ?? heliusId;
}

export async function forgetWebhook(key: string, heliusId: string): Promise<void> {
  await sql(`delete from notify_webhooks where url = $1 and helius_id = $2`, [key, heliusId]);
}

export async function recordSync(key: string, addressCount: number, error: string | null): Promise<void> {
  await sql(
    `update notify_webhooks
        set address_count = case when $3::text is null then $2::int else address_count end,
            synced_at = case when $3::text is null then now() else synced_at end,
            last_error = $3::text
      where url = $1`,
    [key, addressCount, error === null ? null : error.slice(0, 300)],
  );
}

// ---------------------------------------------------------------- deliveries

export type DeliveryOutcome = "paid" | "open" | "no_request";

/**
 * Take the transaction for processing. False when it was already settled, or another worker took it
 * under a minute ago (Helius retrying while the first delivery is still being checked): the delivery
 * is counted and skipped. A transaction left `open` (the chain didn't show the payment yet) is retried.
 */
export async function claimDelivery(signature: string, payload: string | null = null): Promise<boolean> {
  const rows = await sql(
    `insert into helius_deliveries (signature, outcome, payload) values ($1, 'processing', $2::jsonb)
     on conflict (signature) do update
        set outcome = 'processing', deliveries = helius_deliveries.deliveries + 1, updated_at = now()
      where helius_deliveries.outcome = 'open'
         or (helius_deliveries.outcome = 'processing' and helius_deliveries.updated_at < now() - interval '1 minute')
     returning signature`,
    [signature, payload],
  );
  if (rows.length) return true;
  await sql(`update helius_deliveries set deliveries = deliveries + 1, updated_at = now() where signature = $1`, [signature]);
  return false;
}

export async function finishDelivery(
  signature: string,
  outcome: DeliveryOutcome,
  requestIds: readonly string[],
  markedPaid: readonly string[],
): Promise<void> {
  await sql(
    `update helius_deliveries
        set outcome = $2, request_ids = $3::text[],
            marked_paid = array(select distinct unnest(marked_paid || $4::text[]) order by 1), updated_at = now()
      where signature = $1`,
    [signature, outcome, requestIds, markedPaid],
  );
}
