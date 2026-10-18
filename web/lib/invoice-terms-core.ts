// F8 invoices: the pure core of invoice terms (installments, early-pay discount, late fee, chase schedule).
// This file is byte-identical in plugin/src/invoice-terms-core.ts and web/lib/invoice-terms-core.ts
// (web/test/invoice-terms.test.ts checks), so the plugin can recompute every amount and date the server returns.
// Rules: money is bigint units (a token's atomic units, or a local currency's minor units); dates are UTC calendar
// days written YYYY-MM-DD; nothing here reads the clock, randomness or the network, and nothing is imported.
//
// A request id commits to its exact amount, so a term that changes what is owed never edits a request: it opens a
// new one. An installment plan is one request per installment; an early-pay discount is two (the early price now,
// the full price after the date); a late fee is one more, for the fee only.

export const INSTALLMENT_COUNT = { min: 2, max: 12 } as const;
/** "interval": "monthly", or a whole number of days between installments. */
export const INTERVAL_DAYS = { min: 7, max: 365 } as const;
/** A later installment's request opens this many days before its due date (the first one opens at once). */
export const OPEN_LEAD_DAYS = 7;
/** The early price stays payable up to 89 days after the invoice is made (requests expire after at most 90). */
export const EARLY_UNTIL_MAX_DAYS = 89;
/** Chase reminders: days after the due date, polite then firm then formal. */
export const CHASE_DEFAULT_DAYS: readonly number[] = [3, 7, 14];
export const CHASE_DAY_MAX = 90;
export const CHASE_TONES = ["polite", "firm", "formal"] as const;
export type ChaseTone = (typeof CHASE_TONES)[number];
/** Percentages have at most 2 decimal places: they are basis points inside. */
export const PERCENT_DECIMALS = 2;

/** A term the caller asked for can't work. The message is shown to the user as is. */
export class TermsError extends Error {}

// ---------------------------------------------------------------- dates (UTC calendar days)

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86_400_000;

/** UTC midnight of a real calendar date, or null. */
export function dayStart(date: string): number | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const t = new Date(ms);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? ms : null;
}

function mustDay(date: string, what: string): number {
  const ms = dayStart(date);
  if (ms === null) throw new TermsError(`${what} ${date} isn't a real date. Use YYYY-MM-DD.`);
  return ms;
}

/** The UTC calendar day of an instant. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return isoDay(mustDay(date, "date") + days * DAY);
}

/** b minus a, in whole days. */
export function daysBetween(a: string, b: string): number {
  return Math.round((mustDay(b, "date") - mustDay(a, "date")) / DAY);
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** `months` calendar months after `date`, keeping its day where the month has it (Jan 31 + 1 = Feb 28 or 29). */
export function addMonths(date: string, months: number): string {
  const ms = mustDay(date, "date");
  const t = new Date(ms);
  const total = t.getUTCFullYear() * 12 + t.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month0 = total - year * 12;
  const day = Math.min(t.getUTCDate(), daysInMonth(year, month0));
  return isoDay(Date.UTC(year, month0, day));
}

const later = (a: string, b: string) => (a >= b ? a : b);

// ---------------------------------------------------------------- amounts

/** `total` in `count` parts that add up to it exactly; the first `total % count` parts get one unit more. */
export function splitUnits(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new TermsError("count must be a whole number of at least 1.");
  if (total < BigInt(count)) throw new TermsError(`The total is too small to split into ${count} parts.`);
  const n = BigInt(count);
  const part = total / n;
  const left = total % n;
  return Array.from({ length: count }, (_, i) => (BigInt(i) < left ? part + 1n : part));
}

const PERCENT_RE = /^(0|[1-9][0-9]{0,2})(?:\.([0-9]{1,2}))?$/;

/** "10" -> 1000n, "2.5" -> 250n (basis points). Over 0, at most 100, at most 2 decimal places. */
export function percentBps(text: string): bigint {
  const m = PERCENT_RE.exec(text);
  if (!m) throw new TermsError(`percent ${text} must be a number like 10 or 2.5 (at most ${PERCENT_DECIMALS} decimal places).`);
  const bps = BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  if (bps <= 0n || bps > 10_000n) throw new TermsError(`percent ${text} must be more than 0 and at most 100.`);
  return bps;
}

/** 250n -> "2.5". */
export function bpsText(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** `bps` of `total`, rounded down to a whole unit. */
export function percentOf(total: bigint, bps: bigint): bigint {
  return (total * bps) / 10_000n;
}

// ---------------------------------------------------------------- installments

export type Interval = "monthly" | number;

export interface InstallmentInput {
  /** The invoice total, in units. */
  totalUnits: bigint;
  count: number;
  interval: Interval;
  /** The first installment's due date. */
  firstDue: string;
  /** The day the invoice is made (UTC). */
  issueDate: string;
}

export interface PlannedInstallment {
  /** 1-based. */
  seq: number;
  units: bigint;
  dueDate: string;
  /** When its request opens: the issue day for the first, else OPEN_LEAD_DAYS before its due date (never before issue). */
  opensOn: string;
}

export function intervalText(interval: Interval): string {
  return interval === "monthly" ? "monthly" : `every ${interval} days`;
}

export function checkInterval(interval: unknown): Interval {
  if (interval === "monthly") return "monthly";
  if (typeof interval === "number" && Number.isInteger(interval) && interval >= INTERVAL_DAYS.min && interval <= INTERVAL_DAYS.max) return interval;
  throw new TermsError(`installments.interval must be "monthly" or a whole number of days from ${INTERVAL_DAYS.min} to ${INTERVAL_DAYS.max}.`);
}

/** One request per installment; the amounts add up to the total exactly and the due dates follow the interval. */
export function planInstallments(i: InstallmentInput): PlannedInstallment[] {
  if (!Number.isInteger(i.count) || i.count < INSTALLMENT_COUNT.min || i.count > INSTALLMENT_COUNT.max) {
    throw new TermsError(`installments.count must be a whole number from ${INSTALLMENT_COUNT.min} to ${INSTALLMENT_COUNT.max}.`);
  }
  const interval = checkInterval(i.interval);
  mustDay(i.firstDue, "installments.first_due");
  mustDay(i.issueDate, "issue date");
  if (i.totalUnits < BigInt(i.count)) throw new TermsError(`The invoice total is too small to split into ${i.count} installments.`);
  const parts = splitUnits(i.totalUnits, i.count);
  return parts.map((units, k) => {
    const dueDate = interval === "monthly" ? addMonths(i.firstDue, k) : addDays(i.firstDue, k * interval);
    const opensOn = k === 0 ? i.issueDate : later(i.issueDate, addDays(dueDate, -OPEN_LEAD_DAYS));
    return { seq: k + 1, units, dueDate, opensOn };
  });
}

// ---------------------------------------------------------------- early-pay discount

export interface EarlyDiscountInput {
  totalUnits: bigint;
  /** Exactly one of amountUnits and bps. */
  amountUnits?: bigint | null;
  bps?: bigint | null;
  /** The last day the early price can be paid (UTC). */
  until: string;
  issueDate: string;
  dueDate: string;
}

export interface PlannedDiscount {
  /** What the early-price request asks for. */
  earlyUnits: bigint;
  discountUnits: bigint;
  bps: bigint | null;
  until: string;
  /** The early-price request stops taking payments at the start of this day (UTC): the day after `until`. */
  earlyExpiresOn: string;
  /** The full-price request opens on this day, unless the early price was paid. */
  fullOpensOn: string;
}

export function planEarlyDiscount(i: EarlyDiscountInput): PlannedDiscount {
  const hasAmount = i.amountUnits !== undefined && i.amountUnits !== null;
  const hasBps = i.bps !== undefined && i.bps !== null;
  if (hasAmount === hasBps) throw new TermsError("early_discount needs exactly one of amount and percent.");
  const discountUnits = hasAmount ? i.amountUnits! : percentOf(i.totalUnits, i.bps!);
  if (discountUnits <= 0n) throw new TermsError("early_discount comes to nothing at this total; use a larger amount or percent.");
  if (discountUnits >= i.totalUnits) throw new TermsError("early_discount must be less than the invoice total.");
  const until = i.until;
  mustDay(until, "early_discount.until");
  const ahead = daysBetween(i.issueDate, until);
  if (ahead < 1) throw new TermsError(`early_discount.until ${until} must be tomorrow or later: the early price needs at least a day.`);
  if (ahead > EARLY_UNTIL_MAX_DAYS) throw new TermsError(`early_discount.until ${until} is more than ${EARLY_UNTIL_MAX_DAYS} days away; Owed requests stop taking payments after 90 days at most.`);
  if (until > i.dueDate) throw new TermsError(`early_discount.until ${until} is after the due date ${i.dueDate}; the early price must end by then.`);
  const next = addDays(until, 1);
  return { earlyUnits: i.totalUnits - discountUnits, discountUnits, bps: hasBps ? i.bps! : null, until, earlyExpiresOn: next, fullOpensOn: next };
}

// ---------------------------------------------------------------- late fee

export interface LateFeeInput {
  totalUnits: bigint;
  amountUnits?: bigint | null;
  bps?: bigint | null;
}

export function planLateFee(i: LateFeeInput): { feeUnits: bigint; bps: bigint | null } {
  const hasAmount = i.amountUnits !== undefined && i.amountUnits !== null;
  const hasBps = i.bps !== undefined && i.bps !== null;
  if (hasAmount === hasBps) throw new TermsError("late_fee needs exactly one of amount and percent.");
  const feeUnits = hasAmount ? i.amountUnits! : percentOf(i.totalUnits, i.bps!);
  if (feeUnits <= 0n) throw new TermsError("late_fee comes to nothing at this total; use a larger amount or percent.");
  return { feeUnits, bps: hasBps ? i.bps! : null };
}

/** The first day a late fee can open: the day after the (first) due date. */
export function lateFeeOpensOn(firstDueDate: string): string {
  return addDays(firstDueDate, 1);
}

/** Paid on time: paid before the end of the due date (UTC). */
export function paidOnTime(paidAt: string | null | undefined, dueDate: string): boolean {
  if (!paidAt) return false;
  const at = Date.parse(paidAt);
  const end = mustDay(dueDate, "due date") + DAY;
  return Number.isFinite(at) && at < end;
}

// ---------------------------------------------------------------- chase schedule

/** 1 to 3 whole days after the due date, each larger than the one before, at most CHASE_DAY_MAX. */
export function checkChaseDays(days: readonly unknown[]): number[] {
  if (!Array.isArray(days) || days.length < 1 || days.length > CHASE_TONES.length) {
    throw new TermsError(`chase.days must list 1 to ${CHASE_TONES.length} days after the due date, e.g. [3, 7, 14].`);
  }
  let last = 0;
  return days.map((d) => {
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > CHASE_DAY_MAX || d <= last) {
      throw new TermsError(`chase.days must be whole days from 1 to ${CHASE_DAY_MAX}, each later than the one before (e.g. [3, 7, 14]).`);
    }
    last = d;
    return d;
  });
}

export interface ChaseStage {
  tone: ChaseTone;
  daysOverdue: number;
  /** The chase day this stage started on (3, 7 or 14 by default). */
  day: number;
  /** The next stage's day, or null at the last one. */
  nextDay: number | null;
}

/** Which reminder is due `today` for something due on `dueDate`; null when none (not overdue enough, or chasing off). */
export function chaseStage(dueDate: string, today: string, days: readonly number[] | null): ChaseStage | null {
  if (!days || days.length === 0) return null;
  const overdue = daysBetween(dueDate, today);
  let stage = -1;
  days.forEach((d, i) => { if (overdue >= d) stage = i; });
  if (stage < 0) return null;
  return { tone: CHASE_TONES[Math.min(stage, CHASE_TONES.length - 1)]!, daysOverdue: overdue, day: days[stage]!, nextDay: days[stage + 1] ?? null };
}

/** write_reminder's tone for a chase stage: polite is its "friendly". */
export function reminderTone(tone: ChaseTone): "friendly" | "firm" | "formal" {
  return tone === "polite" ? "friendly" : tone;
}
