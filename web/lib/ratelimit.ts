import "server-only";
import { sql } from "./db";

// Request creation limits, stored in Postgres (all plugin calls arrive from PayBox's
// sandbox IPs, so limits are per recipient and global, never per IP).
export const CREATE_LIMITS = { perRecipientPerHour: 60, globalPerHour: 600 } as const;

const GLOBAL_KEY = "create:global";

export interface RateDecision {
  allowed: boolean;
  scope?: "recipient" | "global";
  retryAfterSeconds?: number;
}

/** Count the last hour for this recipient and globally; if both are under the limit, record one create. */
export async function takeCreateSlot(recipient: string): Promise<RateDecision> {
  const key = `create:recipient:${recipient}`;
  const [row] = await sql(
    `with recent as (
       select count(*) filter (where key = $1) as per_recipient,
              count(*) filter (where key = $2) as global,
              min(at) filter (where key = $1) as oldest_recipient,
              min(at) filter (where key = $2) as oldest_global
       from rate_events
       where key in ($1, $2) and at > now() - interval '1 hour'
     ), decision as (
       select per_recipient < $3 and global < $4 as allowed from recent
     ), recorded as (
       insert into rate_events (key)
       select k from unnest(array[$1::text, $2::text]) as k, decision where decision.allowed
       returning 1
     )
     select decision.allowed,
            recent.per_recipient < $3 as recipient_ok,
            greatest(1, ceil(extract(epoch from (coalesce(oldest_recipient, now()) + interval '1 hour' - now()))))::int as retry_recipient,
            greatest(1, ceil(extract(epoch from (coalesce(oldest_global, now()) + interval '1 hour' - now()))))::int as retry_global,
            (select count(*) from recorded) as recorded
     from decision, recent`,
    [key, GLOBAL_KEY, CREATE_LIMITS.perRecipientPerHour, CREATE_LIMITS.globalPerHour],
  );

  // Old events only matter for an hour; trim occasionally instead of on every call.
  if (Math.random() < 0.02) {
    await sql("delete from rate_events where at < now() - interval '2 hours'").catch(() => undefined);
  }

  if (row.allowed === "t") return { allowed: true };
  const recipientOk = row.recipient_ok === "t";
  return {
    allowed: false,
    scope: recipientOk ? "global" : "recipient",
    retryAfterSeconds: Number(recipientOk ? row.retry_global : row.retry_recipient),
  };
}
