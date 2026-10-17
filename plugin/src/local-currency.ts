import * as z from "zod/v4";
import type { ApiError } from "./api.js";
import type { FiatQuoteRes } from "./contract.js";
import {
  FIAT_CODES, FIAT_CURRENCIES, fiatCurrency, fiatLine, formatFiat, formatRate, fromMinor, lockedAt, quoteProblem, toMinor, type FiatCode,
} from "./fiat.js";
import { fromAtomic, toAtomic } from "./money.js";
import { rateLimitedText } from "./text.js";

// Local-currency asks in the tools (ask_for_money, split_bill, create_invoice). The plugin never fetches a
// rate: Owed's server locks one (web/lib/fx.ts), so the plugin's network hosts don't change. What the plugin
// does is check the server's arithmetic: the quote it returns must be the currency and amount asked, and its
// amount at its rate, rounded up to 6 decimals, must be exactly the USDC every link and id commits to.

export const currencyInput = z.string().min(3).max(4).describe(
  `Optional: the currency the amounts are in, as an ISO 4217 code, when the user asks in their own money ("₹1,200" -> "INR", "€45" -> "EUR"). ` +
  `Owed locks the USDC amount at a live rate when the request is made; the payer pays that USDC, which never changes. ` +
  `One of ${FIAT_CODES.join(", ")}. Leave it out for USDC or SOL (and for US dollars: 1 USDC is 1 dollar).`,
);

export const fiatOutput = z.object({
  currency: z.string(),
  amount: z.string().describe("The amount asked, in currency."),
  rate: z.string().describe("Units of currency per 1 USDC, locked when the request was made."),
  rate_source: z.string(),
  quoted_at: z.string().describe("When the rate was locked (UTC)."),
}).strict().describe("Local-currency ask: the quote behind the USDC amount. A quote, not a guarantee: the USDC amount is what is owed.");

export interface FiatAsk {
  code: FiatCode;
  /** Normalized ("1200", "1200.5"). */
  amount: string;
  minor: bigint;
}

/** The ask's currency and amount, or what to tell the user. Local-currency asks are paid in USDC. */
export function parseFiatAsk(currency: string, amount: string, token: string): { ok: true; ask: FiatAsk } | { ok: false; message: string } {
  try {
    const code = fiatCurrency(currency);
    if (token !== "USDC") return { ok: false, message: `A ${code} ask is paid in USDC, locked at today's rate. Leave token out (or set it to USDC), or ask in SOL without currency.` };
    const minor = toMinor(amount, code);
    return { ok: true, ask: { code, amount: fromMinor(minor, code), minor } };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "That amount can't be used." };
  }
}

export type QuoteCheck = { ok: true; fiat: FiatQuoteRes; atomic: bigint; amount: string } | { ok: false };

/**
 * The server's quote for `ask`: the same currency and amount, and the USDC (`usdc`, a decimal string) that
 * amount at the quoted rate rounds up to. Anything else, including a reply with no quote (a server that
 * ignored `currency`), is a mismatch and the link must not be used.
 */
export function checkQuote(fiat: FiatQuoteRes | undefined, usdc: string | undefined, ask: Pick<FiatAsk, "code" | "amount">): QuoteCheck {
  try {
    if (!fiat || usdc === undefined) return { ok: false };
    if (fiat.currency !== ask.code || toMinor(fiat.amount, ask.code) !== toMinor(ask.amount, ask.code)) return { ok: false };
    const atomic = toAtomic(usdc, "USDC");
    if (quoteProblem(fiat, atomic) !== null) return { ok: false };
    return { ok: true, fiat, atomic, amount: fromAtomic(atomic, "USDC") };
  } catch {
    return { ok: false };
  }
}

/** "₹1,200" */
export function fiatAmountText(fiat: Pick<FiatQuoteRes, "currency" | "amount">): string {
  return formatFiat(fiat.amount, fiat.currency);
}

/** "₹1,200 = 12.637145 USDC (rate locked 2026-10-17 21:04 UTC)" */
export function fiatHeadline(fiat: FiatQuoteRes, usdc: string): string {
  return `${formatFiat(fiat.amount, fiat.currency)} = ${usdc} USDC (rate locked ${lockedAt(fiat.quoted_at)})`;
}

/** The tool-output line that says where the rate came from and what it means. */
export function fiatRateLine(fiat: FiatQuoteRes, usdc: string): string {
  const name = Object.hasOwn(FIAT_CURRENCIES, fiat.currency) ? FIAT_CURRENCIES[fiat.currency as FiatCode].name : fiat.currency;
  return `Rate locked ${lockedAt(fiat.quoted_at)}: ${formatRate(fiat.rate, fiat.currency)} (${fiat.rate_source}), rounded up to the nearest 0.000001 USDC. ` +
    `The payer pays ${usdc} USDC, which never changes; the ${name} amount is a quote, not a guarantee.`;
}

/** check_payments, who_owes_me, write_reminder: "₹1,200 · 12.637145 USDC (rate locked …)", or null when there's no usable quote. */
export function fiatStatusLine(fiat: FiatQuoteRes | undefined, usdc: string | undefined): string | null {
  if (!fiat || usdc === undefined) return null;
  try {
    if (quoteProblem(fiat, toAtomic(usdc, "USDC")) !== null) return null;
  } catch {
    return null;
  }
  return fiatLine(fiat, usdc);
}

/**
 * Why a local-currency ask wasn't made. There is no offline fallback: an offline link needs a USDC amount,
 * and only Owed's server can lock a rate.
 */
export function fiatApiRefusal(error: ApiError, what: string): string | null {
  if (error.code === "upstream_unavailable") {
    const reason = error.detail ? ` (${error.detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)})` : "";
    return `Owed couldn't lock an exchange rate right now${reason}, so the ${what} wasn't created. Try again in a minute, or ask in USDC.`;
  }
  if (error.code === "rate_limited") return rateLimitedText(error.message);
  return null;
}
