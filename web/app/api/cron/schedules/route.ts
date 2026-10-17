import { errorResponse, json, toErrorResponse } from "@/lib/http";
import { cronAuthorized, runDueSchedules } from "@/lib/schedules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel's default ceiling; runDueSchedules stops starting new work after 40 s. */
export const maxDuration = 60;

/**
 * GET /api/cron/schedules — Vercel Cron, daily (web/vercel.json). Opens this month's request for every
 * active schedule whose day has come and that has none yet, through createRequest. Idempotent per
 * (schedule, month): calling it again opens nothing new. Vercel sends `Authorization: Bearer $CRON_SECRET`;
 * anything else is refused, and so is every call while CRON_SECRET is unset.
 */
export async function GET(req: Request): Promise<Response> {
  if (!process.env.CRON_SECRET?.trim()) {
    return errorResponse("upstream_unavailable", "the schedule cron isn't configured on this deployment");
  }
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return json({ error: { code: "invalid_input", message: "not authorized" } }, { status: 401 });
  }
  try {
    const summary = await runDueSchedules();
    console.log(`cron schedules ${summary.period}: due ${summary.due}, opened ${summary.opened.length}, already ${summary.already}, skipped ${summary.skipped.length}, failed ${summary.failed.length}, remaining ${summary.remaining}`);
    return json(summary, { status: summary.failed.length > 0 ? 500 : 200 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
