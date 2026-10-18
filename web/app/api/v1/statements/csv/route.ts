import { baseUrl, json, toErrorResponse } from "@/lib/http";
import { buildStatement, checkStatementLink, parseClient, statementCsv, statementFilename } from "@/lib/statements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

/**
 * GET /api/v1/statements/csv?recipient=…&client=…&month=…&expires=…&sig=… — F8: a statement as CSV. Links come only
 * from GET /api/v1/statements, after the recipient's wallet signature, and work for 10 minutes.
 */
export async function GET(req: Request): Promise<Response> {
  const check = checkStatementLink(new URL(req.url).searchParams);
  if (!check.ok) {
    const code = check.status === 503 ? "upstream_unavailable" : "invalid_input";
    return json({ error: { code, message: check.message } }, { status: check.status, headers: PRIVATE });
  }
  try {
    const statement = await buildStatement(check.recipient, parseClient(check.client), check.month, { base: baseUrl(req), chainBudgetMs: null });
    return new Response(statementCsv(statement), {
      status: 200,
      headers: {
        ...PRIVATE,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${statementFilename(check.recipient, check.month)}"`,
        "X-Owed-Lines": String(statement.lines.length),
        ...(statement.truncated && { "X-Owed-Truncated": "true" }),
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
