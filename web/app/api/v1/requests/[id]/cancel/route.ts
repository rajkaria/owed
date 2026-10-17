import { CancelBody, type CancelResponse } from "@/lib/contract";
import { cancelRequest } from "@/lib/cancel";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { toPublic } from "@/lib/requests";

export const runtime = "nodejs";

/**
 * POST /api/v1/requests/:id/cancel — cancel a request, proven by the recipient's wallet (W3-C).
 * Body: {recipient, signed_message, signature}. The message is "Owed cancel <id> for <recipient> at <ISO time>",
 * signed by the wallet the request pays (PayBox request_wallet_sign, op solanaMessage), at most 5 minutes old,
 * usable once. A paid request can't be cancelled; cancelling twice returns the request with already_cancelled.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/requests/[id]/cancel">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isRequestId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed id");
    const body = CancelBody.parse(await readJson(req));
    const { row, already } = await cancelRequest({
      id,
      recipient: body.recipient,
      signedMessage: body.signed_message,
      signature: body.signature,
    });
    const res: CancelResponse = { ...toPublic(row, baseUrl(req)), already_cancelled: already };
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
