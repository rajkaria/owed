import { cache } from "react";
import { getPublicInvoice, isInvoiceId, type PublicInvoice } from "@/lib/invoices";
import { requestOrigin } from "@/lib/site";

export interface LoadedInvoice {
  invoice: PublicInvoice;
  /** When it was read: "due today" and "overdue" are relative to this, the same for page and metadata. */
  now: number;
}

/** One read per invoice id per render, shared by the page, its metadata and its preview card. */
export const loadPublicInvoice = cache(async (id: string): Promise<LoadedInvoice | null> => {
  if (!isInvoiceId(id)) return null;
  const invoice = await getPublicInvoice(id, await requestOrigin());
  return invoice ? { invoice, now: Date.now() } : null;
});
