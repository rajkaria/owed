import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { POST as ctaRoute } from "@/app/api/v1/cta/route";
import { GET as payboxRoute, HEAD as payboxHead } from "@/app/api/v1/cta/paybox/route";
import { POST as createRoute } from "@/app/api/v1/requests/route";
import { GET as statsRoute } from "@/app/api/v1/stats/route";
import { ErrorResponse, StatsResponse } from "@/lib/contract";
import { CTA_LIMITS, ctaSettled, PAYBOX_APP_URL } from "@/lib/cta";
import { sql } from "@/lib/db";
import { check, shapes } from "../../contract/shapes.mjs";

// SP1 "Pay with PayBox" counters on real Postgres: migration 0016 after every earlier one, the redirect
// (GET /api/v1/cta/paybox), the prompt-copy POST (/api/v1/cta) and GET /api/v1/stats, with PGlite answering
// lib/db.ts's Neon-over-HTTP calls. Any other network call fails. Skips until @electric-sql/pglite is installed.

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
const MIGRATIONS = new URL("../db/migrations/", import.meta.url);
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 2278, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
let neonDown = false;
before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(NEON)) {
      if (neonDown) throw new TypeError("fetch failed");
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
    throw new TypeError(`no network in this test: ${url}`);
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  delete process.env.OWED_BASE_URL;
  for (const f of migrationFiles()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  neonDown = false;
  if (mod) await pg.exec("delete from cta_events; delete from rate_events;");
});

const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const IP = "203.0.113.77";
const UA = "Mozilla/5.0 (zq-agent-marker)";
const ORIGIN = "https://owed-preview.example";

async function newRequest(amount = "0.01"): Promise<string> {
  const res = await createRoute(new Request(`${ORIGIN}/api/v1/requests`, {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": "198.51.100.1" },
    body: JSON.stringify({ recipient: TEAM, amount, token: "USDC", source: "web", for: "SP1 counters" }),
  }));
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}
const click = (query: string) =>
  payboxRoute(new Request(`${ORIGIN}/api/v1/cta/paybox${query}`, { headers: { "x-real-ip": IP, "user-agent": UA } }));
const copy = (body: unknown, contentType = "application/json") =>
  ctaRoute(new Request(`${ORIGIN}/api/v1/cta`, {
    method: "POST", headers: { "content-type": contentType, "x-real-ip": IP, "user-agent": UA },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const rows = async () => sql("select kind, request_id, day::text as day, events::text as events from cta_events order by kind, request_id, day");
const todayUtc = () => new Date().toISOString().slice(0, 10);
const UNKNOWN_ID = "zzzzzzzzzzzz"; // valid base58 shape, no such request

function assertRedirect(res: Response) {
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), PAYBOX_APP_URL);
  assert.equal(res.headers.get("cache-control"), "no-store"); // a CDN must never answer for the counter
  assert.match(res.headers.get("x-robots-tag") ?? "", /noindex/);
}

it("migration 0016 applies on top of 0001–0015 alone, and its table holds only kind, request, day and a count", async () => {
  const fresh = new mod!.PGlite();
  const files = migrationFiles();
  assert.ok(files.includes("0016_cta_events.sql"));
  const earlier = files.filter((f) => f < "0016");
  assert.ok(earlier.length >= 15, earlier.join(","));
  for (const f of earlier) await fresh.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  await fresh.exec(readFileSync(new URL("0016_cta_events.sql", MIGRATIONS), "utf8"));
  const cols = (await fresh.query<{ column_name: string; data_type: string; is_nullable: string }>(
    "select column_name, data_type, is_nullable from information_schema.columns where table_name = 'cta_events' order by ordinal_position",
  )).rows;
  // No IP address, user agent, cookie or time finer than the day: nothing personal to store.
  assert.deepEqual(cols.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
    ["kind", "text", "NO"], ["request_id", "text", "NO"], ["day", "date", "NO"], ["events", "integer", "NO"],
  ]);
  const rls = (await fresh.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'cta_events'")).rows[0];
  assert.equal(rls?.relrowsecurity, true);
});

it("the table refuses unknown kinds, unknown requests and non-positive counts", async () => {
  const id = await newRequest();
  const refused = async (q: string, params: unknown[], code: string) => {
    await assert.rejects(pg.query(q, params), (e: { code?: string }) => e.code === code);
  };
  await refused("insert into cta_events (kind, request_id) values ('pageview', $1)", [id], "23514");
  await refused("insert into cta_events (kind, request_id) values ('paybox_click', $1)", [UNKNOWN_ID], "23503");
  await refused("insert into cta_events (kind, request_id, events) values ('prompt_copy', $1, 0)", [id], "23514");
  await pg.query("insert into cta_events (kind, request_id) values ('prompt_copy', $1)", [id]);
  await refused("insert into cta_events (kind, request_id) values ('prompt_copy', $1)", [id], "23505"); // one row per kind, request and day
  assert.deepEqual(await rows(), [{ kind: "prompt_copy", request_id: id, day: todayUtc(), events: "1" }]);
});

it("GET /api/v1/cta/paybox?r=<id> answers 302 to app.paybox.sh and counts one paybox_click per click", async () => {
  const id = await newRequest();
  assertRedirect(await click(`?r=${id}`));
  await ctaSettled();
  assert.deepEqual(await rows(), [{ kind: "paybox_click", request_id: id, day: todayUtc(), events: "1" }]);
  assertRedirect(await click(`?r=${id}`));
  await ctaSettled();
  assert.deepEqual(await rows(), [{ kind: "paybox_click", request_id: id, day: todayUtc(), events: "2" }]);
  // HEAD (link checkers, previews) redirects too but counts nothing.
  const head = await payboxHead();
  assertRedirect(head);
  await ctaSettled();
  assert.equal((await rows())[0]!.events, "2");
  // Nothing about the person who clicked is kept, not even in the rate limiter's keys.
  const stored = JSON.stringify([await sql("select * from cta_events"), await sql("select key from rate_events")]);
  assert.ok(!stored.includes(IP) && !stored.includes("zq-agent-marker"), stored);
});

it("an invalid, missing or unknown id still redirects but records nothing", async () => {
  await newRequest();
  for (const query of ["", "?r=", "?r=bad_id-0OIl", "?r=0OIl0OIl0OIl", `?r=${"a".repeat(13)}`, "?r=abc", `?x=${UNKNOWN_ID}`, `?r=${UNKNOWN_ID}`, "?r=%00%01"]) {
    assertRedirect(await click(query));
  }
  await ctaSettled();
  assert.deepEqual(await rows(), []);
  // Malformed ids never reach the rate limiter; an unknown one isn't charged to the global budget either.
  assert.deepEqual(await sql("select key from rate_events where key like 'cta:%'"), []);
});

it("the redirect still answers at once when the database is down", async () => {
  const id = await newRequest();
  neonDown = true;
  assertRedirect(await click(`?r=${id}`));
  await ctaSettled(); // the failed write is logged and swallowed
  neonDown = false;
  assert.deepEqual(await rows(), []);
});

it("POST /api/v1/cta records a prompt_copy and answers 204", async () => {
  const id = await newRequest();
  const res = await copy({ event: "prompt_copy", request: id });
  assert.equal(res.status, 204, await res.clone().text());
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await copy({ event: "prompt_copy", request: id })).status, 204);
  assert.deepEqual(await rows(), [{ kind: "prompt_copy", request_id: id, day: todayUtc(), events: "2" }]);
});

it("POST validates the event kind, the id and the body, and records nothing it refuses", async () => {
  const id = await newRequest();
  const cases: Array<[unknown, number, string, string?]> = [
    [{ event: "paybox_click", request: id }, 400, "invalid_input"], // the link counts clicks; POST can't add them
    [{ event: "pageview", request: id }, 400, "invalid_input"],
    [{ request: id }, 400, "invalid_input"],
    [{ event: "prompt_copy" }, 400, "invalid_input"],
    [{ event: "prompt_copy", request: "bad_id-0OIl" }, 400, "invalid_input"],
    [{ event: "prompt_copy", request: 12 }, 400, "invalid_input"],
    [[], 400, "invalid_input"],
    ["not json", 400, "invalid_input"],
    [{ event: "prompt_copy", request: id }, 400, "invalid_input", "text/plain"], // a cross-site form post can't count
    [{ event: "prompt_copy", request: UNKNOWN_ID }, 404, "not_found"],
  ];
  for (const [body, status, code, type] of cases) {
    const res = await copy(body, type);
    assert.equal(res.status, status, JSON.stringify(body));
    const err = ErrorResponse.parse(await res.json());
    assert.equal(err.error.code, code, JSON.stringify(body));
    assert.equal(check(shapes.errorRes, err).errors.length, 0);
  }
  assert.deepEqual(await rows(), []);
});

it("counts are capped per request and per hour; over the cap the link still redirects and POST answers 429", async () => {
  const id = await newRequest();
  await pg.query("insert into rate_events (key) select $1 from generate_series(1, $2::int)", [`cta:prompt_copy:request:${id}`, CTA_LIMITS.perRequestPerHour]);
  await pg.query("insert into rate_events (key) select $1 from generate_series(1, $2::int)", [`cta:paybox_click:request:${id}`, CTA_LIMITS.perRequestPerHour]);
  const res = await copy({ event: "prompt_copy", request: id });
  assert.equal(res.status, 429);
  assert.equal(ErrorResponse.parse(await res.json()).error.code, "rate_limited");
  assert.match(res.headers.get("retry-after") ?? "", /^\d+$/);
  assertRedirect(await click(`?r=${id}`));
  await ctaSettled();
  assert.deepEqual(await rows(), []);
  // Another request is unaffected; the global cap is a backstop for many requests at once.
  const other = await newRequest("0.02");
  assert.equal((await copy({ event: "prompt_copy", request: other })).status, 204);
  await pg.query("insert into rate_events (key) select 'cta:prompt_copy:all' from generate_series(1, $1::int)", [CTA_LIMITS.globalPerHour]);
  assert.equal((await copy({ event: "prompt_copy", request: other })).status, 429);
  assert.deepEqual((await rows()).map((r) => [r.request_id, r.events]), [[other, "1"]]);
});

it("GET /api/v1/stats adds cta totals since launch and keeps every field and its cache headers", async () => {
  const a = await newRequest("0.03");
  const b = await newRequest("0.04");
  for (const id of [a, a, b]) assertRedirect(await click(`?r=${id}`));
  await ctaSettled();
  for (const id of [b, b]) assert.equal((await copy({ event: "prompt_copy", request: id })).status, 204);
  // Earlier days count in the totals too.
  await pg.query("insert into cta_events (kind, request_id, day, events) values ('paybox_click', $1, date '2026-10-17', 4)", [a]);

  const res = await statsRoute();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, s-maxage=10, stale-while-revalidate=50");
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["cta", "paid_count", "paid_volume_usdc", "pots", "since"]); // F7: + pots (0019)
  assert.deepEqual(body.cta, { paybox_clicks: 7, prompt_copies: 2 });
  assert.equal(body.since, "2026-10-17T00:00:00Z");
  assert.equal(typeof body.paid_count, "number");
  StatsResponse.parse(body); // the web contract (zod strips the extra key, as the plugin's does)
  const shape = check(shapes.statsRes, body);
  assert.deepEqual(shape.errors, []);

  // Per day and in total, from the table itself (the query in the migration's header).
  const daily = await sql(
    `select day::text as day, kind, sum(events)::text as n from cta_events group by day, kind order by day, kind`,
  );
  assert.deepEqual(daily.map((r) => [r.day, r.kind, r.n]), [
    ["2026-10-17", "paybox_click", "4"],
    [todayUtc(), "paybox_click", "3"],
    [todayUtc(), "prompt_copy", "2"],
  ]);
});

it("stats leaves cta out (and keeps working) while migration 0016 isn't applied yet", async () => {
  await pg.exec("alter table cta_events rename to cta_events_parked");
  try {
    const res = await statsRoute();
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["paid_count", "paid_volume_usdc", "pots", "since"]); // F7: + pots (0019)
    assert.deepEqual(check(shapes.statsRes, body).errors, []);
    // The redirect keeps working too: it never waits for the counter.
    assertRedirect(await click(`?r=${UNKNOWN_ID}`));
    await ctaSettled();
  } finally {
    await pg.exec("alter table cta_events_parked rename to cta_events");
  }
});
