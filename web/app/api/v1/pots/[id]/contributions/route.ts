import { ContributionBody, type PotContributionResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { isPotId } from "@/lib/ids";
import { contributionAmount, getPot, mintContribution, potAmount, requireContributionSlot, requireOpen } from "@/lib/pots";
import { toPublic } from "@/lib/requests";
import { requireNotSanctioned } from "@/lib/sanctions";
import { requireSolMinimum } from "@/lib/sol-minimum";

export const runtime = "nodejs";

/**
 * POST /api/v1/pots/:id/contributions {amount?} — F7: mint one contribution, an ordinary request with a fresh
 * reference paying the pot's recipient (201, the GET /api/v1/requests/:id shape plus `pot`). amount defaults to the
 * pot's suggested amount; a pot that takes only fixed amounts accepts only those. Refuses a pot past its deadline.
 * The board mints one per click (never on render) and pay_link right before it proposes; rate limited per client
 * per pot, per pot and per day so nobody can flood rows.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/pots/[id]/contributions">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isPotId(id)) throw new ApiError("invalid_input", "id must be a 14-character Owed pot id");
    const body = ContributionBody.parse(await readJson(req));
    const pot = await getPot(id);
    if (!pot) throw new ApiError("not_found", "no pot with this id");
    requireOpen(pot);
    const base = baseUrl(req);
    const amount = contributionAmount(pot, body.amount == null ? null : potAmount(body.amount, pot.token, "amount"), base);
    requireNotSanctioned(pot.recipient); // W2-E: the list may have changed since the pot was made
    if (pot.token === "SOL") await requireSolMinimum(pot.recipient, amount, "amount");
    await requireContributionSlot(req, pot.id);
    const row = await mintContribution(pot, amount, body.source);
    const res = toPublic(row, base) as PotContributionResponse;
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
