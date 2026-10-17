import { formatUnits } from "../money";
import { DEFAULT_MAX_ATOMIC, DEFAULT_MIN_ATOMIC } from "./config";

// Which requests can be paid by card, and why not. Pure.

export interface CardLimits {
  minAtomic: bigint;
  maxAtomic: bigint;
}

export const DEFAULT_LIMITS: CardLimits = { minAtomic: DEFAULT_MIN_ATOMIC, maxAtomic: DEFAULT_MAX_ATOMIC };

export type CardEligibility =
  | { ok: true }
  | { ok: false; reason: "not_usdc_on_solana" | "not_open" }
  | { ok: false; reason: "below_minimum" | "above_maximum"; limit: string }
  | { ok: false; reason: "sub_cent" };

/** MoonPay prices usdc_sol to the cent (precision 2); an amount with more digits would arrive short. */
const CENT_ATOMIC = 10_000n;

export function cardEligibility(
  req: { token: string; chain?: string; amountAtomic: bigint; status: string },
  limits: CardLimits = DEFAULT_LIMITS,
): CardEligibility {
  if (req.token !== "USDC" || (req.chain ?? "solana") !== "solana") return { ok: false, reason: "not_usdc_on_solana" };
  if (req.status !== "open") return { ok: false, reason: "not_open" };
  if (req.amountAtomic < limits.minAtomic) return { ok: false, reason: "below_minimum", limit: formatUnits(limits.minAtomic, 6) };
  if (req.amountAtomic > limits.maxAtomic) return { ok: false, reason: "above_maximum", limit: formatUnits(limits.maxAtomic, 6) };
  if (req.amountAtomic % CENT_ATOMIC !== 0n) return { ok: false, reason: "sub_cent" };
  return { ok: true };
}

/** One sentence for the payer, shown where the card button would be. Null when nothing needs saying. */
export function ineligibleNote(e: CardEligibility): string | null {
  if (e.ok) return null;
  switch (e.reason) {
    case "below_minimum":
      return `Paying by card isn't offered for this request: MoonPay's smallest USDC purchase is ${e.limit} USDC.`;
    case "above_maximum":
      return `Paying by card isn't offered for this request: it is more than MoonPay's largest USDC purchase (${e.limit} USDC).`;
    case "sub_cent":
      return "Paying by card isn't offered for this request: MoonPay sells USDC in whole cents, and this amount has more decimals.";
    default:
      return null;
  }
}
