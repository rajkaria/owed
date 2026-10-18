import * as z from "zod/v4";
import type { AddExpenseReq, GroupLedgerRes } from "./contract.js";
import { FIAT_CURRENCIES, formatFiat, isFiatCode, lockedAt, usdcAtomicFor, fromMinor, type FiatCode } from "./fiat.js";
import {
  decimalToUnits, expenseDigest, expensePrefix, ledgerBalances, LedgerError, ledgerText, planSettlement, settlePrefix, splitExpense,
  transferAmounts, unitsToDecimal, usdcToFiatUnits, WEIGHT_DECIMALS, type CanonicalExpense, type MemberBalance, type PlannedTransfer,
  type SplitInput, type SplitMode,
} from "./ledger-math.js";
import { clean, quote } from "./text.js";
import { signatureMatches } from "./tools/who_owes_me.js";

// F6 group ledgers, the plugin's half. The server stores a ledger and computes its balances; the plugin never takes
// that on trust. checkLedger re-derives every split, USDC share, balance and the settle-up plan with the same
// arithmetic (src/ledger-math.ts, byte-identical to web/lib/ledgers-math.ts) and checks every recorder's signature, so
// a server that changed an amount, a split or a plan is caught before anything is signed or shown as fact. Names and
// descriptions are members' own words: cleaned, quoted, never an identity.

/** Same words as web/lib/ledgers.ts LEDGER_CAUTION (web/test/ledgers-db.test.ts checks the server's). */
export const LEDGER_CAUTION =
  "Names, descriptions and amounts are written by whoever recorded them; Owed doesn't check them. Each expense and settle-up is signed by a wallet named in the ledger, and handles are labels Owed doesn't verify.";

export const MESSAGE_VALID_MS = 5 * 60_000;
const MAX_SKEW_MS = 60_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const ledgerIdInput = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/).describe("The ledger id start_ledger returned (12 characters; also the end of the ledger link).");
export const signedMessageInput = z.string().min(1).max(200).describe("Second call only: the exact message_to_sign from the first call.");
export const signatureInput = z.string().min(64).max(200)
  .describe("Second call only: the signature request_wallet_sign returned for that message (hex as PayBox returns it; base58 or base64 also work).");

export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** "USDC" -> 6; a local currency -> its minor units. */
export function currencyDecimals(currency: string): number {
  return currency === "USDC" ? 6 : isFiatCode(currency) ? FIAT_CURRENCIES[currency].decimals : 2;
}

/** "84.6 USDC" or "€84.60". */
export function money(amount: string, currency: string): string {
  return currency === "USDC" ? `${amount} USDC` : formatFiat(amount, currency);
}

const norm = (name: string) => clean(name, 40).toLowerCase().replace(/\s+/g, " ").trim();

/** The member a name (as the ledger lists it, any case) or a wallet in the ledger refers to. */
export function findMember(ledger: Pick<GroupLedgerRes, "members">, who: string): number | null {
  const key = norm(who);
  const byName = ledger.members.filter((m) => norm(m.name) === key);
  if (byName.length === 1) return byName[0]!.position;
  const byWallet = ledger.members.find((m) => m.wallet !== null && m.wallet === who.trim());
  return byWallet ? byWallet.position : null;
}

export function memberNames(ledger: Pick<GroupLedgerRes, "members">): string {
  return ledger.members.map((m) => quote(m.name, 40) || `Member ${m.position + 1}`).join(", ");
}

export function memberLabel(ledger: Pick<GroupLedgerRes, "members">, position: number): string {
  const m = ledger.members[position];
  return (m && clean(m.name, 40)) || `Member ${position + 1}`;
}

/** What a recorder must sign, wording and freshness first; null when the pair looks right. */
export function localSignatureCheck(lead: string, signer: string, message: string, signature: string, now: number, again: string): string | null {
  if (!message.startsWith(lead) || !ISO_RE.test(message.slice(lead.length))) {
    return `signed_message must be exactly the message_to_sign from the first call ("${lead}<time>"). If anything changed, ${again}`;
  }
  const signedAt = Date.parse(message.slice(lead.length));
  if (!Number.isFinite(signedAt)) return `signed_message has an invalid time. ${again}`;
  if (now - signedAt > MESSAGE_VALID_MS) return `That signed message is more than 5 minutes old. ${again}`;
  if (signedAt - now > MAX_SKEW_MS) return `That signed message is dated in the future. ${again}`;
  if (!signatureMatches(message, signature, signer)) {
    return `That signature isn't from wallet ${signer} over this exact message. Sign message_to_sign with that same wallet (request_wallet_sign, op solanaMessage) and pass its output signature unchanged.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- expenses

export interface ExpenseArgs {
  description?: string | undefined;
  paid_by: string;
  amount: string;
  currency?: string | undefined;
  split: SplitMode;
  among?: string[] | undefined;
  shares?: Array<{ member: string; shares: string }> | undefined;
  amounts?: Array<{ member: string; amount: string }> | undefined;
  items?: Array<{ description?: string | undefined; amount: string; members: string[] }> | undefined;
  tax?: string | undefined;
  tip?: string | undefined;
}

export interface BuiltExpense {
  /** The API body, without signer and signature. */
  body: Omit<AddExpenseReq, "signer" | "signed_message" | "signature">;
  canonical: CanonicalExpense;
  digest: string;
  /** Who owes what, in the expense's own units, by member position. */
  units: bigint[];
  participants: number[];
  currency: string;
  decimals: number;
}

const ascending = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

/**
 * The expense as the API takes it (member positions, amounts normalized), the canonical form the signature covers, and
 * the split worked out locally. Throws LedgerError with a message for the user.
 */
export function buildExpense(ledger: GroupLedgerRes, args: ExpenseArgs): BuiltExpense {
  const code = (args.currency ?? "USDC").trim().toUpperCase();
  if (code === "USD") throw new LedgerError("USD needs no conversion: 1 USDC is 1 US dollar. Use currency USDC (or leave it out).");
  if (code !== "USDC" && !isFiatCode(code)) throw new LedgerError(`Owed can't quote ${/^[A-Z]{3}$/.test(code) ? code : "that currency"}. Use USDC or one of ${Object.keys(FIAT_CURRENCIES).join(", ")}.`);
  const d = currencyDecimals(code);
  const positive = (text: string, what: string) => {
    const u = decimalToUnits(text, d, what);
    if (u === 0n) throw new LedgerError(`${what} must be more than zero.`);
    return u;
  };
  const member = (name: string, what: string) => {
    const p = findMember(ledger, name);
    if (p === null) throw new LedgerError(`${what}: ${quote(name, 40) || "that name"} isn't in this ledger. Its members are ${memberNames(ledger)}; name them exactly.`);
    return p;
  };
  const n = ledger.members.length;
  const paidBy = member(args.paid_by, "paid_by");
  const totalUnits = positive(args.amount, "amount");
  const description = ledgerText(args.description, 80);
  const listed = (field: "among" | "shares" | "amounts" | "items", expected: SplitMode) => {
    if (args[field] !== undefined && args.split !== expected) throw new LedgerError(`${field} goes with split "${expected}", not "${args.split}".`);
  };
  listed("among", "even"); listed("shares", "shares"); listed("amounts", "exact"); listed("items", "items");
  if (args.split !== "items" && (args.tax !== undefined || args.tip !== undefined)) throw new LedgerError('tax and tip go with split "items"; for other splits include them in amount.');
  const once = (positions: number[], what: string) => {
    if (new Set(positions).size !== positions.length) throw new LedgerError(`${what} names someone twice.`);
    return positions;
  };

  let among: number[] | null = null;
  let shares: Array<{ member: number; weight: bigint; text: string }> | null = null;
  let amounts: Array<{ member: number; units: bigint; text: string }> | null = null;
  let items: Array<{ description: string | null; units: bigint; members: number[]; text: string }> | null = null;
  if (args.split === "even") among = args.among ? ascending(once(args.among.map((m) => member(m, "among")), "among")) : Array.from({ length: n }, (_, i) => i);
  if (args.split === "shares") {
    if (!args.shares?.length) throw new LedgerError('split "shares" needs shares: each member with their number of shares.');
    shares = args.shares.map((s) => ({ member: member(s.member, "shares"), weight: decimalToUnits(s.shares, WEIGHT_DECIMALS, "shares"), text: s.shares }));
    once(shares.map((s) => s.member), "shares");
    shares.sort((a, b) => a.member - b.member);
  }
  if (args.split === "exact") {
    if (!args.amounts?.length) throw new LedgerError('split "exact" needs amounts: what each member owes.');
    amounts = args.amounts.map((a) => ({ member: member(a.member, "amounts"), units: positive(a.amount, "Each exact amount"), text: a.amount }));
    once(amounts.map((a) => a.member), "amounts");
    amounts.sort((a, b) => a.member - b.member);
  }
  if (args.split === "items") {
    if (!args.items?.length) throw new LedgerError('split "items" needs items: each receipt line with its amount and who had it.');
    items = args.items.map((i, k) => ({
      description: ledgerText(i.description, 60), units: positive(i.amount, `Item ${k + 1}'s amount`),
      members: ascending(once(i.members.map((m) => member(m, `Item ${k + 1}`)), `Item ${k + 1}`)), text: i.amount,
    }));
  }
  const taxUnits = args.tax === undefined ? null : positive(args.tax, "tax");
  const tipUnits = args.tip === undefined ? null : positive(args.tip, "tip");
  const input: SplitInput = {
    split: args.split, among, shares: shares?.map((s) => ({ member: s.member, weight: s.weight })) ?? null, amounts: amounts?.map((a) => ({ member: a.member, units: a.units })) ?? null,
    items: items?.map((i) => ({ units: i.units, members: i.members })) ?? null, taxUnits, tipUnits,
  };
  const split = splitExpense(totalUnits, input, n);
  const canonical: CanonicalExpense = {
    description, paidBy, currency: code, totalUnits, split: args.split, among,
    shares: input.shares ?? null, amounts: input.amounts ?? null,
    items: items?.map((i) => ({ description: i.description, units: i.units, members: i.members })) ?? null, taxUnits, tipUnits,
  };
  const dec = (u: bigint) => unitsToDecimal(u, d);
  const body: BuiltExpense["body"] = {
    ...(description !== null && { description }),
    paid_by: paidBy,
    amount: dec(totalUnits),
    ...(code !== "USDC" && { currency: code }),
    split: args.split,
    ...(args.split === "even" && args.among && { among: among! }),
    ...(shares && { shares: shares.map((s) => ({ member: s.member, shares: unitsToDecimal(s.weight, WEIGHT_DECIMALS) })) }),
    ...(amounts && { amounts: amounts.map((a) => ({ member: a.member, amount: dec(a.units) })) }),
    ...(items && { items: items.map((i) => ({ ...(i.description !== null && { description: i.description }), amount: dec(i.units), members: i.members })) }),
    ...(taxUnits !== null && { tax: dec(taxUnits) }),
    ...(tipUnits !== null && { tip: dec(tipUnits) }),
  };
  return { body, canonical, digest: expenseDigest(ledger.id, canonical), units: split.units, participants: split.participants, currency: code, decimals: d };
}

export function expenseLead(ledgerId: string, built: BuiltExpense, signer: string): string {
  return `${expensePrefix(ledgerId, built.digest, unitsToDecimal(built.canonical.totalUnits, built.decimals), built.currency, signer)} at `;
}

// ---------------------------------------------------------------------------------------------- checking a ledger

export interface LedgerCheck {
  /** What doesn't add up or doesn't verify, for the user. Empty when the ledger checks out. */
  problems: string[];
  balances: MemberBalance[];
  plan: PlannedTransfer[];
}

const usdc = (atomic: bigint) => unitsToDecimal(atomic, 6);

/** The stored split as splitExpense takes it, and the canonical form its recorder signed. */
function storedExpense(l: GroupLedgerRes, e: GroupLedgerRes["expenses"][number]) {
  const d = currencyDecimals(e.currency);
  const u = (s: string) => decimalToUnits(s, d);
  const input: SplitInput = {
    split: e.split,
    among: e.split === "even" ? e.shares.map((s) => s.member) : null,
    shares: e.split === "shares" ? e.shares.map((s) => ({ member: s.member, weight: decimalToUnits(s.weight ?? "0", WEIGHT_DECIMALS) })) : null,
    amounts: e.split === "exact" ? e.shares.map((s) => ({ member: s.member, units: u(s.share) })) : null,
    items: e.split === "items" ? (e.items ?? []).map((i) => ({ units: u(i.amount), members: i.members })) : null,
    taxUnits: e.tax === null ? null : u(e.tax),
    tipUnits: e.tip === null ? null : u(e.tip),
  };
  const canonical: CanonicalExpense = {
    description: e.description, paidBy: e.paid_by, currency: e.currency, totalUnits: u(e.total), split: e.split,
    among: input.among ?? null, shares: input.shares ?? null, amounts: input.amounts ?? null,
    items: e.split === "items" ? (e.items ?? []).map((i) => ({ description: i.description, units: u(i.amount), members: i.members })) : null,
    taxUnits: input.taxUnits ?? null, tipUnits: input.tipUnits ?? null,
  };
  return { input, canonical, d };
}

export function checkLedger(l: GroupLedgerRes): LedgerCheck {
  const problems: string[] = [];
  const n = l.members.length;
  const wallets = new Set(l.members.map((m) => m.wallet).filter((w): w is string => w !== null));
  if (l.members.some((m, i) => m.position !== i) || l.members[0]?.wallet !== l.owner) problems.push("the member list isn't in ledger order with the owner first");
  const expenses = l.expenses.map((e) => {
    const where = `expense ${e.position + 1}`;
    const sharesAtomic = Array.from({ length: n }, () => 0n);
    try {
      if (e.currency !== "USDC" && !isFiatCode(e.currency)) throw new LedgerError(`its currency ${e.currency} isn't one Owed quotes`);
      const { input, canonical, d } = storedExpense(l, e);
      const split = splitExpense(canonical.totalUnits, input, n);
      const rows = new Map(e.shares.map((s) => [s.member, s]));
      let sum = 0n;
      for (let p = 0; p < n; p++) {
        const row = rows.get(p);
        const units = row ? decimalToUnits(row.share, d) : 0n;
        if (units !== split.units[p]) throw new LedgerError(`${memberLabel(l, p)}'s share isn't what the split gives`);
        const atomic = row ? decimalToUnits(row.amount, 6) : 0n;
        const expected = e.currency === "USDC" || units === 0n ? units : usdcAtomicFor(fromMinor(units, e.currency as FiatCode), e.currency as FiatCode, e.fiat?.rate ?? "0");
        if (atomic !== expected) throw new LedgerError(`${memberLabel(l, p)}'s USDC share isn't the locked quote`);
        sharesAtomic[p] = atomic;
        sum += atomic;
      }
      if (sum !== decimalToUnits(e.amount, 6)) throw new LedgerError("its USDC total isn't the sum of the shares");
      if (e.currency !== "USDC" && (!e.fiat || e.fiat.currency !== e.currency || e.fiat.amount !== e.total)) throw new LedgerError("its quote isn't for this amount");
      const lead = `${expensePrefix(l.id, expenseDigest(l.id, canonical), e.total, e.currency, e.recorded_by)} at `;
      if (!wallets.has(e.recorded_by) || !e.signed_message.startsWith(lead) || !signatureMatches(e.signed_message, e.signature, e.recorded_by)) {
        throw new LedgerError("it isn't signed by a wallet in the ledger over exactly what is stored");
      }
    } catch (error) {
      problems.push(`${where}: ${error instanceof Error ? error.message : "it can't be read"}`);
    }
    return { paidBy: e.paid_by, amountAtomic: decimalToUnits(e.amount, 6), sharesAtomic };
  });
  const transfers = l.settlements.flatMap((s) => {
    const total = s.transfers.reduce((a, t) => a + decimalToUnits(t.amount, 6), 0n);
    const lead = `${settlePrefix(l.id, s.round, s.transfers.length, usdc(total), s.recorded_by)} at `;
    if (!wallets.has(s.recorded_by) || !s.signed_message.startsWith(lead) || !signatureMatches(s.signed_message, s.signature, s.recorded_by)) {
      problems.push(`settle-up v${s.round}: it isn't signed by a wallet in the ledger over these requests`);
    }
    return s.transfers.map((t) => {
      const amountAtomic = decimalToUnits(t.amount, 6);
      return { from: t.from, to: t.to, amountAtomic, ...transferAmounts(t.status, amountAtomic, t.paid ? decimalToUnits(t.paid.amount, 6) : null) };
    });
  });
  let balances: MemberBalance[] = [];
  let plan: PlannedTransfer[] = [];
  try {
    balances = ledgerBalances(n, expenses, transfers);
    plan = planSettlement(balances.map((b) => b.toSettle));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "the balances can't be worked out");
  }
  const theirs = l.balances.map((b) => [b.paid, b.share, b.sent, b.received, b.net, b.pending_out, b.pending_in, b.to_settle].join(" "));
  const ours = balances.map((b) => [b.paid, b.share, b.sent, b.received, b.net, b.pendingOut, b.pendingIn, b.toSettle].map(usdc).join(" "));
  if (theirs.join("|") !== ours.join("|")) problems.push("the balances Owed's server sent don't match the expenses and requests");
  const planOurs = plan.map((t) => `${t.from}>${t.to}:${usdc(t.amountAtomic)}:${l.members[t.to]?.wallet != null}`).join(",");
  const planTheirs = l.plan.map((t) => `${t.from}>${t.to}:${t.amount}:${t.payable}`).join(",");
  if (planOurs !== planTheirs) problems.push("the settle-up plan Owed's server sent isn't the one the balances give");
  return { problems, balances, plan };
}

// ---------------------------------------------------------------------------------------------- showing balances

/** ≈ the amount in the ledger's latest local currency (display only), or null. */
export function fiatBeside(l: GroupLedgerRes, atomic: bigint): string | null {
  const f = l.fiat_beside;
  if (!f || !isFiatCode(f.currency) || atomic === 0n) return null;
  const d = FIAT_CURRENCIES[f.currency].decimals;
  try {
    const units = usdcToFiatUnits(atomic < 0n ? -atomic : atomic, f.rate, d);
    return `≈ ${formatFiat(unitsToDecimal(units, d), f.currency)}`;
  } catch {
    return null;
  }
}

export function fiatNote(l: GroupLedgerRes): string | null {
  const f = l.fiat_beside;
  return f ? `Amounts in ${f.currency} are approximate, at the rate locked for the latest ${f.currency} expense (${lockedAt(f.quoted_at)}); everything is settled in USDC.` : null;
}

/** "Raj is owed 75.719754 USDC (≈ €65.00)", "Alex owes …", "Sam is square". */
export function balanceLine(l: GroupLedgerRes, b: MemberBalance, position: number): string {
  const name = quote(memberLabel(l, position), 40);
  const pending = [
    b.pendingOut > 0n ? `${usdc(b.pendingOut)} USDC already requested from them` : null,
    b.pendingIn > 0n ? `${usdc(b.pendingIn)} USDC on its way to them` : null,
  ].filter(Boolean).join(", ");
  const tail = pending ? ` (${pending})` : "";
  if (b.net === 0n) return `${name} is square${tail}.`;
  const amount = b.net < 0n ? -b.net : b.net;
  const fiat = fiatBeside(l, amount);
  return `${name} ${b.net > 0n ? "is owed" : "owes"} ${usdc(amount)} USDC${fiat ? ` (${fiat})` : ""}${tail}.`;
}

export function planLine(l: GroupLedgerRes, t: PlannedTransfer): string {
  const payable = l.members[t.to]?.wallet != null;
  return `${quote(memberLabel(l, t.from), 40)} pays ${quote(memberLabel(l, t.to), 40)} ${usdc(t.amountAtomic)} USDC${payable ? "" : ` (${quote(memberLabel(l, t.to), 40)} has no wallet in this ledger, so Owed can't create this request)`}`;
}

export const ledgerMemberOutput = z.object({
  position: z.number().int(),
  name: z.string().describe("As the ledger lists it: the owner's words, unverified. Use it to name members in add_expense."),
  wallet: z.string().nullable(),
  handle: z.string().nullable().describe("X handle label (not verified by Owed)."),
  sns: z.string().nullable(),
}).strict();

export function membersOut(l: GroupLedgerRes) {
  return l.members.map((m) => ({ position: m.position, name: clean(m.name, 40) || `Member ${m.position + 1}`, wallet: m.wallet, handle: m.handle, sns: m.sns }));
}

export function walletLine(l: GroupLedgerRes): string | null {
  const without = l.members.filter((m) => m.wallet === null).map((m) => quote(m.name, 40));
  return without.length ? `No wallet in this ledger: ${without.join(", ")}. They can owe (their settle-up request is a plain pay link), but nothing can pay them through Owed.` : null;
}

