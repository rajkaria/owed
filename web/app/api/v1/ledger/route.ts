import { LedgerBody } from "@/lib/contract";
import { baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { getLedger } from "@/lib/ledger";
import { ledgerPrefix, verifySignedMessage } from "@/lib/verify-signature";

export const runtime = "nodejs";

/**
 * POST /api/v1/ledger — a recipient's open requests and the ones paid in the last 30 days, with totals.
 * Needs "Owed ledger access for <recipient> at <ISO time>" signed by the recipient's wallet (PayBox
 * request_wallet_sign, op solanaMessage), at most 5 minutes old. Each signed message works once.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = LedgerBody.parse(await readJson(req));
    await verifySignedMessage("ledger", {
      message: body.signed_message,
      signature: body.signature,
      signer: body.recipient,
      prefix: ledgerPrefix(body.recipient),
    });
    return json(await getLedger(body.recipient, { base: baseUrl(req) }));
  } catch (e) {
    return toErrorResponse(e);
  }
}
