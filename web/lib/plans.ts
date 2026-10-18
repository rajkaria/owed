import "server-only";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import type { CreatePlanBody, CreatePlanResponse, PlanStatsResponse, PlanUsedResponse } from "./contract";
import { DbError, sql } from "./db";
import { ApiError } from "./http";
import { take, type RateRule } from "./ratelimit";

// F2 funding plans (migration 0018). When a payer's wallet can't cover a payment, the plugin's pay_link / pay_all return
// the exact PayBox calls that fix it (swap SOL, bridge USDC from Base, swap another token, a MoonPay buy link, or x402
// when only the fee is short). The server never sees the plan's arguments or the wallet's balances: only that a plan
// was offered, for whom, for which requests, how much was short and which kinds of option it listed. That is enough to
// answer "how many plans were offered, how many ended in a proposal (used), how many in a payment (paid)".
//
// "paid" is decided on read, from the requests table, never from anything a caller says: every request in the plan is
// paid, by the plan's sender, after the plan was offered. attributePaidPlans() writes paid_at once that holds.

/** Counted from the day F2 shipped. */
export const PLANS_SINCE = "2026-10-18T00:00:00Z";

/** Per sender (a plan per payment attempt is plenty), per client IP (PayBox's sandbox IPs are shared), then globally. */
export const PLAN_LIMITS = { perSenderPerHour: 30, perIpPerHour: 600, globalPerHour: 3000, usedPerIpPerHour: 600 } as const;
const HOUR = 3600;

export function planRules(sender: string, ip: string): RateRule[] {
  return [
    { key: `plan:sender:${sender}`, max: PLAN_LIMITS.perSenderPerHour, windowSeconds: HOUR, scope: "sender" },
    { key: `plan:ip:${ip}`, max: PLAN_LIMITS.perIpPerHour, windowSeconds: HOUR, scope: "ip" },
    { key: "plan:all", max: PLAN_LIMITS.globalPerHour, windowSeconds: HOUR, scope: "global" },
  ];
}

const REFUSALS: Record<string, string> = {
  sender: "too many funding plans for this wallet in the last hour, try again later",
  ip: "too many funding plans from this client in the last hour, try again later",
  global: "Owed is recording too many funding plans right now, try again later",
};

/** 12 base58 characters from 16 random bytes (the low-order digits are uniform). */
export function newPlanId(): string {
  return bs58.encode(randomBytes(16)).slice(-12);
}

const isoUtc = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * POST /api/v1/plans. Every request id must exist (a plan for a link that isn't an Owed request has none). Rate limited
 * per sender, per client IP and globally; over a cap nothing is stored.
 */
export async function createPlan(body: CreatePlanBody, ip: string): Promise<CreatePlanResponse> {
  if (body.request_ids.length > 0) {
    const found = await sql("select id from requests where id = any($1::text[])", [body.request_ids]);
    const known = new Set(found.map((r) => r.id));
    const missing = body.request_ids.filter((id) => !known.has(id));
    if (missing.length > 0) throw new ApiError("not_found", `no request with the id ${missing[0]}`);
  }
  const slot = await take(planRules(body.sender, ip));
  if (!slot.allowed) {
    throw new ApiError("rate_limited", REFUSALS[slot.scope ?? "global"] ?? REFUSALS.global, { "Retry-After": String(slot.retryAfterSeconds ?? 60) });
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      const [row] = await sql(
        `insert into funding_plans (id, tool, sender, request_ids, shortfall_token, shortfall_atomic, option_kinds)
         values ($1, $2, $3, $4::text[], $5, $6::numeric, $7::text[])
         returning id, ${isoUtc("created_at")} as created_at`,
        [newPlanId(), body.tool, body.sender, body.request_ids, body.shortfall.token, body.shortfall.atomic, body.options],
      );
      return { plan_id: row.id!, created_at: row.created_at! };
    } catch (e) {
      // A 70-bit id colliding is a fluke; try one more fresh id, then give up.
      if (e instanceof DbError && e.code === "23505" && attempt === 0) continue;
      throw e;
    }
  }
}

/**
 * POST /api/v1/plans/<id>/used: the plan's final pay_link / pay_all proposed the payment. Only the plan's own sender
 * marks it (anyone else gets not_found, so plan ids reveal nothing). The first mark wins; later ones say already_used.
 */
export async function markPlanUsed(id: string, sender: string, ip: string): Promise<PlanUsedResponse> {
  const slot = await take([{ key: `plan-used:ip:${ip}`, max: PLAN_LIMITS.usedPerIpPerHour, windowSeconds: HOUR, scope: "ip" }]);
  if (!slot.allowed) throw new ApiError("rate_limited", "too many plan updates from this client in the last hour, try again later", { "Retry-After": String(slot.retryAfterSeconds ?? 60) });
  const [row] = await sql(
    `update funding_plans p set used_at = coalesce(p.used_at, now())
       from (select id, used_at as before from funding_plans where id = $1 and sender = $2) b
      where p.id = b.id
     returning ${isoUtc("p.used_at")} as used_at, (b.before is not null)::text as already`,
    [id, sender],
  );
  if (!row) throw new ApiError("not_found", "no funding plan with this id for this sender");
  await attributePaidPlans(id).catch((e) => console.warn(`plans: paid check skipped: ${e instanceof Error ? e.message : String(e)}`));
  return { plan_id: id, used_at: row.used_at!, already_used: row.already === "true" };
}

/**
 * Sets paid_at on plans whose every request is now paid by the plan's own sender after the plan was offered (one
 * minute of clock slack: paid_at is the block time). Plans for links that aren't Owed requests are never "paid".
 * Returns how many plans it marked. `only` limits it to one plan.
 */
export async function attributePaidPlans(only?: string): Promise<number> {
  const rows = await sql(
    `update funding_plans f set paid_at = s.paid_at
       from (
         select p.id, max(r.paid_at) as paid_at
           from funding_plans p
           join requests r on r.id = any(p.request_ids)
          where p.paid_at is null and cardinality(p.request_ids) > 0 and ($1::text is null or p.id = $1)
          group by p.id
         having count(*) = max(cardinality(p.request_ids))
            and bool_and(r.status = 'paid' and r.paid_at >= p.created_at - interval '1 minute'
                         and (r.paid_payer = p.sender or (p.sender like '0x%' and lower(r.paid_payer) = lower(p.sender))))
       ) s
      where f.id = s.id
     returning f.id`,
    [only ?? null],
  );
  return rows.length;
}

/** GET /api/v1/plans/stats: offered, used and paid since PLANS_SINCE. Settles any newly paid plans first. */
export async function planStats(): Promise<PlanStatsResponse> {
  await attributePaidPlans();
  const [row] = await sql(
    `select count(*)::text as offered,
            count(*) filter (where used_at is not null)::text as used,
            count(*) filter (where paid_at is not null)::text as paid
       from funding_plans`,
  );
  return { offered: Number(row.offered), used: Number(row.used), paid: Number(row.paid), since: PLANS_SINCE };
}
