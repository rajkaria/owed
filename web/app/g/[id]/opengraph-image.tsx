import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/og-card";
import { siteOrigin } from "@/lib/site";
import { formatAmount } from "@/lib/view/money";
import { LIMITS, truncate } from "@/lib/view/text";
import { boardFromGroup, paidLine, progress } from "./model";
import { loadBoardGroup } from "./source";

export const alt = "Split bill on Owed. Pay your share with any Solana wallet.";
export const size = OG_SIZE;
export const contentType = "image/png";

// Preview card for WhatsApp, iMessage and X: "2 of 3 paid", the total and the quoted
// title. No names: the card must not vouch for who is asking or who owes.
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const group = await loadBoardGroup(id, siteOrigin()).catch(() => null);
  if (!group) {
    return new ImageResponse(<OgCard amount="Owed" line="Split a bill with anyone" cta="Pay with any Solana wallet" />, size);
  }
  const model = boardFromGroup(group, siteOrigin());
  const title = model.title && model.brandWords.length === 0 ? ` · for “${truncate(model.title, LIMITS.ogFor)}”` : "";
  return new ImageResponse(
    (
      <OgCard
        amount={paidLine(progress(model))}
        line={`${formatAmount(model.total, model.token)}${title}`}
        cta="Pay your share with any Solana wallet"
      />
    ),
    size,
  );
}
