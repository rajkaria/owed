import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/og-card";
import { loadPublicRequest } from "@/lib/request-source";
import { formatAmount, isToken } from "@/lib/view/money";
import { LIMITS, cleanText } from "@/lib/view/text";

export const alt = "Payment request on Owed. Pay with any Solana wallet.";
export const size = OG_SIZE;
export const contentType = "image/png";

// Preview card for WhatsApp, iMessage and X: amount, the quoted reason and how
// to pay. No names: the card must not vouch for who is asking.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await loadPublicRequest(id).catch(() => null);

  if (!request) {
    return new ImageResponse(<OgCard amount="Owed" line="Ask anyone for money" cta="Pay with any Solana wallet" />, size);
  }

  const token = isToken(request.token) ? request.token : "USDC";
  const forText = cleanText(request.for, LIMITS.ogFor);
  return new ImageResponse(
    (
      <OgCard
        amount={formatAmount(request.amount, token)}
        line={forText ? `for “${forText}”` : null}
        cta="Pay with any Solana wallet"
      />
    ),
    size,
  );
}
