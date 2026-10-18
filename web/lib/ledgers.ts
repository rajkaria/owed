import "server-only";
import bs58 from "bs58";
import { isoUtc, isUniqueViolation, sql, transaction, type Row } from "./db";
import { newReference, requestIdFor } from "./ids";
import { USDC_MINT } from "./money";
import { chainCheckable, getRequests, settleFromChain, type PayerRecord, type RequestRow } from "./requests";
import type { RpcOptions } from "./solana";
import { watchSoon } from "./notify/helius";
import { FIAT_CURRENCIES, isFiatCode, type FiatCode } from "./fiat";
import {
  ledgerBalances, planSettlement, transferAmounts, unitsToDecimal, type MemberBalance, type PlannedTransfer, type SplitMode,
} from "./ledgers-math";
import type { GroupLedgerResponse } from "./contract";

// F6 group ledgers (migration 0020). A ledger is a tab for a trip or a house: its members (member 0 is the owner),
// the expenses each of them recorded, and the settle-ups that turned the balances into Owed requests. Owed never holds
// money: a settle-up request is an ordinary request (kind 'single'), payable to the creditor's wallet and addressed to
// the debtor's, paid in one transaction from payer to recipient like any other, and settled from the chain.
//
// The arithmetic lives in lib/ledgers-math.ts, byte for byte the plugin's src/ledger-math.ts, so the plugin re-checks
// every split, balance and plan this server computes. Writes are signed by a wallet named in the ledger (routes under
// app/api/v1/ledgers); everything recorder-written is untrusted text, cleaned on the way in and shown quoted.

export const LEDGER_TEXT_LIMITS = { title: 60, name: 40, description: 80, item: 60 } as const;
export const LEDGER_EXPENSE_PURPOSE = "ledger_expense";
export const LEDGER_SETTLE_PURPOSE = "ledger_settle";
/** Signed expenses one wallet may record per hour (a receipt-heavy trip); settle-ups use the default 30. */
export const LEDGER_EXPENSES_PER_HOUR = 60;
export const MAX_SETTLEMENTS = 50;
export const LEDGER_CREATE_LIMITS = { perOwnerPerHour: 20, perIpPerHour: 100 } as const;
/** Every ledger surface says this (plugin/src/ledger.ts keeps the same text; web/test/ledgers-db.test.ts checks). */
export const LEDGER_CAUTION =
  "Names, descriptions and amounts are written by whoever recorded them; Owed doesn't check them. Each expense and settle-up is signed by a wallet named in the ledger, and handles are labels Owed doesn't verify.";

const LEDGER_ID = /^[1-9A-HJ-NP-Za-km-z]{12}$/;

export function isLedgerId(s: unknown): s is string {
  return typeof s === "string" && LEDGER_ID.test(s);
}

/** 12 base58 characters from 16 random bytes. A ledger id commits to nothing; each settle-up request id does. */
export function newLedgerId(): string {
  return bs58.encode(crypto.getRandomValues(new Uint8Array(16))).slice(-12);
}

/** Units of an expense's currency: USDC atomic units (6) or the local currency's minor units. */
export function currencyDecimals(currency: FiatCode | null): number {
  return currency === null ? 6 : FIAT_CURRENCIES[currency].decimals;
}

// ---------------------------------------------------------------------------------------------- rows

export interface LedgerRow {
  id: string;
  /** Requester-written, sanitized. Render quoted. */
  title: string;
  owner: string;
  memberCount: number;
  expenseCount: number;
  version: number;
  flags: string[];
  source: "plugin" | "web";
  createdAt: string;
}

export interface MemberRow {
  position: number;
  /** Requester-written, sanitized. Render quoted. */
  name: string;
  wallet: string | null;
  handle: string | null;
  sns: string | null;
}

export interface ExpenseItemRow {
  position: number;
  description: string | null;
  units: bigint;
  members: number[];
}

export interface ExpenseShareRow {
  member: number;
  weight: bigint | null;
  units: bigint;
  amountAtomic: bigint;
}

export interface ExpenseRow {
  position: number;
  description: string | null;
  paidBy: number;
  split: SplitMode;
  /** null: a USDC expense. */
  currency: FiatCode | null;
  totalUnits: bigint;
  amountAtomic: bigint;
  taxUnits: bigint | null;
  tipUnits: bigint | null;
  fiat: { rate: string; rateSource: string; quotedAt: string } | null;
  flags: string[];
  recordedBy: string;
  signedMessage: string;
  signature: string;
  createdAt: string;
  items: ExpenseItemRow[];
  shares: ExpenseShareRow[];
}

export interface TransferRow {
  round: number;
  position: number;
  from: number;
  to: number;
  amountAtomic: bigint;
  requestId: string;
}

export interface SettlementRow {
  round: number;
  recordedBy: string;
  signedMessage: string;
  signature: string;
  createdAt: string;
  transfers: TransferRow[];
}

export interface LoadedLedger {
  ledger: LedgerRow;
  members: MemberRow[];
  expenses: ExpenseRow[];
  settlements: SettlementRow[];
  /** The settle-up requests, by id, as stored (or as just settled from the chain). */
  requests: Map<string, RequestRow>;
  /** False when the chain couldn't be read in time (or wasn't asked): statuses are the stored ones. */
  chainChecked: boolean;
}

const big = (v: string | null): bigint | null => (v == null ? null : BigInt(v));

/**
 * A ledger with every member, expense and settle-up, read in one batch. With `rpc`, settle-up requests that can still
 * turn out paid are checked on chain first (one batched lookup); if the chain can't be read in time the stored state
 * is used and chainChecked is false.
 */
export async function loadLedger(id: string, rpc: RpcOptions | null = null): Promise<LoadedLedger | null> {
  if (!isLedgerId(id)) return null;
  const [ledgerRows, memberRows, expenseRows, itemRows, shareRows, settlementRows, transferRows] = await transaction([
    {
      text: `select id, title, owner_wallet, member_count, expense_count, version, array_to_json(flags)::text as flags, source,
               ${isoUtc("created_at")} as created_at
               from ledgers where id = $1`,
      params: [id],
    },
    { text: `select position, name, wallet, handle, sns from ledger_members where ledger_id = $1 order by position`, params: [id] },
    {
      text: `select position, description, paid_by, split, currency, total_units::text as total_units, amount_atomic::text as amount_atomic,
               tax_units::text as tax_units, tip_units::text as tip_units, fiat_rate, fiat_rate_source, ${isoUtc("fiat_quoted_at")} as fiat_quoted_at,
               array_to_json(flags)::text as flags, recorded_by, signed_message, signature, ${isoUtc("created_at")} as created_at
               from ledger_expenses where ledger_id = $1 order by position`,
      params: [id],
    },
    {
      text: `select expense_position, position, description, units::text as units, array_to_json(members)::text as members
               from ledger_expense_items where ledger_id = $1 order by expense_position, position`,
      params: [id],
    },
    {
      text: `select expense_position, member_position, weight::text as weight, units::text as units, amount_atomic::text as amount_atomic
               from ledger_expense_shares where ledger_id = $1 order by expense_position, member_position`,
      params: [id],
    },
    {
      text: `select round, recorded_by, signed_message, signature, ${isoUtc("created_at")} as created_at
               from ledger_settlements where ledger_id = $1 order by round`,
      params: [id],
    },
    {
      text: `select round, position, from_member, to_member, amount_atomic::text as amount_atomic, request_id
               from ledger_transfers where ledger_id = $1 order by round, position`,
      params: [id],
    },
  ]);
  if (ledgerRows.length === 0) return null;
  const l = ledgerRows[0];
  const ledger: LedgerRow = {
    id: l.id!,
    title: l.title!,
    owner: l.owner_wallet!,
    memberCount: Number(l.member_count),
    expenseCount: Number(l.expense_count),
    version: Number(l.version),
    flags: JSON.parse(l.flags ?? "[]") as string[],
    source: l.source === "web" ? "web" : "plugin",
    createdAt: l.created_at!,
  };
  const members: MemberRow[] = memberRows.map((m) => ({
    position: Number(m.position), name: m.name!, wallet: m.wallet ?? null, handle: m.handle ?? null, sns: m.sns ?? null,
  }));
  const byExpense = <T>(rows: Row[], map: (r: Row) => T) => {
    const out = new Map<number, T[]>();
    for (const r of rows) {
      const key = Number(r.expense_position);
      out.set(key, [...(out.get(key) ?? []), map(r)]);
    }
    return out;
  };
  const items = byExpense(itemRows, (r): ExpenseItemRow => ({
    position: Number(r.position), description: r.description ?? null, units: BigInt(r.units!), members: JSON.parse(r.members ?? "[]") as number[],
  }));
  const shares = byExpense(shareRows, (r): ExpenseShareRow => ({
    member: Number(r.member_position), weight: big(r.weight), units: BigInt(r.units!), amountAtomic: BigInt(r.amount_atomic!),
  }));
  const expenses: ExpenseRow[] = expenseRows.map((e) => {
    const position = Number(e.position);
    const currency = e.currency && isFiatCode(e.currency) ? e.currency : null;
    return {
      position,
      description: e.description ?? null,
      paidBy: Number(e.paid_by),
      split: e.split as SplitMode,
      currency,
      totalUnits: BigInt(e.total_units!),
      amountAtomic: BigInt(e.amount_atomic!),
      taxUnits: big(e.tax_units),
      tipUnits: big(e.tip_units),
      fiat: currency && e.fiat_rate && e.fiat_rate_source && e.fiat_quoted_at
        ? { rate: e.fiat_rate, rateSource: e.fiat_rate_source, quotedAt: e.fiat_quoted_at }
        : null,
      flags: JSON.parse(e.flags ?? "[]") as string[],
      recordedBy: e.recorded_by!,
      signedMessage: e.signed_message!,
      signature: e.signature!,
      createdAt: e.created_at!,
      items: items.get(position) ?? [],
      shares: shares.get(position) ?? [],
    };
  });
  const transfers = new Map<number, TransferRow[]>();
  for (const t of transferRows) {
    const round = Number(t.round);
    transfers.set(round, [...(transfers.get(round) ?? []), {
      round, position: Number(t.position), from: Number(t.from_member), to: Number(t.to_member),
      amountAtomic: BigInt(t.amount_atomic!), requestId: t.request_id!,
    }]);
  }
  const settlements: SettlementRow[] = settlementRows.map((s) => ({
    round: Number(s.round), recordedBy: s.recorded_by!, signedMessage: s.signed_message!, signature: s.signature!, createdAt: s.created_at!,
    transfers: transfers.get(Number(s.round)) ?? [],
  }));

  const ids = settlements.flatMap((s) => s.transfers.map((t) => t.requestId));
  let requests = await getRequests(ids);
  let chainChecked = rpc !== null;
  const due = [...requests.values()].filter((r) => chainCheckable(r.status));
  if (rpc && due.length > 0) {
    try {
      const settled = await settleFromChain(due, rpc);
      requests = new Map([...requests, ...settled.map((r): [string, RequestRow] => [r.id, r])]);
    } catch {
      chainChecked = false; // serve the stored state; the page's polling settles it
    }
  }
  return { ledger, members, expenses, settlements, requests, chainChecked };
}

// ---------------------------------------------------------------------------------------------- arithmetic

export interface LedgerState {
  balances: MemberBalance[];
  plan: PlannedTransfer[];
  /** Per settle-up request id: what has moved and what is still pending (lib/ledgers-math.ts transferAmounts). */
  transferState: Map<string, { settledAtomic: bigint; pendingAtomic: bigint }>;
}

/** Balances from the stored shares and the live request statuses, and the settle-up that would square them. */
export function ledgerState(loaded: Pick<LoadedLedger, "ledger" | "expenses" | "settlements" | "requests">): LedgerState {
  const n = loaded.ledger.memberCount;
  const expenses = loaded.expenses.map((e) => {
    const sharesAtomic = Array.from({ length: n }, () => 0n);
    for (const s of e.shares) sharesAtomic[s.member] = s.amountAtomic;
    return { paidBy: e.paidBy, amountAtomic: e.amountAtomic, sharesAtomic };
  });
  const transferState = new Map<string, { settledAtomic: bigint; pendingAtomic: bigint }>();
  const transfers = loaded.settlements.flatMap((s) => s.transfers).map((t) => {
    const r = loaded.requests.get(t.requestId);
    const state = transferAmounts(r?.status ?? "not_found", t.amountAtomic, r?.paidAmountAtomic ?? null);
    transferState.set(t.requestId, state);
    return { from: t.from, to: t.to, amountAtomic: t.amountAtomic, ...state };
  });
  const balances = ledgerBalances(n, expenses, transfers);
  return { balances, plan: planSettlement(balances.map((b) => b.toSettle)), transferState };
}

// ---------------------------------------------------------------------------------------------- public shape

const usdc = (atomic: bigint) => unitsToDecimal(atomic, 6);

export function toPublicLedger(loaded: LoadedLedger, base: string, state: LedgerState = ledgerState(loaded)): GroupLedgerResponse {
  const { ledger, members, expenses, settlements, requests } = loaded;
  const wallets = new Map(members.map((m) => [m.position, m.wallet]));
  let spent = 0n;
  let openRequests = 0;
  const latestFiat = [...expenses].reverse().find((e) => e.currency && e.fiat);
  const out: GroupLedgerResponse = {
    id: ledger.id,
    link: `${base}/l/${ledger.id}`,
    title: ledger.title,
    owner: ledger.owner,
    created_at: ledger.createdAt,
    version: ledger.version,
    flags: ledger.flags,
    caution: LEDGER_CAUTION,
    members: members.map((m) => ({ position: m.position, name: m.name, wallet: m.wallet, handle: m.handle, sns: m.sns })),
    expenses: expenses.map((e) => {
      spent += e.amountAtomic;
      const d = currencyDecimals(e.currency);
      const inCurrency = (units: bigint) => unitsToDecimal(units, d);
      return {
        position: e.position,
        description: e.description,
        paid_by: e.paidBy,
        split: e.split,
        currency: e.currency ?? "USDC",
        total: inCurrency(e.totalUnits),
        amount: usdc(e.amountAtomic),
        tax: e.taxUnits === null ? null : inCurrency(e.taxUnits),
        tip: e.tipUnits === null ? null : inCurrency(e.tipUnits),
        fiat: e.currency && e.fiat
          ? { currency: e.currency, amount: inCurrency(e.totalUnits), rate: e.fiat.rate, rate_source: e.fiat.rateSource, quoted_at: e.fiat.quotedAt }
          : null,
        items: e.split === "items"
          ? e.items.map((i) => ({ description: i.description, amount: inCurrency(i.units), members: i.members }))
          : null,
        shares: e.shares.map((s) => ({
          member: s.member, weight: s.weight === null ? null : unitsToDecimal(s.weight, 4), share: inCurrency(s.units), amount: usdc(s.amountAtomic),
        })),
        recorded_by: e.recordedBy,
        recorded_at: e.createdAt,
        signed_message: e.signedMessage,
        signature: e.signature,
        flags: e.flags,
      };
    }),
    balances: state.balances.map((b, member) => ({
      member, paid: usdc(b.paid), share: usdc(b.share), sent: usdc(b.sent), received: usdc(b.received), net: usdc(b.net),
      pending_out: usdc(b.pendingOut), pending_in: usdc(b.pendingIn), to_settle: usdc(b.toSettle),
    })),
    plan: state.plan.map((t) => ({ from: t.from, to: t.to, amount: usdc(t.amountAtomic), payable: wallets.get(t.to) != null })),
    settlements: settlements.map((s) => ({
      round: s.round,
      recorded_by: s.recordedBy,
      recorded_at: s.createdAt,
      signed_message: s.signedMessage,
      signature: s.signature,
      transfers: s.transfers.map((t) => {
        const r = requests.get(t.requestId);
        const paid = r && (r.status === "paid" || r.status === "underpaid") && r.paidSignature && r.paidAmountAtomic != null && r.paidPayer && r.paidAt
          ? { signature: r.paidSignature, payer: r.paidPayer, amount: usdc(r.paidAmountAtomic), at: r.paidAt, rail: r.paidRail ?? "solana_pay" as const }
          : null;
        if ((state.transferState.get(t.requestId)?.pendingAtomic ?? 0n) > 0n) openRequests += 1;
        return {
          position: t.position, from: t.from, to: t.to, amount: usdc(t.amountAtomic), request_id: t.requestId,
          link: `${base}/r/${t.requestId}`, status: r?.status === "open" || r?.status === "paid" || r?.status === "underpaid" || r?.status === "cancelled" || r?.status === "expired" ? r.status : "cancelled",
          paid, addressed: r?.payer != null,
        };
      }),
    })),
    totals: { spent: usdc(spent), expense_count: expenses.length, open_requests: openRequests },
    fiat_beside: latestFiat && latestFiat.currency && latestFiat.fiat
      ? { currency: latestFiat.currency, rate: latestFiat.fiat.rate, rate_source: latestFiat.fiat.rateSource, quoted_at: latestFiat.fiat.quotedAt }
      : null,
    settled: expenses.length > 0 && state.balances.every((b) => b.net === 0n && b.pendingIn === 0n && b.pendingOut === 0n),
    chain_checked: loaded.chainChecked,
  };
  return out;
}

// ---------------------------------------------------------------------------------------------- writes

export interface CreateLedgerInput {
  title: string;
  owner: string;
  ownerName: string;
  /** Everyone but the owner, in ledger order (positions 1..n-1). */
  members: ReadonlyArray<{ name: string; payer: PayerRecord | null }>;
  flags: string[];
  source: "plugin" | "web";
}

/** Inserts the ledger and its members in one transaction; returns the new id. */
export async function createLedger(input: CreateLedgerInput): Promise<string> {
  const all = [{ name: input.ownerName, payer: { wallet: input.owner, handle: null, sns: null } as PayerRecord }, ...input.members];
  for (let attempt = 0; ; attempt++) {
    const id = newLedgerId();
    try {
      await transaction([
        {
          text: `insert into ledgers (id, title, owner_wallet, member_count, flags, source) values ($1, $2, $3, $4, $5::text[], $6)`,
          params: [id, input.title, input.owner, all.length, input.flags, input.source],
        },
        {
          text: `insert into ledger_members (ledger_id, position, name, wallet, handle, sns)
                 select $1, m.ord - 1, m.name, nullif(m.wallet, ''), nullif(m.handle, ''), nullif(m.sns, '')
                   from unnest($2::text[], $3::text[], $4::text[], $5::text[]) with ordinality as m(name, wallet, handle, sns, ord)`,
          params: [
            id,
            all.map((m) => m.name),
            all.map((m) => m.payer?.wallet ?? ""),
            all.map((m) => m.payer?.handle ?? ""),
            all.map((m) => m.payer?.sns ?? ""),
          ],
        },
      ]);
      return id;
    } catch (e) {
      if (attempt < 2 && isUniqueViolation(e, "ledgers_pkey")) continue;
      throw e;
    }
  }
}

export interface NewExpense {
  ledgerId: string;
  description: string | null;
  paidBy: number;
  split: SplitMode;
  currency: FiatCode | null;
  totalUnits: bigint;
  amountAtomic: bigint;
  taxUnits: bigint | null;
  tipUnits: bigint | null;
  fiat: { rate: string; rateSource: string; quotedAt: string } | null;
  flags: string[];
  recordedBy: string;
  signedMessage: string;
  signature: string;
  items: ReadonlyArray<{ description: string | null; units: bigint; members: readonly number[] }>;
  shares: ReadonlyArray<{ member: number; weight: bigint | null; units: bigint; amountAtomic: bigint }>;
}

/**
 * One statement: the ledger's expense count and version go up, then the expense, its items and its shares are
 * inserted. Returns the new expense's position, or null when the ledger is full (100 expenses) or gone.
 */
export async function insertExpense(e: NewExpense): Promise<number | null> {
  const [row] = await sql(
    `with bump as (
       update ledgers set expense_count = expense_count + 1, version = version + 1
        where id = $1 and expense_count < 100
       returning expense_count - 1 as position
     ), expense as (
       insert into ledger_expenses (ledger_id, position, description, paid_by, split, currency, total_units, amount_atomic, tax_units, tip_units,
                                    fiat_rate, fiat_rate_source, fiat_quoted_at, flags, recorded_by, signed_message, signature)
       select $1, bump.position, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $13::text[], $14, $15, $16 from bump
       returning position
     ), items as (
       insert into ledger_expense_items (ledger_id, expense_position, position, description, units, members)
       select $1, expense.position, i.ord - 1, nullif(i.description, ''), i.units::numeric, string_to_array(i.members, ',')::smallint[]
         from expense, unnest($17::text[], $18::text[], $19::text[]) with ordinality as i(description, units, members, ord)
       returning 1
     ), shares as (
       insert into ledger_expense_shares (ledger_id, expense_position, member_position, weight, units, amount_atomic)
       select $1, expense.position, s.member::smallint, nullif(s.weight, '')::numeric, s.units::numeric, s.amount::numeric
         from expense, unnest($20::text[], $21::text[], $22::text[], $23::text[]) as s(member, weight, units, amount)
       returning 1
     )
     select (select position from expense) as position, (select count(*) from items) as items, (select count(*) from shares) as shares`,
    [
      e.ledgerId, e.description, e.paidBy, e.split, e.currency, e.totalUnits, e.amountAtomic, e.taxUnits, e.tipUnits,
      e.fiat?.rate ?? null, e.fiat?.rateSource ?? null, e.fiat?.quotedAt ?? null, e.flags, e.recordedBy, e.signedMessage, e.signature,
      e.items.map((i) => i.description ?? ""), e.items.map((i) => i.units.toString()), e.items.map((i) => i.members.join(",")),
      e.shares.map((s) => String(s.member)), e.shares.map((s) => (s.weight === null ? "" : s.weight.toString())),
      e.shares.map((s) => s.units.toString()), e.shares.map((s) => s.amountAtomic.toString()),
    ],
  );
  return row?.position == null ? null : Number(row.position);
}

export interface NewTransfer {
  from: number;
  to: number;
  amountAtomic: bigint;
  /** The creditor's wallet: the request pays it. */
  recipient: string;
  /** The debtor, when the ledger knows their wallet: the request lands in their what_do_i_owe inbox. */
  payer: PayerRecord | null;
  payerName: string | null;
  requesterName: string | null;
  requesterHandle: string | null;
  flags: string[];
}

export interface NewSettlement {
  ledgerId: string;
  /** The version the signed message names; the write happens only if the ledger is still at it. */
  version: number;
  recordedBy: string;
  signedMessage: string;
  signature: string;
  forText: string | null;
  note: string | null;
  source: "plugin" | "web";
  transfers: readonly NewTransfer[];
}

export interface CreatedTransfer extends NewTransfer {
  position: number;
  id: string;
  reference: string;
}

/**
 * One statement: the ledger's version goes up (only from `version`), the settlement row is written, then one
 * ordinary USDC request per transfer (ids derived from their terms, lib/ids.ts, exactly as POST /requests derives
 * them) and the rows that tie them to the ledger. Returns null when the ledger changed since `version`.
 */
export async function insertSettlement(s: NewSettlement): Promise<{ round: number; transfers: CreatedTransfer[] } | null> {
  for (let attempt = 0; ; attempt++) {
    const transfers: CreatedTransfer[] = s.transfers.map((t, position) => {
      const reference = newReference();
      return { ...t, position, reference, id: requestIdFor({ recipient: t.recipient, token: "USDC", amountAtomic: t.amountAtomic, reference }) };
    });
    try {
      const [row] = await sql(
        `with bump as (
           update ledgers set version = version + 1 where id = $1 and version = $2 returning version
         ), settlement as (
           insert into ledger_settlements (ledger_id, round, recorded_by, signed_message, signature)
           select $1, $2, $3, $4, $5 from bump
           returning round
         ), reqs as (
           insert into requests (id, kind, recipient, token, mint, decimals, amount_atomic, reference, payer_name, for_text, note, requester_name,
                                 flags, source, payer_wallet, payer_handle, payer_sns, requester_handle)
           select r.id, 'single', r.recipient, 'USDC', $6, 6, r.amount::numeric, r.reference, nullif(r.payer_name, ''), $7, $8,
                  nullif(r.requester_name, ''), array(select json_array_elements_text(r.flags::json)), $9,
                  nullif(r.payer_wallet, ''), nullif(r.payer_handle, ''), nullif(r.payer_sns, ''), nullif(r.requester_handle, '')
             from settlement,
                  unnest($10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[], $20::text[])
                    as r(id, recipient, amount, reference, payer_name, requester_name, flags, payer_wallet, payer_handle, payer_sns, requester_handle)
           returning id
         ), links as (
           insert into ledger_transfers (ledger_id, round, position, from_member, to_member, amount_atomic, request_id)
           select $1, settlement.round, t.ord - 1, t.from_m::smallint, t.to_m::smallint, t.amount::numeric, t.request_id
             from settlement, unnest($21::text[], $22::text[], $12::text[], $10::text[]) with ordinality as t(from_m, to_m, amount, request_id, ord)
           returning 1
         )
         select (select round from settlement) as round, (select count(*) from reqs) as created, (select count(*) from links) as linked`,
        [
          s.ledgerId, s.version, s.recordedBy, s.signedMessage, s.signature, USDC_MINT, s.forText, s.note, s.source,
          transfers.map((t) => t.id), transfers.map((t) => t.recipient), transfers.map((t) => t.amountAtomic.toString()), transfers.map((t) => t.reference),
          transfers.map((t) => t.payerName ?? ""), transfers.map((t) => t.requesterName ?? ""), transfers.map((t) => JSON.stringify(t.flags)),
          transfers.map((t) => t.payer?.wallet ?? ""), transfers.map((t) => t.payer?.handle ?? ""), transfers.map((t) => t.payer?.sns ?? ""),
          transfers.map((t) => t.requesterHandle ?? ""),
          transfers.map((t) => String(t.from)), transfers.map((t) => String(t.to)),
        ],
      );
      if (row?.round == null) return null;
      watchSoon(); // W3-A: Helius watches every new request's reference key
      return { round: Number(row.round), transfers };
    } catch (e) {
      // A 256-bit reference (and so a 70-bit id) collision is astronomically rare; retry with fresh references.
      if (attempt < 2 && (isUniqueViolation(e, "requests_pkey") || isUniqueViolation(e, "requests_reference_key"))) continue;
      throw e;
    }
  }
}

/** "Lisbon trip settle-up": what every settle-up request is for (the inbox and pay page show it, quoted). */
export function settleForText(title: string): string {
  return `${title} settle-up`;
}

/** Names the ledger and who recorded the settle-up, on every request it creates. */
export function settleNote(ledgerId: string, recorder: string): string {
  return `Settle-up from Owed ledger ${ledgerId}, recorded by ${recorder}.`;
}
