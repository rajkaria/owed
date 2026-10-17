// Owned by sprint W1-A (plugin-core). Signatures are fixed; bodies are filled by the sprint.
export type Token = "USDC" | "SOL";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const TOKENS: Record<Token, { decimals: number; mint: string | null; symbol: string }> = {
  USDC: { decimals: 6, mint: USDC_MINT, symbol: "USDC" },
  SOL: { decimals: 9, mint: null, symbol: "SOL" },
};

/** Decimal string -> atomic units. Throws on zero, negative, too many decimals or > u64. */
export function toAtomic(amount: string, token: Token): bigint {
  void amount; void token;
  throw new Error("not implemented: toAtomic");
}

/** Atomic units -> shortest decimal string ("15", "0.5"). */
export function fromAtomic(atomic: bigint, token: Token): string {
  void atomic; void token;
  throw new Error("not implemented: fromAtomic");
}

/** Split total into n shares; leftover atomic units go to the first shares. */
export function splitEvenly(total: bigint, n: number): bigint[] {
  void total; void n;
  throw new Error("not implemented: splitEvenly");
}
