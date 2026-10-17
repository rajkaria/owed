import { ImageResponse } from "next/og";
import { OG_SIZE, OgCard } from "@/components/og-card";

export const alt = "Owed is a PayBox plugin that lets your agent ask anyone for money, then tells you who has paid.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    <OgCard amount="Owed" line="Your agent asks for money and knows when it lands" cta="Works with any Solana wallet" />,
    size,
  );
}
