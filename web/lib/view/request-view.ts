// Turns an API request (/r/[id]) or a raw Solana Pay link (/p) into one view
// model, so both pages render the same UI from the same rules.

import type { PublicRequest } from "../public-api";
import { formatAmount, isToken, remainingAmount, type Token } from "./money.ts";
import { shortAddress } from "./format.ts";
import { LIMITS, cleanText, withoutInvisible } from "./text.ts";
import { isBrandOwnDomain } from "../safety";
import type { TransferRequest } from "./pay-url.ts";
import { FIAT_CURRENCIES, formatFiat, formatRate, isFiatCode, lockedAt, quoteProblem, type FiatQuote } from "../fiat";

export type LiveState =
  | { status: "open" }
  | {
      status: "paid";
      amount: string | null;
      payer: string | null;
      signature: string | null;
      at: string | null;
      rail: "solana_pay" | "x402" | "base_transfer" | "matched" | "moonpay_card" | null;
      /** 0012: a payment without the reference that the recipient matched (all of it, or the rest after a partial one). */
      matched?: MatchedView | null;
    }
  | {
      status: "underpaid";
      amountPaid: string | null;
      remaining: string | null;
      payer: string | null;
      signature: string | null;
      at: string | null;
      /** 0012: the follow-up request that asks for the rest, when one was made. */
      restRequestId?: string | null;
    }
  // W3-C: `at` is when it was cancelled or when it expired, when known.
  | { status: "cancelled"; at?: string | null }
  | { status: "expired"; at?: string | null };

/** 0012: what the page says about a matched payment. Never shown like a referenced payment. */
export interface MatchedView {
  covers: "full" | "rest";
  amount: string | null;
  signature: string | null;
  confirmedAt: string | null;
}

/** The label every surface uses for a matched payment (plugin text uses the same words). */
export const MATCHED_LABEL = "Matched by the recipient (no reference on the payment)";

export type PollTarget =
  | { endpoint: "/api/v1/status"; id: string }
  | { endpoint: "/api/v1/status-raw"; solanaPayUrl: string };

export interface PayModel {
  kind: "hosted" | "stateless";
  /** W3-B: "base" for a USDC request on Base (EIP-681 link, Base wallets, Basescan). */
  chain: "solana" | "base";
  amount: string | null;
  token: Token;
  /** Requester name, or the short recipient address when there is none or the request is flagged. */
  asker: string;
  askerIsAddress: boolean;
  /** Name the requester gave on a flagged request, shown only as quoted text. */
  claimedName: string | null;
  payerName: string | null;
  forText: string | null;
  note: string | null;
  recipient: string;
  solanaPayUrl: string;
  shareLink: string;
  agentPrompt: string;
  /** W2-B: where an x402 agent pays this request (USDC, 12-char ids); null otherwise. */
  x402Url: string | null;
  brandWords: string[];
  initial: LiveState;
  poll: PollTarget | null;
  /** W3-C: when an open request stops taking payments (ISO), or null. */
  expiresAt?: string | null;
  /** 0012: this request asks for the rest of that underpaid request. */
  restOf?: string | null;
  /** Local-currency ask: the quote beside the USDC amount (display only), or null. */
  fiat?: FiatView | null;
}

/** What a page shows for a local-currency ask: "₹1,200", paid as "12.637145 USDC", rate locked when. */
export interface FiatView {
  /** "₹1,200" */
  amount: string;
  /** "12.637145 USDC" */
  usdc: string;
  /** "1 USDC = ₹94.96" */
  rate: string;
  /** "2026-10-17 21:04 UTC" */
  lockedAt: string;
  /** "api.coinbase.com, checked against open.er-api.com" */
  source: string;
  /** "Indian rupee" */
  currencyName: string;
}

/**
 * The quote to show beside `amount` USDC, or null. A quote whose amount at its rate doesn't round up to
 * exactly the USDC amount isn't shown: the USDC amount (which the id commits to) is what the payer pays.
 */
export function fiatView(fiat: FiatQuote | null | undefined, amount: string | null): FiatView | null {
  if (!fiat || amount === null || !isFiatCode(fiat.currency)) return null;
  const atomic = toUsdcAtomic(amount);
  if (atomic === null || quoteProblem(fiat, atomic) !== null) return null;
  return {
    amount: formatFiat(fiat.amount, fiat.currency),
    usdc: formatAmount(amount, "USDC"),
    rate: formatRate(fiat.rate, fiat.currency),
    lockedAt: lockedAt(fiat.quoted_at),
    // Written by Owed's server (lib/fx.ts), never by the requester: hostnames, commas and brackets only.
    source: /^[A-Za-z0-9 .,()-]{1,120}$/.test(fiat.rate_source) ? fiat.rate_source : "",
    currencyName: FIAT_CURRENCIES[fiat.currency].name,
  };
}

function toUsdcAtomic(amount: string): bigint | null {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(amount);
  return m ? BigInt(m[1] + (m[2] ?? "").padEnd(6, "0")) : null;
}

// SPEC §6 brand-word list. A hit never blocks; it shows a caution banner.
const BRAND_WORDS: Array<[string, string]> = [
  ["solana foundation", "Solana Foundation"],
  ["usdc support", "USDC support"],
  ["tax office", "tax office"],
  ["moonpay", "MoonPay"],
  ["paybox", "PayBox"],
  ["coinbase", "Coinbase"],
  ["binance", "Binance"],
  ["phantom", "Phantom"],
  ["solflare", "Solflare"],
  ["circle", "Circle"],
  ["refund", "refund"],
  ["irs", "IRS"],
  // W2-E (QA-06): Owed's own name, as phrases the ordinary word "owed" never forms, and the model maker.
  ["owed support", "Owed Support"],
  ["owed team", "Owed team"],
  ["owed security", "Owed Security"],
  ["owed admin", "Owed admin"],
  ["owed billing", "Owed billing"],
  ["getowed", "getowed"],
  ["anthropic", "Anthropic"],
];
const BRAND_DISPLAY = new Map(BRAND_WORDS);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Brand words found in requester text (case-insensitive, whole words). */
export function detectBrandWords(texts: Array<string | null | undefined>, verifiedDomain?: string | null): string[] {
  // W2-E (QA-01): an invisible character inside a brand word ("Pay<U+E0100>Box") doesn't hide it.
  const haystack = texts.filter((t): t is string => typeof t === "string" && t !== "").map(withoutInvisible).join(" \n ").toLowerCase();
  const found: string[] = [];
  for (const [word, display] of BRAND_WORDS) {
    if (isBrandOwnDomain(word, verifiedDomain)) continue; // W2-E: the verified domain is this brand's own
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word).replace(/ /g, "\\s+")}($|[^\\p{L}\\p{N}])`, "u");
    if (re.test(haystack)) found.push(display);
  }
  return found;
}

/** Display names for `brand_word:<w>` flags set by the API. */
export function brandWordsFromFlags(flags: unknown, verifiedDomain?: string | null): string[] {
  if (!Array.isArray(flags)) return [];
  const out: string[] = [];
  for (const flag of flags) {
    if (typeof flag !== "string" || !flag.startsWith("brand_word:")) continue;
    const word = flag.slice("brand_word:".length).toLowerCase();
    if (isBrandOwnDomain(word, verifiedDomain)) continue; // W2-E: the verified domain is this brand's own
    const display = BRAND_DISPLAY.get(word) ?? cleanText(word, 30);
    if (display) out.push(display);
  }
  return out;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

// W3-B: Base payments carry a 0x transaction hash and a 0x payer.
const BASE58_SIG = /^(?:[1-9A-HJ-NP-Za-km-z]{32,100}|0x[0-9a-f]{64})$/;
const BASE58_KEY = /^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function sig(value: unknown): string | null {
  return typeof value === "string" && BASE58_SIG.test(value) ? value : null;
}
function key(value: unknown): string | null {
  return typeof value === "string" && BASE58_KEY.test(value) ? value : null;
}
function dec(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && DECIMAL.test(value) ? value : null;
}
function iso(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? value : null;
}
const REQUEST_ID = /^[1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?$/;
function requestId(value: unknown): string | null {
  return typeof value === "string" && REQUEST_ID.test(value) ? value : null;
}
const RAILS = ["solana_pay", "x402", "base_transfer", "matched", "moonpay_card"] as const;
function rail(value: unknown): (typeof RAILS)[number] | null {
  return RAILS.find((r) => r === value) ?? null;
}

// 0012: the keys appear only when there is something to say, so a plain payment's state is unchanged.
const withMatched = (matched: MatchedView | null) => (matched ? { matched } : {});
const withRest = (restRequestId: string | null) => (restRequestId ? { restRequestId } : {});

/** 0012: the matched part of a status result or public request, read defensively. */
function matchedView(value: unknown): MatchedView | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (m.covers !== "full" && m.covers !== "rest") return null;
  return { covers: m.covers, amount: dec(m.amount), signature: sig(m.signature), confirmedAt: iso(m.confirmed_at) };
}

/**
 * Map one status result (from POST /api/v1/status or /status-raw) to a live
 * state. Returns null for results that should not change what is on screen
 * (not_found, invalid, anything unexpected).
 */
export function stateFromStatus(result: unknown, requested: string | null, token: Token): LiveState | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  switch (r.status) {
    case "open":
      return { status: "open" };
    case "paid":
      return {
        status: "paid",
        amount: dec(r.amount_paid) ?? requested,
        payer: key(r.payer),
        signature: sig(r.signature),
        at: iso(r.paid_at),
        rail: rail(r.rail),
        ...withMatched(matchedView(r.matched)), // 0012
      };
    case "underpaid": {
      const amountPaid = dec(r.amount_paid);
      return {
        status: "underpaid",
        amountPaid,
        remaining: requested && amountPaid ? remainingAmount(requested, amountPaid, token) : null,
        payer: key(r.payer),
        signature: sig(r.signature),
        at: iso(r.paid_at),
        ...withRest(requestId(r.rest_request)), // 0012
      };
    }
    case "cancelled":
    case "expired": // W3-C: polling stops here, like cancelled
      return ended(r.status, iso(r.status === "cancelled" ? r.cancelled_at : r.expires_at));
    default:
      return null;
  }
}

/** W3-C: a cancelled or expired state, with when it happened only if known. */
function ended(status: "cancelled" | "expired", at: string | null): LiveState {
  return at ? { status, at } : { status };
}

/** Pick this request's row out of a POST /api/v1/status response. */
export function pickStatusResult(json: unknown, id: string): unknown {
  if (!json || typeof json !== "object") return null;
  const results = (json as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  return results.find((r) => r && typeof r === "object" && (r as { id?: unknown }).id === id) ?? null;
}

export function stateFromRequest(req: PublicRequest): LiveState {
  const token: Token = isToken(req.token) ? req.token : "USDC";
  const paid = req.paid;
  switch (req.status) {
    case "paid":
      return {
        status: "paid",
        amount: dec(paid?.amount) ?? dec(req.amount),
        payer: key(paid?.payer),
        signature: sig(paid?.signature),
        at: iso(paid?.at),
        rail: rail(paid?.rail),
        ...withMatched(matchedView(req.matched)), // 0012
      };
    case "underpaid": {
      const amountPaid = dec(paid?.amount);
      return {
        status: "underpaid",
        amountPaid,
        remaining: amountPaid ? remainingAmount(req.amount, amountPaid, token) : null,
        payer: key(paid?.payer),
        signature: sig(paid?.signature),
        at: iso(paid?.at),
        ...withRest(requestId(req.rest_request?.id)), // 0012
      };
    }
    case "cancelled":
    case "expired": // W3-C
      return ended(req.status, iso(req.status === "cancelled" ? req.cancelled?.at : req.expires_at));
    default:
      return { status: "open" };
  }
}

/**
 * What a hosted Solana request's QR code and "Open in wallet" open: a Solana Pay transaction request
 * served by Owed (app/api/v1/pay/[id]), not the transfer URL. Phantom turns a scanned transfer URL into a
 * plain Send without its reference or memo, so the payment could never be matched; with a transaction
 * request the wallet signs the transaction Owed built, reference included. The transfer URL stays in
 * the API for agents (pay_link, check_payments).
 */
export function walletPayUrl(origin: string, id: string): string {
  return `solana:${origin}/api/v1/pay/${encodeURIComponent(id)}`;
}

export function modelFromRequest(req: PublicRequest, origin: string): PayModel {
  const token: Token = isToken(req.token) ? req.token : "USDC";
  const requester = cleanText(req.requester_name, LIMITS.name);
  const payerName = cleanText(req.payer_name, LIMITS.name);
  const forText = cleanText(req.for, LIMITS.for);
  const note = cleanText(req.note, LIMITS.note);
  const shareLink = `${origin}/r/${encodeURIComponent(req.id)}`;
  // W2-E: only a domain the server verified over DNS can clear a brand word, never a name.
  const verifiedDomain = req.from_domain && req.from_domain_verified_at ? req.from_domain : null;
  const brandWords = unique([
    ...brandWordsFromFlags(req.flags, verifiedDomain),
    ...detectBrandWords([req.requester_name, req.payer_name, req.for, req.note], verifiedDomain),
  ]);
  const flagged = brandWords.length > 0;
  return {
    kind: "hosted",
    chain: req.chain === "base" ? "base" : "solana", // W3-B
    amount: dec(req.amount),
    token,
    asker: requester !== null && !flagged ? requester : shortAddress(req.recipient),
    askerIsAddress: requester === null || flagged,
    claimedName: flagged ? requester : null,
    payerName,
    forText,
    note,
    recipient: req.recipient,
    // W3-B: Base requests open their EIP-681 link. Solana: the transaction request (see walletPayUrl).
    solanaPayUrl: req.chain === "base" ? (req.pay_url ?? req.solana_pay_url ?? "") : walletPayUrl(origin, req.id),
    shareLink,
    agentPrompt: `Use the Owed plugin in PayBox to pay ${shareLink}`,
    x402Url: token === "USDC" && req.id.length === 12 ? `${origin}/x/${encodeURIComponent(req.id)}` : null,
    brandWords,
    initial: stateFromRequest(req),
    poll: { endpoint: "/api/v1/status", id: req.id },
    expiresAt: iso(req.expires_at), // W3-C
    ...(requestId(req.rest_of) && { restOf: requestId(req.rest_of) }), // 0012
    fiat: token === "USDC" ? fiatView(req.fiat, dec(req.amount)) : null, // local-currency asks
  };
}

export function modelFromTransfer(t: TransferRequest, origin: string): PayModel {
  const requester = cleanText(t.label, LIMITS.name);
  const forText = cleanText(t.message, LIMITS.for);
  const brandWords = detectBrandWords([t.label, t.message]);
  const flagged = brandWords.length > 0;
  return {
    kind: "stateless",
    chain: "solana", // W3-B
    amount: t.amount,
    token: t.token,
    asker: requester !== null && !flagged ? requester : shortAddress(t.recipient),
    askerIsAddress: requester === null || flagged,
    claimedName: flagged ? requester : null,
    payerName: null,
    forText,
    note: null,
    recipient: t.recipient,
    solanaPayUrl: t.raw,
    shareLink: `${origin}/p?u=${encodeURIComponent(t.raw)}`,
    // pay_link takes the solana: URL directly; it may not know /p links.
    agentPrompt: `Use the Owed plugin in PayBox to pay ${t.raw}`,
    x402Url: null,
    brandWords,
    initial: { status: "open" },
    poll: t.references.length > 0 ? { endpoint: "/api/v1/status-raw", solanaPayUrl: t.raw } : null,
  };
}

export interface Headline {
  /** "Raj is asking Priya for" */
  lead: string;
  /** "Raj asked Priya for", once the request is settled. */
  past: string;
  /** "15 USDC" */
  amount: string;
}

export function headline(model: Pick<PayModel, "asker" | "payerName" | "amount" | "token">): Headline {
  const who = model.payerName ?? "you";
  const tail = model.amount === null ? " a payment in" : "";
  return {
    lead: `${model.asker} is asking ${who} for${tail}`,
    past: `${model.asker} asked ${who} for${tail}`,
    amount: model.amount === null ? model.token : formatAmount(model.amount, model.token),
  };
}

/**
 * Page and preview title. A flagged request never echoes the requester's
 * name, so "MoonPay Support" can't title its own preview card.
 */
export function pageTitle(model: Pick<PayModel, "asker" | "amount" | "token" | "brandWords"> & { fiat?: FiatView | null }): string {
  const what = model.fiat
    ? `${model.fiat.amount} (${model.fiat.usdc})`
    : model.amount === null ? `a payment in ${model.token}` : formatAmount(model.amount, model.token);
  if (model.brandWords.length > 0) return `Payment request for ${what}`;
  return `${model.asker} is asking you for ${what}`;
}

/** Preview text under the title: amount, quoted reason, how to pay. */
export function pageDescription(model: Pick<PayModel, "amount" | "token" | "forText" | "brandWords"> & { initial?: LiveState; chain?: PayModel["chain"]; fiat?: FiatView | null }): string {
  // W3-C: a cancelled or expired request's preview never invites a payment.
  if (model.initial?.status === "cancelled") return "This request was cancelled. Don't send money to it.";
  if (model.initial?.status === "expired") return "This request has expired and no longer takes payments.";
  const how = model.chain === "base" // W3-B
    ? "Pay from any Base wallet, or with your AI agent in PayBox."
    : "Pay with any Solana wallet, or with your AI agent in PayBox.";
  if (model.amount === null) return how;
  const amount = model.fiat ? `${model.fiat.amount} = ${model.fiat.usdc} (rate locked ${model.fiat.lockedAt})` : formatAmount(model.amount, model.token);
  if (model.forText && model.brandWords.length === 0) return `${amount} for \u201c${model.forText}\u201d. ${how}`;
  return `${amount}. ${how}`;
}
