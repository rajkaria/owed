// F8 invoices: terms in create_invoice. The plugin works every term out itself with the core rules (invoice-terms-core.ts,
// byte-identical on the server), so it can refuse a server reply whose plan, prices, fee or dates differ from what the
// user asked, the way checkInvoice refuses a total that isn't the items' sum.
import * as z from "zod/v4";
import type { InvoiceTerms, TermRequest } from "./contract.js";
import { fromMinor, usdcAtomicFor, type FiatCode } from "./fiat.js";
import {
  addDays, bpsText, CHASE_DEFAULT_DAYS, checkChaseDays, checkInterval, intervalText, lateFeeOpensOn, percentBps, planEarlyDiscount, planInstallments,
  planLateFee, TermsError, type Interval, type PlannedDiscount, type PlannedInstallment,
} from "./invoice-terms-core.js";
import type { Token } from "./money.js";

const percentText = z.string().regex(/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/);
const decimalText = z.string().max(40).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const installmentsInput = z.object({
  count: z.number().int().min(2).max(12).describe("How many installments, 2 to 12. The amounts add up to the total exactly; any leftover cents go to the first ones."),
  interval: z.union([z.literal("monthly"), z.number().int().min(7).max(365)]).default("monthly")
    .describe('"monthly" (default: the same day each month, or the month\'s last day) or a whole number of days between installments (7 to 365).'),
  first_due: isoDate.optional().describe("The first installment's due date, YYYY-MM-DD. It is the invoice's due_date; leave it out or pass the same date."),
}).strict().describe("Optional: split the invoice into installments. The first is due on due_date and payable at once; each later one opens 7 days before it is due. The invoice shows Paid only when every installment is.");

export const earlyDiscountInput = z.object({
  amount: decimalText.optional().describe("The discount, in the invoice's prices (token, or currency when given), e.g. \"10\"."),
  percent: percentText.optional().describe("Or the discount as a percent of the total, e.g. \"2\" or \"2.5\" (rounded down to the smallest unit)."),
  until: isoDate.describe("The last day the early price can be paid, YYYY-MM-DD: tomorrow at the earliest, by due_date, within 89 days."),
}).strict().describe("Optional: a lower price for paying early. The invoice asks the early price until `until`; from the next day it asks the full price. Paying one cancels the other.");

export const lateFeeInput = z.object({
  amount: decimalText.optional().describe("The fee, in the invoice's prices (token, or currency when given)."),
  percent: percentText.optional().describe("Or the fee as a percent of the total (rounded down), e.g. \"1.5\"."),
}).strict().describe("Optional: a late fee printed on the invoice now. If the invoice isn't paid by its due date (for installments, any installment by its own), Owed opens one more request for the fee alone, once, the day after. Never if it was paid on time.");

export const chaseInput = z.union([
  z.literal(false),
  z.object({ days: z.array(z.number().int().min(1).max(90)).min(1).max(3).describe("Days after the due date for a polite, a firm and a formal reminder.") }).strict(),
]).describe("Optional: when who_owes_me says a reminder is due (polite, firm, formal). Default: 3, 7 and 14 days after the due date. false turns it off. Owed never sends anything itself.");

export interface TermsArgs {
  installments?: { count: number; interval: Interval; first_due?: string | undefined } | undefined;
  early_discount?: { amount?: string | undefined; percent?: string | undefined; until: string } | undefined;
  late_fee?: { amount?: string | undefined; percent?: string | undefined } | undefined;
  chase?: false | { days: number[] } | undefined;
}

export function hasTermsArgs(a: TermsArgs): boolean {
  return a.installments !== undefined || a.early_discount !== undefined || a.late_fee !== undefined || a.chase !== undefined;
}

export interface LocalPlan {
  installments: PlannedInstallment[] | null;
  interval: Interval | null;
  discount: PlannedDiscount | null;
  lateFee: { feeUnits: bigint; bps: bigint | null } | null;
  chaseDays: number[] | null;
  /** The invoice's own request in item units: installment 1, the early price, or the total. */
  ownUnits: bigint;
  firstDue: string;
}

/** The plan the user asked for, or what to tell them. Units: the token's atomic units, or the currency's minor units. */
export function planLocal(a: TermsArgs, c: {
  totalUnits: bigint; issueDate: string; dueDate: string; currency: FiatCode | null; expiresInDays: number | undefined;
  units: (amount: string) => bigint;
}): { ok: true; plan: LocalPlan } | { ok: false; message: string } {
  try {
    if (a.installments && a.early_discount) return { ok: false, message: "An invoice takes installments or an early-pay discount, not both. Pick one." };
    if (a.installments && c.currency) return { ok: false, message: "Installments are priced in USDC or SOL only: in a local currency each installment would round on its own and they wouldn't add up to the total exactly. Price the invoice in USDC, or drop installments." };
    if ((a.installments || a.early_discount) && c.expiresInDays !== undefined) return { ok: false, message: "expires_in_days can't be combined with installments or an early-pay discount: their later requests open on their own dates. Leave expires_in_days out." };
    let installments: PlannedInstallment[] | null = null;
    let interval: Interval | null = null;
    if (a.installments) {
      const first = a.installments.first_due ?? c.dueDate;
      if (first !== c.dueDate) return { ok: false, message: `With installments, due_date is the first installment's due date, but installments.first_due is ${first} and due_date is ${c.dueDate}. Pass the same date (or leave first_due out).` };
      interval = checkInterval(a.installments.interval);
      installments = planInstallments({ totalUnits: c.totalUnits, count: a.installments.count, interval, firstDue: first, issueDate: c.issueDate });
      const last = installments[installments.length - 1]!.dueDate;
      if (last > addDays(c.issueDate, 3 * 366)) return { ok: false, message: `The last installment would be due ${last}, more than 3 years away. Use fewer installments or a shorter interval.` };
    }
    let discount: PlannedDiscount | null = null;
    if (a.early_discount) {
      const d = a.early_discount;
      discount = planEarlyDiscount({
        totalUnits: c.totalUnits,
        amountUnits: d.amount !== undefined ? c.units(d.amount) : null,
        bps: d.percent !== undefined ? percentBps(d.percent) : null,
        until: d.until, issueDate: c.issueDate, dueDate: c.dueDate,
      });
    }
    let lateFee: LocalPlan["lateFee"] = null;
    if (a.late_fee) {
      lateFee = planLateFee({
        totalUnits: c.totalUnits,
        amountUnits: a.late_fee.amount !== undefined ? c.units(a.late_fee.amount) : null,
        bps: a.late_fee.percent !== undefined ? percentBps(a.late_fee.percent) : null,
      });
    }
    const chaseDays = a.chase === false ? null : a.chase ? checkChaseDays(a.chase.days) : [...CHASE_DEFAULT_DAYS];
    const ownUnits = installments ? installments[0]!.units : discount ? discount.earlyUnits : c.totalUnits;
    return { ok: true, plan: { installments, interval, discount, lateFee, chaseDays, ownUnits, firstDue: installments ? installments[0]!.dueDate : c.dueDate } };
  } catch (error) {
    if (error instanceof TermsError) return { ok: false, message: error.message };
    return { ok: false, message: error instanceof Error ? error.message : "Those terms can't be used." };
  }
}

/** Atomic units of the token for an amount in item units (local currency: the USDC it locks at `rate`). */
export function payAtomicOf(units: bigint, currency: FiatCode | null, rate: string | null): bigint {
  if (!currency) return units;
  if (!rate) throw new Error("a local-currency invoice needs its rate");
  return usdcAtomicFor(fromMinor(units, currency), currency, rate);
}

/**
 * The server's terms must be exactly this plan: every installment's amount, due date and open day; the two prices and
 * the date between them; the fee; the chase days. null when they are, else what to tell the user.
 */
export function checkTerms(t: InvoiceTerms | undefined, plan: LocalPlan, c: { id: string; token: Token; toAtomic: (amount: string, token: Token) => bigint; pay: (units: bigint) => bigint }): string | null {
  const bad = "Owed's server returned invoice terms that don't match what was asked, so the invoice wasn't used. Try again.";
  if (!t) return plan.installments || plan.discount || plan.lateFee ? "This Owed server didn't keep the invoice's terms, so it wasn't used. Create it without installments, discount or late fee, or try again later." : null;
  try {
    const amt = (r: TermRequest) => c.toAtomic(r.amount, c.token);
    if (plan.installments) {
      const p = t.installments?.plan;
      if (!p || p.length !== plan.installments.length) return bad;
      for (const [i, want] of plan.installments.entries()) {
        const got = p[i]!;
        if (got.role !== "installment" || got.seq !== want.seq || got.due_date !== want.dueDate || got.opens_on !== want.opensOn || amt(got) !== c.pay(want.units)) return bad;
      }
      if (p[0]!.id !== c.id) return bad;
    } else if (t.installments) return bad;
    if (plan.discount) {
      const d = t.early_discount;
      if (!d || d.until !== plan.discount.until || amt(d.early) !== c.pay(plan.discount.earlyUnits) || d.early.id !== c.id || d.full.opens_on !== plan.discount.fullOpensOn) return bad;
      if ((plan.discount.bps === null ? null : bpsText(plan.discount.bps)) !== d.percent) return bad;
    } else if (t.early_discount) return bad;
    if (plan.lateFee) {
      const f = t.late_fee;
      if (!f || amt(f.request) !== c.pay(plan.lateFee.feeUnits) || f.applies_after !== plan.firstDue || f.request.opens_on !== lateFeeOpensOn(plan.firstDue)) return bad;
    } else if (t.late_fee) return bad;
    const wantChase = plan.chaseDays === null ? null : plan.chaseDays.join(",");
    const gotChase = t.chase === null ? null : t.chase.days.join(",");
    if (wantChase !== gotChase) return bad;
    return null;
  } catch {
    return bad;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m! - 1] ?? "?"} ${d}, ${y}`;
}

/** One sentence for the client about the terms, or "" (amounts already formatted with their token). */
export function termsSentence(t: InvoiceTerms, token: string, fee?: string): string {
  const parts: string[] = [];
  if (t.installments) {
    const plan = t.installments.plan;
    const rest = plan.slice(1);
    const same = rest.every((r) => r.amount === rest[0]!.amount);
    parts.push(`It is payable in ${plan.length} ${intervalText(t.installments.interval)} installments: ${plan[0]!.amount} ${token} by ${shortDate(plan[0]!.due_date)}, then ${same ? `${rest[0]!.amount} ${token} each` : rest.map((r) => `${r.amount} ${token}`).join(", ")} due ${rest.map((r) => shortDate(r.due_date)).join(", ")}.`);
  }
  if (t.early_discount) {
    const d = t.early_discount;
    parts.push(`Pay ${d.early_price} ${token} by ${shortDate(d.until)}${d.percent ? ` (${d.percent}% off)` : ""}; after that it's ${d.full_price} ${token}.`);
  }
  if (t.late_fee) parts.push(`A late fee of ${fee ?? `${t.late_fee.amount} ${token}`} applies if it isn't paid by ${shortDate(t.late_fee.applies_after)}${t.installments ? " (each installment by its own date)" : ""}.`);
  return parts.join(" ");
}

/** Lines for the user about the terms (who_owes_me and the cron do the rest). */
export function termsLines(t: InvoiceTerms): string[] {
  const lines: string[] = [];
  if (t.installments) {
    lines.push(`Installments: ${t.installments.plan.map((p) => `${p.seq}) ${p.amount} due ${p.due_date}${p.status === "scheduled" ? ` (opens ${p.opens_on})` : ""}`).join("; ")}. Each later installment is its own request and invoice page, opened by Owed 7 days before it is due; the invoice shows Paid only when all are.`);
  }
  if (t.early_discount) {
    const d = t.early_discount;
    lines.push(`Early price ${d.early_price} until ${d.until} (the invoice's own request); the full price ${d.full_price} opens as its own request on ${d.full.opens_on} unless the early price is paid. Paying one cancels the other.`);
  }
  if (t.late_fee) lines.push(`Late fee ${t.late_fee.amount}${t.late_fee.percent ? ` (${t.late_fee.percent}%)` : ""}: opened once, as its own request, the day after ${t.late_fee.applies_after} if it isn't paid on time.`);
  lines.push(t.chase ? `Reminders: who_owes_me says one is due ${t.chase.days.join(", ")} days after the due date (polite, firm, formal); Owed never sends them.` : "Reminders: off for this invoice.");
  return lines;
}
