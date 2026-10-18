// Turns a PublicInvoice into what /i/[id] renders. Pure (no React, no server), so it is unit-tested
// in test/invoice-page.test.ts. Amounts stay decimal strings; nothing here does money arithmetic.

import type { PublicInvoice } from "@/lib/invoices";
import type { PublicInvoiceWithTerms, PublicTermRequest } from "@/lib/invoice-terms"; // F8 invoices
import { formatAmount, groupDigits, isToken, type Token } from "@/lib/view/money";
import { brandWordsFromFlags, detectBrandWords, fiatView, stateFromRequest, walletPayUrl, type FiatView, type LiveState } from "@/lib/view/request-view";
import { formatFiat, isFiatCode } from "@/lib/fiat";
import { shortAddress } from "@/lib/view/format";
import type { PublicRequest } from "@/lib/public-api";

const DAY_MS = 86_400_000;
const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

/** "2026-10-24" -> "Oct 24, 2026" (calendar date, no time zone shift). */
export function formatDate(isoDate: string): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isNaN(ms) ? isoDate : DATE.format(ms);
}

/** Whole days from today (UTC) to the due date: negative when overdue. */
export function daysUntil(dueDate: string, now: number): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((due - today) / DAY_MS);
}

export function dueLabel(dueDate: string, now: number): string {
  const days = daysUntil(dueDate, now);
  if (days < 0) return `Overdue · was due ${formatDate(dueDate)}`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${formatDate(dueDate)}`;
}

export interface InvoiceLineView {
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  /** The same numbers without the token: print puts the token in the column headers to give descriptions room. */
  unitPriceValue: string;
  amountValue: string;
}

export interface InvoiceModel {
  id: string;
  token: Token;
  total: string;
  totalLabel: string;
  /** Shown as "Invoice <number>"; the Owed id when the sender gave no number. */
  number: string;
  numberIsId: boolean;
  businessName: string;
  clientName: string;
  notes: string | null;
  issued: string;
  due: string;
  dueLabel: string;
  overdue: boolean;
  lines: InvoiceLineView[];
  recipient: string;
  recipientShort: string;
  solanaPayUrl: string;
  invoiceLink: string;
  requestLink: string;
  agentPrompt: string;
  brandWords: string[];
  fromDomain: string | null;
  fromDomainVerifiedAt: string | null;
  initial: LiveState;
  /** W3-C: when an open invoice stops taking payments (ISO), or null. */
  expiresAt: string | null;
  /** What the line items are priced in: the token, or a local-currency invoice's currency ("INR"). */
  itemUnit: string;
  /** Local-currency invoice: the items' total as a quote beside the USDC due (display only), or null. */
  fiat: FiatView | null;
  // F8 invoices start
  /** The request the pay panel pays: the invoice's own, or (with terms) the installment or price due now. */
  payId: string;
  payAmount: string;
  payLabel: string;
  /** "Pay 100 USDC", or "Pay installment 2 of 3: 100 USDC". */
  payTitle: string;
  /** Terms: the plan, the two prices, the late fee; null for an invoice without terms. */
  terms: TermsView | null;
  /** An invoice a plan opened: which part of which invoice it is. */
  termOf: { label: string; link: string; parentId: string } | null;
  /** "Refunded 0.5 USDC to the payer", once a refund is confirmed on Solana; null otherwise. */
  refundedNote: string | null;
  /** The live view reloads the page when the request it watches changes (the plan moves on), instead of flipping. */
  refreshOnChange: boolean;
  /** False while an invoice with terms has nothing payable (the next installment or the full price hasn't opened). */
  payable: boolean;
  /** Cancelled by Owed because the invoice's other price was paid. */
  cancelledNote: string | null;
  // F8 invoices end
}

// F8 invoices start: what the page shows about terms.
export interface TermsRowView {
  label: string;
  amount: string;
  due: string;
  status: string;
  tone: "paid" | "open" | "muted" | "warn";
  link: string | null;
}

export interface TermsView {
  kind: "installments" | "early_discount" | "plain";
  /** "1 of 3 installments paid: 100 USDC of 300 USDC." */
  summary: string | null;
  rows: TermsRowView[];
  /** When nothing is payable right now: what opens next and when. */
  waiting: string | null;
  /** "Pay 90 USDC by Oct 31, 2026 (10% off). After that the full 100 USDC is due by Nov 30, 2026." */
  earlyNote: string | null;
  /** "Late fee: 5 USDC if not paid by Nov 1, 2026." or what happened to it. */
  lateFeeNote: string | null;
  lateFeeLink: string | null;
}

function termLabel(t: PublicTermRequest, count: number | null): string {
  if (t.role === "installment") return `Installment ${t.seq}${count ? ` of ${count}` : ""}`;
  if (t.role === "early_price") return "Early-pay price";
  if (t.role === "full_price") return "Full price";
  return "Late fee";
}

function termStatus(t: PublicTermRequest): { status: string; tone: TermsRowView["tone"] } {
  switch (t.status) {
    case "paid": return { status: t.paid?.on_time === false ? "Paid late" : "Paid", tone: "paid" };
    case "underpaid": return { status: "Partly paid", tone: "warn" };
    case "open": return { status: "Open", tone: "open" };
    case "scheduled": return { status: `Opens ${formatDate(t.opens_on)}`, tone: "muted" };
    case "skipped": return { status: "Not needed", tone: "muted" };
    case "cancelled": return { status: t.superseded_by ? "Not needed (the other price was paid)" : "Cancelled", tone: "muted" };
    case "expired": return { status: "Ended", tone: "muted" };
  }
}

export function termsView(inv: PublicInvoiceWithTerms, token: Token): TermsView | null {
  const t = inv.terms;
  if (!t) return null;
  const money = (v: string) => formatAmount(v, token);
  const fee = t.late_fee;
  const feeOpened = fee?.request.id ? fee.request.link : null;
  const lateFeeNote = !fee ? null
    : fee.request.status === "skipped" ? `Late fee: none, ${fee.request.skip_reason ?? "not needed"}.`
    : feeOpened ? `A late fee of ${money(fee.amount)} was added: it is its own invoice.`
    : `Late fee: ${money(fee.amount)}${fee.percent ? ` (${fee.percent}% of the total)` : ""} if ${t.installments ? "an installment isn't paid by its due date" : `not paid by ${formatDate(fee.applies_after)}`}, added once.`;
  if (t.installments) {
    const plan = t.installments.plan;
    const paid = plan.filter((p) => p.status === "paid").length;
    const next = plan.find((p) => p.status === "scheduled");
    return {
      kind: "installments",
      summary: `${paid} of ${plan.length} installments paid: ${money(t.paid_so_far)} of ${money(inv.total)}. ${t.installments.interval_label === "monthly" ? "Monthly" : `Every ${t.installments.interval} days`}.`,
      rows: plan.map((p) => ({ label: termLabel(p, plan.length), amount: money(p.amount), due: formatDate(p.due_date), ...termStatus(p), link: p.id ? p.link : null })),
      waiting: !t.pay_now && next && t.status !== "paid" ? `${termLabel(next, plan.length)} opens ${formatDate(next.opens_on)}, a week before it is due.` : null,
      earlyNote: null, lateFeeNote, lateFeeLink: feeOpened,
    };
  }
  if (t.early_discount) {
    const d = t.early_discount;
    const rows = [d.early, d.full].map((p) => ({ label: termLabel(p, null), amount: money(p.amount), due: formatDate(p.due_date), ...termStatus(p), link: p.id ? p.link : null }));
    return {
      kind: "early_discount",
      summary: d.paid_with === "early" ? `Paid at the early price, ${money(d.early_price)}.` : d.paid_with === "full" ? `Paid at the full price, ${money(d.full_price)}.` : null,
      rows,
      waiting: !t.pay_now && t.status === "open" ? `The early price ended. The full price, ${money(d.full_price)}, opens ${formatDate(d.full.opens_on)}.` : null,
      earlyNote: `Pay ${money(d.early_price)} by ${formatDate(d.until)}${d.percent ? ` (${d.percent}% off)` : ` (${money(d.discount)} off)`}. After that the full ${money(d.full_price)} is due by ${formatDate(inv.due_date)}.`,
      lateFeeNote, lateFeeLink: feeOpened,
    };
  }
  return { kind: "plain", summary: null, rows: [], waiting: null, earlyNote: null, lateFeeNote, lateFeeLink: feeOpened };
}
// F8 invoices end

export function invoiceModel(inv: PublicInvoiceWithTerms | PublicInvoice, now: number): InvoiceModel {
  const token: Token = isToken(inv.token) ? inv.token : "USDC";
  const brandWords = [
    ...new Set([
      // W2-E: a brand word the server-verified from_domain owns isn't a caution.
      ...brandWordsFromFlags(inv.flags, inv.from_domain_verified_at ? inv.from_domain : null),
      ...detectBrandWords([inv.business_name, inv.client_name, inv.invoice_number, inv.notes, ...inv.items.map((i) => i.description)],
        inv.from_domain_verified_at ? inv.from_domain : null),
    ]),
  ];
  // stateFromRequest reads only status, amount, token and paid.
  const asRequest = {
    status: inv.status, amount: inv.total, token, paid: inv.paid,
    // W3-C: when it expired or was cancelled
    expires_at: inv.expires_at ?? null, cancelled: inv.cancelled_at ? { at: inv.cancelled_at } : null,
  } as unknown as PublicRequest;
  const open = inv.status === "open";
  // Local-currency invoice: lines are in fiat.currency; the total due is the USDC locked for their sum.
  const itemCode = inv.fiat && isFiatCode(inv.fiat.currency) ? inv.fiat.currency : null;
  const itemMoney = (v: string) => (itemCode ? formatFiat(v, itemCode) : formatAmount(v, token));
  return {
    id: inv.id,
    token,
    total: inv.total,
    totalLabel: formatAmount(inv.total, token),
    number: inv.invoice_number ?? inv.id,
    numberIsId: inv.invoice_number === null,
    businessName: inv.business_name,
    clientName: inv.client_name,
    notes: inv.notes,
    issued: formatDate(inv.issue_date),
    due: formatDate(inv.due_date),
    dueLabel: dueLabel(inv.due_date, now),
    overdue: open && daysUntil(inv.due_date, now) < 0,
    lines: inv.items.map((i) => ({
      description: i.description,
      quantity: groupDigits(i.quantity),
      unitPrice: itemMoney(i.unit_price),
      amount: itemMoney(i.amount),
      unitPriceValue: groupDigits(i.unit_price),
      amountValue: groupDigits(i.amount),
    })),
    recipient: inv.recipient,
    recipientShort: shortAddress(inv.recipient),
    // The QR and "Open in wallet" use Owed's transaction request, so the wallet can't drop the reference.
    solanaPayUrl: walletPayUrl(new URL(inv.link).origin, inv.id),
    invoiceLink: inv.link,
    requestLink: inv.request_link,
    agentPrompt: `Use the Owed plugin in PayBox to pay this invoice: ${inv.request_link}`,
    brandWords,
    fromDomain: inv.from_domain,
    fromDomainVerifiedAt: inv.from_domain_verified_at,
    initial: stateFromRequest(asRequest),
    expiresAt: inv.expires_at ?? null, // W3-C
    itemUnit: itemCode ?? token,
    fiat: token === "USDC" ? fiatView(inv.fiat, inv.total) : null,
    ...termsFields(inv as PublicInvoiceWithTerms, token, now), // F8 invoices
  };
}

// F8 invoices start
/** The chip on an invoice with terms when nothing is payable right now. */
function waitingChip(inv: PublicInvoiceWithTerms): string {
  const t = inv.terms!;
  if (t.installments) {
    const paid = t.installments.plan.filter((p) => p.status === "paid").length;
    return `${paid} of ${t.installments.plan.length} paid`;
  }
  if (t.early_discount) return `Full price opens ${formatDate(t.early_discount.full.opens_on)}`;
  return "Waiting";
}

/** An installment plan's next unpaid due date (the Due cell), or null. */
function nextDue(inv: PublicInvoiceWithTerms): string | null {
  const plan = inv.terms?.installments?.plan;
  if (!plan || inv.terms?.status === "paid") return null;
  return plan.find((p) => p.status !== "paid")?.due_date ?? null;
}

function termsFields(inv: PublicInvoiceWithTerms, token: Token, now: number) {
  const t = inv.terms;
  const terms = termsView(inv, token);
  const pay = t?.pay_now ?? null;
  const count = t?.installments?.count ?? null;
  const what = pay && pay.role === "installment" ? `installment ${pay.seq} of ${count}` : pay?.role === "early_price" ? "the early-pay price" : pay?.role === "full_price" ? "the full price" : null;
  const payAmount = pay ? pay.amount : inv.total;
  const payLabel = formatAmount(payAmount, token);
  const refunded = inv.refunded ? `Refunded ${formatAmount(inv.refunded, token)} to the payer, confirmed on Solana.` : null;
  const origin = new URL(inv.link).origin;
  return {
    ...(pay && pay.id !== inv.id ? { solanaPayUrl: walletPayUrl(origin, pay.id), agentPrompt: `Use the Owed plugin in PayBox to pay this invoice: ${origin}/r/${pay.id}` } : {}),
    payable: !t || !!pay,
    cancelledNote: inv.superseded_by ? `Cancelled by Owed: the other price of this invoice was paid (request ${inv.superseded_by}).` : null,
    payId: pay?.id ?? inv.id,
    payAmount,
    payLabel,
    payTitle: what ? `Pay ${what}: ${payLabel}` : `Pay ${payLabel}`,
    terms,
    termOf: inv.term_of ? { label: inv.term_of.label, link: inv.term_of.link, parentId: inv.term_of.invoice_id } : null,
    refundedNote: refunded,
    refreshOnChange: !!t,
    ...(t && pay ? { dueLabel: dueLabel(pay.due_date ?? inv.due_date, now), overdue: daysUntil(pay.due_date ?? inv.due_date, now) < 0 } : {}),
    ...(t && !pay && t.status !== "paid" && t.status !== "cancelled" ? { dueLabel: waitingChip(inv), overdue: false } : {}),
    ...(nextDue(inv) ? { due: formatDate(nextDue(inv)!) } : {}),
    ...(t && (t.status === "open" || t.status === "underpaid") ? { initial: { status: "open" } as LiveState } : {}),
  };
}
// F8 invoices end

/** Page title and preview text: amount and due date only, never requester-written text (SPEC §6). */
export function invoiceTitle(m: Pick<InvoiceModel, "totalLabel"> & { fiat?: FiatView | null }): string {
  return m.fiat ? `Invoice for ${m.fiat.amount} (${m.totalLabel})` : `Invoice for ${m.totalLabel}`;
}

export function invoiceDescription(m: Pick<InvoiceModel, "totalLabel" | "due" | "initial"> & { fiat?: FiatView | null }): string {
  if (m.fiat && m.initial.status === "open") {
    return `Invoice for ${m.fiat.amount} = ${m.totalLabel} (rate locked ${m.fiat.lockedAt}), due ${m.due}. Pay with any Solana wallet or your AI agent.`;
  }
  if (m.initial.status === "paid") return `Invoice for ${m.totalLabel}: paid on Solana.`;
  // W3-C: a cancelled or expired invoice's preview never invites a payment.
  if (m.initial.status === "cancelled") return `Invoice for ${m.totalLabel}: cancelled. Don't send money for it.`;
  if (m.initial.status === "expired") return `Invoice for ${m.totalLabel}: expired, no longer payable.`;
  return `Invoice for ${m.totalLabel}, due ${m.due}. Pay with any Solana wallet or your AI agent.`;
}
