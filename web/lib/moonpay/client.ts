import "server-only";
import { toAtomic } from "../money";
import { MOONPAY_API, MOONPAY_CURRENCY, type MoonpayConfig } from "./config";
import { DEFAULT_LIMITS, type CardLimits } from "./eligibility";
import { parseMoonpayList, type MoonpayTx } from "./transaction";
import { parseSellList, type SellTx } from "./sell"; // F4 cash out

// MoonPay's REST API (https://api.moonpay.com, same host for sandbox and live; the key decides).
// Errors never carry a key: messages name the endpoint and status only.

export class MoonpayError extends Error {}

const TIMEOUT_MS = 2500;

async function get(path: string, config: Pick<MoonpayConfig, "publishableKey" | "secretKey">, { deadline = Infinity, secret = false } = {}): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining < 250) throw new MoonpayError(`MoonPay ${path.split("?")[0]}: time budget spent`);
  const url = new URL(path, MOONPAY_API);
  url.searchParams.set("apiKey", config.publishableKey);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json", ...(secret && { Authorization: `Api-Key ${config.secretKey}` }) },
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, remaining)),
      cache: "no-store",
    });
  } catch (e) {
    throw new MoonpayError(`MoonPay ${url.pathname}: ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable"}`);
  }
}

/**
 * GET /v1/transactions/ext/{externalTransactionId}: every Buy transaction started from a widget URL
 * carrying this request id. Sent with the secret key (server-to-server) as well as the publishable
 * apiKey the reference names. 404 means none yet.
 */
export async function transactionsForRequest(requestId: string, config: MoonpayConfig, deadline?: number): Promise<MoonpayTx[]> {
  const res = await get(`/v1/transactions/ext/${encodeURIComponent(requestId)}`, config, { deadline, secret: true });
  if (res.status === 404) return [];
  if (!res.ok) throw new MoonpayError(`MoonPay /v1/transactions/ext answered HTTP ${res.status}`);
  return parseMoonpayList(await res.json());
}

const LIMITS_TTL_MS = 10 * 60_000;
let cachedLimits: { at: number; limits: CardLimits } | null = null;

/** Parse GET /v3/currencies/usdc_sol/limits: quoteCurrency.minBuyAmount / maxBuyAmount, in USDC. */
export function parseLimits(json: unknown): CardLimits | null {
  const quote = (json as { quoteCurrency?: { code?: unknown; minBuyAmount?: unknown; maxBuyAmount?: unknown } } | null)?.quoteCurrency;
  if (!quote || quote.code !== MOONPAY_CURRENCY) return null;
  const atomic = (n: unknown): bigint | null => {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
    try {
      return toAtomic(n.toFixed(6).replace(/\.?0+$/, ""), "USDC");
    } catch {
      return null;
    }
  };
  const minAtomic = atomic(quote.minBuyAmount);
  const maxAtomic = atomic(quote.maxBuyAmount);
  if (minAtomic === null) return null;
  return { minAtomic, maxAtomic: maxAtomic !== null && maxAtomic > minAtomic ? maxAtomic : DEFAULT_LIMITS.maxAtomic };
}

/**
 * Card buy limits for usdc_sol (paymentMethod credit_debit_card), cached for 10 minutes per instance.
 * Falls back to the published currency limits (4.99 to 30,000 USDC) when MoonPay doesn't answer in time.
 */
export async function cardLimits(config: MoonpayConfig, deadline = Date.now() + 1500): Promise<CardLimits> {
  if (cachedLimits && Date.now() - cachedLimits.at < LIMITS_TTL_MS) return cachedLimits.limits;
  try {
    const res = await get(`/v3/currencies/${MOONPAY_CURRENCY}/limits?baseCurrencyCode=usd&paymentMethod=credit_debit_card`, config, { deadline });
    const limits = res.ok ? parseLimits(await res.json()) : null;
    if (limits) {
      cachedLimits = { at: Date.now(), limits };
      return limits;
    }
    console.warn(`MoonPay limits: HTTP ${res.status}, using the published limits`);
  } catch (e) {
    console.warn(`MoonPay limits: ${e instanceof Error ? e.message : String(e)}, using the published limits`);
  }
  return DEFAULT_LIMITS;
}

// F4 cash out start
/**
 * GET /v3/sell_transactions/ext/{externalTransactionId}: every Sell transaction started from a sell widget URL carrying
 * this cash-out id (https://dev.moonpay.com/api-reference/widget/getselltransactionbyexternalid.md: an array, because
 * MoonPay can't promise the id is unique). Sent with the secret key as well as the publishable apiKey. 404 means none yet.
 */
export async function sellTransactionsFor(cashOutId: string, config: Pick<MoonpayConfig, "publishableKey" | "secretKey">, deadline?: number): Promise<SellTx[]> {
  const res = await get(`/v3/sell_transactions/ext/${encodeURIComponent(cashOutId)}`, config, { deadline, secret: true });
  if (res.status === 404) return [];
  if (!res.ok) throw new MoonpayError(`MoonPay /v3/sell_transactions/ext answered HTTP ${res.status}`);
  return parseSellList(await res.json());
}
// F4 cash out end
