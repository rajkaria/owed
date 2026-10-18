// Owned by sprint W1-A (plugin-core). Signatures are fixed; bodies are filled by the sprint.
// Solana Pay transfer requests per https://docs.solanapay.com/spec, plus Owed's own links.
import bs58 from "bs58";

import { AmountError, USDC_MINT, toAtomic, type Token } from "./money.js";

export interface TransferRequest {
  recipient: string;
  amount?: string;        // decimal, token units (per Solana Pay spec), not atomic
  splToken?: string;      // mint; absent = SOL
  references: string[];   // base58 32-byte keys
  label?: string;
  message?: string;
  memo?: string;
}

export type ParsedLink =
  | { kind: "transfer"; request: TransferRequest }
  | { kind: "transaction"; link: string }
  | { kind: "owed"; id: string }
  // F7 pots: a pot's board (https://<owed host>/pot/<id>), its bare 14-char id, or Owed's own pot QR code
  // (solana:https://<owed host>/api/v1/pay/<pot id>?amount=X, the amount optional).
  | { kind: "pot"; id: string; amount?: string };

/** Message is shown to the user verbatim. */
export class LinkError extends Error {}

export const MAX_REFERENCES = 5;
/** Longest link accepted or produced. Fits an Owed `/p?u=` link whose texts are all at their caps. */
export const MAX_LINK_CHARS = 4096;

const OWED_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?$/;
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const SINGLE_PARAMS = { amount: "amount", "spl-token": "token", label: "label", message: "message", memo: "memo" } as const;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** USDC when the request names the USDC mint, SOL when it names none. */
export function transferToken(r: TransferRequest): Token {
  return r.splToken === undefined ? "SOL" : "USDC";
}

export function parseLink(input: string, owedHosts: string[]): ParsedLink {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) throw new LinkError("Paste an Owed link, a request id or a solana: payment link.");
  if (text.length > MAX_LINK_CHARS) throw new LinkError("That link is too long to be a payment link.");
  if (OWED_ID_RE.test(text)) return { kind: "owed", id: text };
  if (POT_ID_RE.test(text)) return { kind: "pot", id: text }; // F7 pots

  const hosts = normalizeHosts(owedHosts);
  const scheme = SCHEME_RE.exec(text)?.[1]?.toLowerCase();
  if (scheme === "solana") return parseSolanaUrl(text, hosts);
  if (scheme === "https" || scheme === "http") return parseOwedUrl(text, hosts);
  if (scheme === undefined && hosts.some((h) => text.toLowerCase().startsWith(`${h}/`))) {
    return parseOwedUrl(`https://${text}`, hosts);
  }
  if (isSolanaAddress(text)) {
    throw new LinkError("That is a wallet address, not a payment link. Ask for an Owed link or a solana: link.");
  }
  throw new LinkError("That isn't an Owed link or a Solana Pay link.");
}

export function buildTransferUrl(r: TransferRequest): string {
  validateTransfer(r);
  const params: string[] = [];
  const add = (key: string, value: string) => params.push(`${key}=${encodeURIComponent(value)}`);
  if (r.amount !== undefined) add("amount", r.amount);
  if (r.splToken !== undefined) add("spl-token", r.splToken);
  for (const reference of r.references) add("reference", reference);
  for (const key of ["label", "message", "memo"] as const) {
    const value = r[key];
    if (value) add(key, value.replace(LONE_SURROGATE_RE, "�"));
  }
  const url = `solana:${r.recipient}${params.length ? `?${params.join("&")}` : ""}`;
  if (url.length > MAX_LINK_CHARS) throw new LinkError("The label, message and memo are too long for a payment link.");
  return url;
}

/** 32 random bytes, base58. */
export function newReference(): string {
  return bs58.encode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export function isSolanaAddress(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  const bytes = bs58.decodeUnsafe(s);
  return bytes !== undefined && bytes.length === 32 && bs58.encode(bytes) === s;
}

function normalizeHosts(owedHosts: string[]): string[] {
  if (!Array.isArray(owedHosts)) return [];
  return owedHosts
    .filter((h): h is string => typeof h === "string" && h.trim() !== "")
    .map((h) => {
      const host = h.trim().toLowerCase();
      if (!host.includes("://")) return host.replace(/\/+$/, "");
      try {
        return new URL(host).host;
      } catch {
        return host;
      }
    });
}

function parseOwedUrl(text: string, hosts: string[]): ParsedLink {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new LinkError("That isn't an Owed link or a Solana Pay link.");
  }
  if (!hosts.includes(url.host.toLowerCase())) {
    throw new LinkError(
      hosts[0]
        ? `That web link isn't an Owed link. Owed pays links from ${hosts[0]} and solana: payment links only.`
        : "That web link isn't a Solana Pay link. Owed pays solana: payment links.",
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  // /r/<id> is a request's pay page; /i/<id> is an invoice, whose id is its payment request's id.
  const request = /^\/[ri](?:\/([^/]*))?$/.exec(path);
  if (request) {
    const id = request[1] ?? "";
    if (!OWED_ID_RE.test(id)) throw new LinkError("That Owed link has an invalid request id.");
    return { kind: "owed", id };
  }
  // F7 pots: /pot/<id> is a pot's board.
  const pot = /^\/pot(?:\/([^/]*))?$/.exec(path);
  if (pot) {
    const id = pot[1] ?? "";
    if (!POT_ID_RE.test(id)) throw new LinkError("That Owed pot link has an invalid pot id.");
    return { kind: "pot", id };
  }
  if (path === "/p") {
    const inner = url.searchParams.getAll("u");
    const solanaUrl = inner.length === 1 ? (inner[0] ?? "").trim() : "";
    if (SCHEME_RE.exec(solanaUrl)?.[1]?.toLowerCase() !== "solana") {
      throw new LinkError("That Owed link is missing its payment details.");
    }
    if (solanaUrl.length > MAX_LINK_CHARS) throw new LinkError("That link is too long to be a payment link.");
    return parseSolanaUrl(solanaUrl, hosts);
  }
  throw new LinkError("That Owed link isn't a payment request.");
}

function parseSolanaUrl(text: string, hosts: string[] = []): ParsedLink {
  const rest = text.slice("solana:".length);
  const hash = rest.indexOf("#");
  const body = hash === -1 ? rest : rest.slice(0, hash);
  const question = body.indexOf("?");
  const path = question === -1 ? body : body.slice(0, question);
  const query = question === -1 ? "" : body.slice(question + 1);

  // Transaction request: the pathname is an HTTPS link, URL-encoded when it has its own query.
  if (/^https?(:|%3a)/i.test(path)) {
    // F7 pots: a link pasted without the encoding still carries its own query (Owed's pot QR has ?amount=).
    const link = parseTransactionLink(path.includes("%") || !query ? path : `${path}?${query}`);
    return potTransactionLink(link, hosts) ?? { kind: "transaction", link };
  }

  if (!isSolanaAddress(path)) throw new LinkError("The recipient in this link isn't a valid Solana address.");
  const params = new URLSearchParams(query);
  for (const [key, name] of Object.entries(SINGLE_PARAMS)) {
    if (params.getAll(key).length > 1) throw new LinkError(`This link has more than one ${name}.`);
  }

  const request: TransferRequest = { recipient: path, references: params.getAll("reference") };
  const amount = params.get("amount");
  if (amount !== null) request.amount = amount;
  const splToken = params.get("spl-token");
  if (splToken !== null) request.splToken = splToken;
  for (const key of ["label", "message", "memo"] as const) {
    const value = params.get(key);
    if (value) request[key] = value;
  }
  validateTransfer(request);
  return { kind: "transfer", request };
}

// F7 pots start
const POT_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{14}$/;
const AMOUNT_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Owed's own pot QR code: https://<owed host>/api/v1/pay/<14-char pot id>, optionally ?amount=<decimal>. Anything else
 * (every other transaction request, Owed's request ones included) stays a transaction request, which tools refuse.
 */
function potTransactionLink(link: string, hosts: string[]): ParsedLink | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!hosts.includes(url.host.toLowerCase())) return null;
  const m = /^\/api\/v1\/pay\/([^/]+)\/?$/.exec(url.pathname);
  if (!m || !POT_ID_RE.test(m[1]!)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((k) => k !== "amount")) throw new LinkError("That Owed pot link has parameters Owed doesn't recognise. Use the pot's QR code or board link as shared.");
  const amounts = url.searchParams.getAll("amount");
  if (amounts.length > 1) throw new LinkError("This link has more than one amount.");
  const amount = amounts[0];
  if (amount !== undefined && (amount.length > 40 || !AMOUNT_RE.test(amount))) throw new LinkError("The amount in this pot link isn't a decimal number.");
  return amount === undefined ? { kind: "pot", id: m[1]! } : { kind: "pot", id: m[1]!, amount };
}
// F7 pots end

function parseTransactionLink(path: string): string {
  let link: string;
  try {
    link = path.includes("%") ? decodeURIComponent(path) : path;
  } catch {
    throw new LinkError("That Solana Pay checkout link is malformed.");
  }
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new LinkError("That Solana Pay checkout link is malformed.");
  }
  if (url.protocol !== "https:") throw new LinkError("Solana Pay checkout links must use HTTPS.");
  return link;
}

function validateTransfer(r: TransferRequest): void {
  if (!isSolanaAddress(r.recipient)) throw new LinkError("The recipient in this link isn't a valid Solana address.");
  if (r.splToken !== undefined && r.splToken !== USDC_MINT) throw new LinkError("Owed pays USDC or SOL links only.");
  if (r.amount !== undefined) {
    try {
      toAtomic(r.amount, transferToken(r));
    } catch (e) {
      if (e instanceof AmountError) throw new LinkError(`The amount in this link isn't valid. ${e.message}`);
      throw e;
    }
  }
  if (!Array.isArray(r.references)) throw new LinkError("A reference in this link isn't a valid 32-byte Solana key.");
  if (r.references.length > MAX_REFERENCES) throw new LinkError(`This link has more than ${MAX_REFERENCES} references.`);
  for (const reference of r.references) {
    if (!isSolanaAddress(reference)) throw new LinkError("A reference in this link isn't a valid 32-byte Solana key.");
  }
}
