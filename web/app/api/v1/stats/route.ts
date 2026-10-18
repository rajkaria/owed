import { ctaTotals } from "@/lib/cta";
import { sql } from "@/lib/db";
import { json, toErrorResponse } from "@/lib/http";
import { formatUnits, TOKENS } from "@/lib/money";
import { potStats } from "@/lib/pots"; // F7 pots

export const runtime = "nodejs";

/** Owed went live on mainnet on this day; every counted row is a real paid request since then. */
const SINCE = "2026-10-17T00:00:00Z";

/**
 * GET /api/v1/stats — real paid requests only, for the landing page. SP1: plus `cta`, the pay pages'
 * "Pay with PayBox" link clicks and "Pay this" prompt copies since they started being counted (migration 0016).
 * `cta` is optional: it is left out while those counters can't be read, and the paid numbers never wait on it.
 */
export async function GET(): Promise<Response> {
  try {
    const [[row], cta, pots] = await Promise.all([
      sql(
        `select count(*)::text as paid_count,
                coalesce(sum(paid_amount_atomic) filter (where token = 'USDC'), 0)::text as usdc_atomic
           from requests
          where status = 'paid'`,
      ),
      ctaTotals(),
      potStats(), // F7 pots: optional like cta; a paid contribution is a real paid request, so it is in paid_count too
    ]);
    return json(
      {
        paid_count: Number(row.paid_count),
        paid_volume_usdc: formatUnits(BigInt(row.usdc_atomic!), TOKENS.USDC.decimals),
        since: SINCE,
        ...(cta && { cta }),
        ...(pots && { pots }),
      },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=50" } },
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}
