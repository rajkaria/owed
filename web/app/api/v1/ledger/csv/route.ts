import { baseUrl, json, toErrorResponse } from "@/lib/http";
import { checkCsvLink, csvFilename, ledgerCsv } from "@/lib/ledger-csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

/**
 * GET /api/v1/ledger/csv?recipient=…&expires=…&sig=… — the ledger as CSV (W3-D). Links come only from
 * POST /api/v1/ledger with csv: true, after the recipient's wallet signature, and work for 10 minutes.
 */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const check = checkCsvLink(url.searchParams);
  if (!check.ok) {
    const code = check.status === 503 ? "upstream_unavailable" : "invalid_input";
    return json({ error: { code, message: check.message } }, { status: check.status, headers: PRIVATE });
  }
  try {
    const csv = await ledgerCsv(check.recipient, baseUrl(req));
    return new Response(csv.text, {
      status: 200,
      headers: {
        ...PRIVATE,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvFilename(check.recipient)}"`,
        "X-Owed-Rows": String(csv.rows),
        ...(csv.truncated && { "X-Owed-Truncated": "true" }),
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
