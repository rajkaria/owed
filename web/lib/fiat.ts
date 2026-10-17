// Local-currency asks: the ISO 4217 currencies Owed quotes, and the exact decimal arithmetic that turns an
// amount in one of them into the USDC a payer pays. No floats: decimal strings at the edges, bigint inside.
// plugin/src/fiat.ts and web/lib/fiat.ts are the same file (web/test/fiat.test.ts checks), with no imports,
// so the plugin, the server and the pages compute the same USDC amount from the same quote.
//
// The rule: usdc = fiat_amount / rate, rounded UP to 6 decimals (1 atomic unit of USDC), where rate is how
// many units of the currency one USDC buys. Rounding up means the requester never receives less than the
// quote says; the payer pays at most 0.000001 USDC more. The USDC amount is locked when the request is
// made and never changes; the local-currency amount is a quote shown next to it, not a guarantee.

export interface FiatCurrency {
  /** ISO 4217 minor units: 2 for INR ("1200.50"), 0 for JPY ("1500"). */
  decimals: number;
  /** Written before the amount: "₹1,200", "KSh 1,200". */
  prefix: string;
  name: string;
}

export const FIAT_CURRENCIES = {
  AED: { decimals: 2, prefix: "AED ", name: "UAE dirham" },
  ARS: { decimals: 2, prefix: "ARS ", name: "Argentine peso" },
  AUD: { decimals: 2, prefix: "A$", name: "Australian dollar" },
  BDT: { decimals: 2, prefix: "৳", name: "Bangladeshi taka" },
  BRL: { decimals: 2, prefix: "R$", name: "Brazilian real" },
  CAD: { decimals: 2, prefix: "CA$", name: "Canadian dollar" },
  CHF: { decimals: 2, prefix: "CHF ", name: "Swiss franc" },
  CLP: { decimals: 0, prefix: "CLP ", name: "Chilean peso" },
  CNY: { decimals: 2, prefix: "CN¥", name: "Chinese yuan" },
  COP: { decimals: 2, prefix: "COP ", name: "Colombian peso" },
  CZK: { decimals: 2, prefix: "CZK ", name: "Czech koruna" },
  EGP: { decimals: 2, prefix: "EGP ", name: "Egyptian pound" },
  EUR: { decimals: 2, prefix: "€", name: "euro" },
  GBP: { decimals: 2, prefix: "£", name: "British pound" },
  GHS: { decimals: 2, prefix: "GH₵", name: "Ghanaian cedi" },
  HKD: { decimals: 2, prefix: "HK$", name: "Hong Kong dollar" },
  IDR: { decimals: 2, prefix: "Rp ", name: "Indonesian rupiah" },
  INR: { decimals: 2, prefix: "₹", name: "Indian rupee" },
  JPY: { decimals: 0, prefix: "¥", name: "Japanese yen" },
  KES: { decimals: 2, prefix: "KSh ", name: "Kenyan shilling" },
  KRW: { decimals: 0, prefix: "₩", name: "South Korean won" },
  MAD: { decimals: 2, prefix: "MAD ", name: "Moroccan dirham" },
  MXN: { decimals: 2, prefix: "MX$", name: "Mexican peso" },
  MYR: { decimals: 2, prefix: "RM ", name: "Malaysian ringgit" },
  NGN: { decimals: 2, prefix: "₦", name: "Nigerian naira" },
  NZD: { decimals: 2, prefix: "NZ$", name: "New Zealand dollar" },
  PHP: { decimals: 2, prefix: "₱", name: "Philippine peso" },
  PKR: { decimals: 2, prefix: "PKR ", name: "Pakistani rupee" },
  PLN: { decimals: 2, prefix: "PLN ", name: "Polish złoty" },
  SAR: { decimals: 2, prefix: "SAR ", name: "Saudi riyal" },
  SEK: { decimals: 2, prefix: "SEK ", name: "Swedish krona" },
  SGD: { decimals: 2, prefix: "S$", name: "Singapore dollar" },
  THB: { decimals: 2, prefix: "฿", name: "Thai baht" },
  TRY: { decimals: 2, prefix: "₺", name: "Turkish lira" },
  TZS: { decimals: 2, prefix: "TSh ", name: "Tanzanian shilling" },
  VND: { decimals: 0, prefix: "VND ", name: "Vietnamese dong" },
  XOF: { decimals: 0, prefix: "CFA ", name: "West African CFA franc" },
  ZAR: { decimals: 2, prefix: "R ", name: "South African rand" },
} as const satisfies Record<string, FiatCurrency>;

export type FiatCode = keyof typeof FIAT_CURRENCIES;
export const FIAT_CODES = Object.keys(FIAT_CURRENCIES) as [FiatCode, ...FiatCode[]];

/** USDC is 6 decimals on Solana (and on Base). */
export const USDC_DECIMALS = 6;
/** Rates keep at most this many decimal places (truncated); every reader recomputes from the stored string. */
export const RATE_DECIMALS = 12;
/** The two rate sources may differ by at most this much (basis points of the lower one). */
export const MAX_RATE_DISAGREEMENT_BPS = 200n;
const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** A local-currency amount or rate is not acceptable. Message is shown to the user verbatim. */
export class FiatError extends Error {}

/** The quote a fiat request carries (contract `fiat`): the amount asked, the rate locked, where and when. */
export interface FiatQuote {
  currency: string;
  /** In `currency`, shortest decimal ("1200", "1200.5"). */
  amount: string;
  /** Units of `currency` per 1 USDC, decimal string. */
  rate: string;
  rate_source: string;
  /** ISO time the rate was locked (UTC). */
  quoted_at: string;
}

export function isFiatCode(code: unknown): code is FiatCode {
  return typeof code === "string" && Object.hasOwn(FIAT_CURRENCIES, code);
}

/**
 * The currency an ask names, upper-cased, or a FiatError saying what to do instead. USD is refused on
 * purpose: 1 USDC is 1 US dollar, so a dollar ask is a plain USDC ask with nothing to quote.
 */
export function fiatCurrency(code: string): FiatCode {
  const upper = code.trim().toUpperCase();
  if (upper === "USD" || upper === "USDC") throw new FiatError("USD needs no conversion: 1 USDC is 1 US dollar. Ask in USDC instead (leave currency out).");
  if (isFiatCode(upper)) return upper;
  throw new FiatError(`Owed can't quote ${/^[A-Z]{3}$/.test(upper) ? upper : "that currency"} yet. It quotes ${FIAT_CODES.join(", ")}; or ask in USDC.`);
}

function decimalParts(s: string): { whole: string; frac: string } | null {
  const m = DECIMAL.exec(s);
  return m ? { whole: m[1]!, frac: m[2] ? m[2].slice(1) : "" } : null;
}

/** "1200.5" INR -> 120050n (minor units). Throws FiatError for zero, too many decimals or too large. */
export function toMinor(amount: string, code: FiatCode): bigint {
  const { decimals } = FIAT_CURRENCIES[code];
  const parts = typeof amount === "string" && amount.length <= 40 ? decimalParts(amount) : null;
  if (!parts) throw new FiatError(`${code} amount must be a plain decimal number like 1200 or 45.50.`);
  if (parts.frac.replace(/0+$/, "").length > decimals) {
    throw new FiatError(decimals === 0 ? `${code} amounts are whole numbers (no decimals).` : `${code} amounts have at most ${decimals} decimal places.`);
  }
  const minor = BigInt(parts.whole + parts.frac.replace(/0+$/, "").padEnd(decimals, "0"));
  if (minor === 0n) throw new FiatError("Amount must be more than zero.");
  if (minor > U64_MAX) throw new FiatError("Amount is too large.");
  return minor;
}

/** Minor units -> shortest decimal ("1200", "1200.5"). */
export function fromMinor(minor: bigint, code: FiatCode): string {
  return shortest(minor, FIAT_CURRENCIES[code].decimals);
}

function shortest(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const frac = digits.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

interface Scaled {
  units: bigint;
  scale: number;
}

function parseRate(rate: string): Scaled {
  const parts = typeof rate === "string" && rate.length <= 40 ? decimalParts(rate) : null;
  if (!parts || parts.frac.length > RATE_DECIMALS) throw new FiatError("The exchange rate isn't a decimal Owed can use.");
  const units = BigInt(parts.whole + parts.frac);
  if (units === 0n) throw new FiatError("The exchange rate must be more than zero.");
  return { units, scale: parts.frac.length };
}

/** A rate as received ("94.95975", "4131.8058255") cut to RATE_DECIMALS places, trailing zeros dropped. */
export function normalizeRate(raw: string): string {
  const parts = decimalParts(raw);
  if (!parts) throw new FiatError("The exchange rate isn't a decimal Owed can use.");
  const frac = parts.frac.slice(0, RATE_DECIMALS).replace(/0+$/, "");
  const out = frac ? `${parts.whole}.${frac}` : parts.whole;
  parseRate(out); // refuses a rate that truncates to zero
  return out;
}

/** a / b as a decimal string with RATE_DECIMALS places (truncated), for a rate derived from two quotes. */
export function divideRates(a: string, b: string): string {
  const x = parseRate(normalizeRate(a));
  const y = parseRate(normalizeRate(b));
  // (x.units / 10^x.scale) / (y.units / 10^y.scale) * 10^RATE_DECIMALS
  const num = x.units * 10n ** BigInt(y.scale + RATE_DECIMALS);
  const den = y.units * 10n ** BigInt(x.scale);
  return normalizeRate(shortest(num / den, RATE_DECIMALS));
}

/** USDC atomic units for `amount` of `code` at `rate`, rounded up. Throws FiatError when out of range. */
export function usdcAtomicFor(amount: string, code: FiatCode, rate: string): bigint {
  const minor = toMinor(amount, code);
  const r = parseRate(rate);
  const { decimals } = FIAT_CURRENCIES[code];
  // (minor / 10^decimals) / (r.units / 10^r.scale) * 10^6, rounded up.
  const num = minor * 10n ** BigInt(r.scale + USDC_DECIMALS);
  const den = r.units * 10n ** BigInt(decimals);
  const atomic = (num + den - 1n) / den;
  if (atomic > U64_MAX) throw new FiatError("Amount is too large.");
  return atomic;
}

/** True when two rates differ by more than `bps` basis points of the lower one. */
export function ratesDisagree(a: string, b: string, bps: bigint = MAX_RATE_DISAGREEMENT_BPS): boolean {
  const x = parseRate(normalizeRate(a));
  const y = parseRate(normalizeRate(b));
  const scale = Math.max(x.scale, y.scale);
  const xa = x.units * 10n ** BigInt(scale - x.scale);
  const ya = y.units * 10n ** BigInt(scale - y.scale);
  const diff = xa > ya ? xa - ya : ya - xa;
  const low = xa < ya ? xa : ya;
  return diff * 10_000n > bps * low;
}

/** How far apart two rates are, for messages: "6.8%". Rounded to one decimal, half up. */
export function disagreementPercent(a: string, b: string): string {
  const x = parseRate(normalizeRate(a));
  const y = parseRate(normalizeRate(b));
  const scale = Math.max(x.scale, y.scale);
  const xa = x.units * 10n ** BigInt(scale - x.scale);
  const ya = y.units * 10n ** BigInt(scale - y.scale);
  const diff = xa > ya ? xa - ya : ya - xa;
  const low = xa < ya ? xa : ya;
  const tenths = (diff * 2000n + low) / (2n * low); // diff/low * 1000, half up
  return `${tenths / 10n}.${tenths % 10n}%`;
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1200.5" INR -> "₹1,200.50"; "1500" JPY -> "¥1,500". Fractions are shown to the currency's minor units. */
export function formatFiat(amount: string, code: string): string {
  if (!isFiatCode(code)) return `${amount} ${code}`;
  const { decimals, prefix } = FIAT_CURRENCIES[code];
  const parts = decimalParts(amount);
  if (!parts) return `${prefix}${amount}`;
  const frac = parts.frac.replace(/0+$/, "");
  return `${prefix}${group(parts.whole)}${frac ? `.${frac.padEnd(decimals, "0")}` : ""}`;
}

/** "94.95975" INR -> "1 USDC = ₹94.96". Display only: 2 places from 10 up, else 4 ("€0.8899"); half up. */
export function formatRate(rate: string, code: string): string {
  let shown = rate;
  try {
    const r = parseRate(rate);
    const places = r.units >= 10n * 10n ** BigInt(r.scale) ? 2 : 4;
    if (r.scale > places) {
      const cut = 10n ** BigInt(r.scale - places);
      shown = shortest((r.units + cut / 2n) / cut, places);
    }
  } catch {
    // show it as stored
  }
  return `1 USDC = ${formatFiat(shown, code)}`;
}

/** "2026-10-17T21:04:31Z" -> "2026-10-17 21:04 UTC". */
export function lockedAt(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/** "₹1,200 · 12.637145 USDC (rate locked 2026-10-17 21:04 UTC)": the line every surface shows. */
export function fiatLine(fiat: Pick<FiatQuote, "currency" | "amount" | "quoted_at">, usdc: string): string {
  return `${formatFiat(fiat.amount, fiat.currency)} · ${usdc} USDC (rate locked ${lockedAt(fiat.quoted_at)})`;
}

/** The caveat that goes with it wherever there is room. */
export const QUOTE_CAVEAT = "The local-currency amount is a quote, not a guarantee: the USDC amount is what's owed and never changes.";

/**
 * Null when `fiat` is a well-formed quote whose amount at its rate rounds up to exactly `usdcAtomic`;
 * otherwise what is wrong. Pay surfaces refuse a request whose quote doesn't produce its USDC amount.
 */
export function quoteProblem(fiat: Pick<FiatQuote, "currency" | "amount" | "rate">, usdcAtomic: bigint): string | null {
  try {
    if (!isFiatCode(fiat.currency)) return `the quote is in ${fiat.currency}, which Owed doesn't quote`;
    const expected = usdcAtomicFor(fiat.amount, fiat.currency, fiat.rate);
    return expected === usdcAtomic ? null : `${formatFiat(fiat.amount, fiat.currency)} at ${formatRate(fiat.rate, fiat.currency)} isn't the USDC amount asked`;
  } catch (error) {
    return error instanceof Error ? error.message : "the quote can't be read";
  }
}
