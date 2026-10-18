import type { PotResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, toErrorResponse } from "@/lib/http";
import { isPotId } from "@/lib/ids";
import { loadPotBoard, toPublicPot } from "@/lib/pots";

export const runtime = "nodejs";

/**
 * GET /api/v1/pots/:id — F7: the pot and its board. The newest unsettled contributions are settled from the chain
 * first (about 1.5 s at most), so the total counts a payment that just landed; `chain_checked` is false when the
 * chain couldn't be read and the stored state is shown. totals.raised is the sum of what arrived on paid and partly
 * paid contributions; contributions lists them newest first (at most 100).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/v1/pots/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isPotId(id)) throw new ApiError("invalid_input", "id must be a 14-character Owed pot id");
    const board = await loadPotBoard(id);
    if (!board) throw new ApiError("not_found", "no pot with this id");
    const res: PotResponse = toPublicPot(board.pot, baseUrl(req), board);
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
