import { AutopayCreateBody, type AutopayCreateResponse } from "@/lib/contract";
import { json, readJson, toErrorResponse } from "@/lib/http";
import { createAutopayRule } from "@/lib/autopay";

export const runtime = "nodejs";

/**
 * POST /api/v1/autopay — F5: store a payer's autopay rule, "pay <requester wallet>'s requests up to <max> USDC each and
 * <max_month> USDC a month until <date>". Needs
 *   "Owed autopay for <payer>: pay <requester> up to <max> USDC per request and <max_month> USDC per month until <YYYY-MM-DD> (at <ISO time>)"
 * signed by the payer's wallet (PayBox request_wallet_sign, op solanaMessage), at most 5 minutes old, once; the server
 * rebuilds that text from the fields. The rule matches the requester's wallet only (handle and .sns name are labels; an
 * .sns name must point to that wallet now). A new rule for the same requester replaces the live one. Owed never pays:
 * the payer's inbox marks requests eligible, and the payer's agent pays them through PayBox inside PayBox's limits.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = AutopayCreateBody.parse(await readJson(req));
    const res: AutopayCreateResponse = await createAutopayRule(body);
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
