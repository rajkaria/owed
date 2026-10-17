// Display-side money helpers for the pay pages. Amounts arrive as decimal
// strings; any arithmetic happens on bigint atomic units. No floats.

export type Token = "USDC" | "SOL";

export const TOKEN_DECIMALS: Record<Token, number> = { USDC: 6, SOL: 9 };

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const TEN = BigInt(10);
const ZERO = BigInt(0);

export function isToken(value: unknown): value is Token {
  return value === "USDC" || value === "SOL";
}

/** Decimal string to atomic units. Null when malformed or too precise. */
export function toAtomic(amount: string, decimals: number): bigint | null {
  if (typeof amount !== "string" || amount.length > 40 || !DECIMAL.test(amount)) return null;
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) return null;
  return BigInt(whole) * TEN ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Atomic units to the shortest decimal string ("15", "4.5", "0.000001"). */
export function fromAtomic(atomic: bigint, decimals: number): string {
  const negative = atomic < ZERO;
  const abs = negative ? -atomic : atomic;
  const base = TEN ** BigInt(decimals);
  const whole = (abs / base).toString();
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** What is still owed after a partial payment, or null if inputs are unusable. */
export function remainingAmount(requested: string, paid: string, token: Token): string | null {
  const decimals = TOKEN_DECIMALS[token];
  const want = toAtomic(requested, decimals);
  const got = toAtomic(paid, decimals);
  if (want === null || got === null) return null;
  const left = want - got;
  return fromAtomic(left > ZERO ? left : ZERO, decimals);
}

/** "1250.5" -> "1,250.5". Leaves anything that is not a plain decimal untouched. */
export function groupDigits(amount: string): string {
  if (!DECIMAL.test(amount)) return amount;
  const [whole, frac] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

/** "15 USDC", "0.25 SOL". */
export function formatAmount(amount: string, token: Token): string {
  return `${groupDigits(amount)} ${token}`;
}
