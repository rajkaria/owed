import "server-only";
import { sql, transaction } from "./db";
import { ApiError } from "./http";
import { normalizeDomain } from "./payee";

// Rate limits, stored in Postgres (rate_events: one row per counted event). Request creation is
// limited per recipient and globally, never per IP: every plugin call arrives from PayBox's sandbox IPs.
// Work a caller can make the server do for free (DNS lookups for from_domain, x402 settlement
// attempts, chain lookups for arbitrary links) is also capped per client IP.
//
// A decision is atomic: one transaction takes a per-key advisory lock (in a fixed order, so two
// callers can't deadlock), counts each window, and records the event only if every rule allows it.
// Without the lock, concurrent creates all counted 59 and all inserted, overshooting the limit.

export interface RateRule {
  /** rate_events key, e.g. "create:recipient:<address>". */
  key: string;
  max: number;
  windowSeconds: number;
  /** Which limit this is, reported back when it is the one that refuses. */
  scope: string;
}

export interface RateDecision {
  allowed: boolean;
  scope?: string;
  retryAfterSeconds?: number;
}

const HOUR = 3600;
/** Events older than every window are deleted now and then; keep this above the longest window. */
const KEEP_SECONDS = 2 * HOUR;

export const CREATE_LIMITS = { perRecipientPerHour: 60, globalPerHour: 600 } as const;
/** Server-side DNS checks for from_domain (each is up to two DoH queries). */
export const DNS_LIMITS = { perIp: 60, perDomain: 30, windowSeconds: 600 } as const;
/** x402 payments that reach the facilitator (a payment header that passed the local checks). */
export const X402_LIMITS = { perRequest: 10, perIp: 30, windowSeconds: 600 } as const;
/** POST /status-raw checks any Solana Pay link on chain; a pay page polls it every 4 s. */
export const STATUS_RAW_LIMITS = { perIp: 60, windowSeconds: 60 } as const;

const GLOBAL_KEY = "create:global";

/** Record one event against every rule, or none if any rule is at its limit. */
export async function take(rules: readonly RateRule[]): Promise<RateDecision> {
  const keys = rules.map((r) => r.key);
  const [, rows] = await transaction([
    {
      // Hash order, not key order: any two callers lock shared keys in the same order.
      text: `select pg_advisory_xact_lock(h) from (
               select distinct hashtextextended(k, 0) as h from unnest($1::text[]) as k order by h
             ) as locks`,
      params: [keys],
    },
    {
      text: `with rules as (
               select * from unnest($1::text[], $2::int[], $3::int[], $4::text[]) as r(key, max, window_s, scope)
             ), counts as (
               select r.key, r.max, r.scope, r.window_s, count(e.at) as used, min(e.at) as oldest
                 from rules r
                 left join rate_events e on e.key = r.key and e.at > now() - make_interval(secs => r.window_s)
                group by r.key, r.max, r.scope, r.window_s
             ), decision as (
               select bool_and(used < max) as allowed from counts
             ), recorded as (
               insert into rate_events (key)
               select c.key from counts c, decision d where d.allowed
               returning 1
             )
             select c.scope, (c.used < c.max) as ok, d.allowed,
                    greatest(1, ceil(extract(epoch from (coalesce(c.oldest, now()) + make_interval(secs => c.window_s) - now()))))::int as retry_after,
                    (select count(*) from recorded) as recorded
               from counts c, decision d`,
      params: [keys, rules.map((r) => String(r.max)), rules.map((r) => String(r.windowSeconds)), rules.map((r) => r.scope)],
    },
  ]);

  // Old events only matter for their window; trim occasionally instead of on every call.
  if (Math.random() < 0.02) {
    await sql(`delete from rate_events where at < now() - make_interval(secs => $1)`, [KEEP_SECONDS]).catch(() => undefined);
  }

  if (rows.length === 0 || rows[0].allowed === "t") return { allowed: true };
  // The first rule (in the caller's order) that is full is the one reported.
  const full = rules.map((r) => rows.find((row) => row.scope === r.scope && row.ok !== "t")).find(Boolean)!;
  return { allowed: false, scope: full.scope!, retryAfterSeconds: Number(full.retry_after) };
}

/** Count the last hour for this recipient and globally; if both are under the limit, record one create. */
export async function takeCreateSlot(recipient: string): Promise<RateDecision> {
  return take([
    { key: `create:recipient:${recipient}`, max: CREATE_LIMITS.perRecipientPerHour, windowSeconds: HOUR, scope: "recipient" },
    { key: GLOBAL_KEY, max: CREATE_LIMITS.globalPerHour, windowSeconds: HOUR, scope: "global" },
  ]);
}

/** Refuse a create with the contract's rate_limited error when the recipient or global limit is full. */
export async function requireCreateSlot(recipient: string): Promise<void> {
  const slot = await takeCreateSlot(recipient);
  if (!slot.allowed) {
    throw new ApiError(
      "rate_limited",
      slot.scope === "recipient"
        ? "too many requests for this recipient in the last hour, try again later"
        : "Owed is handling too many new requests right now, try again later",
      { "Retry-After": String(slot.retryAfterSeconds ?? 60) },
    );
  }
}

/**
 * The caller's IP as Vercel reports it (it sets x-real-ip and overwrites x-forwarded-for, so neither
 * can be spoofed there). Anywhere else, requests without them share one bucket.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = real || forwarded || "unknown";
  return ip.slice(0, 64);
}

/**
 * Before a server-side DNS check for from_domain: per client IP and per domain (its ASCII form, so
 * "Example.COM." and "example.com" share a count). A malformed domain is refused later without any
 * lookup, so it spends nothing here.
 */
export async function requireDnsSlot(req: Request, domain: string): Promise<void> {
  const d = normalizeDomain(domain);
  if (!d) return;
  const slot = await take([
    { key: `dns:ip:${clientIp(req)}`, max: DNS_LIMITS.perIp, windowSeconds: DNS_LIMITS.windowSeconds, scope: "ip" },
    { key: `dns:domain:${d.ascii}`, max: DNS_LIMITS.perDomain, windowSeconds: DNS_LIMITS.windowSeconds, scope: "domain" },
  ]);
  if (!slot.allowed) {
    throw new ApiError(
      "rate_limited",
      slot.scope === "domain"
        ? "too many from_domain checks for this domain in the last 10 minutes, try again later"
        : "too many from_domain checks from this client in the last 10 minutes, try again later",
      { "Retry-After": String(slot.retryAfterSeconds ?? 60) },
    );
  }
}

/** Before an x402 payment reaches the facilitator: per request and per client IP. */
export async function takeX402Attempt(requestId: string, ip: string): Promise<RateDecision> {
  return take([
    { key: `x402:request:${requestId}`, max: X402_LIMITS.perRequest, windowSeconds: X402_LIMITS.windowSeconds, scope: "request" },
    { key: `x402:ip:${ip}`, max: X402_LIMITS.perIp, windowSeconds: X402_LIMITS.windowSeconds, scope: "ip" },
  ]);
}

/** Before POST /status-raw reads the chain for an arbitrary link: per client IP. */
export async function requireStatusRawSlot(req: Request): Promise<void> {
  const slot = await take([{ key: `status-raw:ip:${clientIp(req)}`, max: STATUS_RAW_LIMITS.perIp, windowSeconds: STATUS_RAW_LIMITS.windowSeconds, scope: "ip" }]);
  if (!slot.allowed) {
    throw new ApiError("rate_limited", "too many link checks from this client in the last minute, try again shortly", {
      "Retry-After": String(slot.retryAfterSeconds ?? 60),
    });
  }
}
