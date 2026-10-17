import { baseUrl, errorResponse, toErrorResponse } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { clientIp, takeX402Attempt } from "@/lib/ratelimit";
import { getRequest, settleFromChain, type RequestRow } from "@/lib/requests";
import { waitForSettlement } from "@/lib/x402/chain";
import { makeFacilitator } from "@/lib/x402/facilitator";
import { handleX402, type X402Deps } from "@/lib/x402/handler";
import { store } from "@/lib/x402/store";
import { EXPOSED_HEADERS } from "@/lib/x402/wire";

export const runtime = "nodejs";
// Settlement submits a transaction and waits for the chain; keep well under Vercel's limit.
export const maxDuration = 60;

function deps(req: Request): X402Deps {
  return {
    load: getRequest,
    async refresh(row: RequestRow, budgetMs: number) {
      try {
        [row] = await settleFromChain([row], { deadline: Date.now() + budgetMs });
      } catch {
        // Chain unreachable: the stored state stands; the lock still stops a double x402 payment.
      }
      return row;
    },
    facilitator: makeFacilitator(),
    store,
    waitForSettlement: (signature, t, deadline) => waitForSettlement(signature, t, { deadline }),
    now: Date.now,
    limitAttempt: (requestId) => takeX402Attempt(requestId, clientIp(req)), // W2-E
  };
}

async function handle(req: Request, ctx: RouteContext<"/x/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isRequestId(id)) return errorResponse("invalid_input", "id must be a 12-character Owed id");
    return await handleX402(req, id, baseUrl(req), deps(req));
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** GET|POST /x/:id — pay an Owed request over x402 (USDC on Solana mainnet; W3-B: USDC on Base for Base requests). */
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
