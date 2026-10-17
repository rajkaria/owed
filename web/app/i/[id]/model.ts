// Turns a PublicInvoice into what /i/[id] renders. Pure (no React, no server), so it is unit-tested
// in test/invoice-page.test.ts. Amounts stay decimal strings; nothing here does money arithmetic.

import type { PublicInvoice } from "@/lib/invoices";
import { formatAmount, groupDigits, isToken, type Token } from "@/lib/view/money";
import { brandWordsFromFlags, detectBrandWords, stateFromRequest, type LiveState } from "@/lib/view/request-view";
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
}

export function invoiceModel(inv: PublicInvoice, now: number): InvoiceModel {
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
      unitPrice: formatAmount(i.unit_price, token),
      amount: formatAmount(i.amount, token),
      unitPriceValue: groupDigits(i.unit_price),
      amountValue: groupDigits(i.amount),
    })),
    recipient: inv.recipient,
    recipientShort: shortAddress(inv.recipient),
    solanaPayUrl: inv.solana_pay_url,
    invoiceLink: inv.link,
    requestLink: inv.request_link,
    agentPrompt: `Use the Owed plugin in PayBox to pay this invoice: ${inv.request_link}`,
    brandWords,
    fromDomain: inv.from_domain,
    fromDomainVerifiedAt: inv.from_domain_verified_at,
    initial: stateFromRequest(asRequest),
    expiresAt: inv.expires_at ?? null, // W3-C
  };
}

/** Page title and preview text: amount and due date only, never requester-written text (SPEC §6). */
export function invoiceTitle(m: Pick<InvoiceModel, "totalLabel">): string {
  return `Invoice for ${m.totalLabel}`;
}

export function invoiceDescription(m: Pick<InvoiceModel, "totalLabel" | "due" | "initial">): string {
  if (m.initial.status === "paid") return `Invoice for ${m.totalLabel}: paid on Solana.`;
  // W3-C: a cancelled or expired invoice's preview never invites a payment.
  if (m.initial.status === "cancelled") return `Invoice for ${m.totalLabel}: cancelled. Don't send money for it.`;
  if (m.initial.status === "expired") return `Invoice for ${m.totalLabel}: expired, no longer payable.`;
  return `Invoice for ${m.totalLabel}, due ${m.due}. Pay with any Solana wallet or your AI agent.`;
}
