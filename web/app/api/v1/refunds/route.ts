import { CreateRefundBody, type CreateRefundResponse, type RefundsLookupResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { fromAtomic } from "@/lib/money";
import { createRefund, refundSummaries, toPublicRefund, toPublicSummary } from "@/lib/refunds";
import { getRequests } from "@/lib/requests";

export const runtime = "nodejs";

/** Chain reads for a lookup (pending refunds), under the plugin's API timeout. */
const LOOKUP_CHAIN_BUDGET_MS = 2500;

/**
 * POST /api/v1/refunds — F8: refund all or part of a paid request to the wallet that paid it. Body: {request,
 * recipient, amount, signed_message, signature}. The message is "Owed refund <amount> <token> of <request> to <payer>
 * for <recipient> at <ISO time>", signed by the wallet the request pays (PayBox request_wallet_sign, op solanaMessage),
 * at most 5 minutes old, usable once. The reply is a pending refund with a fresh reference: the plugin proposes one
 * unsigned transfer recipient -> payer carrying it, and the refund is confirmed only when the chain shows it.
 * Refunds never add up to more than was paid.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateRefundBody.parse(await readJson(req));
    const out = await createRefund({
      requestId: body.request,
      recipient: body.recipient,
      amount: body.amount,
      signedMessage: body.signed_message,
      signature: body.signature,
    });
    const token = out.request.token;
    const left = out.paidAtomic - out.refundedAtomic - out.pendingAtomic;
    const res: CreateRefundResponse = {
      ...toPublicRefund(out.refund, baseUrl(req)),
      paid: fromAtomic(out.paidAtomic, token),
      refunded: fromAtomic(out.refundedAtomic, token),
      pending: fromAtomic(out.pendingAtomic, token),
      refundable: fromAtomic(left > 0n ? left : 0n, token),
    };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

/**
 * GET /api/v1/refunds?requests=a,b,c — F8: each request's refunds (1 to 20 ids): what was paid, refunded, waiting to
 * land and still refundable. Pending refunds are checked on chain first. Public, like a request's status.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const raw = new URL(req.url).searchParams.get("requests") ?? "";
    const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length < 1 || ids.length > 20) throw new ApiError("invalid_input", "requests must list 1 to 20 Owed request ids, comma-separated");
    const bad: string | undefined = ids.find((id: string) => !isRequestId(id));
    if (bad !== undefined) throw new ApiError("invalid_input", `requests: ${String(bad).slice(0, 20)} isn't an Owed request id`);
    const byId = await getRequests(ids);
    const rows = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const { summaries, chainChecked } = await refundSummaries(rows, { deadline: Date.now() + LOOKUP_CHAIN_BUDGET_MS, timeoutMs: LOOKUP_CHAIN_BUDGET_MS });
    const res: RefundsLookupResponse = {
      requests: summaries.map(toPublicSummary),
      not_found: ids.filter((id) => !byId.has(id)),
      chain_checked: chainChecked,
    };
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
