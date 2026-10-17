import { VERIFIED_ID_LENGTH } from "../ids";
import type { Token } from "../money";

/** Where an x402 agent pays this request: USDC requests with a terms-derived (12-char) id. */
export function x402UrlFor(base: string, row: { id: string; token: Token }): string | null {
  return row.token === "USDC" && row.id.length === VERIFIED_ID_LENGTH ? `${base}/x/${row.id}` : null;
}
