import "server-only";
import { sql } from "../db";
import { getRequest } from "../requests";
import { alertChannels, alertsBase, emailConfig, telegramConfig, type AlertChannel } from "./config";
import { EmailError, sendEmail } from "./email";
import { alertFacts, emailAlert, telegramAlert, type AlertFacts } from "./messages";
import { endSubscription, mintUnsubscribeToken } from "./subscribe";
import { sendTelegram, TelegramError } from "./telegram";

// S1 paid alerts: sending what the 0025 trigger queued. A run claims due rows (pending -> sending, attempts + 1) with
// FOR UPDATE SKIP LOCKED, so two runs at once (two settles, a kick and the cron) never take the same row: each alert
// row is sent by one run, and there is one row per (subscription, request). Then, per row:
//   - the subscription was turned off meanwhile          -> skipped
//   - the payment was recorded more than 48 hours ago   -> failed (an alert that late helps nobody)
//   - sent                                               -> sent
//   - the channel refused for good (bot blocked, bad request, address refused) -> failed; a blocked bot or a gone chat
//     also ends the subscription
//   - anything else (timeout, 5xx, flood control)        -> retried in the same run after 1 s and 4 s, then left pending
//     for 10 minutes (the next kick or the daily cron), and given up after MAX_ATTEMPTS attempts in all.
// A row left "sending" by a run that died is taken again after 2 minutes. Telegram has no idempotency key, so a
// timeout whose message did arrive can, rarely, repeat it; Resend gets one (Idempotency-Key) per row and run.
// Never throws: a failed run is logged and the rows stay due.

export const MAX_ATTEMPTS = 5;
export const MAX_AGE_HOURS = 48;
const BATCH = 25;
const PARALLEL = 4;

export interface DeliverDeps {
  sleep: (ms: number) => Promise<void>;
  /** Waits before the in-run retries (two delays: three tries per run). */
  retryDelaysMs: readonly number[];
  /** A row whose tries in this run all failed waits this long for the next run. */
  laterSeconds: number;
  /** Stop claiming new rows after this long (the routes' maxDuration is 60 s). */
  budgetMs: number;
}

export const deliverTiming: DeliverDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelaysMs: [1000, 4000],
  laterSeconds: 600,
  budgetMs: 40_000,
};

export type DeliverSummary =
  | { status: "off" }
  | { status: "ran"; claimed: number; sent: number; failed: number; skipped: number; retrying: number; error?: string };

type Outcome = "sent" | "failed" | "skipped" | "retrying";

interface Job {
  id: string;
  subscriptionId: string;
  requestId: string;
  attempts: number;
  stale: boolean;
}

async function claim(channels: readonly AlertChannel[]): Promise<Job[]> {
  const rows = await sql(
    `update alert_deliveries d
        set status = 'sending', attempts = least(d.attempts + 1, 20), claimed_at = now()
      where d.id in (
        select x.id from alert_deliveries x
          join alert_subscriptions s on s.id = x.subscription_id
         where s.channel = any($2::text[])
           and ((x.status = 'pending' and x.next_attempt_at <= now())
             or (x.status = 'sending' and x.claimed_at < now() - interval '2 minutes'))
         order by x.id
         limit $1
         for update of x skip locked)
     returning d.id::text as id, d.subscription_id, d.request_id, d.attempts::text as attempts,
               (d.created_at < now() - make_interval(hours => $3::int))::text as stale`,
    [BATCH, channels, MAX_AGE_HOURS],
  );
  return rows.map((r) => ({ id: r.id!, subscriptionId: r.subscription_id!, requestId: r.request_id!, attempts: Number(r.attempts), stale: r.stale === "true" }));
}

async function bump(id: string): Promise<number> {
  const [row] = await sql(`update alert_deliveries set attempts = least(attempts + 1, 20) where id = $1::bigint and status = 'sending' returning attempts::text as attempts`, [id]);
  return Number(row?.attempts ?? MAX_ATTEMPTS);
}

async function finish(id: string, status: "sent" | "failed" | "skipped" | "pending", error: string | null = null, laterSeconds: number | null = null): Promise<void> {
  await sql(
    `update alert_deliveries
        set status = $2, error = $3, claimed_at = null,
            sent_at = case when $2 = 'sent' then now() else null end,
            next_attempt_at = case when $4::int is null then next_attempt_at else now() + make_interval(secs => $4::int) end
      where id = $1::bigint and status = 'sending'`,
    [id, status, error === null ? null : error.slice(0, 300), laterSeconds],
  );
}

interface Subscription {
  id: string;
  wallet: string;
  channel: AlertChannel;
  status: string;
  chatId: string | null;
  email: string | null;
}

/** One send to the subscription's channel; returns a function so in-run retries send byte-identical messages. */
async function prepare(sub: Subscription, facts: AlertFacts, jobId: string, base: string): Promise<() => Promise<void>> {
  if (sub.channel === "telegram") {
    const cfg = telegramConfig();
    const html = telegramAlert(facts);
    return () => sendTelegram(cfg!, sub.chatId!, html);
  }
  const cfg = emailConfig();
  const { token, hash } = await mintUnsubscribeToken(sub.id);
  const page = `${base}/alerts/unsubscribe?token=${token}`;
  const oneClick = `${base}/api/v1/alerts/unsubscribe?token=${token}`;
  const message = emailAlert(facts, page, oneClick);
  return () => sendEmail(cfg!, { to: sub.email!, ...message, idempotencyKey: `owed-alert-${jobId}-${hash.slice(0, 16)}` });
}

function classify(e: unknown): { permanent: boolean; ends: boolean; retryAfterSeconds: number; message: string } {
  if (e instanceof TelegramError) return { permanent: e.permanent, ends: e.endsSubscription, retryAfterSeconds: e.retryAfterSeconds ?? 0, message: e.message };
  if (e instanceof EmailError) return { permanent: e.permanent, ends: false, retryAfterSeconds: 0, message: e.message };
  return { permanent: false, ends: false, retryAfterSeconds: 0, message: e instanceof Error ? e.message.slice(0, 200) : "error" };
}

async function deliverOne(job: Job, deps: DeliverDeps, base: string, deadline: number): Promise<Outcome> {
  const [s] = await sql(`select id, wallet, channel, status, telegram_chat_id::text as chat_id, email from alert_subscriptions where id = $1`, [job.subscriptionId]);
  const sub: Subscription | null = s ? { id: s.id!, wallet: s.wallet!, channel: s.channel as AlertChannel, status: s.status!, chatId: s.chat_id, email: s.email } : null;
  if (!sub || sub.status !== "active") {
    await finish(job.id, "skipped", "the subscription was turned off before the alert went out");
    return "skipped";
  }
  if (job.stale) {
    await finish(job.id, "failed", `not sent within ${MAX_AGE_HOURS} hours of the payment being recorded`);
    return "failed";
  }
  const row = await getRequest(job.requestId);
  if (!row || (row.status !== "paid" && row.status !== "underpaid")) {
    await finish(job.id, "skipped", "the request is no longer marked paid");
    return "skipped";
  }
  const send = await prepare(sub, alertFacts(row, sub.wallet, base), job.id, base);
  let attempts = job.attempts;
  for (let i = 0; ; i++) {
    try {
      await send();
      await finish(job.id, "sent");
      return "sent";
    } catch (e) {
      const err = classify(e);
      console.warn(`alerts: ${sub.channel} alert ${job.id} (attempt ${attempts}) failed: ${err.message}`);
      if (err.permanent) {
        if (err.ends) await endSubscription(sub.id, sub.channel === "telegram" ? "bot_blocked" : "undeliverable");
        await finish(job.id, "failed", err.message);
        return "failed";
      }
      if (attempts >= MAX_ATTEMPTS) {
        await finish(job.id, "failed", `gave up after ${attempts} attempts: ${err.message}`);
        return "failed";
      }
      const delay = deps.retryDelaysMs[i];
      const wait = Math.max(delay ?? 0, err.retryAfterSeconds * 1000);
      if (delay !== undefined && wait <= 10_000 && Date.now() + wait < deadline) {
        await deps.sleep(wait);
        attempts = await bump(job.id);
        continue;
      }
      await finish(job.id, "pending", err.message, Math.max(deps.laterSeconds, err.retryAfterSeconds));
      return "retrying";
    }
  }
}

/** Send every due alert (configured channels only). Safe to call from anywhere, any number of times at once. */
export async function deliverDueAlerts(overrides: Partial<DeliverDeps> = {}): Promise<DeliverSummary> {
  const on = alertChannels();
  const channels = (Object.keys(on) as AlertChannel[]).filter((c) => on[c]);
  if (channels.length === 0) return { status: "off" };
  const deps = { ...deliverTiming, ...overrides };
  const deadline = Date.now() + deps.budgetMs;
  const base = alertsBase();
  const summary = { status: "ran" as const, claimed: 0, sent: 0, failed: 0, skipped: 0, retrying: 0 };
  try {
    while (Date.now() < deadline) {
      const jobs = await claim(channels);
      if (jobs.length === 0) break;
      summary.claimed += jobs.length;
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          let outcome: Outcome;
          try {
            outcome = await deliverOne(job, deps, base, deadline);
          } catch (e) {
            // Storage or a bug, not the channel: leave the row due again in a while.
            console.warn(`alerts: alert ${job.id} not processed: ${e instanceof Error ? e.message : String(e)}`);
            await finish(job.id, "pending", "not processed (storage error)", deps.laterSeconds).catch(() => undefined);
            outcome = "retrying";
          }
          summary[outcome] += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
      if (jobs.length < BATCH) break;
    }
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 200) : "error";
    console.warn(`alerts: delivery run failed: ${error}`);
    return { ...summary, error };
  }
  if (summary.claimed) {
    console.log(`alerts: claimed ${summary.claimed}, sent ${summary.sent}, failed ${summary.failed}, skipped ${summary.skipped}, retrying ${summary.retrying}`);
  }
  return summary;
}
