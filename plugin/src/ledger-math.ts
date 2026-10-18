// F6 group ledger: the arithmetic every side runs. plugin/src/ledger-math.ts and web/lib/ledgers-math.ts are the same
// file, byte for byte (web/test/ledgers-math.test.ts checks), importing only node:crypto, so the plugin, the server and
// the page split an expense, net the balances and plan a settle-up exactly the same way.
//
// Money: decimal strings at the edges, bigint units inside, never floats. An expense is split in its own currency's
// smallest unit (USDC atomic units, 6 decimals, or a local currency's minor units, cents); the caller converts each
// member's share to USDC. Leftover units always go one each to the first members in ledger order, the way
// splitEvenly (plugin/src/money.ts) gives them to the first shares.

import { createHash } from "node:crypto";

export const LEDGER_LIMITS = {
  /** The owner plus up to 19 others (split_bill's MAX_SPLIT). */
  members: 20,
  expenses: 100,
  items: 30,
  title: 60,
  name: 40,
  description: 80,
  itemDescription: 60,
} as const;

export const SPLIT_MODES = ["even", "shares", "exact", "items"] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

/** A ledger input that can't be used. The message is shown to the user as-is. */
export class LedgerError extends Error {}

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const U64_MAX = (1n << 64n) - 1n;

/** "12.5" with 2 decimals -> 1250n. Zero is allowed here; callers refuse it where it matters. */
export function decimalToUnits(text: string, decimals: number, what = "amount"): bigint {
  const m = typeof text === "string" && text.length <= 40 ? DECIMAL_RE.exec(text) : null;
  if (!m) throw new LedgerError(`${what} must be a plain decimal number like 12 or 12.50.`);
  const frac = (m[2] ?? "").slice(1).replace(/0+$/, "");
  if (frac.length > decimals) {
    throw new LedgerError(decimals === 0 ? `${what} must be a whole number here.` : `${what} has more than ${decimals} decimal places.`);
  }
  const units = BigInt(m[1]! + frac.padEnd(decimals, "0"));
  if (units > U64_MAX) throw new LedgerError(`${what} is too large.`);
  return units;
}

/** 1250n with 2 decimals -> "12.5"; negative units keep their sign ("-12.5"). Shortest form. */
export function unitsToDecimal(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = decimals === 0 ? digits : digits.slice(0, -decimals);
  const frac = decimals === 0 ? "" : digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** `total` split `count` ways; the first `total % count` get one unit more (money.ts splitEvenly's rule). */
export function splitEvenlyUnits(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new LedgerError("A split needs at least one member.");
  const n = BigInt(count);
  const each = total / n;
  const leftover = total % n;
  return Array.from({ length: count }, (_, i) => (BigInt(i) < leftover ? each + 1n : each));
}

/**
 * `total` spread over `weights` in proportion, rounded down; the units left over go one each to the first entries
 * with a positive weight (so a member who owes nothing never picks up a unit). Weights must not all be zero.
 */
export function proRataUnits(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum <= 0n) {
    if (total === 0n) return weights.map(() => 0n);
    throw new LedgerError("Nothing to spread this amount over.");
  }
  const out = weights.map((w) => (total * w) / sum);
  let leftover = total - out.reduce((a, v) => a + v, 0n);
  for (let i = 0; i < out.length && leftover > 0n; i++) {
    if (weights[i]! > 0n) {
      out[i] = out[i]! + 1n;
      leftover -= 1n;
    }
  }
  return out;
}

/** The split as the API stores it: member positions (ascending), amounts in the expense's own units. */
export interface SplitInput {
  split: SplitMode;
  /** even: who shares it (default everyone). */
  among?: readonly number[] | null;
  /** shares: weights in 1/10,000ths ("1.5" shares is 15000n: decimalToUnits(text, WEIGHT_DECIMALS)). */
  shares?: ReadonlyArray<{ member: number; weight: bigint }> | null;
  /** exact: what each member owes, in units. */
  amounts?: ReadonlyArray<{ member: number; units: bigint }> | null;
  /** items: each line in units, split evenly among its members. Tax and tip follow each member's item subtotal. */
  items?: ReadonlyArray<{ units: bigint; members: readonly number[] }> | null;
  taxUnits?: bigint | null;
  tipUnits?: bigint | null;
}

export interface SplitResult {
  /** Units each member owes, indexed by member position (0 for members not in this expense). */
  units: bigint[];
  /** Positions in this expense, ascending. */
  participants: number[];
  /** items only: each member's item subtotal, tax part and tip part (indexed by position). */
  detail?: { subtotal: bigint[]; tax: bigint[]; tip: bigint[] };
}

export const WEIGHT_DECIMALS = 4;

function checkPositions(positions: readonly number[], memberCount: number, what: string): void {
  if (positions.length === 0) throw new LedgerError(`${what} names no one.`);
  positions.forEach((p, i) => {
    if (!Number.isInteger(p) || p < 0 || p >= memberCount) throw new LedgerError(`${what} names someone who isn't in this ledger.`);
    if (i > 0 && p <= positions[i - 1]!) throw new LedgerError(`${what} must list each member once, in ledger order.`);
  });
}

/**
 * Who owes what for one expense of `total` units. Throws LedgerError (user-facing) when the split doesn't add up:
 * exact amounts must sum to the total; items plus tax and tip must sum to the total.
 */
export function splitExpense(total: bigint, input: SplitInput, memberCount: number): SplitResult {
  if (!Number.isInteger(memberCount) || memberCount < 2 || memberCount > LEDGER_LIMITS.members) throw new LedgerError("A ledger has 2 to 20 members.");
  if (total <= 0n) throw new LedgerError("The amount must be more than zero.");
  const units = Array.from({ length: memberCount }, () => 0n);
  const extra = { among: input.among, shares: input.shares, amounts: input.amounts, items: input.items };
  for (const [key, value] of Object.entries(extra)) {
    const allowed = (input.split === "even" && key === "among") || (input.split === "shares" && key === "shares")
      || (input.split === "exact" && key === "amounts") || (input.split === "items" && key === "items");
    if (value != null && !allowed) throw new LedgerError(`${key} doesn't go with split "${input.split}".`);
  }
  if (input.split !== "items" && ((input.taxUnits ?? 0n) !== 0n || (input.tipUnits ?? 0n) !== 0n)) {
    throw new LedgerError('tax and tip go with split "items" only; for other splits, include them in the amount.');
  }
  switch (input.split) {
    case "even": {
      const among = input.among ?? Array.from({ length: memberCount }, (_, i) => i);
      checkPositions(among, memberCount, "among");
      if (total < BigInt(among.length)) throw new LedgerError(`The amount is too small to split ${among.length} ways.`);
      splitEvenlyUnits(total, among.length).forEach((u, k) => { units[among[k]!] = u; });
      return { units, participants: [...among] };
    }
    case "shares": {
      const shares = input.shares ?? [];
      checkPositions(shares.map((s) => s.member), memberCount, "shares");
      const weights = shares.map((s) => {
        if (s.weight <= 0n) throw new LedgerError("Each member's shares must be more than zero.");
        return s.weight;
      });
      proRataUnits(total, weights).forEach((u, k) => { units[shares[k]!.member] = u; });
      return { units, participants: shares.map((s) => s.member) };
    }
    case "exact": {
      const amounts = input.amounts ?? [];
      checkPositions(amounts.map((a) => a.member), memberCount, "amounts");
      let sum = 0n;
      for (const a of amounts) {
        if (a.units <= 0n) throw new LedgerError("Each exact amount must be more than zero.");
        units[a.member] = a.units;
        sum += a.units;
      }
      if (sum !== total) throw new LedgerError(`The exact amounts add up to ${sum} units, not the expense's ${total}.`);
      return { units, participants: amounts.map((a) => a.member) };
    }
    case "items": {
      const items = input.items ?? [];
      if (items.length === 0 || items.length > LEDGER_LIMITS.items) throw new LedgerError(`A receipt has 1 to ${LEDGER_LIMITS.items} items.`);
      const tax = input.taxUnits ?? 0n;
      const tip = input.tipUnits ?? 0n;
      if (tax < 0n || tip < 0n) throw new LedgerError("Tax and tip can't be negative.");
      const subtotal = Array.from({ length: memberCount }, () => 0n);
      let itemsSum = 0n;
      items.forEach((item, i) => {
        checkPositions(item.members, memberCount, `Item ${i + 1}`);
        if (item.units <= 0n) throw new LedgerError(`Item ${i + 1}'s amount must be more than zero.`);
        itemsSum += item.units;
        splitEvenlyUnits(item.units, item.members.length).forEach((u, k) => {
          const p = item.members[k]!;
          subtotal[p] = subtotal[p]! + u;
        });
      });
      if (itemsSum + tax + tip !== total) {
        throw new LedgerError(`The items (${itemsSum}) plus tax (${tax}) and tip (${tip}) add up to ${itemsSum + tax + tip} units, not the expense's ${total}.`);
      }
      const taxParts = proRataUnits(tax, subtotal);
      const tipParts = proRataUnits(tip, subtotal);
      const participants: number[] = [];
      for (let p = 0; p < memberCount; p++) {
        units[p] = subtotal[p]! + taxParts[p]! + tipParts[p]!;
        if (subtotal[p]! > 0n) participants.push(p);
      }
      return { units, participants, detail: { subtotal, tax: taxParts, tip: tipParts } };
    }
    default:
      throw new LedgerError('split must be "even", "shares", "exact" or "items".');
  }
}

// ---------------------------------------------------------------------------------------------- balances

export interface BalanceExpense {
  paidBy: number;
  /** USDC atomic units: the sum of sharesAtomic. */
  amountAtomic: bigint;
  /** USDC each member owes for it, indexed by position. */
  sharesAtomic: readonly bigint[];
}

/** A settle-up transfer: an Owed request from `from` (debtor) to `to` (creditor). */
export interface BalanceTransfer {
  from: number;
  to: number;
  amountAtomic: bigint;
  /** What has moved: the amount once paid, the partial payment if underpaid, else 0. */
  settledAtomic: bigint;
  /** Still committed to this request: the amount while it is open, else 0. */
  pendingAtomic: bigint;
}

export interface MemberBalance {
  /** Expenses this member paid for. */
  paid: bigint;
  /** This member's part of every expense. */
  share: bigint;
  /** Settle-up payments made and received. */
  sent: bigint;
  received: bigint;
  /** paid - share + sent - received: positive is owed money, negative owes money. */
  net: bigint;
  /** Open settle-up requests from and to this member. */
  pendingOut: bigint;
  pendingIn: bigint;
  /** What a new settle-up would still settle: net + pendingOut - pendingIn. */
  toSettle: bigint;
}

/** How a settle-up request's status counts: paid moves the full amount, underpaid what arrived, open stays pending. */
export function transferAmounts(status: string, amountAtomic: bigint, paidAtomic: bigint | null): { settledAtomic: bigint; pendingAtomic: bigint } {
  if (status === "paid") return { settledAtomic: amountAtomic, pendingAtomic: 0n };
  if (status === "underpaid") {
    const moved = paidAtomic === null || paidAtomic < 0n ? 0n : paidAtomic > amountAtomic ? amountAtomic : paidAtomic;
    return { settledAtomic: moved, pendingAtomic: 0n };
  }
  if (status === "open") return { settledAtomic: 0n, pendingAtomic: amountAtomic };
  return { settledAtomic: 0n, pendingAtomic: 0n }; // cancelled, expired: the debt is back on the ledger
}

export function ledgerBalances(memberCount: number, expenses: readonly BalanceExpense[], transfers: readonly BalanceTransfer[]): MemberBalance[] {
  const b = Array.from({ length: memberCount }, (): MemberBalance => ({
    paid: 0n, share: 0n, sent: 0n, received: 0n, net: 0n, pendingOut: 0n, pendingIn: 0n, toSettle: 0n,
  }));
  for (const e of expenses) {
    b[e.paidBy]!.paid += e.amountAtomic;
    e.sharesAtomic.forEach((s, p) => { b[p]!.share += s; });
  }
  for (const t of transfers) {
    b[t.from]!.sent += t.settledAtomic;
    b[t.to]!.received += t.settledAtomic;
    b[t.from]!.pendingOut += t.pendingAtomic;
    b[t.to]!.pendingIn += t.pendingAtomic;
  }
  for (const m of b) {
    m.net = m.paid - m.share + m.sent - m.received;
    m.toSettle = m.net + m.pendingOut - m.pendingIn;
  }
  return b;
}

export interface PlannedTransfer {
  from: number;
  to: number;
  amountAtomic: bigint;
}

/**
 * Greedy settle-up: the largest debtor pays the largest creditor the smaller of the two amounts, until everyone is at
 * zero. Every step zeroes at least one member (the last step two), so n members need at most n - 1 transfers, and
 * the transfers add up exactly to what is owed. Ties go to the earlier member in ledger order.
 */
export function planSettlement(toSettle: readonly bigint[]): PlannedTransfer[] {
  const sum = toSettle.reduce((a, v) => a + v, 0n);
  if (sum !== 0n) throw new LedgerError("The ledger's balances don't add up to zero, so it can't be settled.");
  const left = [...toSettle];
  const out: PlannedTransfer[] = [];
  const pick = (sign: 1n | -1n) => {
    let best = -1;
    for (let i = 0; i < left.length; i++) {
      const v = left[i]! * sign;
      if (v > 0n && (best === -1 || v > left[best]! * sign)) best = i;
    }
    return best;
  };
  for (;;) {
    const d = pick(-1n);
    const c = pick(1n);
    if (d === -1 || c === -1) break;
    const owe = -left[d]!;
    const due = left[c]!;
    const amount = owe < due ? owe : due;
    out.push({ from: d, to: c, amountAtomic: amount });
    left[d] = left[d]! + amount;
    left[c] = left[c]! - amount;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- signed messages

/**
 * What an add_expense signature covers, in a fixed order: who paid, the currency and every amount in integer units,
 * how it is split (member positions, ascending), and the cleaned descriptions (ledgerText below), exactly as the
 * server stores them. So anyone can recompute it from GET /api/v1/ledgers/<id> and check the recorder's signature.
 */
export interface CanonicalExpense {
  description: string | null;
  paidBy: number;
  /** "USDC" or an ISO 4217 code. */
  currency: string;
  totalUnits: bigint;
  split: SplitMode;
  /** even: who shares it, always listed (everyone when the body named no one). */
  among: readonly number[] | null;
  shares: ReadonlyArray<{ member: number; weight: bigint }> | null;
  amounts: ReadonlyArray<{ member: number; units: bigint }> | null;
  items: ReadonlyArray<{ description: string | null; units: bigint; members: readonly number[] }> | null;
  taxUnits: bigint | null;
  tipUnits: bigint | null;
}

/** 16 hex characters of sha256 over the canonical expense: what the signer approves. */
export function expenseDigest(ledgerId: string, e: CanonicalExpense): string {
  const n = (v: bigint | null) => (v === null ? null : v.toString());
  const canonical = JSON.stringify([
    "owed-ledger-expense:v1", ledgerId, e.description, e.paidBy, e.currency, e.totalUnits.toString(), e.split,
    e.among === null ? null : [...e.among],
    e.shares === null ? null : e.shares.map((s) => [s.member, s.weight.toString()]),
    e.amounts === null ? null : e.amounts.map((a) => [a.member, a.units.toString()]),
    e.items === null ? null : e.items.map((i) => [i.description, i.units.toString(), [...i.members]]),
    n(e.taxUnits), n(e.tipUnits),
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

// Expense descriptions are recorder-written: untrusted. Both sides clean them with this one function before the digest,
// so the text a signature covers is the text stored and shown. It is stricter than the server's sanitizeText: any
// word that looks like a link, a domain, an IP address or an address scheme is dropped, and only letters, marks, digits,
// spaces, currency signs and plain punctuation are kept (everything else, "@" and double quotes included, becomes a space)
// first. Cleaning twice changes nothing.
const LEDGER_INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const LINK_WORD = /:\/\/|^www\.|[\p{L}\p{N}_-]\.\p{L}{2,}|^[a-z][a-z0-9+.-]*:\S|\d{1,3}(?:\.\d{1,3}){3}/iu;
const NOT_KEPT = /[^\p{L}\p{M}\p{N}\p{Sc} .,\-'\u2018\u2019\u2013\u2014&()\/:;!?#%+*_=~]/gu;

export function ledgerText(input: string | null | undefined, max: number): string | null {
  if (typeof input !== "string") return null;
  // Characters first, then words: a word left after the characters go is checked as it will be shown.
  const text = input.slice(0, 4 * max + 64).normalize("NFKC").replace(LEDGER_INVISIBLE, " ").replace(NOT_KEPT, " ");
  const kept = text.split(" ").filter((w) => w !== "" && !LINK_WORD.test(w)).join(" ");
  const capped = Array.from(kept).slice(0, max).join("").trim();
  return capped === "" || !/[\p{L}\p{N}]/u.test(capped) ? null : capped;
}

/** Everything before " at <ISO time>" in an add_expense signature. `amount` is the total, shortest form ("84.6"). */
export function expensePrefix(ledgerId: string, digest: string, amount: string, currency: string, signer: string): string {
  return `Owed add expense ${digest} (${amount} ${currency}) to ledger ${ledgerId} by ${signer}`;
}

/** Everything before " at <ISO time>" in a settle_up signature: the ledger's version pins the state it settles. */
export function settlePrefix(ledgerId: string, version: number, count: number, totalUsdc: string, signer: string): string {
  return `Owed settle up ledger ${ledgerId} v${version}: ${count} ${count === 1 ? "request" : "requests"}, ${totalUsdc} USDC by ${signer}`;
}

// ---------------------------------------------------------------------------------------------- display

/**
 * A USDC amount (atomic, may be negative) in a local currency's minor units at `rate` (units per 1 USDC), rounded
 * half away from zero. Display only ("≈ €12.40 at the last locked rate"); nothing is paid in it.
 */
export function usdcToFiatUnits(atomic: bigint, rate: string, fiatDecimals: number): bigint {
  const m = DECIMAL_RE.exec(rate);
  if (!m) throw new LedgerError("The exchange rate isn't a decimal.");
  const frac = (m[2] ?? "").slice(1);
  const rateUnits = BigInt(m[1]! + frac);
  const negative = atomic < 0n;
  const magnitude = negative ? -atomic : atomic;
  // atomic / 10^6 USDC * rateUnits / 10^frac  -> * 10^fiatDecimals minor units
  const num = magnitude * rateUnits * 10n ** BigInt(fiatDecimals);
  const den = 10n ** BigInt(6 + frac.length);
  const rounded = (num * 2n + den) / (2n * den);
  return negative ? -rounded : rounded;
}
