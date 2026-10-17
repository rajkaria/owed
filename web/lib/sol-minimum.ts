import "server-only";
import { ApiError } from "./http";
import { fromAtomic } from "./money";
import { rpcBatch } from "./solana";

// QA-18, the server's copy of plugin/src/sol-minimum.ts. Solana won't create an account holding less than the
// rent-exempt minimum, so the first SOL a never-used wallet receives must be at least that much. A smaller SOL
// request to such a wallet could never be paid, so creation refuses it. Read from the cluster, never hard-coded.

const BUDGET_MS = 2000;

/** Minimum first payment in lamports when `recipient` has no account; null when it has one or RPC didn't answer. */
export async function newWalletMinimum(recipient: string): Promise<bigint | null> {
  try {
    const [info, min] = await rpcBatch(
      [
        { method: "getAccountInfo", params: [recipient, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }] },
        { method: "getMinimumBalanceForRentExemption", params: [0, { commitment: "confirmed" }] },
      ],
      { deadline: Date.now() + BUDGET_MS, timeoutMs: BUDGET_MS },
    );
    const value = (info as { value?: unknown } | null)?.value;
    if (value !== null) return null; // the account exists (or the reply is off-shape): any amount works
    return typeof min === "number" && Number.isSafeInteger(min) && min > 0 ? BigInt(min) : null;
  } catch {
    return null; // chain unreadable: create as before; pay_link and wallets still refuse an unpayable amount
  }
}

/** Throws invalid_input when the smallest SOL amount can't open `recipient`'s account. */
export async function requireSolMinimum(recipient: string, smallestAtomic: bigint, what: string): Promise<void> {
  const min = await newWalletMinimum(recipient);
  if (min !== null && smallestAtomic < min) {
    const minSol = fromAtomic(min, "SOL");
    throw new ApiError(
      "invalid_input",
      `${what} is below ${minSol} SOL, the first payment Solana accepts into a wallet that has never been used, so it could never be paid; ask for at least ${minSol} SOL or use USDC`,
    );
  }
}
