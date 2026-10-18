import { LedgerBody } from "@/lib/contract";
import { baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { getLedger } from "@/lib/ledger";
import { csvLink } from "@/lib/ledger-csv"; // W3-D
import { withSchedules } from "@/lib/schedules"; // W3-D
import { withInvoiceTerms } from "@/lib/invoice-terms"; // F8 invoices
import { ledgerPrefix, verifySignedMessage } from "@/lib/verify-signature";

export const runtime = "nodejs";

/**
 * POST /api/v1/ledger — a recipient's open requests and the ones paid in the last 30 days, with totals.
 * Needs "Owed ledger access for <recipient> at <ISO time>" signed by the recipient's wallet (PayBox
 * request_wallet_sign, op solanaMessage), at most 5 minutes old. Each signed message works once.
 * W3-D: also lists the wallet's monthly schedules; with csv: true the reply carries a CSV link for 10 minutes.
 * F8: each entry also carries its invoice's chase days, the reminder due now and what was refunded (lib/invoice-terms.ts).
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
    // W3-D start: monthly schedules and, when asked, a 10-minute CSV link (minted only after the signature check)
    const base = baseUrl(req);
    const ledger = await withInvoiceTerms(await withSchedules(await getLedger(body.recipient, { base }), { base })); // F8: chase days, reminder due, refunds
    return json(body.csv ? { ...ledger, csv: csvLink(body.recipient, base) } : ledger);
    // W3-D end
  } catch (e) {
    return toErrorResponse(e);
  }
}
