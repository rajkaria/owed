import { createHash } from "node:crypto";
import bs58 from "bs58";
import { USDC_MINT, type Token } from "./money";

// A request id commits to where the money goes: it is derived from the payment terms
// (recipient, asset, atomic amount, reference), so this server can't change who gets paid
// or how much without the id, and therefore the link, changing too. The plugin recomputes it
// (plugin/src/request-id.ts) before it proposes a payment; contract/fixtures pin both sides.

const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
/** New ids are 12 chars (about 70 bits). 10-char ids are random ids from before 2026-10-17 02:30 EDT. */
const ID_PATTERN = new RegExp(`^${BASE58}{10}(?:${BASE58}{2})?$`);
export const VERIFIED_ID_LENGTH = 12;

export interface RequestTerms {
  recipient: string;
  token: Token;
  amountAtomic: bigint;
  reference: string;
}

export function requestIdFor(terms: RequestTerms): string {
  const asset = terms.token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256")
    .update(`owed-request:v1\n${terms.recipient}\n${asset}\n${terms.amountAtomic}\n${terms.reference}`, "utf8")
    .digest();
  // The low-order base58 digits are uniform; the leading digit of a 32-byte value is not.
  return bs58.encode(digest).slice(-VERIFIED_ID_LENGTH);
}

export function isRequestId(s: unknown): s is string {
  return typeof s === "string" && ID_PATTERN.test(s);
}

/** Solana Pay reference: 32 random bytes, base58. Any 32 bytes are a valid account key. */
export function newReference(): string {
  return bs58.encode(crypto.getRandomValues(new Uint8Array(32)));
}
