import "server-only";
import type { AddExpenseBody } from "./contract";
import { fiatCurrency, FiatError, type FiatCode } from "./fiat";
import { ApiError } from "./http";
import {
  decimalToUnits, expenseDigest, expensePrefix, LedgerError, ledgerText, settlePrefix, splitExpense, unitsToDecimal, WEIGHT_DECIMALS,
  type CanonicalExpense, type PlannedTransfer, type SplitInput, type SplitResult,
} from "./ledgers-math";
import { currencyDecimals, LEDGER_TEXT_LIMITS, ledgerState, type LoadedLedger, type MemberRow } from "./ledgers";
import { sanitizeText } from "./safety";

// F6: what a ledger write means before anything is stored, with no I/O. The routes check the signature against the
// prefix computed here, so a signature covers exactly what the server will store (lib/ledgers-math.ts).

const bad = (message: string) => new ApiError("invalid_input", message);

function asApi<T>(fn: () => T, field?: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LedgerError || e instanceof FiatError) throw bad(field ? `${field}: ${e.message}` : e.message);
    throw e;
  }
}

/**
 * Recorder-written text as stored: lib/ledgers-math.ts ledgerText (the plugin cleans with the same function, so the
 * digest it signs matches), and never anything the general sanitizer would still change.
 */
export function storedText(input: string | null | undefined, max: number, field: string): string | null {
  const text = ledgerText(input, max);
  if (text !== null && sanitizeText(text, max) !== text) throw bad(`${field}: has characters Owed can't store; rephrase it`);
  return text;
}

/** The ledger member who signs: the owner's or a member's wallet, exactly. */
export function signingMember(loaded: Pick<LoadedLedger, "members">, signer: string): MemberRow | null {
  return loaded.members.find((m) => m.wallet !== null && m.wallet === signer) ?? null;
}

export interface PreparedExpense {
  canonical: CanonicalExpense;
  digest: string;
  /** What the signed message must read before " at <ISO time>". */
  prefix: string;
  currency: FiatCode | null;
  decimals: number;
  totalUnits: bigint;
  taxUnits: bigint | null;
  tipUnits: bigint | null;
  description: string | null;
  items: Array<{ description: string | null; units: bigint; members: number[] }>;
  /** Weights by position (split "shares"). */
  weights: Map<number, bigint>;
  split: SplitResult;
}

/** Validates an add-expense body against a ledger of `memberCount` and computes who owes what, in units. */
export function prepareExpense(ledgerId: string, memberCount: number, body: AddExpenseBody, signer: string): PreparedExpense {
  const code = (body.currency ?? "USDC").trim().toUpperCase();
  const currency: FiatCode | null = code === "USDC" ? null : asApi(() => fiatCurrency(code), "currency");
  const decimals = currencyDecimals(currency);
  const unit = currency ?? "USDC";
  const positive = (text: string, field: string): bigint => {
    const units = asApi(() => decimalToUnits(text, decimals, `${unit} amount`), field);
    if (units === 0n) throw bad(`${field}: must be more than zero`);
    return units;
  };
  if (body.paid_by >= memberCount) throw bad("paid_by: names someone who isn't in this ledger");
  const totalUnits = positive(body.amount, "amount");
  const taxUnits = body.tax == null ? null : positive(body.tax, "tax");
  const tipUnits = body.tip == null ? null : positive(body.tip, "tip");
  const description = storedText(body.description, LEDGER_TEXT_LIMITS.description, "description");

  const among = body.split === "even" ? (body.among ?? Array.from({ length: memberCount }, (_, i) => i)) : body.among ?? null;
  const shares = body.shares?.map((s, i) => ({ member: s.member, weight: asApi(() => decimalToUnits(s.shares, WEIGHT_DECIMALS, "shares"), `shares.${i}`) })) ?? null;
  const amounts = body.amounts?.map((a, i) => ({ member: a.member, units: positive(a.amount, `amounts.${i}.amount`) })) ?? null;
  const items = body.items?.map((item, i) => ({
    description: storedText(item.description, LEDGER_TEXT_LIMITS.item, `items.${i}.description`),
    units: positive(item.amount, `items.${i}.amount`),
    members: [...item.members],
  })) ?? null;
  const input: SplitInput = { split: body.split, among, shares, amounts, items, taxUnits, tipUnits };
  const split = asApi(() => splitExpense(totalUnits, input, memberCount));

  const canonical: CanonicalExpense = {
    description, paidBy: body.paid_by, currency: unit, totalUnits, split: body.split,
    among: body.split === "even" ? among : null, shares, amounts, items, taxUnits, tipUnits,
  };
  const digest = expenseDigest(ledgerId, canonical);
  return {
    canonical, digest, prefix: expensePrefix(ledgerId, digest, unitsToDecimal(totalUnits, decimals), unit, signer),
    currency, decimals, totalUnits, taxUnits, tipUnits, description, items: items ?? [],
    weights: new Map((shares ?? []).map((s) => [s.member, s.weight])), split,
  };
}

export interface PreparedSettlement {
  /** Transfers whose creditor has a wallet: each becomes a request. */
  payable: PlannedTransfer[];
  /** Transfers to a creditor without a wallet: nothing can pay them through Owed yet. */
  unpayable: PlannedTransfer[];
  totalAtomic: bigint;
  prefix: string;
}

const U64_MAX = (1n << 64n) - 1n;

/** The settle-up the signer approves: the ledger's plan now, at its current version. */
export function prepareSettlement(loaded: LoadedLedger, signer: string): PreparedSettlement {
  const { plan } = ledgerState(loaded);
  const wallet = (p: number) => loaded.members[p]?.wallet ?? null;
  const payable = plan.filter((t) => wallet(t.to) !== null);
  const unpayable = plan.filter((t) => wallet(t.to) === null);
  if (plan.length === 0) throw bad("nothing to settle: every balance is zero or already has an open settle-up request");
  if (payable.length === 0) {
    throw bad("nobody who is owed money has a wallet in this ledger, so no settle-up request can pay them; settle those by hand");
  }
  if (payable.some((t) => t.amountAtomic > U64_MAX)) throw bad("a settle-up amount is too large for one request");
  const totalAtomic = payable.reduce((a, t) => a + t.amountAtomic, 0n);
  return { payable, unpayable, totalAtomic, prefix: settlePrefix(loaded.ledger.id, loaded.ledger.version, payable.length, unitsToDecimal(totalAtomic, 6), signer) };
}
