import "server-only";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { sql } from "./db";
import { ApiError } from "./http";

// Proof that the holder of a Solana wallet asked for something: an ed25519 signature over a short,
// human-readable message "<prefix> at <ISO time>". PayBox's request_wallet_sign with
// {op:"solanaMessage", address, message} signs the message's UTF-8 bytes as they are (no off-chain
// header; @moon-x/solana-adapter 0.3.0 `signSolanaMessage`) and returns the signature as hex.
// Wallet adapters (Phantom's signMessage) sign the same bytes and usually hand back base58 or base64.
//
// Used by POST /api/v1/ledger (prefix "Owed ledger access for <recipient>"). W3-C's cancel_request
// reuses it with its own prefix and purpose; the wording is the only thing that changes.

export const SIGNATURE_MAX_AGE_MS = 5 * 60_000;
/** A signer's clock may run a little ahead of ours. */
export const SIGNATURE_MAX_SKEW_MS = 60_000;
export const MAX_SIGNED_MESSAGE_CHARS = 200;
/** Fresh signatures one wallet may spend per purpose per hour. */
export const SIGNATURES_PER_HOUR = 30;

export function ledgerPrefix(recipient: string): string {
  return `Owed ledger access for ${recipient}`;
}

/** "2026-10-17T10:30:00Z": whole seconds, UTC, the form the plugin writes. */
export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/** Strict UTC ISO-8601, optional milliseconds; rejects impossible dates like 02-31. */
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function parseIsoUtc(text: string): number | null {
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const ms = Number((m[7] ?? "").padEnd(3, "0") || 0);
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h
    || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) return null;
  return t;
}

/** The 32-byte public key behind a base58 Solana address, or null. */
export function addressBytes(address: string): Uint8Array | null {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return null;
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** Every 64-byte value a signature string could stand for: hex (PayBox), base58 or base64 (wallet adapters). */
export function signatureCandidates(text: string): Uint8Array[] {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s || s.length > 200) return [];
  const out: Uint8Array[] = [];
  const hex = s.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) out.push(Uint8Array.from(Buffer.from(hex, "hex")));
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) {
    try {
      const b = bs58.decode(s);
      if (b.length === 64) out.push(b);
    } catch {
      // not base58
    }
  }
  if (/^[A-Za-z0-9+/_-]{86}(?:==)?$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 64) out.push(Uint8Array.from(b));
  }
  return out;
}

// Group order L = 2^252 + 27742317777372353535851937790883648493. tweetnacl accepts S and S + L alike;
// requiring S < L gives every valid signature exactly one form.
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
function canonicalS(sig: Uint8Array): boolean {
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]);
  return s < L;
}

// Encodings of the eight small-order points (the y coordinate, sign bit ignored), libsodium's blocklist.
// Nobody holds a key for them, and signatures "from" them can be forged, so they never verify.
const SMALL_ORDER = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];
export function isSmallOrder(publicKey: Uint8Array): boolean {
  const masked = Buffer.from(publicKey);
  masked[31] &= 0x7f;
  const hex = masked.toString("hex");
  return SMALL_ORDER.includes(hex);
}

/** ed25519 over the message's UTF-8 bytes, by the wallet `signer`. Never throws. */
export function verifyMessageSignature(message: string, signature: string, signer: string): boolean {
  const publicKey = addressBytes(signer);
  if (!publicKey || isSmallOrder(publicKey) || typeof message !== "string") return false;
  const bytes = new TextEncoder().encode(message);
  return signatureCandidates(signature).some((sig) => {
    try {
      return canonicalS(sig) && nacl.sign.detached.verify(bytes, sig, publicKey);
    } catch {
      return false;
    }
  });
}

export interface SignedMessageInput {
  /** The exact text that was signed. */
  message: string;
  signature: string;
  /** The wallet that must have signed it. */
  signer: string;
  /** Everything before " at <ISO time>", e.g. ledgerPrefix(recipient). */
  prefix: string;
  now?: number;
}

export interface VerifiedMessage {
  signer: string;
  signedAtMs: number;
  /** sha256 of the exact message: the single-use key. */
  messageHash: string;
}

const bad = (message: string) => new ApiError("invalid_input", message);

/**
 * Wording, freshness (≤5 min old, ≤1 min ahead) and signature, in that order, with a reason the agent
 * can act on. Pure: no I/O. Pair it with spendOnce() so a signature works exactly once.
 */
export function checkSignedMessage({ message, signature, signer, prefix, now = Date.now() }: SignedMessageInput): VerifiedMessage {
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_SIGNED_MESSAGE_CHARS) {
    throw bad(`signed_message must be the exact message you signed (at most ${MAX_SIGNED_MESSAGE_CHARS} characters)`);
  }
  if (!addressBytes(signer)) throw bad("the signer must be a base58 Solana address");
  const lead = `${prefix} at `;
  if (!message.startsWith(lead)) {
    throw bad(`signed_message must read "${prefix} at <time>", exactly as it was given to you to sign`);
  }
  const signedAtMs = parseIsoUtc(message.slice(lead.length));
  if (signedAtMs === null) {
    throw bad(`signed_message must end with a UTC time like ${isoSeconds(now)}`);
  }
  if (now - signedAtMs > SIGNATURE_MAX_AGE_MS) {
    throw bad("this signed message is more than 5 minutes old; sign a fresh one");
  }
  if (signedAtMs - now > SIGNATURE_MAX_SKEW_MS) {
    throw bad("this signed message is dated in the future; sign a fresh one with the current time");
  }
  if (signatureCandidates(signature).length === 0) {
    throw bad("signature must be the 64-byte signature as hex (what PayBox returns), base58 or base64");
  }
  if (!verifyMessageSignature(message, signature, signer)) {
    throw bad(`the signature doesn't match this message for wallet ${signer}; sign the exact message with that wallet`);
  }
  return { signer, signedAtMs, messageHash: createHash("sha256").update(message, "utf8").digest("hex") };
}

/**
 * Spend a verified message once. A second use of the same message (any signature over it) is refused,
 * and so is a wallet signing more than SIGNATURES_PER_HOUR messages for one purpose in an hour.
 * Rows older than 2 hours can't pass the freshness check again, so they are deleted as we go.
 */
export async function spendOnce(purpose: string, verified: VerifiedMessage, limitPerHour: number = SIGNATURES_PER_HOUR): Promise<void> {
  if (!/^[a-z_]{1,32}$/.test(purpose)) throw new Error(`bad signature purpose: ${purpose}`);
  const [row] = await sql(
    `with purge as (
       delete from signature_nonces where used_at < now() - interval '2 hours'
     ), recent as (
       select count(*)::int as n from signature_nonces
        where purpose = $2 and signer = $3 and used_at > now() - interval '1 hour'
     ), inserted as (
       insert into signature_nonces (message_sha256, purpose, signer, signed_at)
       select $1, $2, $3, to_timestamp($4::double precision / 1000) from recent where recent.n < $5
       on conflict (message_sha256) do nothing
       returning 1
     )
     select (select count(*) from inserted)::int as inserted, (select n from recent) as recent`,
    [verified.messageHash, purpose, verified.signer, verified.signedAtMs, limitPerHour],
  );
  if (row?.inserted === "1") return;
  if (Number(row?.recent ?? 0) >= limitPerHour) {
    throw new ApiError("rate_limited", "too many signed requests from this wallet in the last hour; try again later", {
      "Retry-After": "600",
    });
  }
  throw bad("this signature was already used; sign a fresh message to try again");
}

/** checkSignedMessage + spendOnce: what a route calls. */
export async function verifySignedMessage(purpose: string, input: SignedMessageInput): Promise<VerifiedMessage> {
  const verified = checkSignedMessage(input);
  await spendOnce(purpose, verified);
  return verified;
}
