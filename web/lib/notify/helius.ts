import "server-only";
import { heliusConfig, hookTarget, type HeliusConfig, type HookTarget } from "./config";
import { defer } from "./defer";
import * as store from "./store";

// W3-A paid-request webhooks. One Helius webhook per deployment watches the Solana Pay reference key
// of every open request. A reference is a fresh key that only the paying transaction carries, so a
// delivery means "this request was probably just paid" and nothing else (watching the recipient's
// USDC account instead would deliver every unrelated transfer to busy wallets such as the team's).
// The address list is recomputed from the database on every change and written whole (PUT), so the
// database stays the source of truth: a request joins the list when it is created and leaves it when
// it is paid (or stops being open); an empty list deletes the webhook.
// Helius limits (docs, 2026-10-17): the free plan allows 5 webhooks with up to 100,000 addresses
// each and 1M credits a month; a create/edit/delete costs 100 credits, a delivery 1. So one shared
// webhook (not one per request), capped at WATCH_LIMIT addresses, about 200 credits per request.
// Helius being down never fails a request: the sync is logged and redone on the next change, and
// status checks keep settling requests exactly as before.

export const HELIUS_WEBHOOKS = "https://api-mainnet.helius-rpc.com/v0/webhooks";
const TIMEOUT_MS = 5000;

/** Message never contains the API URL (it carries the API key). */
export class HeliusError extends Error {
  status?: number;
}

interface Webhook {
  webhookID: string;
  webhookURL?: string;
}

async function call(cfg: HeliusConfig, method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${HELIUS_WEBHOOKS}${path}?api-key=${encodeURIComponent(cfg.apiKey)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new HeliusError(`Helius webhooks API ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable"}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let detail = "";
    try {
      // Helius answers {"message":"Webhook … not found","error":"Not Found","statusCode":404}, or plain "Unauthorized".
      const parsed = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
      const m = parsed.message ?? (typeof parsed.error === "string" ? parsed.error : parsed.error?.message);
      if (m) detail = `: ${String(m).replace(/[^\x20-\x7e]/g, " ").slice(0, 120)}`;
    } catch {
      // not JSON
    }
    const err = new HeliusError(`Helius webhooks API answered HTTP ${res.status} to ${method}${detail}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** Raw webhook: every transaction that includes a watched key, unparsed, lowest latency. */
function spec(cfg: HeliusConfig, target: HookTarget, addresses: readonly string[]) {
  return { webhookURL: target.url, webhookType: "raw", transactionTypes: ["ANY"], accountAddresses: addresses, authHeader: cfg.secret };
}

const withoutQuery = (url: string | undefined) => (url ?? "").split("?")[0];

async function remove(cfg: HeliusConfig, id: string): Promise<void> {
  try {
    await call(cfg, "DELETE", `/${encodeURIComponent(id)}`);
  } catch (e) {
    if (!(e instanceof HeliusError && e.status === 404)) throw e;
  }
}

/** Make Helius watch exactly `addresses`; returns the webhook id (null when none is needed). */
async function apply(cfg: HeliusConfig, target: HookTarget, addresses: readonly string[]): Promise<string | null> {
  const stored = await store.storedWebhook(target.key);
  if (addresses.length === 0) {
    if (stored) {
      await remove(cfg, stored);
      await store.forgetWebhook(target.key, stored);
    }
    return null;
  }
  const body = spec(cfg, target, addresses);
  if (stored) {
    try {
      await call(cfg, "PUT", `/${encodeURIComponent(stored)}`, body);
      return stored;
    } catch (e) {
      if (!(e instanceof HeliusError && e.status === 404)) throw e;
      await store.forgetWebhook(target.key, stored); // deleted in the dashboard: register again
    }
  }
  // Adopt a webhook already pointing here (a lost row, an earlier deployment), else create one.
  const all = await call(cfg, "GET", "");
  const mine = Array.isArray(all) ? (all as Webhook[]).find((w) => withoutQuery(w.webhookURL) === target.key) : undefined;
  let id: string;
  if (mine) {
    id = mine.webhookID;
    await call(cfg, "PUT", `/${encodeURIComponent(id)}`, body);
  } else {
    const created = (await call(cfg, "POST", "", body)) as Webhook | null;
    if (!created?.webhookID) throw new HeliusError("Helius webhooks API returned no webhookID");
    id = created.webhookID;
  }
  const winner = await store.rememberWebhook(target.key, id);
  if (winner !== id) {
    // Another instance registered one at the same moment: keep theirs, drop ours.
    if (!mine) await remove(cfg, id).catch(() => undefined);
    await call(cfg, "PUT", `/${encodeURIComponent(winner)}`, body);
  }
  return winner;
}

export type SyncResult =
  | { status: "off" }
  | { status: "synced"; webhookId: string | null; addresses: number }
  | { status: "failed"; error: string };

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Bring the webhook's address list in line with the database. Two syncs racing converge: each re-reads
 * the list after writing it and writes again if a request was created or paid in between. Never throws.
 */
export async function syncWatch(): Promise<SyncResult> {
  const cfg = heliusConfig();
  const target = hookTarget();
  if (!cfg || !target) return { status: "off" };
  try {
    let addresses: string[] = [];
    let id: string | null = null;
    for (let round = 0; round < 3; round++) {
      addresses = await store.watchedReferences();
      id = await apply(cfg, target, addresses);
      if (sameList(await store.watchedReferences(), addresses)) break;
    }
    if (id) await store.recordSync(target.key, addresses.length, null);
    return { status: "synced", webhookId: id, addresses: addresses.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`helius: watch sync failed: ${error}`);
    await store.recordSync(target.key, 0, error).catch(() => undefined);
    return { status: "failed", error };
  }
}

let queued = false;

/**
 * A request was created, paid or closed: re-sync the watch after the response is sent. Calls made
 * before the queued sync starts share it (a split of 6 shares, a status check settling 20 requests).
 * Without HELIUS_API_KEY and HELIUS_WEBHOOK_SECRET it does nothing, not even a query.
 */
export function watchSoon(): void {
  if (queued || !heliusConfig()) return;
  queued = true;
  defer("Helius watch sync", async () => {
    queued = false;
    await syncWatch();
  });
}
