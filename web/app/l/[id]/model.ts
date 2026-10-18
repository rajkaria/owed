// View model for the ledger page (/l/[id]). Pure: the page renders it on the server, tests call it. Every name and
// description is recorder-written: cleaned again here and rendered quoted. Amounts are decimal strings; any
// arithmetic is bigint (lib/ledgers-math.ts).

import type { GroupLedgerResponse } from "@/lib/contract";
import { FIAT_CURRENCIES, formatFiat, formatRate, isFiatCode, lockedAt } from "@/lib/fiat";
import { decimalToUnits, unitsToDecimal, usdcToFiatUnits } from "@/lib/ledgers-math";
import { formatAmount } from "@/lib/view/money";
import { brandWordsFromFlags, detectBrandWords } from "@/lib/view/request-view";
import { cleanText, LIMITS } from "@/lib/view/text";

export const TITLE_LIMIT = 60;
const DESCRIPTION_LIMIT = 80;
const ITEM_LIMIT = 60;

export type TransferStatus = "open" | "paid" | "underpaid" | "cancelled" | "expired";

export interface MemberView {
  position: number;
  /** Cleaned name (render quoted), or "Member N" when nothing readable is left. */
  label: string;
  quoted: boolean;
  owner: boolean;
  wallet: string | null;
  handle: string | null;
  sns: string | null;
  /** "owed" (net > 0), "owes" (net < 0) or "square". */
  direction: "owed" | "owes" | "square";
  /** |net| in USDC, e.g. "75.72 USDC". */
  net: string;
  /** ≈ the same in the ledger's latest local currency, or null. */
  netFiat: string | null;
  paid: string;
  share: string;
  pendingIn: string | null;
  pendingOut: string | null;
}

export interface ExpenseView {
  position: number;
  description: string | null;
  paidBy: string;
  /** "€84.60" or "84.6 USDC". */
  total: string;
  /** For a local-currency expense: what the payer is credited in USDC, e.g. "92.12 USDC". */
  usdc: string | null;
  rateLine: string | null;
  splitLine: string;
  shares: Array<{ label: string; share: string; usdc: string | null; weight: string | null }>;
  items: Array<{ description: string | null; amount: string; who: string }>;
  extras: string | null;
  recordedBy: string;
  recordedAt: string;
  signedMessage: string;
  signature: string;
  signatureOk: boolean;
  brandWords: string[];
}

export interface TransferView {
  id: string;
  from: string;
  to: string;
  amount: string;
  status: TransferStatus;
  link: string;
  addressed: boolean;
  paidAt: string | null;
  signature: string | null;
}

export interface RoundView {
  round: number;
  recordedBy: string;
  recordedAt: string;
  signatureOk: boolean;
  transfers: TransferView[];
}

export interface LedgerView {
  id: string;
  link: string;
  title: string | null;
  brandWords: string[];
  caution: string;
  members: MemberView[];
  expenses: ExpenseView[];
  plan: Array<{ from: string; to: string; amount: string; payable: boolean }>;
  rounds: RoundView[];
  spent: string;
  expenseCount: number;
  openRequests: number;
  settled: boolean;
  /** "Local amounts use the EUR rate locked for the latest EUR expense (2026-10-18 10:02 UTC)." */
  fiatNote: string | null;
}

const USDC = (amount: string) => formatAmount(amount, "USDC");
const SPLIT_WORDS: Record<string, string> = { even: "split evenly", shares: "split by shares", exact: "exact amounts", items: "receipt items" };

/** `verify(message, signature, signer)` is the server's ed25519 check (lib/verify-signature.ts). */
export function ledgerView(l: GroupLedgerResponse, origin: string, verify: (message: string, signature: string, signer: string) => boolean = () => false): LedgerView {
  const labels = l.members.map((m) => cleanText(m.name, LIMITS.name));
  const label = (p: number) => labels[p] ?? `Member ${p + 1}`;
  const quotedLabel = (p: number) => (labels[p] ? `“${labels[p]}”` : `Member ${p + 1}`);
  const byWallet = new Map(l.members.filter((m) => m.wallet).map((m) => [m.wallet!, m.position]));
  const recorder = (wallet: string) => {
    const p = byWallet.get(wallet);
    return p === undefined ? "a wallet not in this ledger" : quotedLabel(p);
  };
  const fiat = l.fiat_beside && isFiatCode(l.fiat_beside.currency) ? l.fiat_beside : null;
  const fiatOf = (usdcAmount: string): string | null => {
    if (!fiat) return null;
    const atomic = decimalToUnits(usdcAmount, 6);
    const d = FIAT_CURRENCIES[fiat.currency as keyof typeof FIAT_CURRENCIES].decimals;
    return `≈ ${formatFiat(unitsToDecimal(usdcToFiatUnits(atomic, fiat.rate, d), d), fiat.currency)}`;
  };
  const brandWords = Array.from(new Set([
    ...brandWordsFromFlags(l.flags),
    ...detectBrandWords([l.title, ...l.members.map((m) => m.name)]),
  ]));
  const members: MemberView[] = l.members.map((m) => {
    const b = l.balances[m.position]!;
    const negative = b.net.startsWith("-");
    const abs = negative ? b.net.slice(1) : b.net;
    const zero = /^0(\.0+)?$/.test(abs);
    return {
      position: m.position,
      label: label(m.position),
      quoted: labels[m.position] !== null,
      owner: m.position === 0,
      wallet: m.wallet,
      handle: m.handle,
      sns: m.sns,
      direction: zero ? "square" : negative ? "owes" : "owed",
      net: USDC(abs),
      netFiat: zero ? null : fiatOf(abs),
      paid: USDC(b.paid),
      share: USDC(b.share),
      pendingIn: /^0(\.0+)?$/.test(b.pending_in) ? null : USDC(b.pending_in),
      pendingOut: /^0(\.0+)?$/.test(b.pending_out) ? null : USDC(b.pending_out),
    };
  });
  const expenses: ExpenseView[] = l.expenses.map((e) => {
    const local = e.currency !== "USDC";
    const money = (amount: string) => (local ? formatFiat(amount, e.currency) : USDC(amount));
    const who = (positions: number[]) => positions.map(label).join(", ");
    const splitLine = e.split === "even"
      ? `${SPLIT_WORDS.even} between ${e.shares.length === l.members.length ? `all ${e.shares.length}` : e.shares.length}`
      : e.split === "items"
        ? `${SPLIT_WORDS.items}: ${e.items?.length ?? 0} ${(e.items?.length ?? 0) === 1 ? "line" : "lines"}`
        : SPLIT_WORDS[e.split] ?? e.split;
    const extras = [e.tax ? `tax ${money(e.tax)}` : null, e.tip ? `tip ${money(e.tip)}` : null].filter(Boolean).join(", ");
    return {
      position: e.position,
      description: cleanText(e.description, DESCRIPTION_LIMIT),
      paidBy: quotedLabel(e.paid_by),
      total: money(e.total),
      usdc: local ? USDC(e.amount) : null,
      rateLine: local && e.fiat ? `Locked ${lockedAt(e.fiat.quoted_at)}: ${formatRate(e.fiat.rate, e.currency)} (${e.fiat.rate_source}); each share rounded up to 0.000001 USDC.` : null,
      splitLine,
      shares: e.shares.map((s) => ({ label: label(s.member), share: money(s.share), usdc: local ? USDC(s.amount) : null, weight: s.weight })),
      items: (e.items ?? []).map((i) => ({ description: cleanText(i.description, ITEM_LIMIT), amount: money(i.amount), who: who(i.members) })),
      extras: extras || null,
      recordedBy: recorder(e.recorded_by),
      recordedAt: e.recorded_at,
      signedMessage: e.signed_message,
      signature: e.signature,
      signatureOk: byWallet.has(e.recorded_by) && verify(e.signed_message, e.signature, e.recorded_by),
      brandWords: Array.from(new Set([...brandWordsFromFlags(e.flags), ...detectBrandWords([e.description, ...(e.items ?? []).map((i) => i.description)])])),
    };
  });
  const rounds: RoundView[] = l.settlements.map((s) => ({
    round: s.round,
    recordedBy: recorder(s.recorded_by),
    recordedAt: s.recorded_at,
    signatureOk: byWallet.has(s.recorded_by) && verify(s.signed_message, s.signature, s.recorded_by),
    transfers: s.transfers.map((t) => ({
      id: t.request_id, from: quotedLabel(t.from), to: quotedLabel(t.to), amount: USDC(t.amount), status: t.status,
      link: `${origin}/r/${encodeURIComponent(t.request_id)}`, addressed: t.addressed, paidAt: t.paid?.at ?? null, signature: t.paid?.signature ?? null,
    })),
  }));
  return {
    id: l.id,
    link: `${origin}/l/${encodeURIComponent(l.id)}`,
    title: cleanText(l.title, TITLE_LIMIT),
    brandWords,
    caution: l.caution,
    members,
    expenses,
    plan: l.plan.map((t) => ({ from: quotedLabel(t.from), to: quotedLabel(t.to), amount: USDC(t.amount), payable: t.payable })),
    rounds,
    spent: USDC(l.totals.spent),
    expenseCount: l.totals.expense_count,
    openRequests: l.totals.open_requests,
    settled: l.settled,
    fiatNote: fiat ? `Amounts in ${fiat.currency} are approximate, at the rate locked for the latest ${fiat.currency} expense (${lockedAt(fiat.quoted_at)}). Everything is settled in USDC.` : null,
  };
}

/** Ids whose status can still change; the page polls only these. */
export function liveIds(view: Pick<LedgerView, "rounds">): string[] {
  return view.rounds.flatMap((r) => r.transfers).filter((t) => t.status === "open" || t.status === "underpaid").map((t) => t.id);
}

/** Page title: never echoes recorder text, so a flagged ledger can't title its own preview. */
export function ledgerTitle(view: Pick<LedgerView, "settled" | "expenseCount" | "openRequests">): string {
  if (view.settled) return "Group ledger: settled";
  if (view.openRequests > 0) return `Group ledger: ${view.openRequests} settle-up ${view.openRequests === 1 ? "request" : "requests"} open`;
  return `Group ledger: ${view.expenseCount} ${view.expenseCount === 1 ? "expense" : "expenses"}`;
}

export function ledgerDescription(view: Pick<LedgerView, "title" | "brandWords" | "spent" | "members">): string {
  const what = view.title && view.brandWords.length === 0 ? ` for “${view.title}”` : "";
  return `${view.spent} spent by ${view.members.length} people${what}. Settle up with any Solana wallet, or with your AI agent in PayBox.`;
}
