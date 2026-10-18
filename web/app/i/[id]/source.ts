import { cache } from "react";
import { isInvoiceId } from "@/lib/invoices";
import { getPublicInvoiceWithTerms, type PublicInvoiceWithTerms } from "@/lib/invoice-terms"; // F8 invoices
import { requestOrigin } from "@/lib/site";

export interface LoadedInvoice {
  invoice: PublicInvoiceWithTerms;
  /** When it was read: "due today" and "overdue" are relative to this, the same for page and metadata. */
  now: number;
}

/** Chain check budget for a page render, same as getPublicRequest: client polling takes over. */
const PAGE_CHAIN_BUDGET_MS = 1200;

/** One read per invoice id per render, shared by the page, its metadata and its preview card. F8: with terms and refunds. */
export const loadPublicInvoice = cache(async (id: string): Promise<LoadedInvoice | null> => {
  if (!isInvoiceId(id)) return null;
  const invoice = await getPublicInvoiceWithTerms(id, await requestOrigin(), { deadline: Date.now() + PAGE_CHAIN_BUDGET_MS, timeoutMs: PAGE_CHAIN_BUDGET_MS });
  return invoice ? { invoice, now: Date.now() } : null;
});
