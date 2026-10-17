import { ApiError, json, toErrorResponse } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { getRequest, settleFromChain, toPublic } from "@/lib/requests";

export const runtime = "nodejs";

/** Chain budget for a single read; pay_link relies on this to refuse an already-paid link. */
const CHAIN_BUDGET_MS = 2500;

/** GET /api/v1/requests/:id — one request, checked against the chain if still open. */
export async function GET(_req: Request, ctx: RouteContext<"/api/v1/requests/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isRequestId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed id");
    let row = await getRequest(id);
    if (!row) throw new ApiError("not_found", "no request with this id");
    if (row.status === "open" || row.status === "underpaid") {
      try {
        [row] = await settleFromChain([row], { deadline: Date.now() + CHAIN_BUDGET_MS });
      } catch {
        // Serve the stored state; POST /status reports chain outages explicitly.
      }
    }
    return json(toPublic(row));
  } catch (e) {
    return toErrorResponse(e);
  }
}
