import bs58 from "bs58";
import { toAtomic } from "../money";
import { MOONPAY_CURRENCY, type MoonpaySellConfig } from "./config";
import { encodeQuery, signQuery } from "./widget";

// F4 cash out: MoonPay's off-ramp ("sell") widget and the Sell transactions it creates. Pure: no I/O.
//
// Everything here is from MoonPay's public docs, read 2026-10-18:
// - Widget parameters: https://dev.moonpay.com/widget/off-ramp/customization/parameters.md (baseCurrencyCode,
//   baseCurrencyAmount, lockAmount, quoteCurrencyCode, refundWalletAddress, showWalletAddressForm, externalTransactionId,
//   redirectURL, unsupportedRegionRedirectUrl). refundWalletAddress makes signing mandatory.
// - URL signing: https://dev.moonpay.com/widget/off-ramp/customization/url-signing.md, the same scheme as the buy widget
//   (base64 HMAC-SHA256 of the query string including its leading "?", keyed with the secret key, URL-encoded, last).
// - Sell transaction: GET /v3/sell_transactions/ext/{externalTransactionId} returns an array
//   (https://dev.moonpay.com/api-reference/widget/getselltransactionbyexternalid.md): id, status (waitingForDeposit,
//   pending, failed, completed), baseCurrencyAmount (a number), baseCurrency.code, refundWalletAddress, depositHash,
//   failureReason, externalTransactionId, updatedAt. That schema has NO deposit address.
// - Sell webhooks (sell_transaction_created / _updated / _failed / _requote_required, body {type, data: SellTransaction})
//   document status requoteRequired and depositWallet {walletAddress, walletAddressTag}: "The MoonPay wallet the customer
//   deposits crypto to" (https://dev.moonpay.com/api-reference/widget/webhooks.openapi.json). So the deposit address is
//   only ever read from a webhook whose Moonpay-Signature-V2 verified, never from the REST answer or a caller.
// - The deposit must reach MoonPay within 48 hours of the sale, or it fails with "Deposit timeout"
//   (https://dev.moonpay.com/widget/faqs.md).

/** Fiat currencies the sell widget pays out in (quoteCurrencyCode), lower case as MoonPay's currency codes are. */
export const SELL_FIAT_CURRENCIES = [
  "aud", "bgn", "brl", "chf", "cop", "czk", "dkk", "dop", "egp", "eur", "gbp", "hkd", "idr", "ils", "jod", "kes", "kwd", "lkr",
  "mxn", "ngn", "nok", "nzd", "omr", "pen", "pln", "ron", "sek", "thb", "try", "usd", "vnd", "zar",
] as const;
export type SellFiat = (typeof SELL_FIAT_CURRENCIES)[number];

export function isSellFiat(s: unknown): s is SellFiat {
  return typeof s === "string" && (SELL_FIAT_CURRENCIES as readonly string[]).includes(s);
}

/** MoonPay prices usdc_sol to the cent (precision 2): a sale of more decimals would be refused or rounded. */
export const SELL_CENT_ATOMIC = 10_000n;

export interface SellWidgetInput {
  /** The user's wallet: MoonPay refunds a sale it can't complete here. */
  wallet: string;
  /** Exact USDC to sell, as a decimal string with at most 2 decimals ("12.5"). */
  amount: string;
  /** The cash-out id, sent as externalTransactionId. */
  cashOutId: string;
  fiatCurrency: SellFiat | null;
  /** Where MoonPay sends the user after the sale is set up (it appends transactionId and deposit details, ignored). */
  redirectUrl: string;
  unsupportedRegionUrl: string;
}

/** The parameters in the order they are signed and sent. */
export function sellWidgetParams(config: Pick<MoonpaySellConfig, "publishableKey">, input: SellWidgetInput): [string, string][] {
  const params: [string, string][] = [
    ["apiKey", config.publishableKey],
    ["baseCurrencyCode", MOONPAY_CURRENCY],
    ["baseCurrencyAmount", input.amount],
    ["lockAmount", "true"], // the user can't change how much is sold
  ];
  if (input.fiatCurrency) params.push(["quoteCurrencyCode", input.fiatCurrency]);
  params.push(
    ["refundWalletAddress", input.wallet],
    ["showWalletAddressForm", "true"], // shows the refund wallet, unchangeable
    ["externalTransactionId", input.cashOutId],
    ["redirectURL", input.redirectUrl],
    ["unsupportedRegionRedirectUrl", input.unsupportedRegionUrl],
  );
  return params;
}

/** The complete signed sell widget URL. */
export function signedSellUrl(config: Pick<MoonpaySellConfig, "publishableKey" | "secretKey" | "widgetBase">, input: SellWidgetInput): string {
  const query = encodeQuery(sellWidgetParams(config, input));
  return `${config.widgetBase}/${query}&signature=${encodeURIComponent(signQuery(query, config.secretKey))}`;
}

// ---------------------------------------------------------------- Sell transactions

export type SellStatus = "waitingForDeposit" | "pending" | "failed" | "completed" | "requoteRequired";
const SELL_STATUSES: readonly string[] = ["waitingForDeposit", "pending", "failed", "completed", "requoteRequired"];

export interface SellTx {
  id: string;
  status: SellStatus;
  externalTransactionId: string | null;
  refundWalletAddress: string | null;
  /** data.baseCurrency.code, e.g. "usdc_sol". */
  baseCurrencyCode: string | null;
  /** MoonPay's baseCurrencyAmount (a JSON number), as USDC atomic units; null when it isn't a whole number of them. */
  baseAmountAtomic: bigint | null;
  /** The customer's deposit transaction (the user's transfer to MoonPay), once MoonPay received it. */
  depositHash: string | null;
  failureReason: string | null;
  updatedAt: string | null;
  /** Webhook only (see the header): where MoonPay wants the USDC. Null for a REST answer, whatever it contains. */
  depositAddress: string | null;
  /** Webhook only: a memo/tag MoonPay needs with the deposit. Solana deposits can't carry one, so any tag blocks paying in. */
  depositTag: string | null;
}

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

/** A JSON number of USDC as atomic units, or null if it isn't a positive amount with at most 6 decimals. */
export function usdcNumberToAtomic(n: unknown): bigint | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  const fixed = n.toFixed(6);
  if (Number(fixed) !== n) return null; // more than 6 decimals: not a USDC amount
  try {
    return toAtomic(fixed.replace(/\.?0+$/, ""), "USDC");
  } catch {
    return null;
  }
}

/** A base58 Solana address (32 bytes). */
export function isSolanaAddress(s: unknown): s is string {
  if (typeof s !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

/** One SellTransaction from MoonPay's API (`source: "api"`) or a verified webhook (`"webhook"`), or null if it isn't one. */
export function parseSellTx(value: unknown, source: "api" | "webhook"): SellTx | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  const id = str(t.id, 100);
  const status = str(t.status, 40);
  if (!id || !status || !SELL_STATUSES.includes(status)) return null;
  const base = t.baseCurrency && typeof t.baseCurrency === "object" ? (t.baseCurrency as Record<string, unknown>) : null;
  const updatedAt = str(t.updatedAt, 40);
  const wallet = source === "webhook" && t.depositWallet && typeof t.depositWallet === "object" ? (t.depositWallet as Record<string, unknown>) : null;
  return {
    id,
    status: status as SellStatus,
    externalTransactionId: str(t.externalTransactionId, 100),
    refundWalletAddress: str(t.refundWalletAddress, 100),
    baseCurrencyCode: str(base?.code, 40),
    baseAmountAtomic: usdcNumberToAtomic(t.baseCurrencyAmount),
    depositHash: str(t.depositHash, 120),
    failureReason: str(t.failureReason, 300),
    updatedAt: updatedAt && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null,
    depositAddress: wallet ? str(wallet.walletAddress, 100) : null,
    depositTag: wallet ? str(wallet.walletAddressTag, 100) : null,
  };
}

/** The sales in a by-external-id answer (documented as an array; one object is accepted too). */
export function parseSellList(value: unknown): SellTx[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((v) => parseSellTx(v, "api")).filter((t): t is SellTx => t !== null);
}

export const SELL_WEBHOOK_TYPES = ["sell_transaction_created", "sell_transaction_updated", "sell_transaction_failed", "sell_transaction_requote_required"] as const;

/** Whether a webhook body is a Sell event (even a malformed one): such bodies never reach the card path. */
export function isSellWebhook(body: unknown): boolean {
  const type = body && typeof body === "object" ? (body as Record<string, unknown>).type : null;
  return typeof type === "string" && (SELL_WEBHOOK_TYPES as readonly string[]).includes(type);
}

/** The Sell transaction a verified webhook carries, or null for any other event. */
export function parseSellWebhook(body: unknown): SellTx | null {
  if (!isSellWebhook(body)) return null;
  return parseSellTx((body as Record<string, unknown>).data, "webhook");
}

/** Owed's cash-out status for MoonPay's sale status. */
export function cashOutStatusOf(status: SellStatus): "waiting_for_deposit" | "pending" | "completed" | "failed" | "requote_required" {
  switch (status) {
    case "waitingForDeposit": return "waiting_for_deposit";
    case "pending": return "pending";
    case "completed": return "completed";
    case "failed": return "failed";
    case "requoteRequired": return "requote_required";
  }
}

export interface SaleTerms {
  cashOutId: string;
  wallet: string;
  amountAtomic: bigint;
}

/**
 * Why MoonPay's sale isn't the sale this cash-out set up, or null when it is: this cash-out's id, USDC on Solana, the
 * exact amount, and refunds to this wallet. A sale that fails any of these never gets a transfer.
 */
export function saleProblem(tx: SellTx, terms: SaleTerms): string | null {
  if (tx.externalTransactionId !== terms.cashOutId) return "MoonPay's sale belongs to a different cash-out";
  if (tx.baseCurrencyCode !== MOONPAY_CURRENCY) return `MoonPay's sale sells ${tx.baseCurrencyCode ?? "an unnamed currency"}, not USDC on Solana (${MOONPAY_CURRENCY})`;
  if (tx.baseAmountAtomic === null || tx.baseAmountAtomic !== terms.amountAtomic) return "MoonPay's sale is for a different amount than this cash-out";
  if (tx.refundWalletAddress !== terms.wallet) return "MoonPay's sale refunds a different wallet than this one";
  return null;
}

/** Why a webhook's deposit address can't be paid from this wallet, or null when it can. */
export function depositProblem(tx: Pick<SellTx, "depositAddress" | "depositTag">, wallet: string): string | null {
  if (!tx.depositAddress) return "MoonPay named no deposit address";
  if (!isSolanaAddress(tx.depositAddress)) return "MoonPay's deposit address isn't a Solana address";
  if (tx.depositTag) return "MoonPay's deposit address needs a memo tag, which a plain USDC transfer can't carry";
  if (tx.depositAddress === wallet) return "MoonPay's deposit address is this wallet itself";
  return null;
}

/** Of the sales MoonPay lists for one cash-out, the one to act on: the only live one, else the newest failed one. */
export function pickSale(sales: readonly SellTx[], cashOutId: string): { sale: SellTx | null; problem: string | null } {
  const mine = sales.filter((s) => s.externalTransactionId === cashOutId);
  const live = mine.filter((s) => s.status !== "failed");
  if (live.length > 1) return { sale: null, problem: "MoonPay lists more than one open sale for this cash-out; cancel the extra one in MoonPay, then try again" };
  if (live.length === 1) return { sale: live[0], problem: null };
  const newest = [...mine].sort((a, b) => Date.parse(b.updatedAt ?? "1970-01-01") - Date.parse(a.updatedAt ?? "1970-01-01"))[0] ?? null;
  return { sale: newest, problem: null };
}
