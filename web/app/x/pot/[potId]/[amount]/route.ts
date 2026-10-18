import { baseUrl, errorResponse, toErrorResponse } from "@/lib/http";
import { isPotId } from "@/lib/ids";
import { getPot, mintContribution, requireContributionSlot } from "@/lib/pots";
import { clientIp, takeX402Attempt } from "@/lib/ratelimit";
import { getRequest } from "@/lib/requests";
import { waitForSettlement } from "@/lib/x402/chain";
import { makeFacilitator } from "@/lib/x402/facilitator";
import { handlePotX402, type PotX402Deps, type X402Deps } from "@/lib/x402/handler";
import { store } from "@/lib/x402/store";
import { EXPOSED_HEADERS } from "@/lib/x402/wire";

export const runtime = "nodejs";
// Settlement submits a transaction and waits for the chain; keep well under Vercel's limit.
export const maxDuration = 60;

function deps(req: Request): X402Deps & PotX402Deps {
  return {
    load: getRequest,
    // A contribution minted for this payment a moment ago has nothing to settle from the chain yet.
    refresh: async (row) => row,
    facilitator: makeFacilitator(),
    store,
    waitForSettlement: (signature, t, deadline) => waitForSettlement(signature, t, { deadline }),
    now: Date.now,
    limitAttempt: (potId) => takeX402Attempt(potId, clientIp(req)), // W2-E: per pot and per client IP
    loadPot: getPot,
    async mint(pot, amountAtomic) {
      await requireContributionSlot(req, pot.id);
      return mintContribution(pot, amountAtomic, "web");
    },
  };
}

async function handle(req: Request, ctx: RouteContext<"/x/pot/[potId]/[amount]">): Promise<Response> {
  try {
    const { potId, amount } = await ctx.params;
    if (!isPotId(potId)) return errorResponse("invalid_input", "id must be a 14-character Owed pot id");
    // Next hands the segment over decoded already; an amount is digits and one dot, so nothing else needs decoding.
    return await handlePotX402(req, potId, amount, baseUrl(req), deps(req));
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** GET|POST /x/pot/:potId/:amount — F7: contribute one of a USDC pot's preset amounts over x402. */
export const GET = handle;
export const POST = handle;

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
      "Access-Control-Expose-Headers": EXPOSED_HEADERS,
      "Access-Control-Max-Age": "600",
    },
  });
}
