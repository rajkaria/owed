import "server-only";
import { toAtomic } from "../money";
import { cardLimits } from "./client";
import { moonpayConfig } from "./config";
import { cardEligibility, ineligibleNote } from "./eligibility";

// What a pay page offers for paying by card: a button (to /api/moonpay/<id>), a note saying why not,
// or nothing at all. Nothing when MoonPay isn't configured, so the page renders exactly as before.

export type CardOffer =
  | { kind: "button"; href: string; amount: string; sandbox: boolean }
  | { kind: "note"; text: string };

/** `?card=` on the page after MoonPay sends the payer back. */
export type CardNotice = "return" | "region" | null;

export function cardNotice(value: string | string[] | undefined): CardNotice {
  return value === "return" || value === "region" ? value : null;
}

export async function cardOffer(
  req: { id: string; token: string; chain?: string | null; amount: string; status: string },
  page: "r" | "i",
): Promise<CardOffer | null> {
  const config = moonpayConfig();
  if (!config) return null;
  let amountAtomic: bigint;
  try {
    amountAtomic = toAtomic(req.amount, "USDC");
  } catch {
    return null;
  }
  const eligible = cardEligibility(
    { token: req.token, chain: req.chain ?? "solana", amountAtomic, status: req.status },
    await cardLimits(config, Date.now() + 1000),
  );
  if (!eligible.ok) {
    const text = ineligibleNote(eligible);
    return text ? { kind: "note", text } : null;
  }
  const href = `/api/moonpay/${encodeURIComponent(req.id)}${page === "i" ? "?back=i" : ""}`;
  return { kind: "button", href, amount: req.amount, sandbox: config.sandbox };
}
