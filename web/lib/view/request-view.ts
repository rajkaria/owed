// Turns an API request (/r/[id]) or a raw Solana Pay link (/p) into one view
// model, so both pages render the same UI from the same rules.

import type { PublicRequest } from "../public-api";
import { formatAmount, isToken, remainingAmount, type Token } from "./money.ts";
import { shortAddress } from "./format.ts";
import { LIMITS, cleanText } from "./text.ts";
import type { TransferRequest } from "./pay-url.ts";

export type LiveState =
  | { status: "open" }
  | {
      status: "paid";
      amount: string | null;
      payer: string | null;
      signature: string | null;
      at: string | null;
      rail: "solana_pay" | "x402" | "base_transfer" | null;
    }
  | {
      status: "underpaid";
      amountPaid: string | null;
      remaining: string | null;
      payer: string | null;
      signature: string | null;
      at: string | null;
    }
  | { status: "cancelled" };

export type PollTarget =
  | { endpoint: "/api/v1/status"; id: string }
  | { endpoint: "/api/v1/status-raw"; solanaPayUrl: string };

export interface PayModel {
  kind: "hosted" | "stateless";
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
];
const BRAND_DISPLAY = new Map(BRAND_WORDS);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Brand words found in requester text (case-insensitive, whole words). */
export function detectBrandWords(texts: Array<string | null | undefined>): string[] {
  const haystack = texts.filter(Boolean).join(" \n ").toLowerCase();
  const found: string[] = [];
  for (const [word, display] of BRAND_WORDS) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word).replace(/ /g, "\\s+")}($|[^\\p{L}\\p{N}])`, "u");
    if (re.test(haystack)) found.push(display);
  }
  return found;
}

/** Display names for `brand_word:<w>` flags set by the API. */
export function brandWordsFromFlags(flags: unknown): string[] {
  if (!Array.isArray(flags)) return [];
  const out: string[] = [];
  for (const flag of flags) {
    if (typeof flag !== "string" || !flag.startsWith("brand_word:")) continue;
    const word = flag.slice("brand_word:".length).toLowerCase();
    const display = BRAND_DISPLAY.get(word) ?? cleanText(word, 30);
    if (display) out.push(display);
  }
  return out;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
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
        rail: r.rail === "x402" || r.rail === "solana_pay" ? r.rail : null,
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
      };
    }
    case "cancelled":
      return { status: "cancelled" };
    default:
      return null;
  }
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
        rail: paid?.rail ?? null,
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
      };
    }
    case "cancelled":
      return { status: "cancelled" };
    default:
      return { status: "open" };
  }
}

export function modelFromRequest(req: PublicRequest, origin: string): PayModel {
  const token: Token = isToken(req.token) ? req.token : "USDC";
  const requester = cleanText(req.requester_name, LIMITS.name);
  const payerName = cleanText(req.payer_name, LIMITS.name);
  const forText = cleanText(req.for, LIMITS.for);
  const note = cleanText(req.note, LIMITS.note);
  const shareLink = `${origin}/r/${encodeURIComponent(req.id)}`;
  const brandWords = unique([
    ...brandWordsFromFlags(req.flags),
    ...detectBrandWords([req.requester_name, req.payer_name, req.for, req.note]),
  ]);
  const flagged = brandWords.length > 0;
  return {
    kind: "hosted",
    amount: dec(req.amount),
    token,
    asker: requester !== null && !flagged ? requester : shortAddress(req.recipient),
    askerIsAddress: requester === null || flagged,
    claimedName: flagged ? requester : null,
    payerName,
    forText,
    note,
    recipient: req.recipient,
    solanaPayUrl: req.solana_pay_url ?? req.pay_url, // W3-B: Base requests open their EIP-681 link
    shareLink,
    agentPrompt: `Use the Owed plugin in PayBox to pay ${shareLink}`,
    x402Url: token === "USDC" && req.id.length === 12 ? `${origin}/x/${encodeURIComponent(req.id)}` : null,
    brandWords,
    initial: stateFromRequest(req),
    poll: { endpoint: "/api/v1/status", id: req.id },
  };
}

export function modelFromTransfer(t: TransferRequest, origin: string): PayModel {
  const requester = cleanText(t.label, LIMITS.name);
  const forText = cleanText(t.message, LIMITS.for);
  const brandWords = detectBrandWords([t.label, t.message]);
  const flagged = brandWords.length > 0;
  return {
    kind: "stateless",
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
export function pageTitle(model: Pick<PayModel, "asker" | "amount" | "token" | "brandWords">): string {
  const what = model.amount === null ? `a payment in ${model.token}` : formatAmount(model.amount, model.token);
  if (model.brandWords.length > 0) return `Payment request for ${what}`;
  return `${model.asker} is asking you for ${what}`;
}

/** Preview text under the title: amount, quoted reason, how to pay. */
export function pageDescription(model: Pick<PayModel, "amount" | "token" | "forText" | "brandWords">): string {
  const how = "Pay with any Solana wallet, or with your AI agent in PayBox.";
  if (model.amount === null) return how;
  const amount = formatAmount(model.amount, model.token);
  if (model.forText && model.brandWords.length === 0) return `${amount} for \u201c${model.forText}\u201d. ${how}`;
  return `${amount}. ${how}`;
}
