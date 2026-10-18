import { errorResponse, json, toErrorResponse } from "@/lib/http";
import { cronAuthorized, runDueSchedules } from "@/lib/schedules";
import { runDueInvoiceTerms } from "@/lib/invoice-terms"; // F8 invoices
import { deliverDueAlerts } from "@/lib/alerts/deliver"; // S1 alerts
import { purgeExpiredPending } from "@/lib/alerts/subscribe"; // S1 alerts

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
    // F8 invoices start: invoice terms on the same daily run (later installments, full prices, late fees, pending refunds).
    const invoiceTerms = await runDueInvoiceTerms().catch((e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 200) : "error" }));
    if ("error" in invoiceTerms) console.error(`cron invoice terms: ${invoiceTerms.error}`);
    else console.log(`cron invoice terms ${invoiceTerms.date}: due ${invoiceTerms.due}, opened ${invoiceTerms.opened.length}, skipped ${invoiceTerms.skipped.length}, waiting ${invoiceTerms.waiting.length}, failed ${invoiceTerms.failed.length}`);
    Object.assign(summary, { invoice_terms: invoiceTerms });
    // S1 alerts start: alerts still due (retries after a failed send, rows no kick picked up), and pending links that
    // expired a week ago. Never fails the cron: deliverDueAlerts doesn't throw and does nothing without a channel.
    const alerts = await deliverDueAlerts({ budgetMs: 10_000 }); // the schedules above may have used 40 s of the 60
    const purged = await purgeExpiredPending().catch((e: unknown) => {
      console.error(`cron alerts purge: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
      return 0;
    });
    Object.assign(summary, { alerts: { ...alerts, purged_pending: purged } });
    // S1 alerts end
    if ("error" in invoiceTerms || invoiceTerms.failed.length > 0) return json(summary, { status: 500 });
    // F8 invoices end
    return json(summary, { status: summary.failed.length > 0 ? 500 : 200 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
