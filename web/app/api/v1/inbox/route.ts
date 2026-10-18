import { InboxBody, type InboxResponse } from "@/lib/contract";
import { baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { getInbox, INBOX_PURPOSE, inboxPrefix } from "@/lib/inbox";
import { verifySignedMessage } from "@/lib/verify-signature";

export const runtime = "nodejs";

/**
 * POST /api/v1/inbox — F1, what_do_i_owe: the open and underpaid requests addressed to a payer's wallet, oldest first,
 * Base ones apart, with totals per token and chain. Needs "Owed inbox access for <payer> at <ISO time>" signed by that
 * wallet (PayBox request_wallet_sign, op solanaMessage), at most 5 minutes old. Each signed message works once.
 * Requests from requester wallets the payer blocked are left out (POST /api/v1/inbox/block).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = InboxBody.parse(await readJson(req));
    await verifySignedMessage(INBOX_PURPOSE, {
      message: body.signed_message,
      signature: body.signature,
      signer: body.payer,
      prefix: inboxPrefix(body.payer),
    });
    const res: InboxResponse = await getInbox(body.payer, { base: baseUrl(req) });
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
