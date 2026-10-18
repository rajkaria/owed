import { CreateCashOutBody, type CashOutResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { createCashOut, defaultCashOutDeps, NOT_ON, toPublicCashOut } from "@/lib/moonpay/cash-out";
import { clientIp, take } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Cash-outs a wallet or a client may start: plenty for a person retrying, small for a script. */
const LIMITS = { perWallet: 20, perIp: 60, windowSeconds: 3600 } as const;

/**
 * POST /api/v1/cash-out — F4: start cashing out USDC to the user's bank through MoonPay. Body: {wallet, amount} or
 * {wallet, request_ids} (1 to 20 USDC requests paid to this wallet: their paid amounts after refunds, rounded down to
 * whole cents), optional fiat_currency. 201 with the cash-out and, on the sell widget path, the signed MoonPay sell
 * widget URL (usdc_sol, exactly this amount, refunds to this wallet, externalTransactionId = the cash-out id). Nothing
 * moves here: the deposit address comes later, from MoonPay, through GET /api/v1/cash-out/<id>. 503 "isn't switched
 * on" while MoonPay isn't configured (OWED_MOONPAY_SELL=1 with the standard keys and webhook key, or an Enterprise route).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const deps = defaultCashOutDeps();
    if (!deps.sell && !deps.enterprise) throw new ApiError("upstream_unavailable", NOT_ON);
    const body = CreateCashOutBody.parse(await readJson(req));
    const ip = clientIp(req);
    const slot = await take([
      { key: `cashout:wallet:${body.wallet}`, max: LIMITS.perWallet, windowSeconds: LIMITS.windowSeconds, scope: "wallet" },
      { key: `cashout:ip:${ip}`, max: LIMITS.perIp, windowSeconds: LIMITS.windowSeconds, scope: "ip" },
    ]);
    if (!slot.allowed) throw new ApiError("rate_limited", "too many cash-outs started from here in the last hour; try again later", { "Retry-After": String(slot.retryAfterSeconds ?? 600) });
    const created = await createCashOut(
      { wallet: body.wallet, amount: body.amount, requestIds: body.request_ids, fiatCurrency: body.fiat_currency },
      deps,
    );
    const res: CashOutResponse = toPublicCashOut(created.row, {
      origin: baseUrl(req),
      sell: deps.sell,
      account: created.account,
      requestsTotalAtomic: created.requestsTotalAtomic,
    });
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
