import { ImageResponse } from "next/og";
import { BrandOgCard, OG_SIZE } from "@/components/marketing/og";
import { payeeDisplay } from "@/lib/payee";
import { loadPublicRequest } from "@/lib/request-source";
import { formatAmount, isToken } from "@/lib/view/money";
import { LIMITS, cleanText } from "@/lib/view/text";

export const alt = "Payment request on Owed. Pay with any Solana wallet.";
export const size = OG_SIZE;
export const contentType = "image/png";

/** Longest domain the card prints. A longer one is left off rather than cut: a cut domain can read as another. */
const MAX_CARD_DOMAIN = 34;

/**
 * The sender line, only for a domain that published the recipient in DNS (W2-H) and reads cleanly:
 * no lookalike warnings and short enough to print whole. The pay page always shows the full domain.
 */
function verifiedDomain(domain: string | null | undefined, verifiedAt: string | null | undefined): string | null {
  if (!domain || !verifiedAt) return null;
  const payee = payeeDisplay(domain);
  if (!payee || payee.warnings.length > 0 || payee.label.length > MAX_CARD_DOMAIN) return null;
  return payee.label;
}

// Preview card for WhatsApp, iMessage and X: amount, the quoted reason and how to pay. No names: the
// card must not vouch for who is asking. The one sender it shows is a domain checked in DNS.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await loadPublicRequest(id).catch(() => null);

  if (!request) {
    return new ImageResponse(<BrandOgCard title="Owed" line="Ask anyone for money" cta="Pay with any Solana wallet" />, size);
  }

  const token = isToken(request.token) ? request.token : "USDC";
  const forText = cleanText(request.for, LIMITS.ogFor);
  return new ImageResponse(
    (
      <BrandOgCard
        title={formatAmount(request.amount, token)}
        line={forText ? `for “${forText}”` : null}
        verified={verifiedDomain(request.from_domain, request.from_domain_verified_at)}
        cta={request.chain === "base" ? "Pay from any Base wallet" : "Pay with any Solana wallet"} // W3-B
      />
    ),
    size,
  );
}
