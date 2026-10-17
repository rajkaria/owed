// Live check of the Helius webhook (W3-A) on a running deployment, reading that deployment's database
// directly so nothing it does settles a request (no /status, no GET /requests/:id, no pay page).
//
//   cd web
//   node --import ./test/setup.mjs --env-file=<env file of the target's database> scripts/check-hooks.ts <base-url> --create
//   node --import ./test/setup.mjs --env-file=<…> scripts/check-hooks.ts <base-url> --watch <id> [--minutes 10]
//   node --import ./test/setup.mjs --env-file=<…> scripts/check-hooks.ts <base-url> --remove
//
// --create  POST <base>/api/v1/requests (0.01 USDC to the team wallet), then checks the deployment
//           registered its webhook with the new reference (notify_webhooks when DATABASE_URL is set, and
//           Helius itself when HELIUS_API_KEY is), and that /api/hooks/helius refuses a missing or wrong
//           Authorization header. Writes one real open request, so production needs --allow-production.
// --watch   waits for the request to be paid, printing the row and the webhook's delivery log each time
//           either changes. Pass = paid, and a delivery lists the request in marked_paid.
// --remove  deletes the deployment's webhook at Helius (found by its URL) and its notify_webhooks row:
//           for a rollback of W3-A, or to clean up after a preview. Needs HELIUS_API_KEY. The next
//           request created by a deployment that still runs W3-A registers a fresh one.
// Protected previews: VERCEL_BYPASS=<automation bypass secret>. Nothing here signs or sends funds.
import { sql } from "../lib/db";

const args = process.argv.slice(2);
const base = (args[0] ?? "").replace(/\/+$/, "");
const watchFlag = args.indexOf("--watch");
const watchId = watchFlag === -1 ? null : args[watchFlag + 1];
const create = args.includes("--create");
const remove = args.includes("--remove");
const minutesFlag = args.indexOf("--minutes");
const minutes = minutesFlag === -1 ? 10 : Number(args[minutesFlag + 1]);
if (!/^https:\/\//.test(base) || [create, watchId !== null, remove].filter(Boolean).length !== 1 || !(minutes > 0)) {
  console.error("usage: scripts/check-hooks.ts <https-base-url> (--create | --watch <id> [--minutes N] | --remove) [--allow-production]");
  process.exit(2);
}
const PRODUCTION_HOSTS = ["www.getowed.xyz", "getowed.xyz", "owed-omega.vercel.app"];
if (create && PRODUCTION_HOSTS.includes(new URL(base).hostname) && !args.includes("--allow-production")) {
  console.error(`${base} is production; pass --allow-production to create a real request there`);
  process.exit(2);
}
const hasDb = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (watchId && !hasDb) {
  console.error("--watch reads the target's database: pass --env-file with its DATABASE_URL");
  process.exit(2);
}

const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const HOOK_KEY = `${base}/api/hooks/helius`;
const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function report(ok: boolean, name: string, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

async function registry() {
  return (await sql(
    `select helius_id, address_count, to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as synced_at, last_error
       from notify_webhooks where url = $1`,
    [HOOK_KEY],
  ))[0] ?? null;
}

if (create) {
  const started = now();
  const res = await fetch(`${base}/api/v1/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({ recipient: TEAM, amount: "0.01", token: "USDC", for: "W3-A webhook check", requester_name: "Owed check", source: "web" }),
  });
  const body = (await res.json().catch(() => null)) as { id?: string; link?: string; reference?: string } | null;
  report(res.status === 201 && !!body?.id, "POST /api/v1/requests", `HTTP ${res.status}`);
  if (!body?.id) process.exit(1);
  console.log(`     id ${body.id}  link ${body.link}  reference ${body.reference}`);

  // The deployment syncs after its response; give it a few seconds.
  let heliusId: string | null = null;
  if (hasDb) {
    let reg = null;
    for (let i = 0; i < 15; i++) {
      reg = await registry();
      if (reg?.synced_at && reg.synced_at >= started) break;
      await sleep(1000);
    }
    report(!!reg && !reg.last_error, "notify_webhooks row for this deployment", JSON.stringify(reg));
    heliusId = reg?.helius_id ?? null;
  }
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!heliusId && apiKey) {
    await sleep(hasDb ? 0 : 8000);
    const list = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks?api-key=${encodeURIComponent(apiKey)}`);
    const all = (await list.json().catch(() => [])) as { webhookID: string; webhookURL?: string }[];
    heliusId = (Array.isArray(all) ? all : []).find((w) => (w.webhookURL ?? "").split("?")[0] === HOOK_KEY)?.webhookID ?? null;
    report(!!heliusId, "Helius has a webhook for this deployment", `HTTP ${list.status}`);
  }
  if (heliusId && apiKey) {
    const hook = await fetch(`https://api-mainnet.helius-rpc.com/v0/webhooks/${heliusId}?api-key=${encodeURIComponent(apiKey)}`);
    const w = (await hook.json().catch(() => null)) as { webhookURL?: string; webhookType?: string; accountAddresses?: string[]; active?: boolean } | null;
    report(
      hook.ok && !!w?.accountAddresses?.includes(body.reference!) && w.webhookType === "raw" && w.active === true && (w.webhookURL ?? "").split("?")[0] === HOOK_KEY,
      "Helius watches the new reference",
      `HTTP ${hook.status}, ${w?.accountAddresses?.length ?? 0} addresses, type ${w?.webhookType}, active ${w?.active}`,
    );
  }
  for (const [name, auth] of [["no Authorization", null], ["wrong Authorization", "Bearer not-the-secret"]] as const) {
    const r = await fetch(`${base}/api/hooks/helius`, { method: "POST", headers: { ...headers, ...(auth && { Authorization: auth }) }, body: "[]" });
    report(r.status === 401, `hook refuses ${name}`, `HTTP ${r.status}`);
  }
  const secret = process.env.HELIUS_WEBHOOK_SECRET?.trim();
  if (secret) {
    const r = await fetch(`${base}/api/hooks/helius`, { method: "POST", headers: { ...headers, Authorization: secret }, body: "[]" });
    report(r.status === 200, "hook accepts the secret (empty delivery)", `HTTP ${r.status} ${await r.text()}`);
  }
}

if (watchId) {
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  for (;;) {
    const [row] = await sql(
      `select status, paid_signature, paid_rail, to_char(paid_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as paid_at
         from requests where id = $1`,
      [watchId],
    );
    if (!row) {
      report(false, `request ${watchId}`, "not in this database");
      break;
    }
    const deliveries = await sql(
      `select signature, outcome, marked_paid::text as marked_paid, deliveries,
              to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as received_at,
              to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at
         from helius_deliveries where $1 = any(request_ids) order by received_at`,
      [watchId],
    );
    const state = JSON.stringify({ row, deliveries });
    if (state !== last) {
      console.log(`${now()} ${state}`);
      last = state;
    }
    if (row.status === "paid") {
      const byHook = deliveries.find((d) => (d.marked_paid ?? "").includes(watchId));
      report(true, "request is paid", `${row.paid_signature} at ${row.paid_at} (chain time)`);
      report(!!byHook, "a Helius delivery marked it paid", byHook ? `tx ${byHook.signature}, received ${byHook.received_at}, settled ${byHook.updated_at}` : "no delivery lists it in marked_paid");
      break;
    }
    if (Date.now() > deadline) {
      report(false, "request is paid", `still ${row.status} after ${minutes} min`);
      break;
    }
    await sleep(2000);
  }
}

if (remove) {
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!apiKey) {
    console.error("--remove needs HELIUS_API_KEY in the env file");
    process.exit(2);
  }
  const api = "https://api-mainnet.helius-rpc.com/v0/webhooks";
  const list = await fetch(`${api}?api-key=${encodeURIComponent(apiKey)}`);
  const all = (await list.json().catch(() => [])) as { webhookID: string; webhookURL?: string }[];
  const mine = (Array.isArray(all) ? all : []).filter((w) => (w.webhookURL ?? "").split("?")[0] === HOOK_KEY);
  report(list.ok, "list Helius webhooks", `HTTP ${list.status}, ${mine.length} for ${HOOK_KEY}`);
  for (const w of mine) {
    const del = await fetch(`${api}/${w.webhookID}?api-key=${encodeURIComponent(apiKey)}`, { method: "DELETE" });
    report(del.ok, `delete webhook ${w.webhookID}`, `HTTP ${del.status}`);
  }
  if (hasDb) {
    const rows = await sql(`delete from notify_webhooks where url = $1 returning helius_id`, [HOOK_KEY]);
    report(true, "notify_webhooks rows removed", String(rows.length));
  }
}

process.exit(failures ? 1 : 0);
