import { PlanUsedBody, planId } from "@/lib/contract";
import { ApiError, json, readJson, toErrorResponse } from "@/lib/http";
import { markPlanUsed } from "@/lib/plans";
import { clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * POST /api/v1/plans/:id/used — F2: the plan's final pay_link / pay_all returned a payment proposal. Body: {sender}.
 * 200 {plan_id, used_at, already_used}; 404 when no plan has this id for this sender (so ids reveal nothing). Marks only
 * that a proposal followed; a plan counts as paid from the requests table alone (GET /api/v1/plans/stats).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/plans/[id]/used">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!planId.safeParse(id).success) throw new ApiError("invalid_input", "id must be a 12-character Owed plan id");
    const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new ApiError("invalid_input", "content-type must be application/json");
    const { sender } = PlanUsedBody.parse(await readJson(req));
    return json(await markPlanUsed(id, sender, clientIp(req)));
  } catch (e) {
    return toErrorResponse(e);
  }
}
