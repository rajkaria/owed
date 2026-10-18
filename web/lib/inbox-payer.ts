import "server-only";
import { PublicKey } from "@solana/web3.js";
import { ApiError } from "./http";
import { clientIp, take } from "./ratelimit";
import type { PayerRecord } from "./requests";
import { brandFlags } from "./safety";
import { parseSnsName, resolveSnsOnServer, sourceText, type SnsResult } from "./sns";
import { isSolanaAddress } from "./solana-pay";

// F1: who a request is addressed to, as the create routes take it. The payer is a Solana wallet, found one of
// three ways by the requester's agent:
//   {handle, wallet}  an X handle the agent resolved with PayBox resolve_username (Owed can't resolve handles, so the
//                     wallet must come with it; the handle is stored as a label, never as proof);
//   {sns}             an .sns name, which this server resolves on Solana (wallet optional; when given it must match);
//   {wallet}          the payer's wallet itself.
// requester_handle is the requester's own X handle: a label too. The payer's agent checks it with resolve_username
// before paying (pay_link / pay_all say so). Neither is ever part of a request id.

/** X handles: 1–15 of A–Z, a–z, 0–9 and "_", optional leading "@". Stored lower case without "@". */
export const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

/** Payer-addressed creates per requester wallet per hour, and per (requester, payer) pair (QA: inbox spam). */
export const PAYER_ASK_LIMITS = { perRequesterPerHour: 30, perPairPerHour: 10 } as const;
const HOUR = 3600;

const bad = (message: string) => new ApiError("invalid_input", message);

/** The handle as stored ("sam_ok"), null for none; invalid_input naming `field` for anything that isn't one. */
export function parseHandle(input: string | null | undefined, field: string): string | null {
  if (input == null) return null;
  const m = HANDLE_RE.exec(input.trim());
  if (!m) throw bad(`${field}: an X handle is 1 to 15 letters, digits or underscores, like @sam_ok`);
  return m[1]!.toLowerCase();
}

/** What a create body may carry under `payer`. */
export interface PayerInput {
  wallet?: string | null;
  handle?: string | null;
  sns?: string | null;
}

export interface PayerOptions {
  /** Field name used in refusals ("payer", "people.2.payer"). */
  field?: string;
  /** Test seam: resolves an .sns name on Solana. */
  resolve?: (name: string) => Promise<SnsResult>;
}

/**
 * The payer record to store, or null when the body names none. Checks: a base58 wallet that can sign (on the
 * ed25519 curve; a payer signs the payment), not the recipient itself, a well-formed handle, and an .sns name that
 * resolves on Solana to that wallet right now. Throws invalid_input (or upstream_unavailable when Solana can't be
 * read for the name).
 */
export async function requirePayer(input: PayerInput | null | undefined, recipient: string, options: PayerOptions = {}): Promise<PayerRecord | null> {
  if (input == null) return null;
  const field = options.field ?? "payer";
  const handle = parseHandle(input.handle, `${field}.handle`);
  let wallet = input.wallet?.trim() || null;
  let sns: string | null = null;
  if (input.sns != null) {
    const parsed = parseSnsName(input.sns);
    if (!parsed.ok) throw bad(`${field}.sns: ${parsed.message}`);
    const r = await (options.resolve ?? resolveSnsOnServer)(parsed.name);
    if (!r.ok) {
      if (r.code === "unavailable") throw new ApiError("upstream_unavailable", `${field}.sns: ${r.message}`);
      throw bad(`${field}.sns: ${r.message}`);
    }
    if (wallet !== null && r.wallet !== wallet) {
      throw bad(`${field}.sns: ${r.name} points to ${r.wallet} (${sourceText(r.source)}), not to the payer wallet ${wallet}`);
    }
    wallet = r.wallet;
    sns = r.name;
  }
  if (wallet === null) {
    if (handle !== null) throw bad(`${field}.wallet: a handle needs the wallet it belongs to; resolve ${field}.handle with PayBox resolve_username first and pass both`);
    throw bad(`${field}: give the payer's wallet, an .sns name, or a handle with its wallet`);
  }
  if (!isSolanaAddress(wallet)) throw bad(`${field}.wallet: must be the payer's Solana wallet address (base58)`);
  if (!PublicKey.isOnCurve(new PublicKey(wallet).toBytes())) {
    throw bad(`${field}.wallet: must be a wallet that can sign, not a token account or program address`);
  }
  if (wallet === recipient) throw bad(`${field}.wallet: that is the recipient's own wallet; a request can't be addressed to whoever it pays`);
  return { wallet, handle, sns };
}

/** Brand words in the requester's handle ("@paybox_help") flag the request like brand words in its text. */
export function handleFlags(handle: string | null | undefined): string[] {
  return handle ? brandFlags([handle.replace(/_/g, " ")]) : [];
}

/**
 * One payer-addressed create: per requester wallet (the wallet the request pays) and per (requester, payer) pair,
 * per hour, on top of the usual create limits. Throws rate_limited.
 */
export async function requirePayerAskSlot(req: Request, recipient: string, payerWallet: string): Promise<void> {
  const slot = await take([
    { key: `payer-ask:requester:${recipient}`, max: PAYER_ASK_LIMITS.perRequesterPerHour, windowSeconds: HOUR, scope: "requester" },
    { key: `payer-ask:pair:${recipient}:${payerWallet}`, max: PAYER_ASK_LIMITS.perPairPerHour, windowSeconds: HOUR, scope: "pair" },
    { key: `payer-ask:ip:${clientIp(req)}`, max: PAYER_ASK_LIMITS.perRequesterPerHour * 10, windowSeconds: HOUR, scope: "ip" },
  ]);
  if (!slot.allowed) {
    throw new ApiError(
      "rate_limited",
      slot.scope === "pair"
        ? "too many requests addressed to this payer from this wallet in the last hour, try again later"
        : slot.scope === "ip"
          ? "too many addressed requests from this client in the last hour, try again later"
          : "too many addressed requests from this wallet in the last hour, try again later",
      { "Retry-After": String(slot.retryAfterSeconds ?? 60) },
    );
  }
}
