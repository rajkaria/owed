import { ImageResponse } from "next/og";
import { BrandOgCard, OG_SIZE } from "@/components/marketing/og";

export const alt = "Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    <BrandOgCard
      title="Owed"
      line="Your agent asks anyone for money, then tells you who has paid"
      cta="Any Solana wallet or PayBox agent can pay"
    />,
    size,
  );
}
