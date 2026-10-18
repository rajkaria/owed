import { RouteAccountBody, type CashOutAccountResponse } from "@/lib/contract";
import { errorResponse, json, readJson, toErrorResponse } from "@/lib/http";
import { registerCashOutAccount } from "@/lib/moonpay/accounts";
import { enterpriseConfig, fetchAutoramp } from "@/lib/moonpay/enterprise";

export const runtime = "nodejs";

/**
 * POST /api/v1/cash-out/accounts — F4 Enterprise path: register the wallet's MoonPay Enterprise offramp (its persistent
 * liquidation address, https://dev.enterprise.moonpay.com/offramp.md) for cash_out. Body {wallet, autoramp_id}: reads
 * the route from MoonPay and answers {step: "sign", message_to_sign}. Body {wallet, autoramp_id, signed_message,
 * signature}: re-reads it, checks the wallet signed exactly "Owed cash-out account <autoramp> to <liquidation address>
 * for <wallet> at <ISO>" (5 minutes, once) and stores it. 404 while OWED_MOONPAY_ENTERPRISE is off.
 */
export async function POST(req: Request): Promise<Response> {
  const config = enterpriseConfig();
  if (!config) return errorResponse("not_found", "MoonPay Enterprise cash-out isn't switched on on this Owed server");
  try {
    const body = RouteAccountBody.parse(await readJson(req));
    const out = await registerCashOutAccount(
      { wallet: body.wallet, autorampId: body.autoramp_id, signedMessage: body.signed_message, signature: body.signature },
      { config, fetchAutoramp, now: Date.now },
    );
    const res: CashOutAccountResponse = out.step === "sign"
      ? { step: "sign", message_to_sign: out.messageToSign, sign_by: out.signBy, liquidation_address: out.liquidation, currency: out.currency, payout_rail: out.rail }
      : {
        step: "stored", id: out.account.id, wallet: out.account.wallet, liquidation_address: out.account.liquidationAddress,
        currency: out.account.currency, payout_rail: out.account.payoutRail, status: out.account.status, created_at: out.account.createdAt,
      };
    return json(res, { status: out.step === "stored" ? 201 : 200 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
