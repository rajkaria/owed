import { sql } from "@/lib/db";
import { json, toErrorResponse } from "@/lib/http";
import { formatUnits, TOKENS } from "@/lib/money";

export const runtime = "nodejs";

/** Owed went live on mainnet on this day; every counted row is a real paid request since then. */
const SINCE = "2026-10-17T00:00:00Z";

/** GET /api/v1/stats — real paid requests only, for the landing page. */
export async function GET(): Promise<Response> {
  try {
    const [row] = await sql(
      `select count(*)::text as paid_count,
              coalesce(sum(paid_amount_atomic) filter (where token = 'USDC'), 0)::text as usdc_atomic
         from requests
        where status = 'paid'`,
    );
    return json(
      {
        paid_count: Number(row.paid_count),
        paid_volume_usdc: formatUnits(BigInt(row.usdc_atomic!), TOKENS.USDC.decimals),
        since: SINCE,
      },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=50" } },
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}
