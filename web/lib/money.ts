// Money is bigint atomic units inside, decimal strings at the edges. Never floats.

export type Token = "USDC" | "SOL";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const TOKENS: Record<Token, { decimals: number; mint: string | null }> = {
  USDC: { decimals: 6, mint: USDC_MINT },
  SOL: { decimals: 9, mint: null },
};

const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export class AmountError extends Error {}

export function isToken(s: unknown): s is Token {
  return s === "USDC" || s === "SOL";
}

/** Decimal string -> atomic units. Rejects zero, signs, exponents, too many decimals and > u64. */
export function toAtomic(amount: string, token: Token): bigint {
  const { decimals } = TOKENS[token];
  const shape = `amount must be a positive decimal with at most ${decimals} decimal places`;
  const m = DECIMAL.exec(amount);
  if (!m) throw new AmountError(shape);
  const whole = m[1];
  const frac = m[2] ? m[2].slice(1) : "";
  if (frac.length > decimals) throw new AmountError(shape);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (atomic <= 0n) throw new AmountError(shape);
  if (atomic > U64_MAX) throw new AmountError("amount is too large");
  return atomic;
}

/** Atomic units -> shortest decimal string ("15", "4.5", "0.000001"). */
export function fromAtomic(atomic: bigint, token: Token): string {
  return formatUnits(atomic, TOKENS[token].decimals);
}

export function formatUnits(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
