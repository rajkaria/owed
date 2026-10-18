import { CreatePlanBody } from "@/lib/contract";
import { ApiError, json, readJson, toErrorResponse } from "@/lib/http";
import { createPlan } from "@/lib/plans";
import { clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * POST /api/v1/plans — F2: pay_link / pay_all offered a funding plan (the sender's wallet was short). Body:
 * {tool, sender, request_ids, shortfall: {token, atomic}, options: [kind…]}. 201 {plan_id, created_at}; 400 for a bad
 * body, 404 for an unknown request id, 429 over the per-sender, per-client or global hourly cap. No balances, prices or
 * plan arguments are sent or stored (lib/plans.ts). The plugin treats this as best effort: a plan goes out without a
 * plan_id when this is slow or refuses.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new ApiError("invalid_input", "content-type must be application/json");
    const body = CreatePlanBody.parse(await readJson(req));
    return json(await createPlan(body, clientIp(req)), { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
