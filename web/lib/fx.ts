import "server-only";
import { ApiError } from "./http";
import {
  disagreementPercent, divideRates, FIAT_CURRENCIES, fiatCurrency, FiatError, fromMinor, normalizeRate, ratesDisagree, toMinor,
  usdcAtomicFor, type FiatCode, type FiatQuote,
} from "./fiat";

// Live exchange rates for local-currency asks. The server quotes, not the plugin, so the plugin's network
// hosts never change. Only these two keyless HTTPS endpoints are ever fetched (the rate-source allowlist):
//
// 1. api.coinbase.com, the USD table: rate = (currency per USD) / (USDC per USD), both from one response.
//    Live mid-market. Coinbase's own USDC table is not used: for some currencies it is a local crypto
//    market price, e.g. USDC->INR traded ~6.8% above the rupee's mid-market rate on 2026-10-17.
// 2. open.er-api.com, the USD table (ExchangeRate-API's free feed, updated daily): the cross-check, and the
//    fallback when Coinbase is down. USD stands in for USDC there, so it is stale after FALLBACK_MAX_AGE_MS.
//
// Both up: Coinbase's rate is locked unless the two differ by more than 2%, then nothing is locked.
// Only one up (and fresh): its rate is locked and rate_source says which. Neither: no quote.

export const FX_SOURCES = {
  coinbase: { host: "api.coinbase.com", url: "https://api.coinbase.com/v2/exchange-rates?currency=USD" },
  erApi: { host: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD" },
} as const;
/** The only hosts lib/fx.ts fetches. */
export const FX_HOSTS = [FX_SOURCES.coinbase.host, FX_SOURCES.erApi.host] as const;

/** Each source gets this long; they run side by side, inside the plugin's 4 s API timeout. */
export const FX_TIMEOUT_MS = 1800;
/** A fetched table is reused for this long per server instance (one Coinbase call covers every currency). */
export const FX_CACHE_MS = 60_000;
/** open.er-api.com publishes once a day; older than this and its rate is stale. */
export const FALLBACK_MAX_AGE_MS = 26 * 3600_000;
const MAX_BODY_CHARS = 512 * 1024;

type Fetch = typeof fetch;

interface Table {
  /** Code -> exact decimal string of that currency per 1 USD (USDC included for Coinbase). */
  rates: Map<string, string>;
  /** When the source says the rates are from (Coinbase: when fetched). Epoch ms. */
  asOf: number;
  fetchedAt: number;
}

export interface LockedRate {
  rate: string;
  rate_source: string;
  quoted_at: string;
}

export interface FxOptions {
  fetch?: Fetch;
  now?: () => number;
}

let cache = new WeakMap<Fetch, Map<string, Table>>();

/** Tests only: forget every fetched table. */
export function resetFxCache(): void {
  cache = new WeakMap();
}

async function getText(doFetch: Fetch, url: string): Promise<string> {
  const res = await doFetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FX_TIMEOUT_MS),
    redirect: "error",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY_CHARS) throw new Error("response too large");
  return text;
}

/**
 * A JSON number literal ("3.6725", "1.2e-5") as an exact decimal string, or null for anything else
 * (negative, NaN). JSON.parse would turn it into a float; the rate is read from the source text instead.
 */
export function numberLiteralToDecimal(literal: string): string | null {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!m) return null;
  const digits = `${m[1]}${m[2] ?? ""}`;
  const exp = Number(m[3] ?? "0");
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 30) return null;
  const point = m[1].length + exp; // digits before the decimal point
  const padded = point <= 0 ? "0".repeat(1 - point) + digits : digits.padEnd(point, "0");
  const at = Math.max(point, 1);
  const whole = padded.slice(0, at).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(at).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Coinbase: {"data":{"currency":"USD","rates":{"INR":"94.95975",…}}}, every rate a decimal string. */
export function parseCoinbase(text: string, fetchedAt: number): Table {
  const body = JSON.parse(text) as { data?: { currency?: unknown; rates?: Record<string, unknown> } };
  if (body.data?.currency !== "USD" || !body.data.rates) throw new Error("unexpected Coinbase reply");
  const rates = new Map<string, string>();
  for (const [code, value] of Object.entries(body.data.rates)) {
    if (typeof value === "string" && /^[A-Z]{3,5}$/.test(code)) rates.set(code, value);
  }
  return { rates, asOf: fetchedAt, fetchedAt };
}

/** open.er-api.com: {"result":"success","base_code":"USD","time_last_update_unix":…,"rates":{"INR":95.111965,…}}. */
export function parseErApi(text: string, fetchedAt: number): Table {
  const body = JSON.parse(text) as { result?: unknown; base_code?: unknown; time_last_update_unix?: unknown; rates?: Record<string, unknown> };
  if (body.result !== "success" || body.base_code !== "USD" || typeof body.time_last_update_unix !== "number" || !body.rates) {
    throw new Error("unexpected open.er-api.com reply");
  }
  const rates = new Map<string, string>();
  // Exact literals from the text; each must be the same number JSON.parse read for that code.
  for (const m of text.matchAll(/"([A-Z]{3})"\s*:\s*([0-9][0-9.eE+-]*)/g)) {
    const [, code, literal] = m;
    const exact = numberLiteralToDecimal(literal);
    if (exact !== null && body.rates[code] === Number(literal)) rates.set(code, exact);
  }
  return { rates, asOf: body.time_last_update_unix * 1000, fetchedAt };
}

async function table(source: "coinbase" | "erApi", doFetch: Fetch, now: number): Promise<Table | null> {
  let byFetch = cache.get(doFetch);
  if (!byFetch) cache.set(doFetch, (byFetch = new Map()));
  const hit = byFetch.get(source);
  if (hit && now - hit.fetchedAt < FX_CACHE_MS) return hit;
  try {
    const text = await getText(doFetch, FX_SOURCES[source].url);
    const fresh = source === "coinbase" ? parseCoinbase(text, now) : parseErApi(text, now);
    byFetch.set(source, fresh);
    return fresh;
  } catch (e) {
    console.warn(`fx: ${FX_SOURCES[source].host} unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function rateFrom(t: Table | null, code: FiatCode, usdcPerUsd: boolean): string | null {
  const perUsd = t?.rates.get(code);
  if (!perUsd) return null;
  try {
    if (!usdcPerUsd) return normalizeRate(perUsd);
    const usdc = t!.rates.get("USDC");
    return usdc ? divideRates(perUsd, usdc) : null;
  } catch {
    return null;
  }
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The rate to lock for `code` now (units of `code` per 1 USDC), or ApiError upstream_unavailable. */
export async function lockRate(code: FiatCode, options: FxOptions = {}): Promise<LockedRate> {
  const doFetch = options.fetch ?? fetch;
  const now = (options.now ?? Date.now)();
  const [cb, er] = await Promise.all([table("coinbase", doFetch, now), table("erApi", doFetch, now)]);
  const primary = rateFrom(cb, code, true);
  const fresh = er !== null && now - er.asOf <= FALLBACK_MAX_AGE_MS;
  const check = fresh ? rateFrom(er, code, false) : null;
  const quoted_at = isoSeconds(now);
  if (primary && check) {
    if (ratesDisagree(primary, check)) {
      throw new ApiError(
        "upstream_unavailable",
        `the two exchange-rate sources disagree on ${code} by ${disagreementPercent(primary, check)} (more than 2%), so no rate was locked; try again later, or ask in USDC`,
      );
    }
    return { rate: primary, rate_source: `${FX_SOURCES.coinbase.host}, checked against ${FX_SOURCES.erApi.host}`, quoted_at };
  }
  if (primary) return { rate: primary, rate_source: FX_SOURCES.coinbase.host, quoted_at };
  if (check) return { rate: check, rate_source: `${FX_SOURCES.erApi.host} (USD rate)`, quoted_at };
  const why = er !== null && !fresh ? `${FX_SOURCES.erApi.host}'s rates are stale and ${FX_SOURCES.coinbase.host} didn't answer` : "neither rate source answered";
  throw new ApiError("upstream_unavailable", `couldn't get a live ${code} rate (${why}); try again in a minute, or ask in USDC`);
}

export interface FiatAsk {
  code: FiatCode;
  /** Normalized ("1200", "1200.5"). */
  amount: string;
  minor: bigint;
}

/** Validates an ask's currency and amount (ApiError invalid_input), before any rate is fetched. */
export function fiatAsk(currency: string, amount: string, field = "amount"): FiatAsk {
  let code: FiatCode;
  try {
    code = fiatCurrency(currency);
  } catch (e) {
    if (e instanceof FiatError) throw new ApiError("invalid_input", `currency: ${e.message}`);
    throw e;
  }
  try {
    const minor = toMinor(amount, code);
    return { code, amount: fromMinor(minor, code), minor };
  } catch (e) {
    if (e instanceof FiatError) throw new ApiError("invalid_input", `${field}: ${e.message}`);
    throw e;
  }
}

/** The stored quote for `amount` of `code` at a locked rate, and the USDC it locks. */
export function quoteAt(code: FiatCode, amount: string, locked: LockedRate): { fiat: FiatQuote; usdcAtomic: bigint } {
  let usdcAtomic: bigint;
  try {
    usdcAtomic = usdcAtomicFor(amount, code, locked.rate);
  } catch (e) {
    if (e instanceof FiatError) throw new ApiError("invalid_input", `amount: ${e.message}`);
    throw e;
  }
  return { fiat: { currency: code, amount, rate: locked.rate, rate_source: locked.rate_source, quoted_at: locked.quoted_at }, usdcAtomic };
}

export function fiatDecimals(code: FiatCode): number {
  return FIAT_CURRENCIES[code].decimals;
}
