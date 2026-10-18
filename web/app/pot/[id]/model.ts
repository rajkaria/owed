// View model for a chip-in pot's board (/pot/[id], F7). Pure: the page renders it on the server, the board
// refreshes it in the browser from GET /api/v1/pots/:id, tests call it. Requester text is cleaned again here and
// always rendered quoted; titles and previews never echo it when the pot mentions a brand.

import type { PotResponse } from "@/lib/contract";
import { formatAmount, fromAtomic, groupDigits, isToken, toAtomic, TOKEN_DECIMALS, type Token } from "@/lib/view/money";
import { brandWordsFromFlags, detectBrandWords } from "@/lib/view/request-view";
import { cleanText, LIMITS } from "@/lib/view/text";

export const POT_TITLE_LIMIT = 80;

export interface PotContributionView {
  id: string;
  amount: string;
  payer: string;
  signature: string;
  at: string;
  rail: string;
}

export interface PotAmountView {
  amount: string;
  /** solana:<encoded https link> — the pot's transaction request for this amount (each scan mints a contribution). */
  qr: string;
}

export interface PotView {
  id: string;
  link: string;
  /** Requester-written, cleaned; render quoted. Null when nothing readable is left. */
  title: string | null;
  note: string | null;
  /** The requester's name, or null when there is none or the pot mentions a brand. */
  requester: string | null;
  brandWords: string[];
  token: Token;
  recipient: string;
  raised: string;
  target: string | null;
  count: number;
  /** Basis points of the target raised (capped at 10,000); null without a target. */
  progressBps: number | null;
  deadline: string;
  ended: boolean;
  anyAmount: boolean;
  suggested: string | null;
  /** Fixed amounts (suggested first, then presets), each with its QR code's transaction request. */
  amounts: PotAmountView[];
  x402: Array<{ amount: string; url: string }>;
  contributions: PotContributionView[];
  chainChecked: boolean;
}

export function potView(p: PotResponse, origin: string): PotView {
  const token: Token = isToken(p.token) ? p.token : "USDC";
  const brandWords = Array.from(new Set([...brandWordsFromFlags(p.flags), ...detectBrandWords([p.title, p.note, p.requester_name, p.requester_handle])]));
  const decimals = TOKEN_DECIMALS[token];
  const raised = toAtomic(p.totals.raised, decimals) ?? BigInt(0);
  const target = p.target === null ? null : toAtomic(p.target, decimals);
  return {
    id: p.id,
    link: `${origin}/pot/${encodeURIComponent(p.id)}`,
    title: cleanText(p.title, POT_TITLE_LIMIT),
    note: cleanText(p.note, LIMITS.note),
    requester: brandWords.length > 0 ? null : cleanText(p.requester_name, LIMITS.name),
    brandWords,
    token,
    recipient: p.recipient,
    raised: fromAtomic(raised, decimals),
    target: target === null ? null : fromAtomic(target, decimals),
    count: p.totals.count,
    progressBps: target === null || target <= BigInt(0) ? null : Number(raised >= target ? BigInt(10000) : (raised * BigInt(10000)) / target),
    deadline: p.deadline,
    ended: p.status === "ended",
    anyAmount: p.any_amount,
    suggested: p.suggested,
    amounts: p.links.transaction_request.map((l) => ({ amount: l.amount, qr: l.url })),
    x402: p.links.x402,
    contributions: p.contributions.map((c) => ({ id: c.id, amount: c.amount, payer: c.payer, signature: c.signature, at: c.at, rail: c.rail })),
    chainChecked: p.chain_checked,
  };
}

/**
 * Apply a fresh GET /api/v1/pots/:id. A reply that doesn't parse, belongs to another pot or would show less
 * raised than already on screen is ignored, so a flaky response never un-counts anyone.
 */
export function applyPot(current: PotView, json: unknown, origin: string): PotView {
  const next = parsePot(json);
  if (!next || next.id !== current.id) return current;
  const view = potView(next, origin);
  const decimals = TOKEN_DECIMALS[current.token];
  const before = toAtomic(current.raised, decimals) ?? BigInt(0);
  const after = toAtomic(view.raised, decimals) ?? BigInt(0);
  if (after < before || view.count < current.count) return current;
  return view;
}

/** "42.5 of 100 USDC raised", or "42.5 USDC raised" without a target. */
export function raisedLine(v: Pick<PotView, "raised" | "target" | "token">): string {
  return v.target === null ? `${formatAmount(v.raised, v.token)} raised` : `${groupDigits(v.raised)} of ${formatAmount(v.target, v.token)} raised`;
}

/** "3 contributions" */
export function countLine(count: number): string {
  return `${count} ${count === 1 ? "contribution" : "contributions"}`;
}

/** Page title: never echoes requester text, so a flagged pot can't title its own preview. */
export function potTitle(v: PotView): string {
  return `Chip-in pot: ${raisedLine(v)}`;
}

export function potDescription(v: PotView): string {
  const what = v.title && v.brandWords.length === 0 ? ` for “${v.title}”` : "";
  const how = v.ended ? "This pot has ended." : "Chip in with any Solana wallet, or with your AI agent in PayBox.";
  return `${raisedLine(v)}${what} from ${countLine(v.count)}. ${how}`;
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ID14 = /^[1-9A-HJ-NP-Za-km-z]{14}$/;
const ID12 = /^[1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isDec = (v: unknown): v is string => isStr(v) && v.length <= 40 && DECIMAL.test(v);
const amountLinks = (v: unknown) => Array.isArray(v) && v.every((l) => isObj(l) && isDec(l.amount) && isStr(l.url));

/**
 * The browser's check of a GET /api/v1/pots/:id reply (the board's polling), without shipping zod to the page:
 * every field the view reads, with its type. Null when anything is off.
 */
export function parsePot(json: unknown): PotResponse | null {
  if (!isObj(json) || !isStr(json.id) || !ID14.test(json.id) || !isToken(json.token) || !isStr(json.recipient) || !isStr(json.title)) return null;
  if (!isStr(json.deadline) || (json.status !== "open" && json.status !== "ended") || typeof json.any_amount !== "boolean") return null;
  if (!(json.target === null || isDec(json.target)) || !(json.suggested === null || isDec(json.suggested))) return null;
  if (!(json.note === null || isStr(json.note)) || !(json.requester_name === null || isStr(json.requester_name))) return null;
  if (!Array.isArray(json.flags) || !json.flags.every(isStr) || typeof json.chain_checked !== "boolean") return null;
  const totals = json.totals;
  if (!isObj(totals) || !isDec(totals.raised) || !Number.isSafeInteger(totals.count)) return null;
  const links = json.links;
  if (!isObj(links) || !amountLinks(links.transaction_request) || !amountLinks(links.x402)) return null;
  if (!Array.isArray(json.contributions) || !json.contributions.every((c) => isObj(c) && isStr(c.id) && ID12.test(c.id) && isDec(c.amount)
    && isStr(c.payer) && isStr(c.signature) && isStr(c.at) && isStr(c.rail))) return null;
  return json as unknown as PotResponse;
}

/** A minted contribution as the board shows it, or null when the reply isn't one for this pot, amount and wallet. */
export interface MintedView {
  id: string;
  amount: string;
  /** The plain Solana Pay transfer link (carries this contribution's own reference). */
  transferUrl: string;
  /** Owed's transaction request for this contribution (what the QR and Open in wallet use). */
  walletUrl: string;
  qrSrc: string;
  page: string;
  expiresAt: string | null;
}

export function mintedFrom(json: unknown, view: Pick<PotView, "id" | "recipient" | "token">, asked: string, origin: string): MintedView | null {
  if (!isObj(json) || !isStr(json.id) || !ID12.test(json.id) || json.recipient !== view.recipient || json.token !== view.token) return null;
  if (!isDec(json.amount) || json.amount !== asked || !isStr(json.solana_pay_url) || !json.solana_pay_url.startsWith(`solana:${view.recipient}?`)) return null;
  if (!isObj(json.pot) || json.pot.id !== view.id) return null;
  const id = json.id;
  return {
    id,
    amount: json.amount,
    transferUrl: json.solana_pay_url,
    walletUrl: `solana:${origin}/api/v1/pay/${encodeURIComponent(id)}`,
    qrSrc: `/api/qr/${encodeURIComponent(id)}.svg`,
    page: `${origin}/r/${encodeURIComponent(id)}`,
    expiresAt: isStr(json.expires_at) ? json.expires_at : null,
  };
}

/** A custom amount typed on the board, checked like the API checks it; null when it can't be sent. */
export function customAmount(text: string, token: Token): string | null {
  const trimmed = text.trim();
  const atomic = toAtomic(trimmed, TOKEN_DECIMALS[token]);
  return atomic === null || atomic <= BigInt(0) ? null : fromAtomic(atomic, TOKEN_DECIMALS[token]);
}
