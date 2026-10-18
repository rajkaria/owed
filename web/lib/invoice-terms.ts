import "server-only";
import { DbError, sql, type Query, type Row } from "./db";
import { ApiError } from "./http";
import { AmountError, fromAtomic, toAtomic, type Token } from "./money";
import { FiatError, fromMinor, toMinor, type FiatCode } from "./fiat";
import type { LockedRate } from "./fx";
import {
  createInvoice, fit, getInvoice, insertInvoice, invoiceForText, INVOICE_TEXT_LIMITS, loadInvoice, priceItems, toPublicInvoice,
  type CreateInvoiceInput, type InvoiceLine, type InvoiceRow, type InvoiceWithRequest, type PublicInvoice,
} from "./invoices";
import { requireVerifiedDomain } from "./payee";
import { getRequests, settleFromChain, type RequestRow } from "./requests";
import type { RpcOptions } from "./solana";
import type { RequestStatus } from "./public-api";
import { refundsOf, refundTotals, confirmRefundsSoft, confirmPendingRefunds, type RefundRow } from "./refunds";
import {
  addDays, chaseStage, CHASE_DEFAULT_DAYS, checkChaseDays, checkInterval, isoDay, lateFeeOpensOn, paidOnTime, percentBps,
  planEarlyDiscount, planInstallments, planLateFee, bpsText, intervalText, TermsError,
  type Interval, type PlannedDiscount, type PlannedInstallment,
} from "./invoice-terms-core";

// F8 invoices: terms on an invoice (0021). The pure rules (amounts, dates, chase stages) live in invoice-terms-core.ts,
// byte-identical in the plugin; this file stores them, opens the requests they need on the daily cron, and reads an
// invoice's terms back for its page, its API and who_owes_me.
//
// A request id commits to its exact amount, so nothing here edits a request's amount. The invoice's own request (same
// id as the invoice) asks for installment 1, or the early price. Every later request is a whole invoice of its own:
// an invoices row and a kind 'invoice' request written in one transaction by lib/invoices.ts insertInvoice, linked
// here by invoice_term_requests. The cron opens:
//   - installment k (k >= 2): OPEN_LEAD_DAYS (7) before its due date, unless the invoice was cancelled;
//   - the full price: the day after the early price ends, unless the early price was paid (the 0021 trigger also
//     cancels whichever price is left the moment the other one is paid);
//   - the late fee: once, the day after the due date (for installments, the first one missed), only when the invoice
//     wasn't paid on time; never when it was, or when it was cancelled or expired.
// Installments are opened on the scheduler rather than all at once, so a client never sees later installments as
// owed before their time and who_owes_me counts only what is open (DECISION documented in .ocean/notes/sp7-docs.md).

/** A claim older than this belongs to a run that died; the next run may retry the row. */
export const TERM_STALE_CLAIM_MINUTES = 10;
export const TERM_CRON_BATCH = 200;
export const TERM_CRON_CONCURRENCY = 4;
/** The cron route gives schedules 40 s first; terms get what is left of Vercel's 60 s. */
export const TERM_CRON_BUDGET_MS = 12_000;
/** Chain read before a term decision (was the early price paid? was it paid on time?). */
export const TERM_CHAIN_BUDGET_MS = 2500;

// ---------------------------------------------------------------- the create body

export interface TermsBody {
  installments?: { count: number; interval?: Interval | null; first_due?: string | null } | null;
  early_discount?: { amount?: string | null; percent?: string | null; until: string } | null;
  late_fee?: { amount?: string | null; percent?: string | null } | null;
  chase?: false | { days: number[] } | null;
}

export function hasTerms(b: TermsBody): boolean {
  return b.installments != null || b.early_discount != null || b.late_fee != null || b.chase != null;
}

export interface PlannedTerms {
  installments: PlannedInstallment[] | null;
  interval: Interval | null;
  discount: PlannedDiscount | null;
  lateFee: { feeUnits: bigint; bps: bigint | null } | null;
  /** null: chasing is off. */
  chaseDays: number[] | null;
  /** The invoice's own request, in item units: installment 1, the early price, or the total. */
  ownUnits: bigint;
  /** The first due date: installment 1's, or the invoice's. */
  firstDue: string;
}

export interface PlanContext {
  /** The items' total in item units. */
  totalUnits: bigint;
  token: Token;
  currency: FiatCode | null;
  /** UTC day the invoice is made. */
  issueDate: string;
  dueDate: string;
  expiresInDays: number | null;
}

const isDefaultChase = (days: number[] | null) =>
  days !== null && days.length === CHASE_DEFAULT_DAYS.length && days.every((d, i) => d === CHASE_DEFAULT_DAYS[i]);

/** Every term checked and worked out, before anything is written. Throws AmountError (user-facing). */
export function planTerms(b: TermsBody, c: PlanContext): PlannedTerms {
  const units = (amount: string, what: string): bigint => {
    try {
      return c.currency ? toMinor(amount, c.currency) : toAtomic(amount, c.token);
    } catch (e) {
      if (e instanceof AmountError || e instanceof FiatError) throw new AmountError(`${what}: ${e.message}`);
      throw e;
    }
  };
  try {
    if (b.installments && b.early_discount) throw new TermsError("an invoice takes installments or an early-pay discount, not both");
    if (b.installments && c.currency) {
      throw new TermsError("installments are priced in USDC or SOL only: in a local currency each installment would round on its own and they wouldn't add up to the total exactly");
    }
    if ((b.installments || b.early_discount) && c.expiresInDays) {
      throw new TermsError("expires_in_days can't be combined with installments or an early-pay discount: their later requests open on their own dates");
    }
    let installments: PlannedInstallment[] | null = null;
    let interval: Interval | null = null;
    if (b.installments) {
      const first = b.installments.first_due ?? c.dueDate;
      if (first !== c.dueDate) throw new TermsError(`with installments, due_date is the first installment's due date: installments.first_due ${first} differs from due_date ${c.dueDate}`);
      interval = checkInterval(b.installments.interval ?? "monthly");
      installments = planInstallments({ totalUnits: c.totalUnits, count: b.installments.count, interval, firstDue: first, issueDate: c.issueDate });
      const last = installments[installments.length - 1]!.dueDate;
      if (last > addDays(c.issueDate, 3 * 366)) throw new TermsError(`the last installment would be due ${last}, more than 3 years away`);
    }
    let discount: PlannedDiscount | null = null;
    if (b.early_discount) {
      const d = b.early_discount;
      discount = planEarlyDiscount({
        totalUnits: c.totalUnits,
        amountUnits: d.amount != null ? units(d.amount, "early_discount.amount") : null,
        bps: d.percent != null ? percentBps(d.percent) : null,
        until: d.until, issueDate: c.issueDate, dueDate: c.dueDate,
      });
    }
    let lateFee: PlannedTerms["lateFee"] = null;
    if (b.late_fee) {
      lateFee = planLateFee({
        totalUnits: c.totalUnits,
        amountUnits: b.late_fee.amount != null ? units(b.late_fee.amount, "late_fee.amount") : null,
        bps: b.late_fee.percent != null ? percentBps(b.late_fee.percent) : null,
      });
    }
    const chaseDays = b.chase === false ? null : b.chase ? checkChaseDays(b.chase.days) : [...CHASE_DEFAULT_DAYS];
    const ownUnits = installments ? installments[0]!.units : discount ? discount.earlyUnits : c.totalUnits;
    return { installments, interval, discount, lateFee, chaseDays, ownUnits, firstDue: installments ? installments[0]!.dueDate : c.dueDate };
  } catch (e) {
    if (e instanceof TermsError) throw new AmountError(e.message);
    throw e;
  }
}

/** Whether a plan needs an invoice_terms row (anything other than the default chase schedule). */
export function needsTermsRow(p: PlannedTerms): boolean {
  return p.installments !== null || p.discount !== null || p.lateFee !== null || !isDefaultChase(p.chaseDays);
}

/** Every amount a plan will ever ask for, in item units (the smallest must reach Solana's new-wallet minimum). */
export function plannedAmounts(p: PlannedTerms, totalUnits: bigint): bigint[] {
  return [
    ...(p.installments ?? []).map((i) => i.units),
    ...(p.discount ? [p.discount.earlyUnits, totalUnits] : []),
    ...(p.lateFee ? [p.lateFee.feeUnits] : []),
  ];
}

// ---------------------------------------------------------------- storage

export type TermRole = "installment" | "early_price" | "full_price" | "late_fee";
export type TermState = "scheduled" | "opened" | "skipped";

export interface TermRow {
  invoiceId: string;
  role: TermRole;
  seq: number;
  amountAtomic: bigint;
  units: bigint;
  dueDate: string;
  opensOn: string;
  state: TermState;
  requestId: string | null;
  skipReason: string | null;
  lastError: string | null;
}

export interface TermsRow {
  invoiceId: string;
  installmentCount: number | null;
  installmentInterval: Interval | null;
  earlyUnits: bigint | null;
  earlyDiscountUnits: bigint | null;
  earlyBps: bigint | null;
  earlyUntil: string | null;
  lateFeeUnits: bigint | null;
  lateFeeBps: bigint | null;
  /** null: chasing off. */
  chaseDays: number[] | null;
}

const TERM_COLUMNS = `invoice_id, role, seq, amount_atomic::text as amount_atomic, units::text as units,
  to_char(due_date, 'YYYY-MM-DD') as due_date, to_char(opens_on, 'YYYY-MM-DD') as opens_on, state, request_id, skip_reason, last_error`;

const TERMS_COLUMNS = `invoice_id, installment_count, installment_interval, early_units::text as early_units,
  early_discount_units::text as early_discount_units, early_bps, to_char(early_until, 'YYYY-MM-DD') as early_until,
  late_fee_units::text as late_fee_units, late_fee_bps, array_to_json(chase_days)::text as chase_days`;

const ROLE_ORDER: Record<TermRole, number> = { early_price: 0, installment: 1, full_price: 2, late_fee: 3 };

function termFromRow(r: Row): TermRow {
  return {
    invoiceId: r.invoice_id!, role: r.role as TermRole, seq: Number(r.seq), amountAtomic: BigInt(r.amount_atomic!), units: BigInt(r.units!),
    dueDate: r.due_date!, opensOn: r.opens_on!, state: r.state as TermState, requestId: r.request_id, skipReason: r.skip_reason, lastError: r.last_error,
  };
}

function termsFromRow(r: Row): TermsRow {
  const interval = r.installment_interval;
  const big = (v: string | null) => (v == null ? null : BigInt(v));
  return {
    invoiceId: r.invoice_id!,
    installmentCount: r.installment_count == null ? null : Number(r.installment_count),
    installmentInterval: interval == null ? null : interval === "monthly" ? "monthly" : Number(interval),
    earlyUnits: big(r.early_units), earlyDiscountUnits: big(r.early_discount_units), earlyBps: big(r.early_bps), earlyUntil: r.early_until,
    lateFeeUnits: big(r.late_fee_units), lateFeeBps: big(r.late_fee_bps),
    chaseDays: r.chase_days == null ? null : (JSON.parse(r.chase_days) as number[]),
  };
}

/** The statements that store a plan, appended to the invoice's own insert transaction (lib/invoices.ts insertInvoice). */
export function termQueries(id: string, p: PlannedTerms, c: Pick<PlanContext, "issueDate" | "dueDate" | "totalUnits">, payAtomic: (units: bigint) => bigint): Query[] {
  const queries: Query[] = [];
  if (needsTermsRow(p)) queries.push({ text: `update invoices set extras = true where id = $1`, params: [id] });
  if (needsTermsRow(p)) {
    queries.push({
      text: `insert into invoice_terms (invoice_id, installment_count, installment_interval, early_units, early_discount_units, early_bps,
               early_until, late_fee_units, late_fee_bps, chase_days)
             values ($1, $2::smallint, $3, $4::numeric, $5::numeric, $6::smallint, $7::date, $8::numeric, $9::smallint, $10::smallint[])`,
      params: [
        id, p.installments ? p.installments.length : null, p.interval === null ? null : String(p.interval),
        p.discount?.earlyUnits ?? null, p.discount?.discountUnits ?? null, p.discount?.bps ?? null, p.discount?.until ?? null,
        p.lateFee?.feeUnits ?? null, p.lateFee?.bps ?? null, p.chaseDays === null ? null : p.chaseDays.map(String),
      ],
    });
  }
  const row = (role: TermRole, seq: number, units: bigint, dueDate: string, opensOn: string, opened: boolean): Query => ({
    text: `insert into invoice_term_requests (invoice_id, role, seq, amount_atomic, units, due_date, opens_on, state, request_id)
           values ($1, $2, $3::smallint, $4::numeric, $5::numeric, $6::date, $7::date, $8, $9)`,
    params: [id, role, seq, payAtomic(units), units, dueDate, opensOn, opened ? "opened" : "scheduled", opened ? id : null],
  });
  for (const i of p.installments ?? []) queries.push(row("installment", i.seq, i.units, i.dueDate, i.opensOn, i.seq === 1));
  if (p.discount) {
    queries.push(row("early_price", 1, p.discount.earlyUnits, p.discount.until, c.issueDate, true));
    queries.push(row("full_price", 1, c.totalUnits, c.dueDate, p.discount.fullOpensOn, false));
    // The early price stops taking payments at the start of the day after `until` (UTC), when the full price opens.
    queries.push({ text: `update requests set expires_at = ($2 || 'T00:00:00Z')::timestamptz where id = $1`, params: [id, p.discount.earlyExpiresOn] });
  }
  if (p.lateFee) queries.push(row("late_fee", 1, p.lateFee.feeUnits, p.firstDue, lateFeeOpensOn(p.firstDue), false));
  return queries;
}

// ---------------------------------------------------------------- create

export interface CreatedWithTerms {
  created: InvoiceWithRequest;
  planned: PlannedTerms | null;
}

/** An invoice and its terms in one transaction; installments due to open today open right after. */
export async function createInvoiceWithTerms(input: CreateInvoiceInput, terms: TermsBody, now: number = Date.now()): Promise<CreatedWithTerms> {
  if (!hasTerms(terms)) return { created: await createInvoice(input, now), planned: null };
  const issueDate = isoDay(now);
  // prepareInvoice's checks ran in the route already; the item total in item units is what the plan splits.
  const totalUnits = priceItems(input.items, input.token, input.currency ?? null).totalAtomic;
  const ctx: PlanContext = { totalUnits, token: input.token, currency: input.currency ?? null, issueDate, dueDate: input.dueDate, expiresInDays: input.expiresInDays ?? null };
  const planned = planTerms(terms, ctx);
  const count = planned.installments?.length ?? 0;
  const created = await createInvoice({
    ...input,
    ownUnits: planned.ownUnits,
    forSuffix: count ? `· 1 of ${count}` : planned.discount ? "· early price" : null,
    extraQueries: (id, payAtomic) => termQueries(id, planned, ctx, payAtomic),
  }, now);
  if (planned.installments?.some((i) => i.seq > 1 && i.opensOn <= issueDate)) {
    // Installments whose open day is today (a short interval): opened now, as the cron would on its next run.
    await openDueForInvoice(created.invoice.id, now).catch((e: unknown) => console.error(`invoice ${created.invoice.id}: opening today's installments`, e));
  }
  return { created, planned };
}

// ---------------------------------------------------------------- reading an invoice's terms

export interface TermsBundle {
  invoice: InvoiceRow;
  /** The invoice's own request (same id). */
  own: RequestRow;
  terms: TermsRow | null;
  rows: TermRow[];
  /** Every request the plan opened, by id (own included). */
  requests: Map<string, RequestRow>;
  /** Requests cancelled because the invoice's other price was paid: id -> the paid request's id (0021 trigger). */
  superseded: Map<string, string>;
  refunds: RefundRow[];
}

/** requests.superseded_by (0021), which lib/requests.ts doesn't read. */
export async function supersededOf(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await sql(`select id, superseded_by from requests where id = any($1::text[]) and superseded_by is not null`, [ids]);
  return new Map(rows.map((r) => [r.id!, r.superseded_by!]));
}

export async function termRowsOf(invoiceId: string): Promise<{ terms: TermsRow | null; rows: TermRow[] }> {
  const [t, r] = await Promise.all([
    sql(`select ${TERMS_COLUMNS} from invoice_terms where invoice_id = $1`, [invoiceId]),
    sql(`select ${TERM_COLUMNS} from invoice_term_requests where invoice_id = $1`, [invoiceId]),
  ]);
  const rows = r.map(termFromRow).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.seq - b.seq);
  return { terms: t.length ? termsFromRow(t[0]) : null, rows };
}

export interface TermLink {
  /** The invoice whose plan opened this one. */
  invoiceId: string;
  role: TermRole;
  seq: number;
  /** Installments in the plan. */
  count: number | null;
}

/** Which plan opened this invoice (an installment, the full price or a late fee), or null for an invoice of its own. */
export async function termLinkOf(id: string): Promise<TermLink | null> {
  const rows = await sql(
    `select t.invoice_id, t.role, t.seq, it.installment_count
       from invoice_term_requests t left join invoice_terms it on it.invoice_id = t.invoice_id
      where t.request_id = $1 and t.invoice_id <> $1`,
    [id],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { invoiceId: r.invoice_id!, role: r.role as TermRole, seq: Number(r.seq), count: r.installment_count == null ? null : Number(r.installment_count) };
}

/**
 * An invoice with its terms, its plan's requests and their refunds. With `rpc`, open requests (and pending refunds) are
 * checked on chain first; a chain that can't be read leaves the stored state. Null when the invoice doesn't load.
 */
export async function loadTermsBundle(id: string, rpc: RpcOptions | null = null): Promise<TermsBundle | null> {
  const loaded = await loadInvoice(id, rpc);
  if (!loaded) return null;
  // An invoice without terms, plan or refunds (invoices.extras false) is read exactly as before: nothing else to load.
  if (!loaded.invoice.extras) return { invoice: loaded.invoice, own: loaded.request, terms: null, rows: [], requests: new Map([[id, loaded.request]]), superseded: new Map(), refunds: [] };
  const { terms, rows } = await termRowsOf(id);
  const ids = [...new Set(rows.flatMap((r) => (r.requestId && r.requestId !== id ? [r.requestId] : [])))];
  const requests = new Map<string, RequestRow>([[id, loaded.request]]);
  if (ids.length) {
    let others = [...(await getRequests(ids)).values()];
    if (rpc) {
      try {
        others = await settleFromChain(others, rpc);
      } catch {
        // stored state
      }
    }
    for (const r of others) requests.set(r.id, r);
  }
  let refunds = await refundsOf([...requests.keys()]);
  if (rpc) refunds = (await confirmRefundsSoft(refunds, rpc)).refunds;
  const superseded = await supersededOf([...requests.keys()]);
  return { invoice: loaded.invoice, own: loaded.request, terms, rows, requests, superseded, refunds };
}

// ---------------------------------------------------------------- the invoice as a whole

export interface InvoiceLevel {
  status: RequestStatus;
  /** Paid toward the invoice so far (each request counted up to its own amount), in the token's atomic units. */
  paidAtomic: bigint;
  /** What is still owed on the invoice (the current price for an early-pay invoice). */
  remainingAtomic: bigint;
  /** The request to pay right now, or null (paid, cancelled, or the next one hasn't opened yet). */
  payNow: { row: TermRow | null; request: RequestRow; dueAtomic: bigint } | null;
  /** Early-pay invoices: which price was paid. */
  paidWith: "early" | "full" | null;
  /** The latest payment toward the invoice. */
  latest: RequestRow | null;
}

const paidOf = (r: RequestRow) => (r.status === "paid" || r.status === "underpaid" ? (r.paidAmountAtomic ?? 0n) : 0n);
const capped = (r: RequestRow) => { const p = paidOf(r); return p > r.amountAtomic ? r.amountAtomic : p; };
const due = (r: RequestRow) => (r.status === "underpaid" ? r.amountAtomic - capped(r) : r.amountAtomic);
/** Payable by its link right now: open (an underpaid request's link would send the whole amount again). */
const payable = (r: RequestRow | undefined): r is RequestRow => !!r && r.status === "open";
/** Cancelled by the recipient's own signed message (not superseded by a payment): the invoice is withdrawn. */
export const cancelledByRecipient = (r: RequestRow | undefined) => !!r && r.status === "cancelled" && !!r.cancelMessage;

function latestOf(rs: RequestRow[]): RequestRow | null {
  const paid = rs.filter((r) => paidOf(r) > 0n && r.paidAt).sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""));
  return paid[0] ?? null;
}

export function invoiceLevel(b: Pick<TermsBundle, "invoice" | "own" | "rows" | "requests">): InvoiceLevel {
  const req = (t: TermRow | undefined) => (t?.requestId ? b.requests.get(t.requestId) : undefined);
  const plan = b.rows.filter((t) => t.role === "installment");
  if (plan.length > 0) {
    const reqs = plan.map(req);
    const opened = reqs.filter((r): r is RequestRow => !!r);
    const paidAtomic = opened.reduce((s, r) => s + capped(r), 0n);
    const allPaid = reqs.every((r) => r?.status === "paid");
    const next = plan.find((t) => payable(req(t)));
    const status: RequestStatus = allPaid ? "paid" : cancelledByRecipient(b.own) ? "cancelled" : paidAtomic > 0n ? "underpaid" : "open";
    const total = b.invoice.totalAtomic;
    return {
      status, paidAtomic, remainingAtomic: total > paidAtomic ? total - paidAtomic : 0n,
      payNow: status === "cancelled" || !next ? null : { row: next, request: req(next)!, dueAtomic: due(req(next)!) },
      paidWith: null, latest: latestOf(opened),
    };
  }
  const earlyRow = b.rows.find((t) => t.role === "early_price");
  if (earlyRow) {
    const early = req(earlyRow) ?? b.own;
    const fullRow = b.rows.find((t) => t.role === "full_price");
    const full = req(fullRow);
    const latest = latestOf([early, ...(full ? [full] : [])]);
    if (early.status === "paid" || full?.status === "paid") {
      const winner = early.status === "paid" ? early : full!;
      return { status: "paid", paidAtomic: capped(winner), remainingAtomic: 0n, payNow: null, paidWith: winner === early ? "early" : "full", latest };
    }
    const partly = [early, full].find((r) => r?.status === "underpaid");
    const current = payable(early) ? early : payable(full) ? full : null;
    const currentRow = current === early ? earlyRow : current ? fullRow! : null;
    const status: RequestStatus = partly ? "underpaid"
      : cancelledByRecipient(b.own) && !payable(full) ? "cancelled"
      : "open";
    const price = current?.amountAtomic ?? (full?.amountAtomic ?? fullRow?.amountAtomic ?? b.invoice.totalAtomic);
    const paidAtomic = partly ? capped(partly) : 0n;
    return {
      status, paidAtomic, remainingAtomic: price > paidAtomic ? price - paidAtomic : 0n,
      payNow: status === "cancelled" || !current ? null : { row: currentRow, request: current, dueAtomic: due(current) },
      paidWith: null, latest,
    };
  }
  // A plain invoice (perhaps with a late fee or its own chase days): the invoice is its own request.
  const own = b.own;
  return {
    status: own.status, paidAtomic: capped(own), remainingAtomic: own.status === "paid" ? 0n : due(own),
    payNow: payable(own) ? { row: null, request: own, dueAtomic: due(own) } : null,
    paidWith: null, latest: paidOf(own) > 0n ? own : null,
  };
}

// ---------------------------------------------------------------- public shape (contract: invoice.terms.*.json)

export type TermRequestStatus = RequestStatus | "scheduled" | "skipped";

export interface PublicTermRequest {
  role: TermRole;
  seq: number;
  /** What its request asks (USDC or SOL). */
  amount: string;
  /** Local-currency invoices: the same in the invoice's currency. */
  fiat_amount?: string;
  /** installment, early_price, full_price: its due date. late_fee: the due date it applies after. */
  due_date: string;
  opens_on: string;
  status: TermRequestStatus;
  id: string | null;
  link: string | null;
  skip_reason: string | null;
  paid?: { amount: string; at: string; signature: string; on_time: boolean };
  /** Cancelled because the other price was paid: that request's id. */
  superseded_by?: string;
}

export interface PublicTerms {
  status: RequestStatus;
  paid_so_far: string;
  remaining: string;
  pay_now: { id: string; link: string; amount: string; due_date: string | null; role: TermRole | "invoice"; seq: number | null } | null;
  installments: { count: number; interval: Interval; interval_label: string; plan: PublicTermRequest[] } | null;
  early_discount: {
    early_price: string;
    full_price: string;
    discount: string;
    percent: string | null;
    until: string;
    early: PublicTermRequest;
    full: PublicTermRequest;
    paid_with: "early" | "full" | null;
  } | null;
  late_fee: { amount: string; percent: string | null; applies_after: string; request: PublicTermRequest } | null;
  /** Days after the due date for a polite, firm and formal reminder; null = off. */
  chase: { days: number[] } | null;
  /** Confirmed refunds on the invoice's requests. */
  refunded: string;
}

export interface PublicTermOf {
  invoice_id: string;
  link: string;
  role: TermRole;
  seq: number;
  count: number | null;
  /** "Installment 2 of 3", "Full price", "Late fee". */
  label: string;
}

export interface PublicRefundLine {
  id: string;
  request_id: string;
  amount: string;
  status: RefundRow["status"];
  confirmed_at?: string;
  signature?: string;
}

/** The invoice API and page shape, with terms when the invoice has any. */
export type PublicInvoiceWithTerms = PublicInvoice & {
  terms?: PublicTerms;
  term_of?: PublicTermOf;
  /** Cancelled by Owed's server because the invoice's other price was paid: that request's id. */
  superseded_by?: string;
  refunded?: string;
  refunds?: PublicRefundLine[];
};

function termStatus(t: TermRow, r: RequestRow | undefined): TermRequestStatus {
  if (t.state === "skipped") return "skipped";
  if (!r) return "scheduled";
  return r.status;
}

function itemAmount(units: bigint, inv: InvoiceRow): string | undefined {
  return inv.fiatCurrency ? fromMinor(units, inv.fiatCurrency) : undefined;
}

function publicTermRequest(t: TermRow, b: TermsBundle, base: string): PublicTermRequest {
  const r = t.requestId ? b.requests.get(t.requestId) : undefined;
  const fiatAmount = itemAmount(t.units, b.invoice);
  const out: PublicTermRequest = {
    role: t.role, seq: t.seq, amount: fromAtomic(t.amountAtomic, b.invoice.token), ...(fiatAmount && { fiat_amount: fiatAmount }),
    due_date: t.dueDate, opens_on: t.opensOn, status: termStatus(t, r),
    id: t.requestId, link: t.requestId ? `${base}/i/${t.requestId}` : null, skip_reason: t.skipReason,
  };
  if (r && (r.status === "paid" || r.status === "underpaid") && r.paidSignature && r.paidAt && r.paidAmountAtomic != null) {
    out.paid = { amount: fromAtomic(r.paidAmountAtomic, r.token), at: r.paidAt, signature: r.paidSignature, on_time: paidOnTime(r.paidAt, t.role === "late_fee" ? r.createdAt.slice(0, 10) : t.dueDate) };
  }
  const by = t.requestId ? b.superseded.get(t.requestId) : undefined;
  if (by) out.superseded_by = by;
  return out;
}

const roleLabel = (role: TermRole, seq: number, count: number | null) =>
  role === "installment" ? `Installment ${seq}${count ? ` of ${count}` : ""}` : role === "full_price" ? "Full price" : role === "early_price" ? "Early-pay price" : "Late fee";

export function termOfLabel(link: TermLink): string {
  return roleLabel(link.role, link.seq, link.count);
}

/** The invoice-level view of a bundle. Undefined for an invoice with no terms row and no plan rows. */
export function publicTerms(b: TermsBundle, base: string): PublicTerms | undefined {
  if (!b.terms && b.rows.length === 0) return undefined;
  const token = b.invoice.token;
  const lvl = invoiceLevel(b);
  const money = (v: bigint) => fromAtomic(v, token);
  const find = (role: TermRole) => b.rows.find((t) => t.role === role);
  const plan = b.rows.filter((t) => t.role === "installment");
  const early = find("early_price");
  const full = find("full_price");
  const fee = find("late_fee");
  const t = b.terms;
  const { refundedAtomic } = refundTotals(b.refunds);
  const payNow = lvl.payNow;
  return {
    status: lvl.status,
    paid_so_far: money(lvl.paidAtomic),
    remaining: money(lvl.remainingAtomic),
    pay_now: payNow
      ? {
          id: payNow.request.id, link: `${base}/i/${payNow.request.id}`, amount: money(payNow.dueAtomic),
          due_date: payNow.row?.dueDate ?? b.invoice.dueDate, role: payNow.row?.role ?? "invoice", seq: payNow.row?.seq ?? null,
        }
      : null,
    installments: plan.length && t?.installmentInterval != null
      ? { count: plan.length, interval: t.installmentInterval, interval_label: intervalText(t.installmentInterval), plan: plan.map((x) => publicTermRequest(x, b, base)) }
      : null,
    early_discount: early && full && t?.earlyUntil && t.earlyUnits != null && t.earlyDiscountUnits != null
      ? {
          early_price: money(early.amountAtomic), full_price: money(full.amountAtomic), discount: money(full.amountAtomic - early.amountAtomic),
          percent: t.earlyBps == null ? null : bpsText(t.earlyBps), until: t.earlyUntil,
          early: publicTermRequest(early, b, base), full: publicTermRequest(full, b, base), paid_with: lvl.paidWith,
        }
      : null,
    late_fee: fee
      ? { amount: money(fee.amountAtomic), percent: t?.lateFeeBps == null ? null : bpsText(t.lateFeeBps), applies_after: fee.dueDate, request: publicTermRequest(fee, b, base) }
      : null,
    chase: t ? (t.chaseDays ? { days: t.chaseDays } : null) : { days: [...CHASE_DEFAULT_DAYS] },
    refunded: money(refundedAtomic),
  };
}

/** The invoice in its public shape, the invoice-level status and payment for one with terms, and any refunds. */
export function toPublicInvoiceWithTerms(b: TermsBundle, base: string, link: TermLink | null): PublicInvoiceWithTerms {
  const pub: PublicInvoiceWithTerms = toPublicInvoice({ invoice: b.invoice, request: b.own }, base);
  const terms = publicTerms(b, base);
  if (terms) {
    pub.terms = terms;
    const lvl = invoiceLevel(b);
    pub.status = lvl.status;
    const latest = lvl.latest;
    pub.paid = (lvl.status === "paid" || lvl.status === "underpaid") && latest?.paidSignature && latest.paidPayer && latest.paidAt
      ? { signature: latest.paidSignature, payer: latest.paidPayer, amount: fromAtomic(lvl.paidAtomic, b.invoice.token), at: latest.paidAt, rail: latest.paidRail ?? "solana_pay" }
      : null;
    // A local-currency invoice with an early price: the invoice-level quote is the items' total (the own request's
    // quote is the early price's, shown under terms.early_discount).
    if (pub.fiat && b.invoice.fiatCurrency) {
      const totalUnits = b.invoice.items.reduce((s, l) => s + l.amountAtomic, 0n);
      pub.fiat = { ...pub.fiat, amount: fromMinor(totalUnits, b.invoice.fiatCurrency) };
    }
    if (pub.status !== "cancelled") delete pub.cancelled_at;
    // The own request's expiry is the early price's end (terms.early_discount.until), not the invoice's.
    if (terms.early_discount) delete pub.expires_at;
  }
  const by = b.superseded.get(b.own.id);
  if (by && pub.status === "cancelled") pub.superseded_by = by;
  if (link) {
    pub.term_of = { invoice_id: link.invoiceId, link: `${base}/i/${link.invoiceId}`, role: link.role, seq: link.seq, count: link.count, label: termOfLabel(link) };
  }
  if (b.refunds.length) {
    const { refundedAtomic } = refundTotals(b.refunds);
    if (refundedAtomic > 0n) pub.refunded = fromAtomic(refundedAtomic, b.invoice.token);
    pub.refunds = b.refunds.map((r) => ({
      id: r.id, request_id: r.requestId, amount: fromAtomic(r.amountAtomic, r.token), status: r.status,
      ...(r.confirmed && { confirmed_at: r.confirmed.at, signature: r.confirmed.signature }),
    }));
  }
  return pub;
}

/** For GET /api/v1/invoices/:id and /i/[id]: the invoice with terms, links and refunds. */
export async function getPublicInvoiceWithTerms(id: string, base: string, rpc: RpcOptions | null): Promise<PublicInvoiceWithTerms | null> {
  const bundle = await loadTermsBundle(id, rpc);
  if (!bundle) return null;
  const link = bundle.invoice.extras ? await termLinkOf(id) : null;
  return toPublicInvoiceWithTerms(bundle, base, link);
}

// ---------------------------------------------------------------- the cron: opening what a plan needs today

export interface TermCronSummary {
  date: string;
  due: number;
  opened: Array<{ invoice_id: string; role: TermRole; seq: number; request_id: string }>;
  skipped: Array<{ invoice_id: string; role: TermRole; seq: number; reason: string }>;
  /** Due but left for a later run: the chain couldn't be read, a domain didn't check out, or it isn't time yet. */
  waiting: Array<{ invoice_id: string; role: TermRole; seq: number; reason: string }>;
  already: number;
  failed: Array<{ invoice_id: string; role: TermRole; seq: number; error: string }>;
  remaining: number;
  refunds: { checked: number; confirmed: string[] } | { error: string };
}

type Decision = { kind: "open" } | { kind: "skip"; reason: string } | { kind: "wait"; reason: string };

async function claimTerm(t: TermRow): Promise<boolean> {
  const rows = await sql(
    `update invoice_term_requests set claimed_at = now()
      where invoice_id = $1 and role = $2 and seq = $3 and state = 'scheduled'
        and (claimed_at is null or claimed_at < now() - make_interval(mins => $4))
      returning invoice_id`,
    [t.invoiceId, t.role, t.seq, TERM_STALE_CLAIM_MINUTES],
  );
  return rows.length === 1;
}

async function releaseTerm(t: TermRow, error: string | null): Promise<void> {
  await sql(
    `update invoice_term_requests set claimed_at = null, last_error = $4 where invoice_id = $1 and role = $2 and seq = $3 and state = 'scheduled'`,
    [t.invoiceId, t.role, t.seq, error === null ? null : error.slice(0, 300)],
  );
}

async function skipTerm(t: TermRow, reason: string): Promise<void> {
  await sql(
    `update invoice_term_requests set state = 'skipped', skip_reason = $4, claimed_at = null, last_error = null
      where invoice_id = $1 and role = $2 and seq = $3 and state = 'scheduled'`,
    [t.invoiceId, t.role, t.seq, reason.slice(0, 200)],
  );
}

/** Read these requests' payments on chain; throws when the chain can't be read (the decision then waits). */
async function settleAll(rows: RequestRow[]): Promise<RequestRow[]> {
  return settleFromChain(rows, { deadline: Date.now() + TERM_CHAIN_BUDGET_MS, timeoutMs: TERM_CHAIN_BUDGET_MS });
}

/** What to do with one due row, given its invoice's bundle (with the relevant requests read on chain). */
export function decide(t: TermRow, b: TermsBundle, today: string): Decision {
  const own = b.own;
  if (cancelledByRecipient(own)) return { kind: "skip", reason: "the invoice was cancelled" };
  const req = (row: TermRow | undefined) => (row?.requestId ? b.requests.get(row.requestId) : undefined);
  if (t.role === "installment") return { kind: "open" };
  if (t.role === "full_price") {
    const early = req(b.rows.find((x) => x.role === "early_price")) ?? own;
    if (early.status === "paid" || early.status === "underpaid") return { kind: "skip", reason: "the early price was paid" };
    return { kind: "open" };
  }
  // The late fee: once, only if the invoice wasn't paid on time.
  const plan = b.rows.filter((x) => x.role === "installment");
  if (plan.length > 0) {
    for (const k of plan) {
      if (k.dueDate >= today) continue; // not past due yet
      const r = req(k);
      if (!r || r.status !== "paid" || !paidOnTime(r.paidAt, k.dueDate)) return { kind: "open" };
    }
    const last = plan[plan.length - 1]!;
    return last.dueDate < today ? { kind: "skip", reason: "every installment was paid on time" } : { kind: "wait", reason: "installments are still coming due" };
  }
  const dueDate = b.invoice.dueDate;
  const early = req(b.rows.find((x) => x.role === "early_price"));
  const full = req(b.rows.find((x) => x.role === "full_price"));
  const candidates = [early ?? own, ...(full ? [full] : [])];
  const paid = candidates.find((r) => r.status === "paid");
  if (paid) return paidOnTime(paid.paidAt, dueDate) ? { kind: "skip", reason: "the invoice was paid on time" } : { kind: "open" };
  if (!early && own.status === "expired") return { kind: "skip", reason: "the invoice expired before it was paid" };
  if (own.status === "cancelled" && !full) return { kind: "skip", reason: "the invoice was cancelled" };
  return { kind: "open" };
}

function childNumber(parent: string | null, suffix: string): string | null {
  if (!parent) return null;
  return fit(`${parent} ${suffix}`, INVOICE_TEXT_LIMITS.invoice_number);
}

/** Write the request a due row asks for: a whole invoice of its own, and the row marked opened, in one transaction. */
async function openChild(t: TermRow, b: TermsBundle, today: string): Promise<RequestRow> {
  const parent = b.invoice;
  const own = b.own;
  const count = b.rows.filter((x) => x.role === "installment").length || null;
  let lines: InvoiceLine[];
  let dueDate: string;
  let number: string | null;
  let notes: string | null = parent.notes;
  if (t.role === "installment") {
    lines = [{ description: `Installment ${t.seq} of ${count}`, quantity: "1", unitPriceAtomic: t.units, amountAtomic: t.units }];
    dueDate = t.dueDate;
    number = childNumber(parent.invoiceNumber, `${t.seq}/${count}`);
  } else if (t.role === "full_price") {
    lines = parent.items;
    dueDate = t.dueDate;
    number = parent.invoiceNumber;
  } else {
    const which = parent.invoiceNumber ?? parent.id;
    lines = [{ description: fit(`Late fee: invoice ${which} was not paid by ${t.dueDate}`, INVOICE_TEXT_LIMITS.description)!, quantity: "1", unitPriceAtomic: t.units, amountAtomic: t.units }];
    dueDate = today;
    number = childNumber(parent.invoiceNumber, "late fee");
    notes = null;
  }
  const units = lines.reduce((s, l) => s + l.amountAtomic, 0n);
  if (units !== t.units) throw new Error(`term ${t.role}/${t.seq} of ${parent.id}: lines add up to ${units}, not ${t.units}`);
  const rate: { code: FiatCode; locked: LockedRate } | null = parent.fiatCurrency && own.fiat
    ? { code: parent.fiatCurrency, locked: { rate: own.fiat.rate, rate_source: own.fiat.rate_source, quoted_at: own.fiat.quoted_at } }
    : null;
  // A verified payee is re-checked before every request the plan opens, as monthly schedules do.
  const fromDomain = parent.fromDomain ? await requireVerifiedDomain(parent.fromDomain, parent.recipient) : null;
  const label = t.role === "installment" ? `· ${t.seq} of ${count}` : t.role === "full_price" ? "· full price" : "· late fee";
  const created = await insertInvoice({
    recipient: parent.recipient, token: parent.token, businessName: parent.businessName, clientName: parent.clientName,
    invoiceNumber: number, notes, dueDate, lines, totalUnits: units, ownUnits: units, flags: parent.flags, source: parent.source,
    fromDomain, expiresInDays: null, rate, payer: own.payer ?? null, requesterHandle: own.requesterHandle ?? null,
    forText: `${invoiceForText(number, dueDate)} ${label}`,
    extraQueries: (id, payAtomic) => {
      if (payAtomic(units) !== t.amountAtomic) throw new Error(`term ${t.role}/${t.seq} of ${parent.id}: amount drifted`);
      return [{ text: `update invoices set extras = true where id = $1`, params: [id] }, {
        // Exactly once: if the row was opened or skipped meanwhile, 1/0 fails the whole transaction (nothing is written).
        text: `with u as (
                 update invoice_term_requests set state = 'opened', request_id = $4, claimed_at = null, last_error = null
                  where invoice_id = $1 and role = $2 and seq = $3 and state = 'scheduled'
                  returning 1)
               select 1 / (select count(*)::int from u) as one`,
        params: [t.invoiceId, t.role, t.seq, id],
      }];
    },
  });
  return created.request;
}

/** Load an invoice's bundle with every request a decision reads checked on chain. */
async function bundleForDecision(invoiceId: string): Promise<TermsBundle | null> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) return null;
  const { terms, rows } = await termRowsOf(invoiceId);
  const ids = [...new Set([invoiceId, ...rows.flatMap((r) => (r.requestId ? [r.requestId] : []))])];
  const map = await getRequests(ids);
  const own = map.get(invoiceId);
  if (!own) return null;
  const settled = await settleAll([...map.values()]);
  const requests = new Map(settled.map((r) => [r.id, r]));
  return { invoice, own: requests.get(invoiceId)!, terms, rows, requests, superseded: new Map(), refunds: [] };
}

async function handleRow(t: TermRow, now: number, summary: TermCronSummary): Promise<void> {
  const today = isoDay(now);
  if (!(await claimTerm(t))) {
    summary.already++;
    return;
  }
  try {
    let bundle: TermsBundle | null;
    try {
      bundle = await bundleForDecision(t.invoiceId);
    } catch (e) {
      if (e instanceof DbError) throw e;
      await releaseTerm(t, "Solana couldn't be read; retried on the next run");
      summary.waiting.push({ invoice_id: t.invoiceId, role: t.role, seq: t.seq, reason: "Solana couldn't be read" });
      return;
    }
    if (!bundle) {
      await skipTerm(t, "the invoice is missing");
      summary.skipped.push({ invoice_id: t.invoiceId, role: t.role, seq: t.seq, reason: "the invoice is missing" });
      return;
    }
    const d = decide(t, bundle, today);
    if (d.kind === "skip") {
      await skipTerm(t, d.reason);
      summary.skipped.push({ invoice_id: t.invoiceId, role: t.role, seq: t.seq, reason: d.reason });
      return;
    }
    if (d.kind === "wait") {
      await releaseTerm(t, null);
      summary.waiting.push({ invoice_id: t.invoiceId, role: t.role, seq: t.seq, reason: d.reason });
      return;
    }
    try {
      const request = await openChild(t, bundle, today);
      summary.opened.push({ invoice_id: t.invoiceId, role: t.role, seq: t.seq, request_id: request.id });
    } catch (e) {
      if (e instanceof ApiError) { // the payee's domain no longer publishes the wallet, or DNS is down: retried daily
        await releaseTerm(t, `${bundle.invoice.fromDomain ?? "domain"}: ${e.message}`);
        summary.waiting.push({ invoice_id: t.invoiceId, role: t.role, seq: t.seq, reason: e.message });
        return;
      }
      if (e instanceof DbError && e.code === "22012") { // opened or skipped by someone else meanwhile
        summary.already++;
        return;
      }
      throw e;
    }
  } catch (e) {
    await releaseTerm(t, null).catch(() => undefined);
    console.error(`invoice terms ${t.invoiceId} ${t.role}/${t.seq}: could not open`, e);
    summary.failed.push({ invoice_id: t.invoiceId, role: t.role, seq: t.seq, error: e instanceof Error ? e.message.slice(0, 200) : "error" });
  }
}

/**
 * Open every scheduled request whose day has come (later installments, full prices, late fees) and re-read pending
 * refunds. Idempotent: a second run the same day opens nothing new for the same row.
 */
export async function runDueInvoiceTerms({
  now = Date.now(),
  batch = TERM_CRON_BATCH,
  budgetMs = TERM_CRON_BUDGET_MS,
  concurrency = TERM_CRON_CONCURRENCY,
  refunds = true,
}: { now?: number; batch?: number; budgetMs?: number; concurrency?: number; refunds?: boolean } = {}): Promise<TermCronSummary> {
  const today = isoDay(now);
  const rows = (await sql(
    `select ${TERM_COLUMNS}, count(*) over () as total from invoice_term_requests
      where state = 'scheduled' and opens_on <= $1::date
        and (claimed_at is null or claimed_at < now() - make_interval(mins => $3))
      order by opens_on, invoice_id, role, seq
      limit $2`,
    [today, batch, TERM_STALE_CLAIM_MINUTES],
  ));
  const total = Number(rows[0]?.total ?? 0);
  const due = rows.map(termFromRow);
  const summary: TermCronSummary = { date: today, due: total, opened: [], skipped: [], waiting: [], already: 0, failed: [], remaining: 0, refunds: { checked: 0, confirmed: [] } };
  // One invoice's rows run in order (an installment before its late fee), different invoices side by side.
  const byInvoice = new Map<string, TermRow[]>();
  for (const t of due) byInvoice.set(t.invoiceId, [...(byInvoice.get(t.invoiceId) ?? []), t]);
  const groups = [...byInvoice.values()];
  const deadline = Date.now() + budgetMs;
  let next = 0;
  let started = 0;
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const i = next++;
      if (i >= groups.length) return;
      for (const t of groups[i]!) {
        started++;
        await handleRow(t, now, summary);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  summary.remaining = total - started;
  const order = (a: { invoice_id: string; role: string; seq: number }, b: { invoice_id: string; role: string; seq: number }) =>
    a.invoice_id.localeCompare(b.invoice_id) || a.role.localeCompare(b.role) || a.seq - b.seq;
  summary.opened.sort(order);
  summary.skipped.sort(order);
  if (refunds && Date.now() < deadline) {
    try {
      summary.refunds = await confirmPendingRefunds({ deadline: Math.min(deadline, Date.now() + 4000) });
    } catch (e) {
      summary.refunds = { error: e instanceof Error ? e.message.slice(0, 200) : "error" };
    }
  }
  return summary;
}

/** Open whatever of this invoice's plan is due today (used right after creation; the cron does the rest). */
export async function openDueForInvoice(invoiceId: string, now: number = Date.now()): Promise<TermCronSummary> {
  const today = isoDay(now);
  const rows = (await sql(`select ${TERM_COLUMNS} from invoice_term_requests where invoice_id = $1 and state = 'scheduled' and opens_on <= $2::date order by role, seq`, [invoiceId, today])).map(termFromRow);
  const summary: TermCronSummary = { date: today, due: rows.length, opened: [], skipped: [], waiting: [], already: 0, failed: [], remaining: 0, refunds: { checked: 0, confirmed: [] } };
  for (const t of rows.filter((x) => x.role === "installment")) await handleRow(t, now, summary);
  return summary;
}

// ---------------------------------------------------------------- who_owes_me: chase days and refunds on ledger entries

export interface EntryTerms {
  /** Days after the due date for polite, firm and formal reminders; null = the invoice turned chasing off. */
  chase: number[] | null;
}

/**
 * Per invoice id (an invoice of its own, or one a plan opened): its chase days (the plan's invoice decides) and
 * confirmed refunds. Ids without either are left out, so the default (3/7/14) applies to them.
 */
export async function entryTermsFor(ids: readonly string[]): Promise<{ chase: Map<string, number[] | null>; refunded: Map<string, bigint> }> {
  if (ids.length === 0) return { chase: new Map(), refunded: new Map() };
  const [chaseRows, refundRows] = await Promise.all([
    sql(
      `select e.id, it.invoice_id is not null as has_terms, array_to_json(it.chase_days)::text as chase_days
         from unnest($1::text[]) as e(id)
         left join invoice_term_requests t on t.request_id = e.id
         join invoice_terms it on it.invoice_id = coalesce(t.invoice_id, e.id)`,
      [ids],
    ),
    sql(`select request_id, sum(amount_atomic)::text as refunded from refunds where request_id = any($1::text[]) and status = 'confirmed' group by request_id`, [ids]),
  ]);
  const chase = new Map<string, number[] | null>();
  for (const r of chaseRows) chase.set(r.id!, r.chase_days == null ? null : (JSON.parse(r.chase_days) as number[]));
  return { chase, refunded: new Map(refundRows.map((r) => [r.request_id!, BigInt(r.refunded!)])) };
}

/**
 * The ledger (POST /api/v1/ledger) plus, on each entry: `chase` (invoices that chase on other days, or not at,
 * {days} or null) and `reminder` when one is due today, and `refunded` (confirmed refunds). Additive, optional fields.
 */
interface LedgerLike {
  id: string;
  kind: string;
  status: string;
  due_date: string | null;
  token: Token;
}

// Entries are typed loosely (`object`): withSchedules' result types its entries as just { id } plus its own fields, though
// every entry is a full ledger entry (lib/ledger.ts LedgerEntry) at run time.
export async function withInvoiceTerms<L extends { open: object[]; paid_recently: object[] }>(
  ledger: L,
  { now = Date.now() }: { now?: number } = {},
): Promise<Omit<L, "open" | "paid_recently"> & { open: Array<L["open"][number] & EntryExtras>; paid_recently: Array<L["paid_recently"][number] & EntryExtras> }> {
  const all = [...ledger.open, ...ledger.paid_recently] as LedgerLike[];
  const { chase, refunded } = await entryTermsFor(all.map((e) => e.id));
  const today = isoDay(now);
  const tag = <T extends object>(entry: T): T & EntryExtras => {
    const e = entry as T & LedgerLike;
    const out: T & EntryExtras = { ...entry };
    if (e.kind === "invoice") {
      const days = chase.has(e.id) ? chase.get(e.id)! : [...CHASE_DEFAULT_DAYS];
      if (chase.has(e.id)) out.chase = days === null ? null : { days };
      const stage = e.status !== "paid" && e.due_date ? chaseStage(e.due_date, today, days) : null;
      if (stage) out.reminder = { tone: stage.tone, days_overdue: stage.daysOverdue };
    }
    const r = refunded.get(e.id);
    if (r) out.refunded = fromAtomic(r, e.token);
    return out;
  };
  return { ...ledger, open: ledger.open.map(tag), paid_recently: ledger.paid_recently.map(tag) };
}

export interface EntryExtras {
  chase?: { days: number[] } | null;
  reminder?: { tone: "polite" | "firm" | "formal"; days_overdue: number };
  refunded?: string;
}

