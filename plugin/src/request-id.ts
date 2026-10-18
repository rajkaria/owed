import { createHash } from "node:crypto";
import bs58 from "bs58";
import { USDC_MINT, type Token } from "./money.js";
import { BASE_CAIP2, BASE_USDC, type Chain } from "./evm.js"; // W3-B

// A request id commits to where the money goes. It is derived from the payment terms
// (recipient, asset, atomic amount, reference; for Base also the chain), so the server that stores a request can't
// change who gets paid or how much without the id, and therefore the link, changing too.
// web/lib/ids.ts computes the same value; contract/fixtures pin it on both sides.

const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
/** New ids are 12 chars (about 70 bits). 10-char ids are random ids from before 2026-10-17 02:30 EDT. */
export const REQUEST_ID_RE = new RegExp(`^${BASE58}{10}(?:${BASE58}{2})?$`);
export const VERIFIED_ID_LENGTH = 12;

export interface RequestTerms {
  recipient: string;
  token: Token;
  amountAtomic: bigint;
  reference: string;
  /** W3-B: absent or "solana" hashes exactly as before, so every Solana id is unchanged. */
  chain?: Chain;
}

export function requestIdFor(terms: RequestTerms): string {
  const asset = terms.token === "SOL" ? "SOL" : USDC_MINT;
  // W3-B: a Base request names its network and Base USDC, so it can never share an id with a Solana one.
  const preimage = terms.chain === "base"
    ? `owed-request:v1\n${BASE_CAIP2}\n${terms.recipient}\n${BASE_USDC}\n${terms.amountAtomic}\n${terms.reference}`
    : `owed-request:v1\n${terms.recipient}\n${asset}\n${terms.amountAtomic}\n${terms.reference}`;
  const digest = createHash("sha256").update(preimage, "utf8").digest();
  // The low-order base58 digits are uniform; the leading digit of a 32-byte value is not.
  return bs58.encode(digest).slice(-VERIFIED_ID_LENGTH);
}

/** True when the id was derived from exactly these terms. Old 10-char ids never verify. */
export function idMatchesTerms(id: string, terms: RequestTerms): boolean {
  return id.length === VERIFIED_ID_LENGTH && requestIdFor(terms) === id;
}

// F7 pots start
// A pot id commits to who the pot pays and in what token: the last 14 base58 characters of
// sha256("owed-pot:v1\n" recipient "\n" asset "\n" nonce), asset "SOL" or the USDC mint, nonce the 32 random bytes
// (base58) Owed's server minted and returns with the pot. web/lib/ids.ts computes the same value; contract/fixtures
// pin both sides. pay_link refuses a pot whose id doesn't hash its recipient, token and nonce.
export const POT_ID_LENGTH = 14;
export const POT_ID_RE = new RegExp(`^${BASE58}{${POT_ID_LENGTH}}$`);

export interface PotTerms {
  recipient: string;
  token: Token;
  nonce: string;
}

export function potIdFor(terms: PotTerms): string {
  const asset = terms.token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256").update(`owed-pot:v1\n${terms.recipient}\n${asset}\n${terms.nonce}`, "utf8").digest();
  return bs58.encode(digest).slice(-POT_ID_LENGTH);
}

/** True when the id was derived from exactly these terms. */
export function potIdMatchesTerms(id: string, terms: PotTerms): boolean {
  return typeof id === "string" && id.length === POT_ID_LENGTH && potIdFor(terms) === id;
}
// F7 pots end
