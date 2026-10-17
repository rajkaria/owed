import { MatchBody, type MatchResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { confirmMatch } from "@/lib/match";
import { toPublic } from "@/lib/requests";

export const runtime = "nodejs";

/**
 * POST /api/v1/requests/:id/match — the recipient attributes a payment that carried no reference (0012).
 * Body: {recipient, transaction, signed_message, signature}. The message is
 * "Owed match <transaction> to <id> for <recipient> at <ISO time>", signed by the wallet the request pays,
 * at most 5 minutes old, usable once. The server re-reads the transaction (exact amount still due, to that
 * recipient, after the request, no Owed reference, not counted elsewhere) before it marks the request paid.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/requests/[id]/match">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isRequestId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed id");
    const body = MatchBody.parse(await readJson(req));
    const { row, already } = await confirmMatch({
      id,
      recipient: body.recipient,
      transaction: body.transaction,
      signedMessage: body.signed_message,
      signature: body.signature,
    });
    const res: MatchResponse = { ...toPublic(row, baseUrl(req)), already_matched: already };
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
