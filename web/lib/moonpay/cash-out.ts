import "server-only";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { isoUtc, isUniqueViolation, sql, type Row } from "../db";
import { ApiError } from "../http";
import { isRequestId } from "../ids";
import { fromAtomic, toAtomic } from "../money";
import { refundsOf, refundTotals } from "../refunds";
import { getRequests } from "../requests";
import { activeCashOutAccount, getCashOutAccount, liquidationGuard, type CashOutAccount } from "./accounts";
import { sellTransactionsFor } from "./client";
import { moonpaySellConfig, type MoonpaySellConfig } from "./config";
import { enterpriseConfig, fetchAutoramp, type EnterpriseConfig } from "./enterprise";
import {
  cashOutStatusOf,
  depositProblem,
  isSellFiat,
  isSolanaAddress,
  pickSale,
  saleProblem,
  SELL_CENT_ATOMIC,
  signedSellUrl,
  type SellFiat,
  type SellTx,
} from "./sell";

// F4 cash out: the recipient sells USDC to MoonPay, which pays their bank. Owed never holds the money: the user's wallet
// sends one USDC transfer (approved with their passkey in PayBox) to an address that only ever comes from MoonPay.
//
// Sell widget path (OWED_MOONPAY_SELL=1, standard keys):
//   1. POST /api/v1/cash-out stores a cash-out (status created) and returns a signed sell widget URL: usdc_sol, exactly
//      this amount (locked), refunds to this wallet, externalTransactionId = the cash-out id.
//   2. The user finishes MoonPay's checks and bank details in the widget and starts the sale.
//   3. MoonPay's signed sell webhook (app/api/hooks/moonpay) reports the sale; ingestSellEvent records its status and,
//      once the sale's currency, amount and refund wallet match, its depositWallet.walletAddress.
//   4. GET /api/v1/cash-out/<id>?wallet= re-reads the sale from MoonPay's API (secret key) and releases the deposit
//      address only while MoonPay says waitingForDeposit for that same sale, with every term still matching.
// Enterprise path (OWED_MOONPAY_ENTERPRISE=1): the deposit address is the user's registered liquidation address,
// released only after liquidationGuard (lib/moonpay/accounts.ts) passes against MoonPay's answer read just now.
// Neither path ever touches a request's status: a cash-out moves the recipient's own money after it was paid.

export type CashOutStatus = "created" | "waiting_for_deposit" | "pending" | "completed" | "failed" | "requote_required";
export type CashOutMode = "sell_widget" | "enterprise";

export interface CashOutRow {
  id: string;
  wallet: string;
  amountAtomic: bigint;
  requestIds: string[];
  fiatCurrency: SellFiat | null;
  mode: CashOutMode;
  accountId: string | null;
  status: CashOutStatus;
  moonpayTransactionId: string | null;
  moonpayUpdatedAt: string | null;
  depositAddress: string | null;
  transferSignature: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const COLUMNS = `id, wallet, amount_atomic::text as amount_atomic, array_to_json(request_ids)::text as request_ids, fiat_currency, mode, account_id,
  status, moonpay_transaction_id, ${isoUtc("moonpay_updated_at")} as moonpay_updated_at, to_char(moonpay_updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as moonpay_updated_ms,
  deposit_address, transfer_signature, failure_reason, ${isoUtc("created_at")} as created_at, ${isoUtc("updated_at")} as updated_at`;

function fromRow(r: Row): CashOutRow & { moonpayUpdatedMs: string | null } {
  return {
    id: r.id!, wallet: r.wallet!, amountAtomic: BigInt(r.amount_atomic!), requestIds: JSON.parse(r.request_ids!),
    fiatCurrency: isSellFiat(r.fiat_currency) ? r.fiat_currency : null, mode: r.mode as CashOutMode, accountId: r.account_id,
    status: r.status as CashOutStatus, moonpayTransactionId: r.moonpay_transaction_id, moonpayUpdatedAt: r.moonpay_updated_at,
    moonpayUpdatedMs: r.moonpay_updated_ms, depositAddress: r.deposit_address, transferSignature: r.transfer_signature,
    failureReason: r.failure_reason, createdAt: r.created_at!, updatedAt: r.updated_at!,
  };
}

export const CASH_OUT_ID = /^[1-9A-HJ-NP-Za-km-z]{12}$/;
export const isCashOutId = (s: unknown): s is string => typeof s === "string" && CASH_OUT_ID.test(s);

export async function getCashOut(id: string): Promise<(CashOutRow & { moonpayUpdatedMs: string | null }) | null> {
  if (!isCashOutId(id)) return null;
  const rows = await sql(`select ${COLUMNS} from cash_outs where id = $1`, [id]);
  return rows.length ? fromRow(rows[0]) : null;
}

// ---------------------------------------------------------------- the public shape

export interface PublicCashOut {
  id: string;
  wallet: string;
  amount: string;
  token: "USDC";
  fiat_currency: string | null;
  request_ids: string[];
  /** When summed from requests: what they brought in after refunds, before rounding down to whole cents. */
  requests_total?: string;
  mode: CashOutMode;
  status: CashOutStatus;
  /** Sell widget path: where the user sets up the sale (signed by Owed's server; carries no secret). */
  widget_url: string | null;
  moonpay_transaction_id: string | null;
  /** Set only when MoonPay is waiting for exactly this deposit and every term matched just now. */
  deposit_address: string | null;
  /** MoonPay's depositHash: the user's transfer to MoonPay, once MoonPay received it. */
  transfer_signature: string | null;
  failure_reason: string | null;
  /** Why no deposit address is released right now, in words the user can act on. */
  problem: string | null;
  /** Enterprise path: the wallet-signed record the deposit address comes from, so the plugin can check it too. */
  account: { id: string; liquidation_address: string; signed_message: string; signature: string } | null;
  created_at: string;
  updated_at: string;
}

export interface CashOutDeps {
  sell: MoonpaySellConfig | null;
  enterprise: EnterpriseConfig | null;
  fetchSales: (cashOutId: string, config: MoonpaySellConfig, deadline?: number) => Promise<SellTx[]>;
  fetchAutoramp: typeof fetchAutoramp;
}

export function defaultCashOutDeps(): CashOutDeps {
  return { sell: moonpaySellConfig(), enterprise: enterpriseConfig(), fetchSales: sellTransactionsFor, fetchAutoramp };
}

export const NOT_ON = "cash-out isn't switched on yet on this Owed server (MoonPay's keys for selling USDC aren't configured), so nothing was set up";

function widgetUrl(row: CashOutRow, config: MoonpaySellConfig | null, origin: string): string | null {
  if (row.mode !== "sell_widget" || !config) return null;
  if (row.status === "pending" || row.status === "completed") return null;
  const back = `${origin}/cash-out/${encodeURIComponent(row.id)}`;
  return signedSellUrl(config, {
    wallet: row.wallet,
    amount: fromAtomic(row.amountAtomic, "USDC"),
    cashOutId: row.id,
    fiatCurrency: row.fiatCurrency,
    redirectUrl: back,
    unsupportedRegionUrl: `${back}?region=1`,
  });
}

export function toPublicCashOut(
  row: CashOutRow,
  extra: { origin: string; sell: MoonpaySellConfig | null; depositAddress?: string | null; problem?: string | null; account?: CashOutAccount | null; requestsTotalAtomic?: bigint },
): PublicCashOut {
  return {
    id: row.id,
    wallet: row.wallet,
    amount: fromAtomic(row.amountAtomic, "USDC"),
    token: "USDC",
    fiat_currency: row.fiatCurrency,
    request_ids: row.requestIds,
    ...(extra.requestsTotalAtomic !== undefined && { requests_total: fromAtomic(extra.requestsTotalAtomic, "USDC") }),
    mode: row.mode,
    status: row.status,
    widget_url: widgetUrl(row, extra.sell, extra.origin),
    moonpay_transaction_id: row.moonpayTransactionId,
    deposit_address: extra.depositAddress ?? null,
    transfer_signature: row.transferSignature,
    failure_reason: row.failureReason,
    problem: extra.problem ?? null,
    account: extra.account
      ? { id: extra.account.id, liquidation_address: extra.account.liquidationAddress, signed_message: extra.account.signedMessage, signature: extra.account.signature }
      : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// ---------------------------------------------------------------- creating

export interface CreateCashOutInput {
  wallet: string;
  amount?: string;
  requestIds?: string[];
  fiatCurrency?: string;
}

export interface CreatedCashOut {
  row: CashOutRow;
  account: CashOutAccount | null;
  requestsTotalAtomic?: bigint;
}

/** The USDC that paid these requests into this wallet, after refunds; refuses any request that didn't. */
export async function amountFromRequests(wallet: string, ids: readonly string[]): Promise<bigint> {
  const byId = await getRequests(ids);
  const problems: string[] = [];
  let total = 0n;
  const refunds = refundsOf(ids);
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) problems.push(`${id} isn't an Owed request`);
    else if (r.recipient !== wallet) problems.push(`${id} pays a different wallet`);
    else if ((r.chain ?? "solana") !== "solana" || r.token !== "USDC") problems.push(`${id} isn't a USDC request on Solana`);
    else if ((r.status !== "paid" && r.status !== "underpaid") || r.paidAmountAtomic == null || r.paidAmountAtomic <= 0n) problems.push(`${id} isn't paid (it is ${r.status})`);
    else total += r.paidAmountAtomic;
  }
  if (problems.length) throw new ApiError("invalid_input", `only USDC requests paid to this wallet can be cashed out: ${problems.slice(0, 5).join("; ")}`);
  const { refundedAtomic, pendingAtomic } = refundTotals(await refunds);
  return total - refundedAtomic - pendingAtomic;
}

function newCashOutId(): string {
  return bs58.encode(randomBytes(16)).slice(-12);
}

export async function createCashOut(input: CreateCashOutInput, deps: CashOutDeps = defaultCashOutDeps()): Promise<CreatedCashOut> {
  if (!isSolanaAddress(input.wallet)) throw new ApiError("invalid_input", "wallet must be the user's own base58 Solana wallet address");
  if ((input.amount === undefined) === (input.requestIds === undefined)) throw new ApiError("invalid_input", "send amount (USDC) or request_ids (paid requests), not both");
  const fiat = input.fiatCurrency === undefined ? null : input.fiatCurrency.toLowerCase();
  if (fiat !== null && !isSellFiat(fiat)) throw new ApiError("invalid_input", `fiat_currency ${String(input.fiatCurrency).slice(0, 8)} isn't one MoonPay pays out in`);

  // The Enterprise route wins when the wallet registered one; otherwise the sell widget; otherwise nothing is on.
  const account = deps.enterprise ? await activeCashOutAccount(input.wallet) : null;
  const mode: CashOutMode | null = account ? "enterprise" : deps.sell ? "sell_widget" : null;
  if (!mode) throw new ApiError("upstream_unavailable", NOT_ON);

  let amountAtomic: bigint;
  let requestIds: string[] = [];
  let requestsTotalAtomic: bigint | undefined;
  if (input.amount !== undefined) {
    try {
      amountAtomic = toAtomic(input.amount, "USDC");
    } catch (e) {
      throw new ApiError("invalid_input", `amount: ${e instanceof Error ? e.message : "use a positive decimal amount of USDC"}`);
    }
    if (mode === "sell_widget" && amountAtomic % SELL_CENT_ATOMIC !== 0n) throw new ApiError("invalid_input", "MoonPay sells USDC in whole cents: use at most 2 decimal places");
  } else {
    requestIds = [...new Set(input.requestIds)];
    if (requestIds.length < 1 || requestIds.length > 20 || requestIds.length !== input.requestIds!.length) throw new ApiError("invalid_input", "request_ids must list 1 to 20 different Owed request ids");
    const bad: string | undefined = requestIds.find((id: string) => !isRequestId(id));
    if (bad !== undefined) throw new ApiError("invalid_input", `request_ids: ${String(bad).slice(0, 20)} isn't an Owed request id`);
    const taken = await sql(`select id from cash_outs where wallet = $1 and status <> 'failed' and request_ids && $2::text[] order by created_at desc limit 1`, [input.wallet, requestIds]);
    if (taken.length) throw new ApiError("invalid_input", `some of these requests are already in cash-out ${taken[0].id}; check it with its cash_out_id instead`);
    requestsTotalAtomic = await amountFromRequests(input.wallet, requestIds);
    amountAtomic = mode === "sell_widget" ? requestsTotalAtomic - (requestsTotalAtomic % SELL_CENT_ATOMIC) : requestsTotalAtomic;
    if (amountAtomic <= 0n) throw new ApiError("invalid_input", "after refunds these requests leave nothing to cash out (MoonPay sells whole cents)");
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rows = await sql(
        `insert into cash_outs (id, wallet, amount_atomic, request_ids, fiat_currency, mode, account_id, status)
         values ($1, $2, $3, $4::text[], $5, $6, $7, 'created') returning ${COLUMNS}`,
        [newCashOutId(), input.wallet, amountAtomic, requestIds, fiat, mode, account?.id ?? null],
      );
      return { row: fromRow(rows[0]), account, requestsTotalAtomic };
    } catch (e) {
      if (!isUniqueViolation(e, "cash_outs_pkey")) throw e;
    }
  }
  throw new ApiError("upstream_unavailable", "couldn't pick a cash-out id; try again");
}

// ---------------------------------------------------------------- reading the status

/** Store what MoonPay's API says about the sale (newer reports only). Returns the row as stored afterwards. */
async function recordSale(row: CashOutRow, sale: SellTx): Promise<CashOutRow> {
  const status = cashOutStatusOf(sale.status);
  const rows = await sql(
    `update cash_outs
        set status = $3, moonpay_transaction_id = $2,
            deposit_address = case when moonpay_transaction_id is distinct from $2 then null else deposit_address end,
            moonpay_updated_at = coalesce($4::timestamptz, moonpay_updated_at),
            transfer_signature = coalesce($5, transfer_signature), failure_reason = $6,
            last_event = jsonb_build_object('source', 'api', 'status', $7::text, 'at', $4::text), updated_at = now()
      where id = $1 and (moonpay_transaction_id is null or moonpay_transaction_id = $2 or status = 'failed')
        and (moonpay_transaction_id is distinct from $2 or $4::timestamptz is null or moonpay_updated_at is null or moonpay_updated_at <= $4::timestamptz)
      returning ${COLUMNS}`,
    [row.id, sale.id, status, sale.updatedAt, sale.depositHash, sale.status === "failed" ? sale.failureReason : null, sale.status],
  );
  return rows.length ? fromRow(rows[0]) : row;
}

export interface StatusResult {
  row: CashOutRow;
  depositAddress: string | null;
  problem: string | null;
  account: CashOutAccount | null;
}

const MOONPAY_BUDGET_MS = 3000;

export async function cashOutStatus(id: string, wallet: string, deps: CashOutDeps = defaultCashOutDeps()): Promise<StatusResult> {
  if (!isCashOutId(id)) throw new ApiError("invalid_input", "that isn't a cash-out id (12 base58 characters)");
  if (!isSolanaAddress(wallet)) throw new ApiError("invalid_input", "wallet must be a base58 Solana address");
  const row = await getCashOut(id);
  // Another wallet's cash-out reads exactly like a missing one.
  if (!row || row.wallet !== wallet) throw new ApiError("not_found", `this wallet has no cash-out ${id}`);
  return row.mode === "enterprise" ? enterpriseStatus(row, deps) : sellStatus(row, deps);
}

async function sellStatus(row: CashOutRow, deps: CashOutDeps): Promise<StatusResult> {
  const out = (r: CashOutRow, problem: string | null, depositAddress: string | null = null): StatusResult => ({ row: r, depositAddress, problem, account: null });
  if (!deps.sell) return out(row, "cash-out is switched off on this Owed server right now, so MoonPay can't be asked about this sale");
  if (row.status === "completed") return out(row, null);
  let sales: SellTx[];
  try {
    sales = await deps.fetchSales(row.id, deps.sell, Date.now() + MOONPAY_BUDGET_MS);
  } catch (e) {
    console.warn(`moonpay sell ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    return out(row, "MoonPay couldn't be reached just now, so no transfer can be proposed; try again in a minute");
  }
  const { sale, problem: pickProblem } = pickSale(sales, row.id);
  if (pickProblem) return out(row, pickProblem);
  if (!sale) return out(row, "MoonPay has no sale for this cash-out yet: open the link, finish MoonPay's checks and bank details, and start the sale");
  const termsProblem = saleProblem(sale, { cashOutId: row.id, wallet: row.wallet, amountAtomic: row.amountAtomic });
  if (termsProblem) return out(row, `${termsProblem}, so nothing will be sent to it. Cancel that sale in MoonPay and start one from this cash-out's link`);
  if (row.moonpayTransactionId && row.moonpayTransactionId !== sale.id && row.status !== "failed") {
    return out(row, "MoonPay now reports a different sale than the one Owed recorded for this cash-out, so nothing will be sent; cancel the extra sale in MoonPay");
  }
  const stored = await recordSale(row, sale);
  if (sale.status === "requoteRequired") return out(stored, "MoonPay needs you to accept a new price in its widget before it takes the deposit");
  if (sale.status !== "waitingForDeposit") return out(stored, null);
  // Waiting for the deposit: the address must have come from MoonPay's signed webhook for this very sale.
  if (stored.moonpayTransactionId !== sale.id || !stored.depositAddress) {
    return out(stored, "MoonPay is waiting for the deposit but hasn't sent Owed its deposit address yet (it arrives in MoonPay's signed update); try again in a minute");
  }
  const deposit = depositProblem({ depositAddress: stored.depositAddress, depositTag: null }, row.wallet);
  if (deposit) return out(stored, `${deposit}, so nothing will be sent`);
  return out(stored, null, stored.depositAddress);
}

async function enterpriseStatus(row: CashOutRow, deps: CashOutDeps): Promise<StatusResult> {
  const account = row.accountId ? await getCashOutAccount(row.accountId) : null;
  const out = (problem: string | null, depositAddress: string | null = null): StatusResult => ({ row, depositAddress, problem, account });
  if (!deps.enterprise) return out("MoonPay Enterprise is switched off on this Owed server right now, so no transfer can be proposed");
  if (!account) return out("this cash-out's MoonPay account record is missing, so nothing will be sent");
  let autoramp;
  try {
    autoramp = await deps.fetchAutoramp(account.id, deps.enterprise, Date.now() + MOONPAY_BUDGET_MS);
  } catch (e) {
    console.warn(`moonpay enterprise cash-out ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    return out("MoonPay Enterprise couldn't be reached just now, so no transfer can be proposed; try again in a minute");
  }
  const problem = liquidationGuard(account, autoramp, row.wallet);
  if (problem) return out(`${problem}, so nothing will be sent`);
  // A standing liquidation address takes the deposit whenever it lands: the cash-out now waits for it.
  const rows = row.status === "created"
    ? await sql(`update cash_outs set status = 'waiting_for_deposit', deposit_address = $2, updated_at = now() where id = $1 and status = 'created' returning ${COLUMNS}`, [row.id, account.liquidationAddress])
    : [];
  return { row: rows.length ? fromRow(rows[0]) : row, depositAddress: account.liquidationAddress, problem: null, account };
}

// ---------------------------------------------------------------- MoonPay's sell webhook

export type IngestOutcome = "ignored" | "stale" | "stored";

/**
 * A verified sell webhook (sell_transaction_created / _updated / _failed / _requote_required). Records MoonPay's status
 * on the cash-out it names and, for a sale whose terms all match, its deposit address. Never touches requests.
 */
export async function ingestSellEvent(sale: SellTx): Promise<{ outcome: IngestOutcome; reason?: string }> {
  const id = sale.externalTransactionId;
  if (!isCashOutId(id)) return { outcome: "ignored", reason: "not an Owed cash-out" };
  const row = await getCashOut(id);
  if (!row || row.mode !== "sell_widget") return { outcome: "ignored", reason: "no sell-widget cash-out with this id" };
  const terms = saleProblem(sale, { cashOutId: row.id, wallet: row.wallet, amountAtomic: row.amountAtomic });
  if (terms) {
    console.warn(`moonpay sell ${row.id}: ignored sale ${sale.id} (${terms})`);
    await sql(
      `update cash_outs set last_event = jsonb_build_object('source', 'webhook', 'ignored', $2::text, 'sale', $3::text), updated_at = now() where id = $1`,
      [row.id, terms.slice(0, 200), sale.id.slice(0, 100)],
    );
    return { outcome: "ignored", reason: terms };
  }
  // A different sale is adopted only when the one on record failed (the user started over from the same link).
  if (row.moonpayTransactionId && row.moonpayTransactionId !== sale.id && row.status !== "failed") return { outcome: "ignored", reason: "another sale is already on record" };
  const adopting = row.moonpayTransactionId !== sale.id;
  const deposit = depositProblem(sale, row.wallet) === null ? sale.depositAddress : null;
  const status = cashOutStatusOf(sale.status);
  try {
    const rows = await sql(
      `update cash_outs
          set moonpay_transaction_id = $2,
              deposit_address = case when $8::boolean then $3 else coalesce(deposit_address, $3) end,
              status = case when $8::boolean or moonpay_updated_at is null or $4::timestamptz is null or moonpay_updated_at <= $4::timestamptz then $5 else status end,
              failure_reason = case when $8::boolean or moonpay_updated_at is null or $4::timestamptz is null or moonpay_updated_at <= $4::timestamptz then $6 else failure_reason end,
              moonpay_updated_at = case when moonpay_updated_at is null or $4::timestamptz is null or $8::boolean then coalesce($4::timestamptz, moonpay_updated_at) else greatest(moonpay_updated_at, $4::timestamptz) end,
              transfer_signature = coalesce($7, transfer_signature),
              last_event = jsonb_build_object('source', 'webhook', 'status', $9::text, 'at', $4::text, 'deposit_named', $3::text is not null),
              updated_at = now()
        where id = $1 and (moonpay_transaction_id is null or moonpay_transaction_id = $2 or status = 'failed')
        returning id`,
      [row.id, sale.id, deposit, sale.updatedAt, status, sale.status === "failed" ? sale.failureReason : null, sale.depositHash, adopting, sale.status],
    );
    if (!rows.length) return { outcome: "ignored", reason: "another sale is already on record" };
  } catch (e) {
    if (isUniqueViolation(e, "cash_outs_moonpay_key")) return { outcome: "ignored", reason: "this sale is already on record for another cash-out" };
    throw e;
  }
  return { outcome: row.moonpayUpdatedMs && sale.updatedAt && Date.parse(sale.updatedAt) < Date.parse(row.moonpayUpdatedMs) ? "stale" : "stored" };
}
