import type { GroupResponse } from "@/lib/contract";
import { isGroupId, loadGroup, toPublicGroup } from "@/lib/groups";
import { ApiError, baseUrl, json, toErrorResponse } from "@/lib/http";

export const runtime = "nodejs";

/** Chain budget for one read, same as GET /requests/:id. */
const CHAIN_BUDGET_MS = 2500;

/** GET /api/v1/groups/:id — a split bill and each share's status, checked against the chain if still open. */
export async function GET(req: Request, ctx: RouteContext<"/api/v1/groups/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isGroupId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed group id");
    const loaded = await loadGroup(id, { deadline: Date.now() + CHAIN_BUDGET_MS });
    if (!loaded) throw new ApiError("not_found", "no group with this id");
    const res: GroupResponse = toPublicGroup(loaded, baseUrl(req));
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
