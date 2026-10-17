import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/og-card";
import { formatAmount, isToken } from "@/lib/view/money";
import { formatDate } from "./model";
import { loadPublicInvoice } from "./source";

export const alt = "Invoice on Owed. Pay with any Solana wallet.";
export const size = OG_SIZE;
export const contentType = "image/png";

// Preview card for WhatsApp, iMessage, email and X: the total and the due date. No names and no
// line items: the card must not vouch for who is billing, and sender text stays on the page, quoted.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadPublicInvoice(id).catch(() => null);

  if (!loaded) {
    return new ImageResponse(<OgCard amount="Owed" line="Invoices anyone can pay" cta="Pay with any Solana wallet" />, size);
  }

  const { invoice } = loaded;
  const token = isToken(invoice.token) ? invoice.token : "USDC";
  const line = invoice.status === "paid" ? "Invoice · paid" : `Invoice · due ${formatDate(invoice.due_date)}`;
  return new ImageResponse(<OgCard amount={formatAmount(invoice.total, token)} line={line} cta="Pay with any Solana wallet" />, size);
}
