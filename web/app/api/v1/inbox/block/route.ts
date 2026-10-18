import { InboxBlockBody, type InboxBlockResponse } from "@/lib/contract";
import { baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { BLOCK_PURPOSE, blockPrefix, getInbox, parseRequester, setBlocked } from "@/lib/inbox";
import { verifySignedMessage } from "@/lib/verify-signature";

export const runtime = "nodejs";

/**
 * POST /api/v1/inbox/block — F1: a payer hides (or shows again) every request from one requester wallet, the wallet
 * those requests pay. Needs "Owed block <requester> for <payer> at <ISO time>" (or "Owed unblock …") signed by the
 * payer's wallet, at most 5 minutes old, once. Answers with the payer's inbox after the change, so no second
 * signature is needed to see it. Blocking hides; it never cancels a request or stops anyone paying it.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = InboxBlockBody.parse(await readJson(req));
    // The signed text names the requester exactly as sent; the stored form must be that same wallet.
    const requester = parseRequester(body.requester);
    await verifySignedMessage(BLOCK_PURPOSE, {
      message: body.signed_message,
      signature: body.signature,
      signer: body.payer,
      prefix: blockPrefix(body.action, body.requester.trim(), body.payer),
    });
    const outcome = await setBlocked(body.payer, requester, body.action);
    const res: InboxBlockResponse = {
      payer: body.payer, requester, action: body.action, ...outcome,
      inbox: await getInbox(body.payer, { base: baseUrl(req) }),
    };
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
