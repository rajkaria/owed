import { RouteAccountBody, type VirtualAccountResponse } from "@/lib/contract";
import { errorResponse, json, readJson, toErrorResponse } from "@/lib/http";
import { registerVirtualAccount } from "@/lib/moonpay/accounts";
import { bankRailConfig, fetchAutoramp } from "@/lib/moonpay/enterprise";

export const runtime = "nodejs";

/**
 * POST /api/v1/virtual-accounts — F3 bank rail: register the recipient's MoonPay Enterprise onramp (a named EUR, USD or
 * GBP account that MoonPay turns into USDC on their Solana wallet, https://dev.enterprise.moonpay.com/onramp.md) so
 * their invoices show "Pay by bank transfer". Body {wallet, autoramp_id}: reads the route and answers {step: "sign",
 * message_to_sign, rails}; then {…, signed_message, signature}: re-reads it, checks the wallet signed exactly "Owed bank
 * account <autoramp> details <hash> for <wallet> at <ISO>" (5 minutes, once) and stores only the payer-facing details.
 * 404 while OWED_BANK_RAIL is off.
 */
export async function POST(req: Request): Promise<Response> {
  const config = bankRailConfig();
  if (!config) return errorResponse("not_found", "paying by bank transfer isn't switched on on this Owed server");
  try {
    const body = RouteAccountBody.parse(await readJson(req));
    const out = await registerVirtualAccount(
      { wallet: body.wallet, autorampId: body.autoramp_id, signedMessage: body.signed_message, signature: body.signature },
      { config, fetchAutoramp, now: Date.now },
    );
    const res: VirtualAccountResponse = out.step === "sign"
      ? { step: "sign", message_to_sign: out.messageToSign, sign_by: out.signBy, currency: out.details.currency, rails: out.details.rails }
      : { step: "stored", id: out.account.id, wallet: out.account.wallet, currency: out.account.currency, rails: out.account.details.rails, status: out.account.status, created_at: out.account.createdAt };
    return json(res, { status: out.step === "stored" ? 201 : 200 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
