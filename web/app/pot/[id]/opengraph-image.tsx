import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/og-card";
import { siteOrigin } from "@/lib/site";
import { LIMITS, truncate } from "@/lib/view/text";
import { countLine, potView, raisedLine } from "./model";
import { loadPagePot } from "./source";

export const alt = "Chip-in pot on Owed. Chip in with any Solana wallet.";
export const size = OG_SIZE;
export const contentType = "image/png";

// Preview card for WhatsApp, iMessage and X: what was raised (of the target), how many chipped in and the quoted
// title. No names: the card must not vouch for who is collecting. A flagged pot shows no title at all.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pot = await loadPagePot(id, siteOrigin()).catch(() => null);
  if (!pot) {
    return new ImageResponse(<OgCard amount="Owed" line="Chip in with anyone" cta="Pay with any Solana wallet" />, size);
  }
  const view = potView(pot, siteOrigin());
  const title = view.title && view.brandWords.length === 0 ? ` · for “${truncate(view.title, LIMITS.ogFor)}”` : "";
  return new ImageResponse(
    (
      <OgCard
        amount={raisedLine(view)}
        line={`${countLine(view.count)}${title}`}
        cta={view.ended ? "This pot has ended" : "Chip in with any Solana wallet"}
      />
    ),
    size,
  );
}
