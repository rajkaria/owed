import bs58 from "bs58";

// Solana Pay transfer requests (https://docs.solanapay.com/spec):
// solana:<recipient>?amount=&spl-token=&reference=&label=&message=&memo=

export interface TransferRequest {
  recipient: string;
  amount?: string; // decimal token units, as in the spec (not atomic)
  splToken?: string; // mint; absent = SOL
  references: string[];
  label?: string;
  message?: string;
  memo?: string;
}

export class SolanaPayError extends Error {}

const MAX_URL_LENGTH = 2048;
const MAX_REFERENCES = 8;

/** True for a base58 string that decodes to exactly 32 bytes. */
export function isSolanaAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export function buildTransferUrl(r: TransferRequest): string {
  const params: string[] = [];
  if (r.amount !== undefined) params.push(`amount=${r.amount}`);
  if (r.splToken) params.push(`spl-token=${r.splToken}`);
  for (const ref of r.references) params.push(`reference=${ref}`);
  if (r.label) params.push(`label=${encodeURIComponent(r.label)}`);
  if (r.message) params.push(`message=${encodeURIComponent(r.message)}`);
  if (r.memo) params.push(`memo=${encodeURIComponent(r.memo)}`);
  return `solana:${r.recipient}${params.length ? `?${params.join("&")}` : ""}`;
}

/**
 * Parse a Solana Pay transfer request. Throws SolanaPayError with a message that can
 * be shown to the user for anything else, including transaction requests (solana:https://…).
 */
export function parseTransferUrl(input: string): TransferRequest {
  const url = input.trim();
  if (url.length > MAX_URL_LENGTH) throw new SolanaPayError("link is too long");
  if (!/^solana:/i.test(url)) throw new SolanaPayError("not a Solana Pay link (must start with solana:)");
  const body = url.slice("solana:".length);
  const q = body.indexOf("?");
  const path = decodeURIComponent(q === -1 ? body : body.slice(0, q));
  if (/^https?:/i.test(path) || path.includes("/")) {
    throw new SolanaPayError("this is a Solana Pay transaction request (checkout link); only transfer links are supported");
  }
  if (!isSolanaAddress(path)) throw new SolanaPayError("recipient is not a valid Solana address");

  const out: TransferRequest = { recipient: path, references: [] };
  const query = q === -1 ? "" : body.slice(q + 1);
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    let value: string;
    try {
      value = decodeURIComponent((eq === -1 ? "" : pair.slice(eq + 1)).replace(/\+/g, "%20"));
    } catch {
      throw new SolanaPayError(`malformed ${key} parameter`);
    }
    switch (key) {
      case "amount":
        if (out.amount !== undefined) throw new SolanaPayError("amount appears more than once");
        if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new SolanaPayError("amount must be a plain decimal");
        out.amount = value;
        break;
      case "spl-token":
        if (out.splToken !== undefined) throw new SolanaPayError("spl-token appears more than once");
        if (!isSolanaAddress(value)) throw new SolanaPayError("spl-token is not a valid mint address");
        out.splToken = value;
        break;
      case "reference":
        if (!isSolanaAddress(value)) throw new SolanaPayError("reference is not a valid 32-byte key");
        if (out.references.length >= MAX_REFERENCES) throw new SolanaPayError("too many reference keys");
        out.references.push(value);
        break;
      case "label":
        out.label = value;
        break;
      case "message":
        out.message = value;
        break;
      case "memo":
        out.memo = value;
        break;
      default:
        break; // unknown keys are ignored, per spec
    }
  }
  return out;
}
