import type { Rpc } from "./chain.js";

// QA-18. Solana won't create an account holding less than the rent-exempt minimum, so the first SOL a never-used
// wallet receives must be at least that much. A smaller SOL request to such a wallet could never be paid: every
// wallet, and pay_link, refuse it. The minimum is read from the cluster, never hard-coded (mainnet rent has changed).

/** Inside the 10 s call: runs alongside screening and the DNS check, before the API call. */
export const SOL_MINIMUM_BUDGET_MS = 2500;

/**
 * The smallest first payment, in lamports, when `recipient` has no account yet; null when it has one or when the
 * chain didn't answer in time (the request is then created as before). Never throws.
 */
export async function newWalletMinimum(rpc: Rpc, recipient: string, budgetMs = SOL_MINIMUM_BUDGET_MS): Promise<bigint | null> {
  const read = async (): Promise<bigint | null> => {
    const info = await rpc.call<{ value: unknown } | null>("getAccountInfo", [
      recipient, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
    ]);
    if (!info || info.value !== null) return null;
    const min = await rpc.call<number>("getMinimumBalanceForRentExemption", [0, { commitment: "confirmed" }]);
    return Number.isSafeInteger(min) && min > 0 ? BigInt(min) : null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, budgetMs)); })]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The refusal: names the wallet, the minimum and what was asked for ("a 0.000003 SOL request", "Sam's 0.000002 SOL share"). */
export function belowNewWalletMinimum(recipientShort: string, minSol: string, what: string): string {
  return `${recipientShort} has never been used on Solana, and the first SOL it receives must be at least ${minSol} SOL (Solana's minimum to open an account), so ${what} could never be paid. Ask for at least ${minSol} SOL, or use USDC. Nothing was created.`;
}
