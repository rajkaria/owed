import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { GET as cronGET } from "@/app/api/cron/schedules/route";
import { GET as csvGET } from "@/app/api/v1/ledger/csv/route";
import { POST as ledgerPOST } from "@/app/api/v1/ledger/route";
import { POST as schedulesPOST } from "@/app/api/v1/schedules/route";
import { LedgerResponse, ScheduleResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { checkCsvLink, csvCell, csvLine, csvLink, CSV_CAUTION, CSV_COLUMNS } from "@/lib/ledger-csv";
import { LEDGER_CAUTION } from "@/lib/ledger";
import { getRequest } from "@/lib/requests";
import {
  createSchedule, cronAuthorized, dateIn, dayLabel, dayOf, duePeriod, firstPeriodFor, isoDate, nextPeriod, nextRequestOn,
  periodOf, runDueSchedules, SCHEDULE_LIMITS, type NewSchedule,
} from "@/lib/schedules";
import { isoSeconds, ledgerPrefix } from "@/lib/verify-signature";

// W3-D recurring requests and the ledger CSV. Period math and CSV escaping are pure. Everything else runs on
// real Postgres: PGlite (Postgres compiled to WASM) answers lib/db.ts's Neon-over-HTTP calls after every
// migration in db/migrations/ is applied in order; DNS answers come from plugin/test/fixtures/doh (real
// resolver captures); Solana RPC is down, so routes list stored state. Skips the Postgres part until the
// devDependency @electric-sql/pglite is installed.

const utc = (s: string) => Date.parse(s);

// ---------------------------------------------------------------- period math

test("periods are UTC calendar months; the day turns at 00:00 UTC, across month and year ends", () => {
  assert.equal(periodOf(utc("2026-10-31T23:59:59.999Z")), "2026-10");
  assert.equal(periodOf(utc("2026-11-01T00:00:00Z")), "2026-11");
  assert.equal(periodOf(utc("2026-12-31T23:59:59Z")), "2026-12");
  assert.equal(periodOf(utc("2027-01-01T00:00:00Z")), "2027-01");
  // 20:00 EDT on Oct 17 is already the 18th in UTC.
  assert.equal(dayOf(utc("2026-10-18T00:00:00Z")), 18);
  assert.equal(dayOf(utc("2026-10-17T23:59:59Z")), 17);
  assert.equal(nextPeriod("2026-10"), "2026-11");
  assert.equal(nextPeriod("2026-12"), "2027-01");
  assert.equal(nextPeriod("2099-12"), "2100-01");
  assert.equal(dateIn("2027-02", 28), "2027-02-28");
  assert.equal(isoDate(utc("2028-02-29T12:00:00Z")), "2028-02-29");
  assert.throws(() => nextPeriod("2026-13"));
});

test("the first month is this one unless the day has passed; today's day counts as this month", () => {
  assert.equal(firstPeriodFor(utc("2026-10-17T09:00:00Z"), 17), "2026-10"); // today: opens now
  assert.equal(firstPeriodFor(utc("2026-10-17T09:00:00Z"), 20), "2026-10"); // later this month
  assert.equal(firstPeriodFor(utc("2026-10-17T09:00:00Z"), 5), "2026-11"); // passed: next month
  assert.equal(firstPeriodFor(utc("2026-12-30T00:00:00Z"), 5), "2027-01"); // across the year end
  assert.equal(firstPeriodFor(utc("2026-01-31T23:00:00Z"), 28), "2026-02"); // 31st, day 28: February
  assert.equal(firstPeriodFor(utc("2027-02-28T00:00:00Z"), 28), "2027-02"); // last day of a short month
  assert.equal(firstPeriodFor(utc("2028-02-29T00:00:00Z"), 28), "2028-03"); // leap day is after the 28th
  assert.equal(firstPeriodFor(utc("2026-10-31T23:59:59Z"), 1), "2026-11");
});

test("a month is due from its day to its last second, and never before the first month", () => {
  const s = { firstPeriod: "2026-10", dayOfMonth: 28 };
  assert.equal(duePeriod(s, utc("2026-10-27T23:59:59Z")), null);
  assert.equal(duePeriod(s, utc("2026-10-28T00:00:00Z")), "2026-10");
  assert.equal(duePeriod(s, utc("2026-10-31T23:59:59Z")), "2026-10"); // a missed day is caught up within the month
  assert.equal(duePeriod(s, utc("2026-11-01T00:00:00Z")), null); // a new month starts over: October is not back-filled
  assert.equal(duePeriod(s, utc("2026-11-28T00:00:01Z")), "2026-11");
  assert.equal(duePeriod(s, utc("2027-01-28T10:00:00Z")), "2027-01");
  const later = { firstPeriod: "2026-11", dayOfMonth: 5 };
  assert.equal(duePeriod(later, utc("2026-10-20T00:00:00Z")), null); // made on Oct 17 for the 5th: not October
  assert.equal(duePeriod(later, utc("2026-11-05T00:00:00Z")), "2026-11");
  assert.equal(duePeriod({ firstPeriod: "2026-12", dayOfMonth: 1 }, utc("2026-12-01T00:00:00Z")), "2026-12");
});

test("next_request_on: the first month, this month, today when due, next month once opened, null when ended", () => {
  const base = { firstPeriod: "2026-11", dayOfMonth: 5, status: "active" as const, maxRequests: null, opened: 0 };
  assert.equal(nextRequestOn(base, utc("2026-10-17T09:00:00Z"), false), "2026-11-05");
  const oct = { ...base, firstPeriod: "2026-10", dayOfMonth: 20 };
  assert.equal(nextRequestOn(oct, utc("2026-10-17T09:00:00Z"), false), "2026-10-20");
  assert.equal(nextRequestOn({ ...oct, dayOfMonth: 17 }, utc("2026-10-17T09:00:00Z"), true), "2026-11-17");
  assert.equal(nextRequestOn({ ...oct, dayOfMonth: 17 }, utc("2026-10-17T09:00:00Z"), false), "2026-10-17");
  assert.equal(nextRequestOn({ ...oct, dayOfMonth: 15 }, utc("2026-10-17T09:00:00Z"), false), "2026-10-17"); // missed: today
  assert.equal(nextRequestOn({ ...oct, dayOfMonth: 28 }, utc("2026-12-31T23:00:00Z"), true), "2027-01-28");
  assert.equal(nextRequestOn({ ...oct, maxRequests: 2, opened: 2 }, utc("2026-10-17T09:00:00Z"), true), null);
  assert.equal(nextRequestOn({ ...oct, maxRequests: 3, opened: 2 }, utc("2026-10-21T09:00:00Z"), true), "2026-11-20");
  assert.equal(nextRequestOn({ ...oct, status: "ended" }, utc("2026-10-17T09:00:00Z"), false), null);
});

test("day labels", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(dayLabel),
    ["the 1st", "the 2nd", "the 3rd", "the 4th", "the 11th", "the 12th", "the 13th", "the 21st", "the 22nd", "the 23rd", "the 28th"]);
});

test("the cron accepts only Bearer CRON_SECRET, and nothing while it's unset or short", () => {
  const secret = "s".repeat(24);
  assert.equal(cronAuthorized(`Bearer ${secret}`, secret), true);
  assert.equal(cronAuthorized(`Bearer ${secret}x`, secret), false);
  assert.equal(cronAuthorized(secret, secret), false);
  assert.equal(cronAuthorized(`bearer ${secret}`, secret), false);
  assert.equal(cronAuthorized(null, secret), false);
  assert.equal(cronAuthorized("Bearer ", ""), false);
  assert.equal(cronAuthorized("Bearer undefined", undefined), false);
  assert.equal(cronAuthorized("Bearer short", "short"), false);
});

// ---------------------------------------------------------------- CSV (pure)

test("CSV cells are quoted, quotes doubled, and formula starts neutralised", () => {
  assert.equal(csvCell("rent"), '"rent"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("+1+2"), '"\'+1+2"');
  assert.equal(csvCell("-2+3"), '"\'-2+3"');
  assert.equal(csvCell("@SUM(A1)"), '"\'@SUM(A1)"');
  assert.equal(csvCell("\t=1"), '"\'\t=1"');
  assert.equal(csvCell("\r=1"), '"\'\r=1"');
  assert.equal(csvCell("a=1"), '"a=1"'); // only a leading character is a formula
  assert.equal(csvCell("line\nbreak, comma"), '"line\nbreak, comma"');
  assert.equal(csvLine(["a", null, "=b"]), '"a","","\'=b"');
  assert.equal(CSV_COLUMNS.length, 17);
});

test("QA-20: the export opens with the ledger's caution in one cell, and requester-written columns say unverified", () => {
  assert.equal(CSV_CAUTION, `# ${LEDGER_CAUTION} Columns marked (unverified) are as each request's creator wrote them.`);
  assert.match(csvLine([CSV_CAUTION]), /^"# Anyone can create a request that pays your wallet; Owed can't tell which ones you made\. /);
  assert.deepEqual(CSV_COLUMNS.filter((c) => c.endsWith("(unverified)")), ["payer_name (unverified)", "for (unverified)", "invoice_number (unverified)"]);
  // Every other column is server-made: ids, amounts, wallets, times, links.
  assert.equal(CSV_COLUMNS.filter((c) => c.includes("(")).length, 3);
});

const SECRET_A = "csv-test-secret-0123456789abcdefghijklmnop";
const ME_CSV = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";

test("a CSV link is HMAC-signed over recipient + expiry, valid 10 minutes, refused after", () => {
  const saved = process.env.CSV_LINK_SECRET;
  try {
    process.env.CSV_LINK_SECRET = SECRET_A;
    const now = utc("2026-10-17T14:00:00Z");
    const link = csvLink(ME_CSV, "https://www.getowed.xyz", now)!;
    assert.match(link.url, /^https:\/\/www\.getowed\.xyz\/api\/v1\/ledger\/csv\?recipient=FN6G4C[^&]+&expires=\d+&sig=[A-Za-z0-9_-]{43}$/);
    assert.equal(link.expires_at, "2026-10-17T14:10:00Z");
    const q = new URL(link.url).searchParams;
    assert.deepEqual(checkCsvLink(q, now), { ok: true, recipient: ME_CSV, expires: Date.parse(link.expires_at) / 1000 });
    assert.equal(checkCsvLink(q, now + 10 * 60_000).ok, true); // the last second
    const late = checkCsvLink(q, now + 10 * 60_000 + 1000);
    assert.deepEqual(late, { ok: false, status: 410, message: "this CSV link has expired (links last 10 minutes); ask who_owes_me for a fresh one" });

    // Another wallet, a later expiry or a changed signature: not ours.
    const other = new URLSearchParams(q); other.set("recipient", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    assert.equal((checkCsvLink(other, now) as { status: number }).status, 403);
    const longer = new URLSearchParams(q); longer.set("expires", String(Number(q.get("expires")) + 3600));
    assert.equal((checkCsvLink(longer, now) as { status: number }).status, 403);
    const sig = q.get("sig")!;
    const flipped = new URLSearchParams(q); flipped.set("sig", (sig[0] === "A" ? "B" : "A") + sig.slice(1));
    assert.equal((checkCsvLink(flipped, now) as { status: number }).status, 403);
    const missing = new URLSearchParams(q); missing.delete("sig");
    assert.equal((checkCsvLink(missing, now) as { status: number }).status, 400);

    // A different secret (rotated) invalidates every link.
    process.env.CSV_LINK_SECRET = SECRET_A.replace("csv", "CSV");
    assert.equal((checkCsvLink(q, now) as { status: number }).status, 403);
    // Unset or too short: nothing is minted or accepted.
    process.env.CSV_LINK_SECRET = "short";
    assert.equal(csvLink(ME_CSV, "https://www.getowed.xyz", now), null);
    assert.equal((checkCsvLink(q, now) as { status: number }).status, 503);
  } finally {
    if (saved === undefined) delete process.env.CSV_LINK_SECRET;
    else process.env.CSV_LINK_SECRET = saved;
  }
});

// ---------------------------------------------------------------- Postgres

interface PgResult { fields: { name: string; dataTypeID: number }[]; rows: unknown[][] }
interface Pg {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[], options?: Record<string, unknown>): Promise<{ rows: T[] } & Partial<PgResult>>;
  transaction<T>(fn: (tx: Pg) => Promise<T>): Promise<T>;
}
const PGLITE = "@electric-sql/pglite";
const mod = (await import(PGLITE).catch(() => null)) as { PGlite: new () => Pg } | null;
const it = mod ? test : test.skip;
const pg = mod ? new mod.PGlite() : (null as unknown as Pg);
const WEB = new URL("../", import.meta.url);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

interface DohFixture { query: { qname: string }; responses: Array<{ resolver: string; url: string; status: number; body: string }> }
const doh = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../plugin/test/fixtures/doh/${name}.json`, import.meta.url), "utf8")) as DohFixture;
/** The real example.com NODATA answer with these TXT values added, in each resolver's format (as payee-db.test.ts). */
function withTxt(f: DohFixture, values: string[]): DohFixture {
  return {
    ...f,
    responses: f.responses.map((r) => {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      const quoted = r.resolver === "cloudflare-dns.com";
      body.Answer = values.map((v) => ({ name: f.query.qname, type: 16, TTL: 300, data: quoted ? `"${v}"` : v }));
      delete body.Authority;
      return { ...r, body: JSON.stringify(body) };
    }),
  };
}
let dns: DohFixture | "down" = doh("nodata-signed");

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const CRON_SECRET = "cron-test-secret-abcdefghijklmnopqrstuvwxyz";
const BASE = "https://www.getowed.xyz";

before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(NEON)) {
      const body = JSON.parse(String(init!.body));
      try {
        if (body.queries) {
          const results = await pg.transaction(async (tx) => {
            const out = [];
            for (const q of body.queries) out.push(await run(q, tx));
            return out;
          });
          return Response.json({ results });
        }
        return Response.json(await run(body));
      } catch (e) {
        const err = e as { message: string; code?: string; constraint?: string };
        return Response.json({ message: err.message, code: err.code, constraint: err.constraint }, { status: 400 });
      }
    }
    if (/^https:\/\/(cloudflare-dns\.com|dns\.google)\//.test(url)) {
      if (dns === "down") throw new TypeError("fetch failed");
      const r = dns.responses.find((x) => x.url === url);
      if (!r) throw new TypeError(`unrecorded DNS request ${url}`);
      return new Response(r.body, { status: r.status });
    }
    throw new TypeError(`no network in this test: ${url}`); // Solana RPC: the ledger lists stored state
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.OWED_BASE_URL = BASE;
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.CSV_LINK_SECRET = SECRET_A;
  const dir = new URL("db/migrations/", WEB);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
});

beforeEach(async () => {
  if (!mod) return;
  await pg.exec(`delete from schedule_requests; delete from schedules; delete from invoices; delete from requests;
    delete from groups; delete from signature_nonces; delete from rate_events;`);
  dns = doh("nodata-signed");
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.CSV_LINK_SECRET = SECRET_A;
});

// Throwaway signers (fixed seeds); they hold nothing. PayBox signs the same way and returns hex.
const keyFor = (label: string) => nacl.sign.keyPair.fromSeed(Uint8Array.from(createHash("sha256").update(`owed test signer: schedules.test.ts ${label}`).digest()));
const KEY = keyFor("me");
const ME = bs58.encode(KEY.publicKey);
const signHex = (text: string) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), KEY.secretKey)).toString("hex");

const todayDay = () => dayOf(Date.now());
/** A day of the month that isn't today (1–28). */
const notToday = () => (todayDay() === 1 ? 2 : 1);

const postSchedule = async (body: Record<string, unknown>) => {
  const res = await schedulesPOST(new Request(`${BASE}/api/v1/schedules`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: ME, amount: "0.01", token: "USDC", payer_name: "Sam", for: "rent", source: "plugin", ...body }),
  }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
};
const cron = async (auth?: string) => {
  const res = await cronGET(new Request(`${BASE}/api/cron/schedules`, { headers: auth === undefined ? {} : { authorization: auth } }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const count = async (table: string) => Number((await pg.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0].n);

const schedule = (over: Partial<NewSchedule> = {}): NewSchedule => ({
  recipient: ME, token: "USDC", amountAtomic: 10_000n, payerName: "Sam", forText: "rent", requesterName: "Raj", flags: [],
  dayOfMonth: 28, maxRequests: null, source: "plugin", fromDomain: null, ...over,
});

it("POST on the schedule's day opens this month's request at once, made like any other", async () => {
  const day = todayDay() <= 28 ? todayDay() : null;
  if (day === null) return; // the 29th–31st can't be a schedule day; the cron tests cover the rest
  const { status, json } = await postSchedule({ day_of_month: day, requester_name: "Raj", for: "rent https://evil.example =1+2" });
  assert.equal(status, 201, JSON.stringify(json));
  const s = ScheduleResponse.parse(json);
  assert.equal(s.day_of_month, day);
  assert.equal(s.first_period, periodOf(Date.now()));
  assert.equal(s.for, "rent =1+2"); // the link is stripped, as on every request
  assert.ok(s.first_request);
  assert.equal(s.first_request.period, periodOf(Date.now()));
  assert.equal(s.next_request_on, dateIn(nextPeriod(periodOf(Date.now())), day));
  // The request id commits to its terms and the row is an ordinary open request.
  const row = (await getRequest(s.first_request.id))!;
  assert.equal(row.id, requestIdFor({ recipient: ME, token: "USDC", amountAtomic: 10_000n, reference: s.first_request.reference }));
  assert.deepEqual({ status: row.status, kind: row.kind, forText: row.forText, payerName: row.payerName, requesterName: row.requesterName, source: row.source },
    { status: "open", kind: "single", forText: "rent =1+2", payerName: "Sam", requesterName: "Raj", source: "plugin" });
  assert.match(s.first_request.solana_pay_url, new RegExp(`^solana:${ME}\\?amount=0\\.01&spl-token=EPjF`));
  assert.equal(s.first_request.link, `${BASE}/r/${row.id}`);
  // The cron finds it already open: nothing new.
  const again = await cron(`Bearer ${CRON_SECRET}`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.opened, []);
  assert.equal(await count("requests"), 1);
});

it("POST on any other day stores the schedule and says when the first request opens", async () => {
  const day = notToday();
  const { status, json } = await postSchedule({ day_of_month: day, months: 6 });
  assert.equal(status, 201, JSON.stringify(json));
  const s = ScheduleResponse.parse(json);
  assert.equal(s.first_request, null);
  assert.equal(s.months, 6);
  assert.equal(s.status, "active");
  const now = Date.now();
  const expected = todayDay() < day ? dateIn(periodOf(now), day) : dateIn(nextPeriod(periodOf(now)), day);
  assert.equal(s.next_request_on, expected);
  assert.equal(await count("requests"), 0);
});

it("POST refuses bad days, amounts and recipients, an unpublished domain, and a 21st active schedule", async () => {
  for (const day of [0, 29, 31, 1.5, "1"]) {
    const r = await postSchedule({ day_of_month: day });
    assert.equal(r.status, 400, `day ${day}`);
    assert.equal(r.json.error?.code, "invalid_input");
  }
  assert.equal((await postSchedule({ day_of_month: 3, amount: "0" })).status, 400);
  assert.equal((await postSchedule({ day_of_month: 3, amount: "1.0000001" })).status, 400);
  assert.equal((await postSchedule({ day_of_month: 3, months: 0 })).status, 400);
  assert.equal((await postSchedule({ day_of_month: 3, months: 121 })).status, 400);
  // A program-derived address (off curve, like a token account) would strand the money.
  const pda = PublicKey.findProgramAddressSync([Buffer.from("owed")], new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))[0].toBase58();
  assert.equal((await postSchedule({ day_of_month: 3, recipient: pda })).status, 400);
  dns = withTxt(doh("nodata-signed"), ["owed-pay=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]);
  const unpublished = await postSchedule({ day_of_month: 3, from_domain: "example.com" });
  assert.equal(unpublished.status, 400);
  assert.match(unpublished.json.error!.message, new RegExp(`_owed\\.example\\.com with the value owed-pay=${ME}`));
  assert.equal(await count("schedules"), 0);

  for (let i = 0; i < SCHEDULE_LIMITS.activePerRecipient; i++) await createSchedule(schedule({ dayOfMonth: notToday() }));
  const capped = await postSchedule({ day_of_month: notToday() });
  assert.equal(capped.status, 400);
  assert.match(capped.json.error!.message, /20 active monthly requests/);
});

it("the cron refuses a missing or wrong secret, and runs nothing while CRON_SECRET is unset", async () => {
  await createSchedule(schedule({ dayOfMonth: 1 }), { now: utc("2026-10-01T00:00:00Z"), openNow: false });
  await pg.exec(`update schedules set first_period = '${periodOf(Date.now())}', day_of_month = 1`);
  assert.equal((await cron()).status, 401);
  assert.equal((await cron("Bearer wrong")).status, 401);
  assert.equal((await cron(CRON_SECRET)).status, 401);
  delete process.env.CRON_SECRET;
  const unset = await cron("Bearer undefined");
  assert.equal(unset.status, 503);
  assert.equal(await count("requests"), 0);
  process.env.CRON_SECRET = CRON_SECRET;
  const ok = await cron(`Bearer ${CRON_SECRET}`);
  assert.equal(ok.status, 200);
  assert.equal((ok.json.opened as unknown[]).length, 1);
});

it("the cron opens exactly one request per schedule per month, however often and however concurrently it runs", async () => {
  const now = Date.now();
  const due = await createSchedule(schedule({ dayOfMonth: 1 }), { now, openNow: false });
  const later = await createSchedule(schedule({ dayOfMonth: 28, payerName: "Alex" }), { now, openNow: false });
  // Both made earlier in the month; the first is due today (its day, the 1st, has come).
  await pg.exec(`update schedules set first_period = '${periodOf(now)}'`);

  const first = await cron(`Bearer ${CRON_SECRET}`);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const opened = first.json.opened as Array<{ schedule_id: string; period: string; request_id: string }>;
  const dueNow = todayDay() >= 28 ? 2 : 1;
  assert.equal(opened.length, dueNow);
  assert.equal(opened.find((o) => o.schedule_id === due.schedule.id)?.period, periodOf(now));
  assert.equal(await count("requests"), dueNow);

  const second = await cron(`Bearer ${CRON_SECRET}`);
  assert.deepEqual(second.json.opened, []);
  assert.equal(second.json.due, 0);

  // Two runs at once on a fresh month: the claim lets exactly one of them open it.
  await pg.exec("delete from schedule_requests; delete from requests;");
  const [a, b] = await Promise.all([runDueSchedules(), runDueSchedules()]);
  assert.equal(a.opened.length + b.opened.length, dueNow);
  assert.equal(await count("requests"), dueNow);
  assert.equal(await count("schedule_requests where request_id is not null"), dueNow);
  void later;
});

it("across month ends: due from its day, caught up later in the month, never back-filled into the next", async () => {
  const { schedule: s } = await createSchedule(schedule({ dayOfMonth: 28 }), { now: utc("2026-10-02T10:00:00Z"), openNow: false });
  assert.equal(s.firstPeriod, "2026-10");
  assert.equal((await runDueSchedules({ now: utc("2026-10-27T23:59:59Z") })).opened.length, 0);
  assert.equal((await runDueSchedules({ now: utc("2026-10-31T23:00:00Z") })).opened.length, 1); // missed the 28th: caught up
  assert.equal((await runDueSchedules({ now: utc("2026-10-31T23:30:00Z") })).opened.length, 0);
  assert.equal((await runDueSchedules({ now: utc("2026-11-01T00:00:00Z") })).opened.length, 0); // November's day hasn't come
  const nov = await runDueSchedules({ now: utc("2026-11-28T00:00:00Z") });
  assert.deepEqual(nov.opened.map((o) => o.period), ["2026-11"]);
  const jan = await runDueSchedules({ now: utc("2027-01-29T00:00:00Z") }); // December was missed entirely: not back-filled
  assert.deepEqual(jan.opened.map((o) => o.period), ["2027-01"]);
  const periods = (await pg.query<{ period: string }>("select period from schedule_requests order by period")).rows.map((r) => r.period);
  assert.deepEqual(periods, ["2026-10", "2026-11", "2027-01"]);
});

it("a fixed number of months ends the schedule after its last request", async () => {
  await createSchedule(schedule({ dayOfMonth: 5, maxRequests: 2 }), { now: utc("2026-10-01T00:00:00Z"), openNow: false });
  assert.equal((await runDueSchedules({ now: utc("2026-10-05T00:00:00Z") })).opened.length, 1);
  assert.equal((await runDueSchedules({ now: utc("2026-11-05T00:00:00Z") })).opened.length, 1);
  assert.equal((await pg.query<{ status: string }>("select status from schedules")).rows[0].status, "ended");
  assert.equal((await runDueSchedules({ now: utc("2026-12-05T00:00:00Z") })).opened.length, 0);
  assert.equal(await count("requests"), 2);
});

it("a claim left by a run that died is retried after 10 minutes, not before", async () => {
  const { schedule: s } = await createSchedule(schedule({ dayOfMonth: 5 }), { now: utc("2026-10-01T00:00:00Z"), openNow: false });
  await pg.query("insert into schedule_requests (schedule_id, period, claimed_at) values ($1, '2026-10', now() - interval '2 minutes')", [s.id]);
  assert.equal((await runDueSchedules({ now: utc("2026-10-06T00:00:00Z") })).opened.length, 0);
  await pg.exec("update schedule_requests set claimed_at = now() - interval '11 minutes'");
  const retried = await runDueSchedules({ now: utc("2026-10-06T00:00:00Z") });
  assert.equal(retried.opened.length, 1);
  assert.equal(await count("requests"), 1);
});

it("a verified domain is re-checked every month: unpublished or unreadable opens nothing and says why", async () => {
  dns = withTxt(doh("nodata-signed"), [`owed-pay=${ME}`]);
  const created = await postSchedule({ day_of_month: notToday(), from_domain: "Example.com" });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(ScheduleResponse.parse(created.json).from_domain, "example.com");
  await pg.exec(`update schedules set first_period = '2026-10', day_of_month = 5`);
  const at = utc("2026-10-06T00:00:00Z");

  dns = withTxt(doh("nodata-signed"), ["owed-pay=9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]); // the record changed
  const refused = await runDueSchedules({ now: at });
  assert.equal(refused.opened.length, 0);
  assert.match(refused.skipped[0]?.reason ?? "", /^example\.com: from_domain: example\.com does not publish this recipient/);
  assert.equal(await count("requests"), 0);
  assert.equal(await count("schedule_requests"), 0); // the claim is released for the next run
  assert.match((await pg.query<{ last_error: string }>("select last_error from schedules")).rows[0].last_error, /does not publish/);

  dns = "down";
  const down = await runDueSchedules({ now: at });
  assert.match(down.skipped[0]?.reason ?? "", /couldn't be read right now/);

  dns = withTxt(doh("nodata-signed"), [`owed-pay=${ME}`]);
  const ok = await runDueSchedules({ now: at });
  assert.equal(ok.opened.length, 1);
  const row = (await getRequest(ok.opened[0].request_id))!;
  assert.equal(row.fromDomain, "example.com");
  assert.ok(row.fromDomainVerifiedAt);
  assert.equal((await pg.query<{ last_error: string | null }>("select last_error from schedules")).rows[0].last_error, null);
});

it("brand words in the schedule's text are flagged on every month's request", async () => {
  const { status } = await postSchedule({ day_of_month: notToday(), for: "PayBox rent" });
  assert.equal(status, 201);
  await pg.exec(`update schedules set first_period = '2026-10', day_of_month = 5`);
  const r = await runDueSchedules({ now: utc("2026-10-07T00:00:00Z") });
  const row = (await getRequest(r.opened[0].request_id))!;
  assert.deepEqual(row.flags, ["brand_word:paybox"]);
});

// ---------------------------------------------------------------- the ledger: schedules + CSV

const ledgerMessage = (at = Date.now()) => `${ledgerPrefix(ME)} at ${isoSeconds(at)}`;
const ledger = async (extra: Record<string, unknown> = {}) => {
  const msg = ledgerMessage();
  const res = await ledgerPOST(new Request(`${BASE}/api/v1/ledger`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient: ME, signed_message: msg, signature: signHex(msg), ...extra }),
  }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const download = (url: string) => csvGET(new Request(url));

it("who_owes_me's ledger lists each schedule with its months, and tags the requests it opened", async () => {
  const { schedule: s } = await createSchedule(schedule({ dayOfMonth: 5, payerName: "Sam", forText: "rent" }), { now: utc("2026-09-01T00:00:00Z"), openNow: false });
  await runDueSchedules({ now: utc("2026-09-05T00:00:00Z") });
  await runDueSchedules({ now: utc("2026-10-05T00:00:00Z") });
  await createSchedule(schedule({ dayOfMonth: notToday(), payerName: "Alex", forText: "gym", maxRequests: 3 }));

  const res = await ledger();
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const l = LedgerResponse.parse(res.json);
  assert.equal(l.csv, undefined); // not asked for
  assert.equal(l.schedules?.length, 2);
  const rent = l.schedules!.find((x) => x.id === s.id)!;
  assert.deepEqual({ amount: rent.amount, token: rent.token, payer_name: rent.payer_name, for: rent.for, day: rent.day_of_month, opened: rent.requests_opened, months: rent.months },
    { amount: "0.01", token: "USDC", payer_name: "Sam", for: "rent", day: 5, opened: 2, months: null });
  assert.deepEqual(rent.requests.map((r) => r.period), ["2026-10", "2026-09"]);
  assert.ok(rent.requests.every((r) => r.status === "open" && r.link === `${BASE}/r/${r.id}`));
  const gym = l.schedules!.find((x) => x.id !== s.id)!;
  assert.equal(gym.requests_opened, 0);
  assert.equal(gym.months, 3);
  assert.match(gym.next_request_on ?? "", /^\d{4}-\d{2}-\d{2}$/);

  const tagged = l.open.filter((e) => e.schedule_id === s.id).map((e) => e.period).sort();
  assert.deepEqual(tagged, ["2026-09", "2026-10"]);
});

it("csv: true returns a link that downloads open + paid as escaped CSV, and refuses it after 10 minutes", async () => {
  const { schedule: s } = await createSchedule(schedule({ dayOfMonth: 5, payerName: "@Sam", forText: "=1+2 rent" }), { now: utc("2026-10-01T00:00:00Z"), openNow: false });
  const opened = await runDueSchedules({ now: utc("2026-10-05T00:00:00Z") });
  const requestId = opened.opened[0].request_id;
  // One paid request (a real mainnet transaction signature, as ledger.test.ts uses).
  const sig = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";
  const ref = bs58.encode(createHash("sha256").update("schedules.test paid").digest());
  const paidId = requestIdFor({ recipient: ME, token: "USDC", amountAtomic: 2_500_000n, reference: ref });
  await pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, payer_name, for_text, source, status,
       paid_signature, paid_payer, paid_amount_atomic, paid_at, paid_rail)
     values ($1, $2, 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, 2500000, $3, '-Priya', 'dinner, "Friday"', 'plugin', 'paid',
       $4, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 2500000, '2026-10-16T19:00:00Z', 'solana_pay')`,
    [paidId, ME, ref, sig],
  );

  const res = await ledger({ csv: true });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const l = LedgerResponse.parse(res.json);
  assert.ok(l.csv);
  assert.match(l.csv.url, new RegExp(`^${BASE.replace(/\./g, "\\.")}/api/v1/ledger/csv\\?recipient=${ME}&expires=\\d+&sig=`));
  const expiresMs = Date.parse(l.csv.expires_at);
  assert.ok(expiresMs - Date.now() <= 10 * 60_000 && expiresMs - Date.now() > 9 * 60_000);

  const file = await download(l.csv.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.match(file.headers.get("content-disposition") ?? "", /^attachment; filename="owed-[^"]+\.csv"$/);
  assert.equal(file.headers.get("cache-control"), "no-store, private");
  assert.equal(file.headers.get("referrer-policy"), "no-referrer");
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM, for spreadsheet apps
  const lines = bytes.subarray(3).toString("utf8").split("\r\n");
  assert.equal(lines.at(-1), "");
  assert.equal(lines[0], csvLine([CSV_CAUTION])); // QA-20: first, before the header
  assert.equal(lines[1], csvLine(CSV_COLUMNS));
  assert.equal(lines.length, 5); // caution, header, 2 rows, trailing newline
  const paidLine = lines.find((x) => x.startsWith(`"${paidId}"`))!;
  assert.equal(paidLine, csvLine([
    paidId, "single", "paid", "2.5", "USDC", "2.5", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", `https://solscan.io/tx/${sig}`,
    (await getRequest(paidId))!.createdAt, "2026-10-16T19:00:00Z", "-Priya", 'dinner, "Friday"', null, `${BASE}/r/${paidId}`, null, null, null,
  ]));
  assert.ok(paidLine.includes(`"'-Priya","dinner, ""Friday"""`)); // formula start neutralised, quotes doubled
  const openLine = lines.find((x) => x.startsWith(`"${requestId}"`))!;
  assert.ok(openLine.includes(`"'@Sam","'=1+2 rent"`));
  assert.ok(openLine.endsWith(`"${s.id}","2026-10"`));

  // The same link after 10 minutes: refused. (Minted as if 10 min 1 s ago.)
  const stale = csvLink(ME, BASE, Date.now() - 10 * 60_000 - 1000)!;
  const gone = await download(stale.url);
  assert.equal(gone.status, 410);
  assert.match(((await gone.json()) as { error: { message: string } }).error.message, /expired/);
  // Someone else's wallet in a link we signed for ME: refused.
  const swapped = new URL(l.csv.url);
  swapped.searchParams.set("recipient", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  assert.equal((await download(swapped.toString())).status, 403);
});

it("without CSV_LINK_SECRET the ledger says csv: null and no link is accepted", async () => {
  delete process.env.CSV_LINK_SECRET;
  const res = await ledger({ csv: true });
  assert.equal(res.status, 200);
  assert.equal(LedgerResponse.parse(res.json).csv, null);
  const r = await download(`${BASE}/api/v1/ledger/csv?recipient=${ME}&expires=${Math.floor(Date.now() / 1000) + 60}&sig=${"A".repeat(43)}`);
  assert.equal(r.status, 503);
});
