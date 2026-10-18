import { json, toErrorResponse } from "@/lib/http";
import { planStats } from "@/lib/plans";

export const runtime = "nodejs";

/**
 * GET /api/v1/plans/stats — F2 funding plans: {offered, used, paid, since}. offered: plans pay_link / pay_all handed a
 * short wallet; used: plans whose final call proposed the payment (plan_id echoed); paid: plans whose every request was
 * then paid by the plan's own sender, read from the requests table (lib/plans.ts). Cached for 10 s at the edge.
 */
export async function GET(): Promise<Response> {
  try {
    return json(await planStats(), { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=50" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
