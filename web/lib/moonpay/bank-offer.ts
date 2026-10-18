import "server-only";
import { toAtomic } from "../money";
import { activeVirtualAccounts, bankDetailsGuard } from "./accounts";
import { centsText, fiatAskOf } from "./bank";
import { bankRailConfig, type PayerRail, type PayoutCurrency } from "./enterprise";

// "Pay by bank transfer" on an invoice (F3 bank rail): the recipient's own MoonPay Enterprise virtual account in the
// invoice's currency, the exact amount, and no payment reference. Nothing unless OWED_BANK_RAIL=1 and the Enterprise
// keys are set, the invoice is open, it asks a whole number of cents in EUR, GBP or USD, and the recipient registered
// an active account in that currency whose details still carry the recipient's wallet signature (bankDetailsGuard).

export interface BankOffer {
  currency: PayoutCurrency;
  /** The exact amount to send, a decimal string with at most 2 decimals. */
  amount: string;
  rails: PayerRail[];
  sandbox: boolean;
}

export async function bankOffer(req: {
  recipient: string;
  token: string;
  chain?: string | null;
  amount: string;
  status: string;
  fiat?: { currency: string; amount: string } | null;
}): Promise<BankOffer | null> {
  const config = bankRailConfig();
  if (!config || req.status !== "open") return null;
  let amountAtomic: bigint;
  try {
    amountAtomic = toAtomic(req.amount, "USDC");
  } catch {
    return null;
  }
  const ask = fiatAskOf({ token: req.token, chain: req.chain ?? "solana", amountAtomic, fiat: req.fiat ?? null });
  if (!ask) return null;
  try {
    const va = (await activeVirtualAccounts(req.recipient)).find((a) => a.currency === ask.currency);
    if (!va) return null;
    const problem = bankDetailsGuard(va);
    if (problem) {
      console.warn(`virtual account ${va.id}: not shown (${problem})`);
      return null;
    }
    return { currency: ask.currency, amount: centsText(ask.cents), rails: va.details.rails, sandbox: config.sandbox };
  } catch (e) {
    console.warn(`bank offer: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
