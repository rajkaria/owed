import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { isoUtc, sql } from "./db";
import { ApiError } from "./http";
import { fromAtomic, type Token } from "./money";
import { requireVerifiedDomain } from "./payee";
import { createRequest, type RequestRow } from "./requests";

// Recurring requests (W3-D, ask_every_month): the same payer, amount and text on the same day of every
// month. Months are calendar months in UTC and the day is 1–28, so every month has it. Each month's request
// is made by createRequest like any other (so expiry, the verified payee and every later rule apply), and
// schedule_requests (0008) keys it on (schedule, period): one request per schedule per month, however
// often the cron runs. The cron opens only the current month's request, never back-fills older months.

export const SCHEDULE_LIMITS = {
  /** Active schedules one recipient may have. */
  activePerRecipient: 20,
  /** Longest fixed run, in monthly requests. */
  maxMonths: 120,
} as const;

/** A claim whose request never got linked (the function died mid-way) can be retried after this. */
export const STALE_CLAIM_MINUTES = 10;
/** Schedules one cron run looks at; the rest wait for the next run (they're still due then). */
export const CRON_BATCH = 200;
export const CRON_CONCURRENCY = 4;
/** Vercel gives the cron function 60 s (maxDuration); stop starting new work well before. */
export const CRON_BUDGET_MS = 40_000;

// ---------------------------------------------------------------- periods (pure)

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type Period = string;

function parts(ms: number): { y: number; m: number; d: number } {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "2026-10" for any instant in October 2026, UTC. */
export function periodOf(ms: number): Period {
  const { y, m } = parts(ms);
  return `${pad(y, 4)}-${pad(m)}`;
}

function parsePeriod(p: Period): { y: number; m: number } {
  const match = PERIOD_RE.exec(p);
  if (!match) throw new Error(`bad period ${p}`);
  return { y: Number(match[1]), m: Number(match[2]) };
}

export function nextPeriod(p: Period): Period {
  const { y, m } = parsePeriod(p);
  return m === 12 ? `${pad(y + 1, 4)}-01` : `${pad(y, 4)}-${pad(m + 1)}`;
}

/** UTC day of the month, 1–31. */
export function dayOf(ms: number): number {
  return parts(ms).d;
}

/** "2026-11-05": the day a period's request opens. */
export function dateIn(p: Period, day: number): string {
  parsePeriod(p);
  return `${p}-${pad(day)}`;
}

export function isoDate(ms: number): string {
  const { y, m, d } = parts(ms);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** The first month a schedule made at `createdMs` asks in: this month unless its day has already passed. */
export function firstPeriodFor(createdMs: number, day: number): Period {
  const p = periodOf(createdMs);
  return dayOf(createdMs) <= day ? p : nextPeriod(p);
}

export interface ScheduleTiming {
  firstPeriod: Period;
  dayOfMonth: number;
}

/** The period whose request should exist by `nowMs`, or null when this month's day hasn't come yet. */
export function duePeriod(s: ScheduleTiming, nowMs: number): Period | null {
  const p = periodOf(nowMs);
  if (p < s.firstPeriod) return null; // 'YYYY-MM' strings sort in time order
  return dayOf(nowMs) >= s.dayOfMonth ? p : null;
}

export interface ScheduleProgress extends ScheduleTiming {
  status: ScheduleStatus;
  maxRequests: number | null;
  /** Requests opened so far. */
  opened: number;
}

/**
 * When the next request opens, "YYYY-MM-DD" (UTC), or null when the schedule has ended.
 * `openedCurrent`: this month's request already exists. A due month without one opens today.
 */
export function nextRequestOn(s: ScheduleProgress, nowMs: number, openedCurrent: boolean): string | null {
  if (s.status !== "active") return null;
  if (s.maxRequests !== null && s.opened >= s.maxRequests) return null;
  const p = periodOf(nowMs);
  if (p < s.firstPeriod) return dateIn(s.firstPeriod, s.dayOfMonth);
  if (dayOf(nowMs) < s.dayOfMonth) return dateIn(p, s.dayOfMonth);
  return openedCurrent ? dateIn(nextPeriod(p), s.dayOfMonth) : isoDate(nowMs);
}

const ORDINAL = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** "the 1st", "the 22nd". */
export function dayLabel(day: number): string {
  return `the ${ORDINAL(day)}`;
}

// ---------------------------------------------------------------- storage

export type ScheduleStatus = "active" | "ended" | "stopped";

export interface ScheduleRow {
  id: string;
  recipient: string;
  token: Token;
  amountAtomic: bigint;
  payerName: string | null;
  forText: string | null;
  requesterName: string | null;
  flags: string[];
  dayOfMonth: number;
  firstPeriod: Period;
  maxRequests: number | null;
  status: ScheduleStatus;
  source: "plugin" | "web";
  fromDomain: string | null;
  fromDomainVerifiedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
}

const COLUMNS = `id, recipient, token, amount_atomic::text as amount_atomic, payer_name, for_text, requester_name,
  array_to_json(flags)::text as flags, day_of_month, first_period, max_requests, status, source,
  from_domain, ${isoUtc("from_domain_verified_at")} as from_domain_verified_at,
  last_error, ${isoUtc("last_error_at")} as last_error_at, ${isoUtc("created_at")} as created_at`;

function fromRow(r: Record<string, string | null>): ScheduleRow {
  return {
    id: r.id!,
    recipient: r.recipient!,
    token: r.token as Token,
    amountAtomic: BigInt(r.amount_atomic!),
    payerName: r.payer_name,
    forText: r.for_text,
    requesterName: r.requester_name,
    flags: JSON.parse(r.flags ?? "[]") as string[],
    dayOfMonth: Number(r.day_of_month),
    firstPeriod: r.first_period!,
    maxRequests: r.max_requests == null ? null : Number(r.max_requests),
    status: r.status as ScheduleStatus,
    source: r.source as ScheduleRow["source"],
    fromDomain: r.from_domain,
    fromDomainVerifiedAt: r.from_domain_verified_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    createdAt: r.created_at!,
  };
}

/** 12 random base58 characters (about 70 bits): schedules aren't derived from terms, nothing pays them. */
export function newScheduleId(): string {
  for (;;) {
    const id = bs58.encode(randomBytes(16)).slice(-12);
    if (id.length === 12) return id;
  }
}

export async function getSchedule(id: string): Promise<ScheduleRow | null> {
  const rows = await sql(`select ${COLUMNS} from schedules where id = $1`, [id]);
  return rows.length ? fromRow(rows[0]) : null;
}

export interface NewSchedule {
  recipient: string;
  token: Token;
  amountAtomic: bigint;
  /** Already sanitized (lib/safety.ts sanitizeText). */
  payerName: string | null;
  forText: string | null;
  requesterName: string | null;
  flags: string[];
  dayOfMonth: number;
  maxRequests: number | null;
  source: "plugin" | "web";
  /** Only a value returned by requireVerifiedDomain (lib/payee.ts). */
  fromDomain: string | null;
}

export interface OpenedRequest {
  period: Period;
  request: RequestRow;
}

export interface CreatedSchedule {
  schedule: ScheduleRow;
  /** This month's request, when the schedule's day is today. */
  first: OpenedRequest | null;
}

/**
 * Store a schedule; when its day is today, open this month's request right away (the cron would
 * otherwise open it on its next run). `openNow: false` leaves that to the cron.
 */
export async function createSchedule(input: NewSchedule, { now = Date.now(), openNow = true }: { now?: number; openNow?: boolean } = {}): Promise<CreatedSchedule> {
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 28) {
    throw new ApiError("invalid_input", "day_of_month must be a whole number from 1 to 28");
  }
  if (input.maxRequests !== null && (!Number.isInteger(input.maxRequests) || input.maxRequests < 1 || input.maxRequests > SCHEDULE_LIMITS.maxMonths)) {
    throw new ApiError("invalid_input", `months must be a whole number from 1 to ${SCHEDULE_LIMITS.maxMonths}`);
  }
  const firstPeriod = firstPeriodFor(now, input.dayOfMonth);
  let row: ScheduleRow | null = null;
  for (let attempt = 0; attempt < 3 && !row; attempt++) {
    const rows = await sql(
      `insert into schedules (id, recipient, token, amount_atomic, payer_name, for_text, requester_name, flags,
         day_of_month, first_period, max_requests, source, from_domain, from_domain_verified_at)
       select $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12,
         $13, case when $13::text is null then null else now() end
        where (select count(*) from schedules where recipient = $2 and status = 'active') < $14
       on conflict (id) do nothing
       returning ${COLUMNS}`,
      [
        newScheduleId(), input.recipient, input.token, input.amountAtomic, input.payerName, input.forText,
        input.requesterName, input.flags, input.dayOfMonth, firstPeriod, input.maxRequests, input.source,
        input.fromDomain, SCHEDULE_LIMITS.activePerRecipient,
      ],
    );
    if (rows.length) {
      row = fromRow(rows[0]);
      break;
    }
    const [{ n }] = await sql(`select count(*)::int as n from schedules where recipient = $1 and status = 'active'`, [input.recipient]);
    if (Number(n) >= SCHEDULE_LIMITS.activePerRecipient) {
      throw new ApiError("invalid_input", `this recipient already has ${SCHEDULE_LIMITS.activePerRecipient} active monthly requests, the most Owed keeps`);
    }
    // otherwise an id collision (about 2^-70): try a fresh id
  }
  if (!row) throw new Error("could not store the schedule");

  const period = duePeriod(row, now);
  if (!openNow || period === null) return { schedule: row, first: null };
  // The route verified the domain moments ago; no second DNS round trip for the first request.
  const outcome = await openForPeriod(row, period, { verifiedDomain: row.fromDomain });
  return { schedule: (await getSchedule(row.id)) ?? row, first: outcome.kind === "opened" ? { period, request: outcome.request } : null };
}

export type OpenOutcome =
  | { kind: "opened"; request: RequestRow }
  | { kind: "exists" }
  | { kind: "skipped"; reason: string };

/** Claim (schedule, period); null when another run holds it or its request already exists. */
async function claim(scheduleId: string, period: Period): Promise<boolean> {
  const rows = await sql(
    `insert into schedule_requests (schedule_id, period) values ($1, $2)
     on conflict (schedule_id, period) do update set claimed_at = now()
       where schedule_requests.request_id is null
         and schedule_requests.claimed_at < now() - make_interval(mins => $3)
     returning schedule_id`,
    [scheduleId, period, STALE_CLAIM_MINUTES],
  );
  return rows.length === 1;
}

async function release(scheduleId: string, period: Period): Promise<void> {
  await sql(`delete from schedule_requests where schedule_id = $1 and period = $2 and request_id is null`, [scheduleId, period]);
}

async function noteError(scheduleId: string, reason: string | null): Promise<void> {
  await sql(
    `update schedules set last_error = $2, last_error_at = case when $2::text is null then null else now() end where id = $1`,
    [scheduleId, reason],
  );
}

/**
 * Open the request for one (schedule, period), exactly once. The claim row is the lock: a second caller
 * (an overlapping cron run, a retry) finds it and opens nothing. A domain is re-checked over DNS unless the
 * caller has just verified it; a domain that no longer publishes the wallet opens nothing and is retried
 * on the next run, with the reason kept for who_owes_me.
 */
export async function openForPeriod(
  s: ScheduleRow,
  period: Period,
  { verifiedDomain }: { verifiedDomain?: string | null } = {},
): Promise<OpenOutcome> {
  if (s.status !== "active") return { kind: "skipped", reason: `schedule is ${s.status}` };
  if (!(await claim(s.id, period))) return { kind: "exists" };

  let request: RequestRow;
  try {
    let fromDomain: string | null = null;
    if (s.fromDomain) {
      if (verifiedDomain === s.fromDomain) {
        fromDomain = s.fromDomain;
      } else {
        try {
          fromDomain = await requireVerifiedDomain(s.fromDomain, s.recipient);
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          await release(s.id, period);
          const reason = `${s.fromDomain}: ${e.message}`;
          await noteError(s.id, reason);
          return { kind: "skipped", reason };
        }
      }
    }
    request = await createRequest({
      recipient: s.recipient,
      token: s.token,
      amountAtomic: s.amountAtomic,
      payerName: s.payerName,
      forText: s.forText,
      note: null,
      requesterName: s.requesterName,
      flags: s.flags,
      source: s.source,
      fromDomain,
    });
  } catch (e) {
    await release(s.id, period).catch(() => undefined);
    throw e;
  }

  await sql(`update schedule_requests set request_id = $3 where schedule_id = $1 and period = $2`, [s.id, period, request.id]);
  await sql(
    `update schedules
        set last_error = null, last_error_at = null,
            status = case when max_requests is not null
                           and (select count(*) from schedule_requests where schedule_id = $1 and request_id is not null) >= max_requests
                          then 'ended' else status end
      where id = $1`,
    [s.id],
  );
  return { kind: "opened", request };
}

// ---------------------------------------------------------------- the cron

/** Bearer CRON_SECRET, compared in constant time. False when the secret isn't configured. */
export function cronAuthorized(header: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  const want = secret?.trim();
  if (!want || want.length < 16) return false;
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  // Hash both sides so the comparison doesn't depend on (or leak) the secret's length.
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(want, "utf8").digest();
  return timingSafeEqual(a, b);
}


export interface CronOpened {
  schedule_id: string;
  period: Period;
  request_id: string;
}

export interface CronSummary {
  period: Period;
  /** UTC date the run judged "today" by. */
  date: string;
  due: number;
  opened: CronOpened[];
  /** Due but already opened by an overlapping run, or claimed by one right now. */
  already: number;
  skipped: Array<{ schedule_id: string; reason: string }>;
  failed: Array<{ schedule_id: string; error: string }>;
  /** Due schedules left for the next run (batch or time budget). */
  remaining: number;
}

/**
 * Open this month's request for every active schedule whose day has come and that has none yet.
 * Idempotent: a second run in the same month opens nothing for the same schedule.
 */
export async function runDueSchedules({
  now = Date.now(),
  batch = CRON_BATCH,
  budgetMs = CRON_BUDGET_MS,
  concurrency = CRON_CONCURRENCY,
}: { now?: number; batch?: number; budgetMs?: number; concurrency?: number } = {}): Promise<CronSummary> {
  const period = periodOf(now);
  const day = dayOf(now);
  const due = (await sql(
    `select ${COLUMNS}, count(*) over () as total
       from schedules s
      where s.status = 'active' and s.first_period <= $1 and s.day_of_month <= $2
        and not exists (
          select 1 from schedule_requests sr
           where sr.schedule_id = s.id and sr.period = $1
             and (sr.request_id is not null or sr.claimed_at > now() - make_interval(mins => $4)))
      order by s.created_at, s.id
      limit $3`,
    [period, day, batch, STALE_CLAIM_MINUTES],
  ));
  const total = Number(due[0]?.total ?? 0);
  const schedules = due.map(fromRow);
  const summary: CronSummary = { period, date: isoDate(now), due: total, opened: [], already: 0, skipped: [], failed: [], remaining: 0 };

  const deadline = Date.now() + budgetMs;
  let next = 0;
  let started = 0;
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const i = next++;
      if (i >= schedules.length) return;
      started++;
      const s = schedules[i];
      try {
        const outcome = await openForPeriod(s, period);
        if (outcome.kind === "opened") summary.opened.push({ schedule_id: s.id, period, request_id: outcome.request.id });
        else if (outcome.kind === "exists") summary.already++;
        else summary.skipped.push({ schedule_id: s.id, reason: outcome.reason });
      } catch (e) {
        console.error(`schedule ${s.id} ${period}: could not open`, e);
        summary.failed.push({ schedule_id: s.id, error: e instanceof Error ? e.message.slice(0, 200) : "error" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  summary.remaining = total - started;
  summary.opened.sort((a, b) => a.schedule_id.localeCompare(b.schedule_id));
  return summary;
}

// ---------------------------------------------------------------- the ledger's view

export interface ScheduleRequestSummary {
  period: Period;
  id: string;
  link: string;
  status: string;
}

export interface ScheduleSummary {
  id: string;
  status: ScheduleStatus;
  amount: string;
  token: Token;
  payer_name: string | null;
  for: string | null;
  day_of_month: number;
  /** Total monthly requests, or null for every month with no end date. */
  months: number | null;
  requests_opened: number;
  /** "YYYY-MM-DD", UTC; null once ended. */
  next_request_on: string | null;
  created_at: string;
  from_domain: string | null;
  /** Why the last due run opened nothing (the domain stopped publishing the wallet, DNS was down). */
  last_error: string | null;
  /** Newest first, at most SCHEDULE_REQUESTS_LISTED. */
  requests: ScheduleRequestSummary[];
}

export const SCHEDULES_LISTED = 20;
export const SCHEDULE_REQUESTS_LISTED = 12;

/** A recipient's schedules (newest first) with their recent months' requests, for who_owes_me. */
export async function listSchedules(recipient: string, { base, now = Date.now() }: { base: string; now?: number }): Promise<ScheduleSummary[]> {
  const schedules = (await sql(
    `select ${COLUMNS} from schedules where recipient = $1 order by (status = 'active') desc, created_at desc, id limit $2`,
    [recipient, SCHEDULES_LISTED],
  )).map(fromRow);
  if (schedules.length === 0) return [];
  const linked = await sql(
    `select sr.schedule_id, sr.period, sr.request_id, r.status, r.kind,
            count(*) over (partition by sr.schedule_id) as opened,
            row_number() over (partition by sr.schedule_id order by sr.period desc) as n
       from schedule_requests sr
       join requests r on r.id = sr.request_id
      where sr.schedule_id = any($1::text[])`,
    [schedules.map((s) => s.id)],
  );
  const current = periodOf(now);
  return schedules.map((s) => {
    const mine = linked.filter((r) => r.schedule_id === s.id);
    const opened = Number(mine[0]?.opened ?? 0);
    const requests = mine
      .filter((r) => Number(r.n) <= SCHEDULE_REQUESTS_LISTED)
      .sort((a, b) => b.period!.localeCompare(a.period!))
      .map((r) => ({ period: r.period!, id: r.request_id!, link: `${base}/${r.kind === "invoice" ? "i" : "r"}/${r.request_id}`, status: r.status! }));
    return {
      id: s.id,
      status: s.status,
      amount: fromAtomic(s.amountAtomic, s.token),
      token: s.token,
      payer_name: s.payerName,
      for: s.forText,
      day_of_month: s.dayOfMonth,
      months: s.maxRequests,
      requests_opened: opened,
      next_request_on: nextRequestOn({ ...s, opened }, now, mine.some((r) => r.period === current)),
      created_at: s.createdAt,
      from_domain: s.fromDomain,
      last_error: s.lastError,
      requests,
    };
  });
}

/** Which schedule and month opened each of these requests. */
export async function scheduleLinks(requestIds: readonly string[]): Promise<Map<string, { scheduleId: string; period: Period }>> {
  if (requestIds.length === 0) return new Map();
  const rows = await sql(`select request_id, schedule_id, period from schedule_requests where request_id = any($1::text[])`, [requestIds]);
  return new Map(rows.map((r) => [r.request_id!, { scheduleId: r.schedule_id!, period: r.period! }]));
}

/**
 * The ledger plus schedules: each entry says which schedule and month opened it (null for one-off
 * requests), and `schedules` lists the recipient's monthly requests. Applied by POST /api/v1/ledger.
 */
export async function withSchedules<E extends { id: string }, L extends { recipient: string; open: E[]; paid_recently: E[] }>(
  ledger: L,
  { base, now = Date.now() }: { base: string; now?: number },
): Promise<Omit<L, "open" | "paid_recently"> & {
  open: Array<E & { schedule_id: string | null; period: string | null }>;
  paid_recently: Array<E & { schedule_id: string | null; period: string | null }>;
  schedules: ScheduleSummary[];
}> {
  const [links, schedules] = await Promise.all([
    scheduleLinks([...ledger.open, ...ledger.paid_recently].map((e) => e.id)),
    listSchedules(ledger.recipient, { base, now }),
  ]);
  const tag = (e: E) => ({ ...e, schedule_id: links.get(e.id)?.scheduleId ?? null, period: links.get(e.id)?.period ?? null });
  return { ...ledger, open: ledger.open.map(tag), paid_recently: ledger.paid_recently.map(tag), schedules };
}
