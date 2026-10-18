import type { RefundResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, toErrorResponse } from "@/lib/http";
import { confirmRefundsSoft, getRefund, isRefundId, toPublicRefund } from "@/lib/refunds";

export const runtime = "nodejs";

const CHAIN_BUDGET_MS = 2500;

/** GET /api/v1/refunds/:id — F8: one refund; a pending one is checked on chain first (confirmed only when it landed). */
export async function GET(req: Request, ctx: RouteContext<"/api/v1/refunds/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isRefundId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed refund id");
    const stored = await getRefund(id);
    if (!stored) throw new ApiError("not_found", "no refund with this id");
    const [refund] = (await confirmRefundsSoft([stored], { deadline: Date.now() + CHAIN_BUDGET_MS, timeoutMs: CHAIN_BUDGET_MS })).refunds;
    const res: RefundResponse = toPublicRefund(refund, baseUrl(req));
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
