import { fromAtomic } from "./money";

// F5 autopay within policy: the pure rules, no I/O (lib/autopay.ts stores rules and reads the chain; plugin/src/autopay.ts
// mirrors the message grammar and the dates). A payer's rule says "pay <requester wallet>'s requests up to <max> USDC
// each and <max_month> USDC a month, until <date>". The rule is data: Owed never pays. The payer's signed inbox marks each
// open request against it:
//   eligible     USDC on Solana, open, to the rule's wallet, the rule live, within both limits, no brand-word caution, and
//                the requester's USDC account exists (an x402 payment can't open one). what_do_i_owe then hands the
//                payer's agent the exact PayBox pay_x402 call, which PayBox runs inside its own grant limits.
//   over_limit   the rule covers the requester but this request would break a limit: never paid automatically.
//   not_covered  everything else, with the reason.
// Month = the UTC calendar month. Month-to-date use = what this payer paid this requester since the month began (and
// since the rule was made), plus the eligible lines listed before this one: lines are judged oldest first, so two
// 1,000 USDC requests under a 1,500 USDC monthly cap give eligible, then over_limit.

export const AUTOPAY_PURPOSE = "autopay";
export const AUTOPAY_REVOKE_PURPOSE = "autopay_revoke";
/** The create message names two wallets, two amounts and two dates: longer than the 200-character inbox messages. */
export const AUTOPAY_MESSAGE_MAX_CHARS = 300;
/** No single rule may allow more than this per request or per month (1,000,000 USDC). */
export const AUTOPAY_MAX_ATOMIC = 1_000_000_000_000n;
/** Rules are listed back to the payer for a month after they end. */
export const AUTOPAY_ENDED_LISTED_DAYS = 31;

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface RuleTerms {
  payer: string;
  /** The wallet the requests pay (requests.recipient). */
  requester: string;
  maxPerRequestAtomic: bigint;
  maxPerMonthAtomic: bigint;
  /** The rule's last day, YYYY-MM-DD (UTC). */
  ends: string;
}

/** Everything before " (at <ISO time>)": the server rebuilds it from the stored fields, the plugin from its arguments. */
export function autopayPrefix(t: RuleTerms): string {
  return `Owed autopay for ${t.payer}: pay ${t.requester} up to ${fromAtomic(t.maxPerRequestAtomic, "USDC")} USDC per request and ${fromAtomic(t.maxPerMonthAtomic, "USDC")} USDC per month until ${t.ends}`;
}

/** "2026-10-18T10:15:00Z": whole seconds, UTC. */
export function isoSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function autopayMessage(t: RuleTerms, nowMs: number): string {
  return `${autopayPrefix(t)} (at ${isoSecond(nowMs)})`;
}

/** Everything before " at <ISO time>" (the usual signed-message form, lib/verify-signature.ts). */
export function revokePrefix(ruleId: string, payer: string): string {
  return `Owed autopay revoke ${ruleId} for ${payer}`;
}

/** Midnight UTC of a YYYY-MM-DD date, or null for anything that isn't a real date. */
export function dayStart(date: string): number | null {
  const m = ISO_DATE.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The latest last day a rule made at `nowMs` may have: the same date a year later (Feb 29 → Mar 1). */
export function latestEnds(nowMs: number): string {
  const n = new Date(nowMs);
  return isoDate(Date.UTC(n.getUTCFullYear() + 1, n.getUTCMonth(), n.getUTCDate()));
}

/**
 * When a rule ending on `ends` stops: the start of the next UTC day. Null with the reason when `ends` isn't a date from
 * today to a year from today.
 */
export function endsAtFor(ends: string, nowMs: number): { ok: true; endsAtMs: number } | { ok: false; message: string } {
  const start = dayStart(ends);
  if (start === null) return { ok: false, message: "ends must be a date written YYYY-MM-DD" };
  const today = dayStart(isoDate(nowMs))!;
  if (start < today) return { ok: false, message: `ends (${ends}) is in the past; give the rule's last day, today (${isoDate(nowMs)}) or later` };
  const latest = latestEnds(nowMs);
  if (start > dayStart(latest)!) return { ok: false, message: `ends can be at most a year away (${latest} at the latest)` };
  return { ok: true, endsAtMs: start + DAY_MS };
}

/** "2026-10": the UTC month of `ms`, and when it began. */
export function monthOf(ms: number): { label: string; startMs: number } {
  const d = new Date(ms);
  return { label: d.toISOString().slice(0, 7), startMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
}

/** Checks the two limits as atomic USDC; the reason names the field. */
export function limitProblem(maxPerRequest: bigint, maxPerMonth: bigint): string | null {
  if (maxPerRequest <= 0n) return "max_per_request must be more than 0";
  if (maxPerRequest > AUTOPAY_MAX_ATOMIC) return "max_per_request can be at most 1000000 USDC";
  if (maxPerMonth > AUTOPAY_MAX_ATOMIC) return "max_per_month can be at most 1000000 USDC";
  if (maxPerMonth < maxPerRequest) return "max_per_month must be at least max_per_request";
  return null;
}

// ---------------------------------------------------------------------------------------------- verdicts

export type AutopayStatus = "eligible" | "over_limit" | "not_covered";

export interface AutopayVerdict {
  status: AutopayStatus;
  /** The rule that decided it (absent when no rule covers the requester). */
  rule_id?: string;
  reason: string;
}

/** A rule as the verdicts need it. `usedThisMonthAtomic`: paid to the requester this UTC month since the rule was made. */
export interface VerdictRule {
  id: string;
  requester: string;
  maxPerRequestAtomic: bigint;
  maxPerMonthAtomic: bigint;
  endsAtMs: number;
  revokedAtMs: number | null;
  usedThisMonthAtomic: bigint;
}

/** One inbox line as the verdicts need it. */
export interface VerdictLine {
  id: string;
  chain: "solana" | "base";
  token: "USDC" | "SOL";
  status: "open" | "underpaid";
  recipient: string;
  amountAtomic: bigint;
  flags: string[];
}

/** Whether the requester's USDC account exists: x402 can't open one. "unknown" = Solana couldn't be read in time. */
export type UsdcAccount = "exists" | "missing" | "unknown";

const usdc = (atomic: bigint) => `${fromAtomic(atomic, "USDC")} USDC`;
const day = (ms: number) => isoDate(ms);

/**
 * Every line's verdict, in the order given (oldest first). `rules` maps a requester wallet to the rule that applies: the
 * live one, else the most recently revoked one (so the line can say it was revoked). `account(recipient)` is consulted
 * only for lines that pass every other check.
 */
export function autopayVerdicts(
  lines: readonly VerdictLine[], rules: ReadonlyMap<string, VerdictRule>, account: (recipient: string) => UsdcAccount, nowMs: number,
): AutopayVerdict[] {
  const used = new Map<string, bigint>();
  return lines.map((line) => {
    const rule = rules.get(line.recipient);
    if (!rule) return { status: "not_covered", reason: "No autopay rule covers this requester's wallet." };
    const rule_id = rule.id;
    if (rule.revokedAtMs !== null) return { status: "not_covered", rule_id, reason: `The autopay rule for this wallet was revoked on ${day(rule.revokedAtMs)}.` };
    if (nowMs >= rule.endsAtMs) return { status: "not_covered", rule_id, reason: `The autopay rule for this wallet ended on ${day(rule.endsAtMs - DAY_MS)}.` };
    if (line.chain !== "solana" || line.token !== "USDC") return { status: "not_covered", rule_id, reason: "Autopay pays USDC requests on Solana only (x402 is USDC-only)." };
    if (line.status !== "open") return { status: "not_covered", rule_id, reason: "It is partly paid already; pay the rest by hand." };
    if (line.flags.some((f) => f.startsWith("brand_word:"))) {
      return { status: "not_covered", rule_id, reason: "It mentions a brand word scams use, so it is never paid automatically; pay it by hand only if the user recognises it." };
    }
    if (line.amountAtomic > rule.maxPerRequestAtomic) {
      return { status: "over_limit", rule_id, reason: `${usdc(line.amountAtomic)} is above the rule's ${usdc(rule.maxPerRequestAtomic)} per request.` };
    }
    const before = used.get(rule.id) ?? rule.usedThisMonthAtomic;
    const after = before + line.amountAtomic;
    if (after > rule.maxPerMonthAtomic) {
      return { status: "over_limit", rule_id, reason: `Paying it would make ${usdc(after)} this month (UTC), above the rule's ${usdc(rule.maxPerMonthAtomic)} per month (${usdc(before)} already counted).` };
    }
    const acct = account(line.recipient);
    if (acct === "missing") {
      return { status: "not_covered", rule_id, reason: "The requester's wallet has no USDC account yet, and an x402 payment can't open one; pay it by hand with pay_link (rail solana_pay)." };
    }
    if (acct === "unknown") return { status: "not_covered", rule_id, reason: "Solana couldn't be read to check the requester's USDC account just now; read the inbox again shortly." };
    used.set(rule.id, after);
    return {
      status: "eligible", rule_id,
      reason: `Within the rule: ${usdc(line.amountAtomic)} of ${usdc(rule.maxPerRequestAtomic)} per request, ${usdc(after)} of ${usdc(rule.maxPerMonthAtomic)} this month (UTC).`,
    };
  });
}

/** The requester wallets whose lines would be eligible if their USDC account exists: the only ones worth a chain read. */
export function candidateRecipients(lines: readonly VerdictLine[], rules: ReadonlyMap<string, VerdictRule>, nowMs: number): string[] {
  const verdicts = autopayVerdicts(lines, rules, () => "exists", nowMs);
  return [...new Set(lines.filter((_, i) => verdicts[i]!.status === "eligible").map((l) => l.recipient))];
}
