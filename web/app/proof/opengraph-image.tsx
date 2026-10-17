import { ImageResponse } from "next/og";
import { BrandOgCard, OG_SIZE } from "@/components/marketing/og";

export const alt = "Proof: real Owed payments on Solana mainnet, each with its transaction.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    <BrandOgCard title="Proof" line="Real payments on Solana mainnet, each with its transaction" cta="getowed.xyz/proof" />,
    size,
  );
}
