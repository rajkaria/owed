import { CashOutStatusBody, type CashOutResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { cashOutStatus, defaultCashOutDeps, NOT_ON, toPublicCashOut } from "@/lib/moonpay/cash-out";
import { clientIp, take } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Each status read may ask MoonPay once: generous for a person polling, small for a script. */
const LIMITS = { perIp: 120, windowSeconds: 600 } as const;

async function status(req: Request, id: string, wallet: unknown): Promise<Response> {
  const deps = defaultCashOutDeps();
  if (!deps.sell && !deps.enterprise) throw new ApiError("upstream_unavailable", NOT_ON.replace(", so nothing was set up", ""));
  const { wallet: w } = CashOutStatusBody.parse({ wallet });
  const slot = await take([{ key: `cashout:status:ip:${clientIp(req)}`, max: LIMITS.perIp, windowSeconds: LIMITS.windowSeconds, scope: "ip" }]);
  if (!slot.allowed) throw new ApiError("rate_limited", "too many cash-out checks from here; wait a few minutes", { "Retry-After": String(slot.retryAfterSeconds ?? 120) });
  const result = await cashOutStatus(id, w, deps);
  const res: CashOutResponse = toPublicCashOut(result.row, {
    origin: baseUrl(req),
    sell: deps.sell,
    depositAddress: result.depositAddress,
    problem: result.problem,
    account: result.account,
  });
  return json(res);
}

/**
 * GET /api/v1/cash-out/<id>?wallet=<wallet> — F4: where a cash-out stands. Re-reads the MoonPay sale for this cash-out
 * (GET /v3/sell_transactions/ext/<id>, secret key) and checks it sells usdc_sol, exactly this amount, refunding this
 * wallet; deposit_address is set only while MoonPay says waitingForDeposit for that very sale and the address came from
 * MoonPay's signed webhook for it (Enterprise: the wallet-signed liquidation address, re-checked against MoonPay's
 * answer read now). `problem` says why no address is released. Another wallet's cash-out reads as 404.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/v1/cash-out/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    return await status(req, id, new URL(req.url).searchParams.get("wallet") ?? undefined);
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** POST /api/v1/cash-out/<id> with {wallet}: the same as GET, for clients that keep the wallet out of URLs. */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/cash-out/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    const body = await readJson(req);
    return await status(req, id, body && typeof body === "object" ? (body as { wallet?: unknown }).wallet : undefined);
  } catch (e) {
    return toErrorResponse(e);
  }
}
