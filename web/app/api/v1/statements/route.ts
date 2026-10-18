import type { StatementResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, toErrorResponse } from "@/lib/http";
import { buildStatement, currentMonth, monthRange, parseClient, statementLinks } from "@/lib/statements";
import { isSolanaAddress } from "@/lib/solana-pay";
import { ledgerPrefix, verifySignedMessage } from "@/lib/verify-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };

/**
 * GET /api/v1/statements?recipient=…&client=…&month=YYYY-MM&signed_message=…&signature=… — F8: a client's statement
 * for one month (UTC): their invoices to this wallet, what was invoiced, cancelled, paid and refunded, and the balance
 * before and after. Needs the recipient's signed ledger message ("Owed ledger access for <recipient> at <ISO time>",
 * PayBox request_wallet_sign, at most 5 minutes old, once), the same one who_owes_me signs. client is the client's name
 * as written on the invoices (any case) or a payer wallet. The reply carries a CSV link and a page link for 10 minutes.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const q = new URL(req.url).searchParams;
    const recipient = q.get("recipient") ?? "";
    if (!isSolanaAddress(recipient)) throw new ApiError("invalid_input", "recipient must be the base58 Solana wallet the invoices pay");
    const client = parseClient(q.get("client"));
    const month = q.get("month") || currentMonth();
    monthRange(month);
    await verifySignedMessage("statement", {
      message: q.get("signed_message") ?? "",
      signature: q.get("signature") ?? "",
      signer: recipient,
      prefix: ledgerPrefix(recipient),
    });
    const base = baseUrl(req);
    const statement = await buildStatement(recipient, client, month, { base });
    const links = statementLinks(recipient, client.label, month, base);
    const res: StatementResponse = { ...statement, csv: links.csv, page: links.page };
    return json(res, { headers: PRIVATE });
  } catch (e) {
    return toErrorResponse(e);
  }
}
