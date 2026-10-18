import { createHmac, timingSafeEqual } from "node:crypto";
import { isSolanaAddress } from "./sell";

// MoonPay Enterprise (formerly Iron): virtual bank accounts that turn EUR/USD/GBP into USDC on the recipient's Solana
// wallet (F3 bank rail) and liquidation addresses that turn USDC into a bank payout (F4 Enterprise cash-out). Off unless
// OWED_MOONPAY_ENTERPRISE=1 with an API key and a webhook secret: Owed has no Enterprise access yet (DECISIONS.md
// kickoff), so nothing here has met MoonPay's servers. Everything follows MoonPay's public docs, read 2026-10-18:
// - API base, auth, versions: https://dev.enterprise.moonpay.com/llms.txt (Production https://api.iron.xyz, Sandbox
//   https://api.sandbox.iron.xyz, header X-API-Key; routes live under /api).
// - Autoramp (GET /api/autoramps/{id}) and its deposit_rails: https://dev.enterprise.moonpay.com/offramp.md (a Crypto
//   rail is the liquidation address) and https://dev.enterprise.moonpay.com/onramp.md (SEPA / ACH / Wire / RTP / FedNow /
//   CHAPS / FPS rails are the virtual account), schemas in https://dev.enterprise.moonpay.com/spec.yaml.
// - Transactions (GET /api/autoramp-transactions/ids?ids=): https://dev.enterprise.moonpay.com/transaction-status.md.
// - Webhooks and their signature: https://dev.enterprise.moonpay.com/webhooks.md (headers webhook-id, webhook-timestamp,
//   webhook-signature "v1=<hex HMAC-SHA256 of timestamp + raw body>", keyed with the whole whsec_ secret string).
// Pure except fetchAutoramp / fetchTransactions.

export const ENTERPRISE_API_LIVE = "https://api.iron.xyz";
export const ENTERPRISE_API_SANDBOX = "https://api.sandbox.iron.xyz";

export interface EnterpriseConfig {
  apiKey: string;
  webhookSecret: string;
  base: string;
  sandbox: boolean;
}

type Env = Record<string, string | undefined>;

export function enterpriseConfig(env: Env = process.env): EnterpriseConfig | null {
  if (env.OWED_MOONPAY_ENTERPRISE !== "1") return null;
  const apiKey = env.MOONPAY_ENTERPRISE_API_KEY?.trim() ?? "";
  const webhookSecret = env.MOONPAY_ENTERPRISE_WEBHOOK_SECRET?.trim() ?? "";
  if (!/^[\x21-\x7e]{16,200}$/.test(apiKey) || !/^whsec_[A-Za-z0-9+/=]{16,200}$/.test(webhookSecret)) return null;
  const sandbox = env.MOONPAY_ENTERPRISE_ENV === "sandbox";
  return { apiKey, webhookSecret, base: sandbox ? ENTERPRISE_API_SANDBOX : ENTERPRISE_API_LIVE, sandbox };
}

/** F3 bank rail: its own flag on top of the Enterprise keys. */
export function bankRailConfig(env: Env = process.env): EnterpriseConfig | null {
  return env.OWED_BANK_RAIL === "1" ? enterpriseConfig(env) : null;
}

// ---------------------------------------------------------------- webhook signature

/** The docs' examples use a 5-minute window. Replays are harmless anyway: every event is re-read from the API. */
export const ENTERPRISE_TOLERANCE_SECONDS = 300;

/**
 * webhook-signature "v1=<hex>" over `${webhook-timestamp}${raw body}` (no separator), HMAC-SHA256 keyed with the full
 * secret string including "whsec_". Constant-time; false on anything malformed, stale or wrong.
 */
export function verifyEnterpriseSignature(
  input: { timestamp: string | null; signature: string | null; rawBody: string; secret: string },
  nowMs: number = Date.now(),
  toleranceSeconds: number = ENTERPRISE_TOLERANCE_SECONDS,
): boolean {
  const { timestamp, signature, rawBody, secret } = input;
  if (!timestamp || !signature || !secret || signature.length > 400 || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}${rawBody}`, "utf8").digest();
  // One "v1=<hex>"; a space-separated list (key rotation) is tolerated, any entry may match.
  return signature.split(" ").some((part) => {
    const m = /^v1=([0-9a-f]{64})$/i.exec(part.trim());
    return m !== null && timingSafeEqual(expected, Buffer.from(m[1], "hex"));
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export interface EnterpriseEvent {
  type: "transaction" | "transaction_status";
  customerId: string;
  transactionId: string;
}

/** A `transaction` or `transaction_status` WebhookContainer, or null for every other event (they carry nothing Owed uses). */
export function parseEnterpriseEvent(body: unknown): EnterpriseEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const data = b.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : null;
  const message = data?.message && typeof data.message === "object" ? (data.message as Record<string, unknown>) : null;
  if (!data || !message || !isUuid(data.customer_id)) return null;
  const inner = (key: string) => (message[key] && typeof message[key] === "object" ? (message[key] as Record<string, unknown>) : null);
  if (b.type === "transaction") {
    const event = inner("Event");
    if (!event || event.kind !== "Transaction" || !isUuid(event.id)) return null;
    return { type: "transaction", customerId: data.customer_id, transactionId: event.id };
  }
  if (b.type === "transaction_status") {
    const status = inner("TransactionStatus");
    if (!status || !isUuid(status.id)) return null;
    return { type: "transaction_status", customerId: data.customer_id, transactionId: status.id };
  }
  return null;
}

// ---------------------------------------------------------------- autoramps

export type EnterpriseCurrency = { type: "Crypto"; token: string; blockchain: string } | { type: "Fiat"; code: string };
export type DepositRail = { type: string } & Record<string, unknown>;
export type AutorampRecipient =
  | { type: "Wallet"; blockchain: string; address: string }
  | { type: "BankAccount"; rail: string | null }
  | { type: "other" };

export const AUTORAMP_STATUSES = ["Created", "EditPending", "Authorized", "DepositAccountAdded", "Approved", "Rejected", "Cancelled"] as const;

export interface Autoramp {
  id: string;
  customerId: string;
  status: (typeof AUTORAMP_STATUSES)[number];
  kind: string;
  sourceCurrencies: EnterpriseCurrency[];
  destinationCurrency: EnterpriseCurrency | null;
  depositRails: DepositRail[];
  recipient: AutorampRecipient;
}

const text = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

function currency(v: unknown): EnterpriseCurrency | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (c.type === "Crypto" && text(c.token, 32) && text(c.blockchain, 32)) return { type: "Crypto", token: c.token as string, blockchain: c.blockchain as string };
  if (c.type === "Fiat" && text(c.code, 8)) return { type: "Fiat", code: c.code as string };
  return null;
}

function recipientOf(v: unknown): AutorampRecipient {
  if (!v || typeof v !== "object") return { type: "other" };
  const r = v as Record<string, unknown>;
  if (r.type === "Wallet" && text(r.blockchain, 32) && text(r.address, 100)) return { type: "Wallet", blockchain: r.blockchain as string, address: r.address as string };
  if (r.type === "BankAccount") {
    const id = r.account_identifier && typeof r.account_identifier === "object" ? (r.account_identifier as Record<string, unknown>) : null;
    return { type: "BankAccount", rail: text(id?.type, 16) };
  }
  return { type: "other" };
}

/** GET /api/autoramps/{id}'s Autoramp, or null when it isn't one. */
export function parseAutoramp(value: unknown): Autoramp | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Record<string, unknown>;
  if (!isUuid(a.id) || !isUuid(a.customer_id) || !(AUTORAMP_STATUSES as readonly unknown[]).includes(a.status) || !text(a.kind, 16)) return null;
  const rails = Array.isArray(a.deposit_rails) ? a.deposit_rails.filter((r): r is DepositRail => !!r && typeof r === "object" && typeof (r as { type?: unknown }).type === "string") : [];
  return {
    id: a.id,
    customerId: a.customer_id,
    status: a.status as Autoramp["status"],
    kind: a.kind as string,
    sourceCurrencies: Array.isArray(a.source_currencies) ? a.source_currencies.map(currency).filter((c): c is EnterpriseCurrency => c !== null) : [],
    destinationCurrency: currency(a.destination_currency),
    depositRails: rails.slice(0, 20),
    recipient: recipientOf(a.recipient),
  };
}

const isSolanaUsdc = (c: EnterpriseCurrency | null) => c?.type === "Crypto" && c.token === "USDC" && c.blockchain === "Solana";
export const PAYOUT_CURRENCIES = ["EUR", "USD", "GBP"] as const;
export type PayoutCurrency = (typeof PAYOUT_CURRENCIES)[number];
export const PAYOUT_RAILS = ["SEPA", "ACH", "Wire", "RTP", "FEDNOW", "SWIFT", "CHAPS", "FPS"] as const;

export type Liquidation = { ok: true; address: string; currency: PayoutCurrency; rail: (typeof PAYOUT_RAILS)[number] } | { ok: false; problem: string };

/**
 * An Approved offramp autoramp's liquidation address: the Crypto deposit rail on Solana of a route that takes USDC on
 * Solana and pays a bank in EUR, USD or GBP (https://dev.enterprise.moonpay.com/offramp.md "Share the deposit address").
 */
export function liquidationOf(a: Autoramp): Liquidation {
  const no = (problem: string): Liquidation => ({ ok: false, problem });
  if (a.kind !== "Offramp") return no(`MoonPay route ${a.id} is an ${a.kind} route, not an offramp`);
  if (a.status !== "Approved") return no(`MoonPay route ${a.id} is ${a.status}, not Approved yet`);
  if (!a.sourceCurrencies.some(isSolanaUsdc)) return no(`MoonPay route ${a.id} doesn't take USDC on Solana`);
  const dest = a.destinationCurrency;
  if (dest?.type !== "Fiat" || !(PAYOUT_CURRENCIES as readonly string[]).includes(dest.code)) return no(`MoonPay route ${a.id} doesn't pay out in EUR, USD or GBP`);
  const rail = a.recipient.type === "BankAccount" ? a.recipient.rail : null;
  if (!rail || !(PAYOUT_RAILS as readonly string[]).includes(rail)) return no(`MoonPay route ${a.id} doesn't pay a bank account by SEPA, ACH, wire, RTP, FedNow, SWIFT, CHAPS or FPS`);
  const solana = a.depositRails.filter((r) => r.type === "Crypto" && r.chain === "Solana");
  if (solana.length !== 1) return no(`MoonPay route ${a.id} has ${solana.length === 0 ? "no" : "more than one"} Solana deposit address`);
  const address = solana[0].address;
  if (!isSolanaAddress(address)) return no(`MoonPay route ${a.id}'s Solana deposit address isn't a Solana address`);
  return { ok: true, address, currency: dest.code as PayoutCurrency, rail: rail as (typeof PAYOUT_RAILS)[number] };
}

// ---------------------------------------------------------------- virtual accounts (onramp autoramps)

/** Which deposit rails a payer can use for each currency (https://dev.enterprise.moonpay.com/onramp.md "Deposit rails"). */
export const RAILS_BY_CURRENCY: Record<PayoutCurrency, readonly string[]> = {
  EUR: ["SEPA"],
  USD: ["ACH", "Wire", "RTP", "FedNow"],
  GBP: ["CHAPS", "FPS"],
};

/** A rail's payer-facing details: what a sender types into their bank, nothing else. */
export type PayerRail =
  | { type: "SEPA"; iban: string; bic: string | null; account_holder: string | null; bank_name: string | null }
  | { type: "ACH" | "Wire" | "RTP" | "FedNow"; routing_number: string; account_number: string; account_holder: string | null; bank_name: string | null }
  | { type: "CHAPS" | "FPS"; sort_code: string; account_number: string; account_holder: string | null; bank_name: string | null };

const field = (r: DepositRail, key: string, re: RegExp): string | null => {
  const v = r[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return re.test(t) ? t : null;
};
const NAME = /^[^\u0000-\u001f\u007f<>]{1,140}$/;

/** One deposit rail as a payer sees it, or null if a required field is missing or malformed. */
export function payerRail(r: DepositRail): PayerRail | null {
  if (r.type === "SEPA") {
    const iban = field(r, "iban", /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/);
    if (!iban) return null;
    return { type: "SEPA", iban, bic: field(r, "bic", /^[A-Z0-9]{8}([A-Z0-9]{3})?$/), account_holder: field(r, "beneficiary_name", NAME), bank_name: field(r, "name", NAME) };
  }
  if (r.type === "ACH" || r.type === "Wire" || r.type === "RTP" || r.type === "FedNow") {
    const routing = field(r, "routing_number", /^[0-9]{9}$/);
    const account = field(r, "account_number", /^[0-9A-Za-z]{4,34}$/);
    if (!routing || !account) return null;
    return { type: r.type, routing_number: routing, account_number: account, account_holder: field(r, "recipient_name", NAME), bank_name: field(r, "bank_name", NAME) };
  }
  if (r.type === "CHAPS" || r.type === "FPS") {
    const sort = field(r, "sort_code", /^[0-9]{2}-?[0-9]{2}-?[0-9]{2}$/);
    const account = field(r, "account_number", /^[0-9]{8}$/);
    if (!sort || !account) return null;
    return { type: r.type, sort_code: sort, account_number: account, account_holder: field(r, "beneficiary_name", NAME), bank_name: field(r, "bank_name", NAME) };
  }
  return null;
}

export type VirtualAccountCheck =
  | { ok: true; currency: PayoutCurrency; rails: PayerRail[] }
  | { ok: false; problem: string };

/**
 * An Approved onramp autoramp that turns EUR, USD or GBP into USDC on this wallet: its virtual account details, one per
 * rail a payer can use for that currency.
 */
export function virtualAccountOf(a: Autoramp, wallet: string): VirtualAccountCheck {
  const no = (problem: string): VirtualAccountCheck => ({ ok: false, problem });
  if (a.kind !== "Onramp") return no(`MoonPay route ${a.id} is an ${a.kind} route, not an onramp`);
  if (a.status !== "Approved") return no(`MoonPay route ${a.id} is ${a.status}, not Approved yet`);
  if (!isSolanaUsdc(a.destinationCurrency)) return no(`MoonPay route ${a.id} doesn't deliver USDC on Solana`);
  if (a.recipient.type !== "Wallet" || a.recipient.blockchain !== "Solana" || a.recipient.address !== wallet) return no(`MoonPay route ${a.id} delivers to a different wallet`);
  const fiats = a.sourceCurrencies.filter((c): c is Extract<EnterpriseCurrency, { type: "Fiat" }> => c.type === "Fiat");
  if (fiats.length !== 1 || !(PAYOUT_CURRENCIES as readonly string[]).includes(fiats[0].code)) return no(`MoonPay route ${a.id} doesn't take exactly one of EUR, USD or GBP`);
  const cur = fiats[0].code as PayoutCurrency;
  const rails = a.depositRails.filter((r) => RAILS_BY_CURRENCY[cur].includes(r.type)).map(payerRail).filter((r): r is PayerRail => r !== null);
  if (rails.length === 0) return no(`MoonPay route ${a.id} has no ${cur} bank details yet`);
  return { ok: true, currency: cur, rails: rails.slice(0, 6) };
}

// ---------------------------------------------------------------- transactions

export const TRANSACTION_STATUSES = ["FundsReviewInProgress", "ConversionInProgress", "PayoutInProgress", "Completed", "Failed", "RejectedAml", "RejectedFraud", "RejectedMinAmount"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export const FAILED_STATUSES: readonly TransactionStatus[] = ["Failed", "RejectedAml", "RejectedFraud", "RejectedMinAmount"];

export interface AutorampTransaction {
  id: string;
  customerId: string;
  autorampId: string;
  status: TransactionStatus;
  sourceAmount: { amount: string; currency: EnterpriseCurrency } | null;
  destinationAmount: { amount: string; currency: EnterpriseCurrency } | null;
  recipient: AutorampRecipient;
  /** payout_crypto_transaction.transaction_hash: MoonPay's on-chain delivery, for crypto payouts. */
  payoutHash: string | null;
  createdAt: string | null;
}

const DECIMAL = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,18})?$/;
function amountOf(v: unknown): AutorampTransaction["sourceAmount"] {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const c = currency(a.currency);
  return typeof a.amount === "string" && DECIMAL.test(a.amount) && c ? { amount: a.amount, currency: c } : null;
}

export function parseAutorampTransaction(value: unknown): AutorampTransaction | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (!isUuid(t.id) || !isUuid(t.customer_id) || !isUuid(t.autoramp_id) || !(TRANSACTION_STATUSES as readonly unknown[]).includes(t.status)) return null;
  const payout = t.payout_crypto_transaction && typeof t.payout_crypto_transaction === "object" ? (t.payout_crypto_transaction as Record<string, unknown>) : null;
  const createdAt = text(t.created_at, 40);
  return {
    id: t.id,
    customerId: t.customer_id,
    autorampId: t.autoramp_id,
    status: t.status as TransactionStatus,
    sourceAmount: amountOf(t.source_amount),
    destinationAmount: amountOf(t.destination_amount),
    recipient: recipientOf(t.recipient),
    payoutHash: text(payout?.transaction_hash, 120),
    createdAt: createdAt && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null,
  };
}

// ---------------------------------------------------------------- the API (server to server)

export class EnterpriseError extends Error {}
const TIMEOUT_MS = 2500;

async function getJson(path: string, config: EnterpriseConfig, deadline: number): Promise<{ status: number; body: unknown }> {
  const remaining = deadline - Date.now();
  if (remaining < 250) throw new EnterpriseError(`MoonPay Enterprise ${path.split("?")[0]}: time budget spent`);
  let res: Response;
  try {
    res = await fetch(new URL(path, config.base), {
      headers: { Accept: "application/json; charset=utf-8", "X-API-Key": config.apiKey },
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, remaining)),
      cache: "no-store",
    });
  } catch (e) {
    throw new EnterpriseError(`MoonPay Enterprise ${path.split("?")[0]}: ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable"}`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** GET /api/autoramps/{id}. Null when MoonPay says it doesn't exist (404). */
export async function fetchAutoramp(id: string, config: EnterpriseConfig, deadline = Date.now() + 3000): Promise<Autoramp | null> {
  if (!isUuid(id)) return null;
  const { status, body } = await getJson(`/api/autoramps/${id}`, config, deadline);
  if (status === 404) return null;
  if (status !== 200) throw new EnterpriseError(`MoonPay Enterprise /api/autoramps answered HTTP ${status}`);
  const a = parseAutoramp(body);
  if (!a || a.id !== id) throw new EnterpriseError("MoonPay Enterprise /api/autoramps answered with something that isn't this autoramp");
  return a;
}

/** GET /api/autoramp-transactions/ids?ids=a,b (at most 100): the transactions MoonPay knows, in its words. */
export async function fetchTransactions(ids: readonly string[], config: EnterpriseConfig, deadline = Date.now() + 3000): Promise<AutorampTransaction[]> {
  const wanted = ids.filter(isUuid).slice(0, 100);
  if (wanted.length === 0) return [];
  const { status, body } = await getJson(`/api/autoramp-transactions/ids?ids=${wanted.join(",")}`, config, deadline);
  if (status !== 200) throw new EnterpriseError(`MoonPay Enterprise /api/autoramp-transactions/ids answered HTTP ${status}`);
  const items = body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : [];
  return items.map(parseAutorampTransaction).filter((t): t is AutorampTransaction => t !== null && wanted.includes(t.id));
}
