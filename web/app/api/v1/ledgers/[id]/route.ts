import type { GroupLedgerResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, toErrorResponse } from "@/lib/http";
import { isLedgerId, loadLedger, toPublicLedger } from "@/lib/ledgers";

export const runtime = "nodejs";

/** Chain budget for one read, same as GET /groups/:id. */
const CHAIN_BUDGET_MS = 2500;

/**
 * GET /api/v1/ledgers/:id — F6, ledger_balances: members, expenses (with their recorders' signatures), balances, the
 * settle-up a signer would approve now, and every settle-up request with its live status (checked on chain first while
 * still payable). `?chain=0` skips the chain check (the plugin's writes need the members, not the statuses).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/v1/ledgers/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isLedgerId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed ledger id");
    const skipChain = new URL(req.url).searchParams.get("chain") === "0";
    const loaded = await loadLedger(id, skipChain ? null : { deadline: Date.now() + CHAIN_BUDGET_MS });
    if (!loaded) throw new ApiError("not_found", "no ledger with this id");
    const res: GroupLedgerResponse = toPublicLedger(loaded, baseUrl(req));
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
