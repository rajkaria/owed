import { AutopayRevokeBody, type AutopayRevokeResponse } from "@/lib/contract";
import { json, readJson, toErrorResponse } from "@/lib/http";
import { revokeAutopayRule } from "@/lib/autopay";

export const runtime = "nodejs";

/**
 * POST /api/v1/autopay/revoke — F5: end one of a payer's autopay rules. Needs "Owed autopay revoke <rule id> for <payer>
 * at <ISO time>" signed by the payer's wallet, at most 5 minutes old, once. Revoking twice changes nothing
 * (already_revoked). A rule's requests stay payable by hand; they are just no longer eligible.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = AutopayRevokeBody.parse(await readJson(req));
    const res: AutopayRevokeResponse = await revokeAutopayRule(body);
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
