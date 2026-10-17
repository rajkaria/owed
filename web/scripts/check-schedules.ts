// Live check of monthly requests (W3-D) on a deployment: POST /api/v1/schedules, GET /api/cron/schedules,
// POST /api/v1/ledger (schedules + csv) and GET /api/v1/ledger/csv. Needs migration 0008 on its database.
//
//   set -a; source .env.preview.local; set +a        # DATABASE_URL, CRON_SECRET, CSV_LINK_SECRET of the target (never printed)
//   node --import ./test/setup.mjs scripts/check-schedules.ts <base-url> --create [--wait-expiry] [--skip-ledger]
//   VERCEL_SHARE_URL=<https://<preview>/?_vercel_share=…> node --import ./test/setup.mjs scripts/check-schedules.ts https://<preview>.vercel.app --create
//
// --create writes, on the target's database:
//   1. through the API, a schedule for today (UTC) for 0.01 USDC to the team wallet, months: 1. On its day the API
//      opens this month's request at once (first_request); the schedule then ends, so nothing more is ever opened.
//   2. a second schedule for today, 0.01 USDC to the team wallet, months: 1, stored the way the API stores it but
//      without the immediate open (lib/schedules.ts createSchedule, openNow: false, on DATABASE_URL), so the cron
//      route is what opens its request: one call with the secret opens exactly that one; a second call opens none.
//   3. a third schedule (months: 1) for a throwaway wallet made at run time (it holds nothing; never pay its request),
//      opened by the API, so a ledger signed by that wallet can be read: it lists the schedule and its request,
//      csv: true returns a link, the CSV downloads with the right rows, and (--wait-expiry) the same link is refused
//      once its 10 minutes are up.
// --skip-ledger leaves out step 3 (on production, read the team wallet's own ledger with who_owes_me in PayBox instead).
// Refuses production hosts unless --allow-production.
import assert from "node:assert/strict";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { check as checkShape, requestIdFor, shapes } from "../../contract/shapes.mjs";
import { ErrorResponse, GetRequestResponse, LedgerResponse, ScheduleResponse } from "../lib/contract";
import { createSchedule, dayOf } from "../lib/schedules";

const TEAM_WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const args = process.argv.slice(2);
const base = (args[0] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base) || !args.includes("--create")) {
  console.error("usage: scripts/check-schedules.ts <base-url> --create [--wait-expiry] [--skip-ledger] [--allow-production]");
  process.exit(2);
}
const PRODUCTION_HOSTS = ["owed-omega.vercel.app", "www.getowed.xyz", "getowed.xyz"];
if (PRODUCTION_HOSTS.includes(new URL(base).hostname) && !args.includes("--allow-production")) {
  console.error(`${base} is production; pass --allow-production (it writes real schedules and requests)`);
  process.exit(2);
}
const cronSecret = process.env.CRON_SECRET?.trim();
if (!cronSecret) {
  console.error("CRON_SECRET is not set: source the target's env file first (its value is never printed)");
  process.exit(2);
}
if (dayOf(Date.now()) > 28) {
  console.error("today (UTC) is the 29th-31st, which no schedule can use; run this on another day");
  process.exit(2);
}

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.VERCEL_SHARE_URL) {
  const res = await fetch(process.env.VERCEL_SHARE_URL, { redirect: "manual" });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (cookies.length === 0) throw new Error(`share link did not set a cookie (HTTP ${res.status})`);
  headers.Cookie = cookies.join("; ");
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
/** Links name the deployment's public origin (OWED_BASE_URL); fetch them on the target being checked. */
const onTarget = (link: string) => { const u = new URL(link); return `${base}${u.pathname}${u.search}`; };
async function call(method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${base}${path}`, {
    method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
  });
  const type = res.headers.get("content-type") ?? "";
  const data: unknown = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}
function shapeOk(shape: string, data: unknown) {
  const { errors } = checkShape((shapes as Record<string, unknown>)[shape] as never, data) as { errors: string[] };
  assert.deepEqual(errors, [], `contract/shapes.mjs ${shape}`);
}
async function requestIsOpen(id: string, recipient: string) {
  const r = await call("GET", `/api/v1/requests/${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const req = GetRequestResponse.parse(r.data);
  assert.equal(req.status, "open");
  assert.equal(req.recipient, recipient);
  assert.equal(req.amount, "0.01");
  assert.equal(req.token, "USDC");
  assert.equal(requestIdFor({ recipient, token: "USDC", amountAtomic: 10_000n, reference: req.reference }), id, "id hashes its terms");
  return req;
}

const today = dayOf(Date.now());
const report: Record<string, unknown> = { base, day_of_month: today };

// 1. The API path: today is the day, so the first request opens at once.
await step("POST /api/v1/schedules for today opens this month's request at once (team wallet, 0.01 USDC, months 1)", async () => {
  const r = await call("POST", "/api/v1/schedules", {
    recipient: TEAM_WALLET, amount: "0.01", token: "USDC", payer_name: "Owed check", for: "W3-D monthly check", day_of_month: today, months: 1, source: "web",
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  shapeOk("scheduleRes", r.data);
  const s = ScheduleResponse.parse(r.data);
  assert.ok(s.first_request, "first_request");
  assert.equal(s.next_request_on, null, "months 1: nothing after the first");
  await requestIsOpen(s.first_request.id, TEAM_WALLET);
  report.api = { schedule: s.id, request: s.first_request.id, link: s.first_request.link };
});

// 2. The cron path: a due schedule with no request yet; the cron opens it exactly once.
let cronSchedule = "";
await step("a due schedule stored without its first request (team wallet, 0.01 USDC, months 1)", async () => {
  const { schedule, first } = await createSchedule({
    recipient: TEAM_WALLET, token: "USDC", amountAtomic: 10_000n, payerName: "Owed check", forText: "W3-D cron check", requesterName: null,
    flags: [], dayOfMonth: today, maxRequests: 1, source: "web", fromDomain: null,
  }, { openNow: false });
  assert.equal(first, null);
  cronSchedule = schedule.id;
  report.cron_schedule = schedule.id;
});
await step("GET /api/cron/schedules without the secret, or with a wrong one: 401, nothing opened", async () => {
  for (const auth of [undefined, "Bearer wrong", cronSecret]) {
    const r = await call("GET", "/api/cron/schedules", undefined, auth === undefined ? {} : { authorization: auth });
    assert.equal(r.status, 401, `${auth === undefined ? "no header" : auth === cronSecret ? "secret without Bearer" : "wrong secret"}: ${r.status}`);
  }
});
let cronRequest = "";
await step("GET /api/cron/schedules with the secret opens exactly one request: that schedule's", async () => {
  const r = await call("GET", "/api/cron/schedules", undefined, { authorization: `Bearer ${cronSecret}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data as { period: string; opened: Array<{ schedule_id: string; request_id: string; period: string }>; failed: unknown[] };
  report.cron_first = { status: r.status, period: s.period, opened: s.opened, failed: s.failed };
  assert.equal(s.opened.length, 1, `opened ${JSON.stringify(s.opened)}`);
  assert.equal(s.opened[0].schedule_id, cronSchedule);
  cronRequest = s.opened[0].request_id;
  await requestIsOpen(cronRequest, TEAM_WALLET);
  report.cron_request = { id: cronRequest, link: `${base}/r/${cronRequest}` };
});
await step("a second call opens none", async () => {
  const r = await call("GET", "/api/cron/schedules", undefined, { authorization: `Bearer ${cronSecret}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const s = r.data as { opened: unknown[]; due: number };
  report.cron_second = { status: r.status, due: s.due, opened: s.opened };
  assert.deepEqual(s.opened, []);
  assert.equal(s.due, 0);
});

// 3. The ledger: a throwaway wallet signs, so its ledger (and CSV) can be read.
if (args.includes("--skip-ledger")) {
  console.log(JSON.stringify(report, null, 2));
  console.log(failures === 0 ? "all checks passed (ledger skipped)" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
const key = nacl.sign.keyPair();
const throwaway = bs58.encode(key.publicKey);
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const signedBody = (extra: Record<string, unknown> = {}) => {
  const message = `Owed ledger access for ${throwaway} at ${iso(Date.now())}`;
  return { recipient: throwaway, signed_message: message, signature: Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), key.secretKey)).toString("hex"), ...extra };
};
let throwawaySchedule = "";
let throwawayRequest = "";
await step("a schedule for a throwaway wallet (holds nothing; never pay it) opens its request", async () => {
  const r = await call("POST", "/api/v1/schedules", {
    recipient: throwaway, amount: "0.01", token: "USDC", payer_name: "=Owed check", for: "@W3-D ledger check, do not pay", day_of_month: today, months: 1, source: "web",
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const s = ScheduleResponse.parse(r.data);
  assert.ok(s.first_request);
  throwawaySchedule = s.id;
  throwawayRequest = s.first_request.id;
  report.throwaway = { wallet: throwaway, schedule: s.id, request: s.first_request.id };
});
let csvUrl = "";
let csvExpires = "";
await step("the signed ledger lists the schedule and its request; csv: true returns a 10-minute link", async () => {
  const r = await call("POST", "/api/v1/ledger", signedBody({ csv: true }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  shapeOk("ledgerRes", r.data);
  const l = LedgerResponse.parse(r.data);
  const s = l.schedules?.find((x) => x.id === throwawaySchedule);
  assert.ok(s, "schedule listed");
  assert.deepEqual(s.requests.map((x) => x.id), [throwawayRequest]);
  assert.equal(s.status, "ended");
  const entry = l.open.find((e) => e.id === throwawayRequest);
  assert.equal(entry?.schedule_id, throwawaySchedule);
  assert.ok(l.csv, "csv link");
  const left = Date.parse(l.csv.expires_at) - Date.now();
  assert.ok(left > 9 * 60_000 && left <= 10 * 60_000 + 1000, `expires in ${left} ms`);
  csvUrl = l.csv.url;
  csvExpires = l.csv.expires_at;
  report.csv = { expires_at: l.csv.expires_at };
});
await step("the same signature again is refused (single use)", async () => {
  const body = signedBody();
  assert.equal((await call("POST", "/api/v1/ledger", body)).status, 200);
  const again = await call("POST", "/api/v1/ledger", body);
  assert.equal(again.status, 400);
  assert.match(ErrorResponse.parse(again.data).error.message, /already used/);
});
await step("the CSV downloads: header, the request's row, quoted cells, formula starts neutralised", async () => {
  const r = await fetch(onTarget(csvUrl), { headers: { Cookie: headers.Cookie ?? "" } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="owed-[^"]+\.csv"$/);
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = bytes.subarray(3).toString("utf8").split("\r\n");
  assert.match(lines[0], /^"# Anyone can create a request that pays your wallet; /); // QA-20 caution
  assert.match(lines[1], /^"request_id","kind","status","amount","token",.*"payer_name \(unverified\)","for \(unverified\)"/);
  const row = lines.find((l) => l.startsWith(`"${throwawayRequest}"`));
  assert.ok(row, "the request's row");
  assert.ok(row.includes(`"'=Owed check","'@W3-D ledger check, do not pay"`), row);
  assert.ok(row.endsWith(`"${throwawaySchedule}","${new Date().toISOString().slice(0, 7)}"`), row);
  report.csv_rows = lines.length - 3;
});
await step("a tampered link (another wallet) is refused", async () => {
  const u = new URL(onTarget(csvUrl));
  u.searchParams.set("recipient", TEAM_WALLET);
  const r = await fetch(u, { headers: { Cookie: headers.Cookie ?? "" } });
  assert.equal(r.status, 403);
});
if (args.includes("--wait-expiry")) {
  const wait = Date.parse(csvExpires) + 5000 - Date.now();
  console.log(`…  waiting ${Math.ceil(wait / 1000)} s for the CSV link to expire (${csvExpires})`);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
  await step("the same CSV link after its 10 minutes: 410, refused", async () => {
    const r = await fetch(onTarget(csvUrl), { headers: { Cookie: headers.Cookie ?? "" } });
    assert.equal(r.status, 410);
    const body = ErrorResponse.parse(await r.json());
    assert.match(body.error.message, /expired/);
    report.csv_after_expiry = { status: r.status, at: iso(Date.now()), message: body.error.message };
  });
}

console.log(JSON.stringify(report, null, 2));
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
