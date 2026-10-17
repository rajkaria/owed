import "server-only";
import { transaction } from "./db";
import { ApiError } from "./http";
import { COLUMNS, fromRow, getRequest, settleFromChain, type RequestRow } from "./requests";
import type { RpcOptions } from "./solana";
import { checkSignedMessage, spendOnce } from "./verify-signature";
import { LOCK_TTL_SECONDS, SETTLED_GIVE_UP_SECONDS } from "./x402/store";

// W3-C: cancel a request, proven by the recipient's own wallet. The wallet the request pays signs
// "Owed cancel <id> for <recipient> at <ISO time>" (PayBox request_wallet_sign, op solanaMessage); the
// signature is checked with W2-D's verifier (ed25519, at most 5 minutes old, single use) and kept on the row,
// so anyone can check later that the cancellation came from that wallet.
//
// Rules: only the recipient can cancel; a paid or partly paid request can't be cancelled (the chain is read
// first, so a payment the database hasn't seen yet still counts); cancelling twice changes nothing; an x402
// payment being settled right now blocks the cancel until it lands or fails.

export const CANCEL_PURPOSE = "cancel";
/** Chain read before cancelling: leaves room under the plugin's 7 s API timeout. */
export const CANCEL_CHAIN_BUDGET_MS = 3000;

export function cancelPrefix(id: string, recipient: string): string {
  return `Owed cancel ${id} for ${recipient}`;
}

export interface CancelInput {
  id: string;
  recipient: string;
  signedMessage: string;
  signature: string;
  now?: number;
}

export interface CancelOutcome {
  row: RequestRow;
  /** It was already cancelled before this call; nothing changed. */
  already: boolean;
}

const refuse = (message: string) => new ApiError("invalid_input", message);

function refusePaid(row: RequestRow): ApiError {
  return row.status === "paid"
    ? refuse("this request is already paid, so it can't be cancelled")
    : refuse("this request already received a partial payment, so it can't be cancelled");
}

export async function cancelRequest(input: CancelInput, rpc: RpcOptions = { deadline: Date.now() + CANCEL_CHAIN_BUDGET_MS }): Promise<CancelOutcome> {
  const row = await getRequest(input.id);
  if (!row) throw new ApiError("not_found", "no request with this id");
  if (row.recipient !== input.recipient) {
    throw refuse("only the wallet this request pays can cancel it, and that is not this recipient");
  }
  // Wording, freshness and the signature by the request's own recipient; then spend it, so a replay never works.
  const verified = checkSignedMessage({
    message: input.signedMessage,
    signature: input.signature,
    signer: row.recipient,
    prefix: cancelPrefix(row.id, row.recipient),
    now: input.now,
  });
  await spendOnce(CANCEL_PURPOSE, verified);

  if (row.status === "cancelled") return { row, already: true };
  if (row.status === "paid" || row.status === "underpaid") throw refusePaid(row);

  // A payment may have landed since the last status check. If the chain can't be read, don't guess.
  let checked: RequestRow;
  try {
    [checked] = await settleFromChain([row], rpc);
  } catch {
    throw new ApiError("upstream_unavailable", "Solana couldn't be read to confirm this request is unpaid; sign a fresh message and try again shortly");
  }
  if (checked.status === "paid" || checked.status === "underpaid") throw refusePaid(checked);
  if (checked.status === "cancelled") return { row: checked, already: true };

  // Lock the row (x402's lock takes the same one), then cancel unless an x402 settlement is in flight.
  const [, updated] = await transaction([
    { text: `select id from requests where id = $1 for update`, params: [row.id] },
    {
      text: `update requests
                set status = 'cancelled', cancelled_at = now(), cancel_message = $2, cancel_signature = $3
              where id = $1 and status = 'open'
                and not exists (
                  select 1 from x402_receipts x
                   where x.request_id = $1
                     and ((x.state in ('settling', 'unknown') and x.created_at > now() - make_interval(secs => $4::int))
                       or (x.state = 'settled' and x.created_at > now() - make_interval(secs => $5::int))))
              returning ${COLUMNS}`,
      params: [row.id, input.signedMessage, input.signature.trim(), LOCK_TTL_SECONDS, SETTLED_GIVE_UP_SECONDS],
    },
  ]);
  if (updated.length > 0) return { row: fromRow(updated[0]), already: false };

  const fresh = (await getRequest(row.id)) ?? checked;
  if (fresh.status === "cancelled") return { row: fresh, already: true };
  if (fresh.status === "paid" || fresh.status === "underpaid") throw refusePaid(fresh);
  throw new ApiError(
    "rate_limited",
    "an x402 payment for this request is being settled right now; wait a minute, then check the request before cancelling",
    { "Retry-After": "60" },
  );
}
