// Owned by sprint W1-A (plugin-core). Signatures are fixed; bodies are filled by the sprint.
// Money is decimal strings at the edges and bigint atomic units inside. No Number, no floats.
export type Token = "USDC" | "SOL";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const TOKENS: Record<Token, { decimals: number; mint: string | null; symbol: string }> = {
  USDC: { decimals: 6, mint: USDC_MINT, symbol: "USDC" },
  SOL: { decimals: 9, mint: null, symbol: "SOL" },
};

/** Largest amount an SPL token account or a lamport balance can hold. */
export const U64_MAX = 18_446_744_073_709_551_615n;

export const MAX_SPLIT = 20;

/** An amount the user or a link supplied is not acceptable. Message is shown to the user verbatim. */
export class AmountError extends Error {}

const AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
// u64 max has 20 digits and tokens have at most 9 decimals, so anything longer is out of range.
const MAX_AMOUNT_CHARS = 64;

function tokenInfo(token: Token): { decimals: number; symbol: string } {
  const info = Object.hasOwn(TOKENS, token) ? TOKENS[token] : undefined;
  if (!info) throw new AmountError("Owed handles USDC or SOL only.");
  return info;
}

/** Decimal string -> atomic units. Throws on zero, negative, too many decimals or > u64. */
export function toAtomic(amount: string, token: Token): bigint {
  const { decimals, symbol } = tokenInfo(token);
  if (typeof amount !== "string" || amount.length > MAX_AMOUNT_CHARS) {
    throw new AmountError("Amount is too large.");
  }
  const match = AMOUNT_RE.exec(amount);
  if (!match) throw new AmountError("Amount must be a plain decimal number like 15 or 0.5.");
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").slice(1);
  if (fraction.length > decimals) {
    throw new AmountError(`${symbol} amounts have at most ${decimals} decimal places.`);
  }
  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  if (atomic === 0n) throw new AmountError("Amount must be more than zero.");
  if (atomic > U64_MAX) throw new AmountError("Amount is too large.");
  return atomic;
}

/** Atomic units -> shortest decimal string ("15", "0.5"). */
export function fromAtomic(atomic: bigint, token: Token): string {
  const { decimals } = tokenInfo(token);
  if (typeof atomic !== "bigint") throw new TypeError("fromAtomic expects a bigint.");
  if (atomic < 0n) throw new RangeError("fromAtomic expects a non-negative amount.");
  const digits = atomic.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Split total into n shares; leftover atomic units go to the first shares. */
export function splitEvenly(total: bigint, n: number): bigint[] {
  if (!Number.isInteger(n) || n < 1 || n > MAX_SPLIT) {
    throw new AmountError(`A split needs between 1 and ${MAX_SPLIT} people.`);
  }
  if (typeof total !== "bigint" || total <= 0n) throw new AmountError("Amount must be more than zero.");
  const count = BigInt(n);
  if (total < count) throw new AmountError(`Amount is too small to split ${n} ways.`);
  const share = total / count;
  const leftover = total % count;
  return Array.from({ length: n }, (_, i) => (BigInt(i) < leftover ? share + 1n : share));
}
