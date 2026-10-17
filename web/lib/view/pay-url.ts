// Parse a Solana Pay transfer request (`solana:<recipient>?amount=&spl-token=
// &reference=&label=&message=&memo=`) for the stateless /p page.
// Spec: https://docs.solanapay.com/spec. Transaction requests
// (`solana:https://…`) are out of scope and reported as such.

import bs58 from "bs58";
import { TOKEN_DECIMALS, USDC_MINT, toAtomic, type Token } from "./money.ts";

export const MAX_PAY_URL_LENGTH = 2048;

export interface TransferRequest {
  raw: string;
  recipient: string;
  /** Decimal string in token units, or null when the payer chooses. */
  amount: string | null;
  token: Token;
  references: string[];
  label: string | null;
  message: string | null;
  memo: string | null;
}

export type PayUrlError =
  | "missing"
  | "too_long"
  | "not_solana_pay"
  | "transaction_request"
  | "bad_recipient"
  | "bad_amount"
  | "unsupported_token"
  | "bad_reference";

export type PayUrlResult = { ok: true; value: TransferRequest } | { ok: false; error: PayUrlError };

/** True when `value` is base58 that decodes to exactly 32 bytes (a Solana public key). */
export function isPublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function first(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return value === null || value === "" ? null : value;
}

export function parseTransferRequest(input: unknown): PayUrlResult {
  if (typeof input !== "string" || input.trim() === "") return { ok: false, error: "missing" };
  const raw = input.trim();
  if (raw.length > MAX_PAY_URL_LENGTH) return { ok: false, error: "too_long" };
  if (!/^solana:/i.test(raw)) return { ok: false, error: "not_solana_pay" };

  const body = raw.slice("solana:".length);
  if (/^https?(:|%3a)/i.test(body)) return { ok: false, error: "transaction_request" };

  const q = body.indexOf("?");
  const recipient = q === -1 ? body : body.slice(0, q);
  if (!isPublicKey(recipient)) return { ok: false, error: "bad_recipient" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(q === -1 ? "" : body.slice(q + 1));
  } catch {
    return { ok: false, error: "not_solana_pay" };
  }

  const splToken = first(params, "spl-token");
  let token: Token;
  if (splToken === null) token = "SOL";
  else if (splToken === USDC_MINT) token = "USDC";
  else return { ok: false, error: "unsupported_token" };

  const amount = first(params, "amount");
  if (amount !== null) {
    const atomic = toAtomic(amount, TOKEN_DECIMALS[token]);
    if (atomic === null || atomic <= BigInt(0)) return { ok: false, error: "bad_amount" };
  }

  const references = params.getAll("reference");
  if (references.length > 8 || !references.every(isPublicKey)) return { ok: false, error: "bad_reference" };

  return {
    ok: true,
    value: {
      raw,
      recipient,
      amount,
      token,
      references,
      label: first(params, "label"),
      message: first(params, "message"),
      memo: first(params, "memo"),
    },
  };
}

export const PAY_URL_ERROR_TEXT: Record<PayUrlError, string> = {
  missing: "This page needs a Solana Pay link to show. The link you opened is incomplete.",
  too_long: "This payment link is too long to be a normal Solana Pay link.",
  not_solana_pay: "This isn't a Solana Pay link, so there's nothing to pay here.",
  transaction_request:
    "This is a Solana Pay checkout link (a transaction request). Owed shows transfer links only. Open it in your wallet app instead.",
  bad_recipient: "The recipient address in this link isn't a valid Solana address.",
  bad_amount: "The amount in this link isn't a valid positive number.",
  unsupported_token: "This link asks for a token Owed doesn't show yet. Owed pages support USDC and SOL.",
  bad_reference: "The tracking reference in this link is malformed.",
};
