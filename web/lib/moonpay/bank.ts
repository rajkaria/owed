import "server-only";
import { isoUtc, isUniqueViolation, sql, transaction } from "../db";
import { fromAtomic, USDC_MINT } from "../money";
import { EFFECTIVE_STATUS } from "../requests";
import { rpcBatch, type RpcOptions } from "../solana";
import { isTeamSql, teamWallets } from "../team"; // W2-F is_team
import { watchSoon } from "../notify/helius"; // W3-A
import { alertsSoon } from "../alerts/soon"; // S1 alerts
import { creditFromTransaction, type Credit, type ParsedTransaction } from "../validate";
import { getVirtualAccount, type VirtualAccount } from "./accounts";
import { bankRailConfig, FAILED_STATUSES, fetchTransactions, type AutorampTransaction, type EnterpriseConfig, type EnterpriseEvent, type PayoutCurrency } from "./enterprise";

// F3 bank rail: a payer sends EUR, USD or GBP to the recipient's MoonPay Enterprise virtual account; MoonPay converts
// it to USDC and delivers it to the recipient's Solana wallet. A bank transfer carries no payment reference, so a
// payment is attributed from MoonPay's word plus the chain, and only ever settles an invoice when both agree:
//
//   webhook (transaction / transaction_status: an id only, https://dev.enterprise.moonpay.com/webhooks.md)
//     -> GET /api/autoramp-transactions/ids (amounts, wallet, status, payout hash; transaction-status.md)
//     -> the chain shows that payout hash crediting the recipient's USDC
//     -> exactly one open invoice for this recipient with exactly that fiat amount ......... paid (paid_rail bank_transfer)
//        two or more open invoices with that amount .................................. nothing (match_payments)
//        less than the only open invoice in that currency ............................ underpaid (ask_for_rest)
//        no open invoice with that amount ............................................ nothing
//   A webhook alone, or MoonPay's word without the chain, never marks anything.
//
// Settling is on the fiat amount: the payer sent exactly what the invoice asks in its currency, so it is paid, and
// paid_amount_atomic records the USDC MoonPay actually delivered (its conversion, after its fees). An invoice's fiat
// amount is its local-currency quote (EUR, GBP), or for a plain USDC invoice its amount in USD (USDC is 1:1 USD here).

export interface FiatAsk {
  currency: PayoutCurrency;
  cents: bigint;
}

/** Whole cents of a decimal amount with at most 2 decimals, or null. */
export function fiatCents(amount: string): bigint | null {
  const m = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,2}))?$/.exec(amount);
  if (!m) return null;
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return cents > 0n ? cents : null;
}

export function centsText(cents: bigint): string {
  const whole = cents / 100n;
  const frac = cents % 100n;
  return frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(2, "0")}`;
}

/** What a USDC-on-Solana request asks in a bank currency: its EUR/GBP quote, or its USDC amount as USD; null otherwise. */
export function fiatAskOf(req: { token: string; chain?: string | null; amountAtomic: bigint; fiat?: { currency: string; amount: string } | null }): FiatAsk | null {
  if (req.token !== "USDC" || (req.chain ?? "solana") !== "solana") return null;
  if (req.fiat) {
    if (req.fiat.currency !== "EUR" && req.fiat.currency !== "GBP") return null;
    const cents = fiatCents(req.fiat.amount);
    return cents === null ? null : { currency: req.fiat.currency, cents };
  }
  const cents = fiatCents(fromAtomic(req.amountAtomic, "USDC"));
  return cents === null ? null : { currency: "USD", cents };
}

export type Attribution =
  | { kind: "paid"; requestId: string }
  | { kind: "underpaid"; requestId: string }
  | { kind: "ambiguous"; requestIds: string[] }
  | { kind: "unmatched" };

/** Which open invoice (if any) a confirmed bank transfer of `received` pays. Pure. */
export function attribute(received: FiatAsk, open: ReadonlyArray<{ id: string; ask: FiatAsk | null }>): Attribution {
  const sameCurrency = open.filter((o) => o.ask?.currency === received.currency);
  const exact = sameCurrency.filter((o) => o.ask!.cents === received.cents);
  if (exact.length === 1) return { kind: "paid", requestId: exact[0].id };
  if (exact.length > 1) return { kind: "ambiguous", requestIds: exact.map((o) => o.id) };
  if (sameCurrency.length === 1 && received.cents < sameCurrency[0].ask!.cents) return { kind: "underpaid", requestId: sameCurrency[0].id };
  return { kind: "unmatched" };
}

/** Why MoonPay's transaction doesn't fit this virtual account, or null when it does. Pure. */
export function transactionProblem(tx: AutorampTransaction, va: VirtualAccount): string | null {
  if (tx.autorampId !== va.id) return "the transaction belongs to a different route";
  if (tx.customerId !== va.providerCustomerId) return "the transaction belongs to a different MoonPay customer";
  if (tx.recipient.type !== "Wallet" || tx.recipient.blockchain !== "Solana" || tx.recipient.address !== va.wallet) return "MoonPay delivered to a different wallet";
  const dest = tx.destinationAmount?.currency;
  if (dest?.type !== "Crypto" || dest.token !== "USDC" || dest.blockchain !== "Solana") return "MoonPay didn't deliver USDC on Solana";
  const src = tx.sourceAmount;
  if (src?.currency.type !== "Fiat" || src.currency.code !== va.currency) return `the transfer wasn't in ${va.currency}`;
  if (fiatCents(src.amount) === null) return "the transfer amount isn't a whole number of cents";
  return null;
}

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
/** A bank transfer can't be older than the MoonPay transaction that reported it (with clock slack). */
const NOT_BEFORE_SLACK_SECONDS = 600;

export type ChainCredit = { state: "sent" } | { state: "credited"; credit: Credit } | { state: "mismatch"; reason: string };

/** Judge MoonPay's payout transaction as the chain returned it: confirmed, error-free, crediting the recipient's USDC. Pure. */
export function judgePayout(tx: ParsedTransaction | null, signature: string, recipient: string, notBeforeUnix: number | null): ChainCredit {
  if (!tx) return { state: "sent" };
  if (tx.transaction.signatures[0] !== signature) return { state: "mismatch", reason: "RPC returned a different transaction" };
  if (tx.meta?.err != null) return { state: "mismatch", reason: "the payout failed on chain" };
  const blockTime = tx.blockTime == null ? null : Number(tx.blockTime);
  if (blockTime !== null && notBeforeUnix !== null && blockTime < notBeforeUnix) return { state: "mismatch", reason: "the payout is older than the bank transfer" };
  const credit = creditFromTransaction(tx, { reference: USDC_MINT, recipient, token: "USDC" });
  if (!credit || credit.amountAtomic <= 0n) return { state: "mismatch", reason: "the payout didn't credit the recipient's USDC" };
  return { state: "credited", credit };
}

// ---------------------------------------------------------------- processing a webhook

export interface BankDeps {
  config: EnterpriseConfig | null;
  fetchTransactions: typeof fetchTransactions;
  getTransaction: (signature: string, rpc: RpcOptions) => Promise<ParsedTransaction | null>;
  /** Waits between chain reads while MoonPay's payout isn't visible yet. */
  sleep: (ms: number) => Promise<void>;
}

async function getTransaction(signature: string, rpc: RpcOptions): Promise<ParsedTransaction | null> {
  const [tx] = (await rpcBatch(
    [{ method: "getTransaction", params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }],
    rpc,
  )) as (ParsedTransaction | null)[];
  return tx ?? null;
}

export function defaultBankDeps(): BankDeps {
  return { config: bankRailConfig(), fetchTransactions, getTransaction, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

type BankState = "pending" | "sent" | "verified" | "underpaid" | "ambiguous" | "unmatched" | "mismatch" | "failed";
const FINAL: readonly BankState[] = ["verified", "underpaid", "ambiguous", "unmatched", "mismatch"];

interface StoredTransfer {
  state: BankState;
  signature: string | null;
}

async function stored(id: string): Promise<StoredTransfer | null> {
  const rows = await sql(`select state, signature from bank_transfers where provider_tx_id = $1`, [id]);
  return rows.length ? { state: rows[0].state as BankState, signature: rows[0].signature } : null;
}

async function record(tx: AutorampTransaction, va: VirtualAccount, state: BankState, error: string | null): Promise<void> {
  const src = tx.sourceAmount;
  const cents = src ? fiatCents(src.amount) : null;
  const signature = state === "sent" ? tx.payoutHash : null;
  const usdc = tx.destinationAmount && /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/.test(tx.destinationAmount.amount) ? tx.destinationAmount.amount : null;
  try {
    await sql(
      `insert into bank_transfers (provider_tx_id, virtual_account_id, state, provider_status, fiat_currency, fiat_amount, usdc_amount, signature, error, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
       on conflict (provider_tx_id) do update set state = excluded.state, provider_status = excluded.provider_status,
         usdc_amount = coalesce(excluded.usdc_amount, bank_transfers.usdc_amount), signature = coalesce(excluded.signature, bank_transfers.signature),
         error = excluded.error, updated_at = now()
       where bank_transfers.state in ('pending', 'sent', 'failed')`,
      [tx.id, va.id, state, tx.status, va.currency, cents === null ? "0" : centsText(cents), usdc, signature, error?.slice(0, 300) ?? null, tx.createdAt],
    );
  } catch (e) {
    if (isUniqueViolation(e, "bank_transfers_signature_key")) {
      await sql(
        `insert into bank_transfers (provider_tx_id, virtual_account_id, state, provider_status, fiat_currency, fiat_amount, error, received_at)
         values ($1, $2, 'mismatch', $3, $4, $5, 'the payout is already reported for another bank transfer', $6::timestamptz)
         on conflict (provider_tx_id) do update set state = 'mismatch', error = excluded.error, updated_at = now()`,
        [tx.id, va.id, tx.status, va.currency, cents === null ? "0" : centsText(cents), tx.createdAt],
      );
      return;
    }
    throw e;
  }
}

async function finish(id: string, state: BankState, error: string | null): Promise<void> {
  await sql(`update bank_transfers set state = $2, error = $3, updated_at = now() where provider_tx_id = $1 and state = 'sent'`, [id, state, error?.slice(0, 300) ?? null]);
}

/** Open USDC-on-Solana requests for this recipient made before the transfer arrived, with what each asks in fiat. */
async function openAsks(wallet: string, before: string | null): Promise<Array<{ id: string; ask: FiatAsk | null }>> {
  const rows = await sql(
    `select id, token, chain, amount_atomic::text as amount_atomic, fiat_currency, fiat_amount
       from requests
      where recipient = $1 and chain = 'solana' and token = 'USDC' and ${EFFECTIVE_STATUS} = 'open'
        and ($2::timestamptz is null or created_at <= $2::timestamptz + interval '10 minutes')
      order by created_at limit 500`,
    [wallet, before],
  );
  return rows.map((r) => ({
    id: r.id!,
    ask: fiatAskOf({ token: r.token!, chain: r.chain, amountAtomic: BigInt(r.amount_atomic!), fiat: r.fiat_currency && r.fiat_amount ? { currency: r.fiat_currency, amount: r.fiat_amount } : null }),
  }));
}

/** Mark one request paid or underpaid by this bank transfer, with the bank transfer, in one transaction. */
async function settle(txId: string, requestId: string, outcome: "verified" | "underpaid", credit: Credit): Promise<boolean> {
  try {
    const [, updated] = await transaction([
      {
        text: `update bank_transfers set state = $2, request_id = $3, payer = $4, credited_atomic = $5, verified_at = now(), updated_at = now()
                where provider_tx_id = $1 and state = 'sent'`,
        params: [txId, outcome, requestId, credit.payer, credit.amountAtomic],
      },
      {
        text: `update requests
                  set status = $2, paid_signature = $3, paid_payer = $4, paid_amount_atomic = $5, paid_at = $6::timestamptz, paid_rail = 'bank_transfer',
                      is_team = ${isTeamSql("$7", "$4::text")} -- W2-F is_team (lib/team.ts)
                where id = $1 and status = 'open' and chain = 'solana' and token = 'USDC'
                returning id`,
        params: [requestId, outcome === "verified" ? "paid" : "underpaid", credit.signature, credit.payer, credit.amountAtomic, credit.at, teamWallets()],
      },
    ]);
    if (updated.length > 0 && outcome === "verified") watchSoon(); // W3-A: a paid request leaves the Helius watch
    if (updated.length > 0) alertsSoon(); // S1 alerts: send what the 0025 trigger queued, after the response
    return updated.length > 0;
  } catch (e) {
    if (isUniqueViolation(e, "requests_paid_signature_key")) {
      await finish(txId, "mismatch", "the payout already settles another request");
      return false;
    }
    throw e;
  }
}

export type BankOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "recorded"; state: BankState }
  | { kind: "settled"; state: "verified" | "underpaid"; requestId: string };

/** Chain reads for one webhook, after the 2xx (MoonPay Enterprise wants an answer within 5 s). */
const CHAIN_ATTEMPTS = 3;
const CHAIN_WAIT_MS = 6000;

/**
 * A verified `transaction` / `transaction_status` event: read the transaction from MoonPay, record it against the
 * recipient's virtual account, and when MoonPay names its Solana payout, settle at most one open invoice once the chain
 * shows the credit. Never throws for MoonPay or chain trouble (the next event retries); database errors propagate.
 */
export async function processEnterpriseEvent(event: EnterpriseEvent, deps: BankDeps = defaultBankDeps(), rpc: RpcOptions = {}): Promise<BankOutcome> {
  if (!deps.config) return { kind: "ignored", reason: "the bank rail is off" };
  let tx: AutorampTransaction | undefined;
  try {
    [tx] = await deps.fetchTransactions([event.transactionId], deps.config);
  } catch (e) {
    console.warn(`moonpay enterprise transaction ${event.transactionId}: ${e instanceof Error ? e.message : String(e)}`);
    return { kind: "ignored", reason: "MoonPay Enterprise couldn't be read" };
  }
  if (!tx || tx.id !== event.transactionId) return { kind: "ignored", reason: "MoonPay doesn't know this transaction" };
  if (tx.customerId !== event.customerId) return { kind: "ignored", reason: "the event and the transaction name different customers" };
  const va = await getVirtualAccount(tx.autorampId);
  if (!va || va.status !== "active") return { kind: "ignored", reason: "not a registered virtual account" };

  const prior = await stored(tx.id);
  if (prior && FINAL.includes(prior.state)) return { kind: "recorded", state: prior.state };
  const problem = transactionProblem(tx, va);
  if (problem) {
    await record(tx, va, "mismatch", problem);
    return { kind: "recorded", state: "mismatch" };
  }
  const named = tx.payoutHash && SIGNATURE_RE.test(tx.payoutHash) ? tx.payoutHash : null;
  if (!named) {
    const state: BankState = FAILED_STATUSES.includes(tx.status) ? "failed" : "pending";
    await record(tx, va, state, state === "failed" ? `MoonPay reports ${tx.status}` : null);
    return { kind: "recorded", state };
  }
  if (prior?.state === "sent" && prior.signature && prior.signature !== named) {
    await finish(tx.id, "mismatch", "MoonPay named a different payout than before");
    return { kind: "recorded", state: "mismatch" };
  }
  await record(tx, va, "sent", null);

  // The chain decides. MoonPay may report the hash a moment before the payout is visible: a few reads, then the next event.
  const notBefore = tx.createdAt ? Math.floor(Date.parse(tx.createdAt) / 1000) - NOT_BEFORE_SLACK_SECONDS : null;
  let verdict: ChainCredit = { state: "sent" };
  for (let attempt = 0; attempt < CHAIN_ATTEMPTS && verdict.state === "sent"; attempt++) {
    if (attempt > 0) await deps.sleep(CHAIN_WAIT_MS);
    try {
      verdict = judgePayout(await deps.getTransaction(named, rpc), named, va.wallet, notBefore);
    } catch (e) {
      console.warn(`moonpay enterprise payout ${named}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (verdict.state === "sent") return { kind: "recorded", state: "sent" };
  if (verdict.state === "mismatch") {
    await finish(tx.id, "mismatch", verdict.reason);
    return { kind: "recorded", state: "mismatch" };
  }
  const received: FiatAsk = { currency: va.currency, cents: fiatCents(tx.sourceAmount!.amount)! };
  const verdictAttribution = attribute(received, await openAsks(va.wallet, tx.createdAt));
  if (verdictAttribution.kind === "ambiguous" || verdictAttribution.kind === "unmatched") {
    await finish(tx.id, verdictAttribution.kind, verdictAttribution.kind === "ambiguous" ? `open invoices ${verdictAttribution.requestIds.slice(0, 5).join(", ")} share this amount` : null);
    return { kind: "recorded", state: verdictAttribution.kind };
  }
  const outcome = verdictAttribution.kind === "paid" ? "verified" : "underpaid";
  if (await settle(tx.id, verdictAttribution.requestId, outcome, verdict.credit)) return { kind: "settled", state: outcome, requestId: verdictAttribution.requestId };
  const after = await stored(tx.id);
  if (after?.state === "sent") await finish(tx.id, "unmatched", "the invoice was settled another way first");
  return { kind: "recorded", state: (await stored(tx.id))?.state ?? "unmatched" };
}

/** A bank transfer as the invoice page needs it (nothing beyond what the request already shows). */
export async function bankTransferFor(requestId: string): Promise<{ fiatCurrency: string; fiatAmount: string } | null> {
  const rows = await sql(
    `select fiat_currency, fiat_amount, ${isoUtc("verified_at")} as verified_at from bank_transfers where request_id = $1 and state in ('verified', 'underpaid') order by verified_at desc limit 1`,
    [requestId],
  );
  return rows.length ? { fiatCurrency: rows[0].fiat_currency!, fiatAmount: rows[0].fiat_amount! } : null;
}
