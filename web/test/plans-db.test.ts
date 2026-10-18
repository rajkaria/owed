import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { POST as planRoute } from "@/app/api/v1/plans/route";
import { POST as usedRoute } from "@/app/api/v1/plans/[id]/used/route";
import { GET as statsRoute } from "@/app/api/v1/plans/stats/route";
import { POST as createRoute } from "@/app/api/v1/requests/route";
import { CreatePlanBody, CreatePlanResponse, ErrorResponse, PlanStatsResponse, PlanUsedResponse } from "@/lib/contract";
import { sql } from "@/lib/db";
import { attributePaidPlans, newPlanId, PLAN_LIMITS, PLANS_SINCE } from "@/lib/plans";
import { check, shapes as allShapes } from "../../contract/shapes.mjs";

// F2 funding plans on real Postgres: migration 0018 after every earlier one, POST /api/v1/plans (validation, unknown
// requests, the per-sender cap), POST /api/v1/plans/<id>/used (only the plan's own sender), and GET /api/v1/plans/stats
// with "paid" read from the requests table alone. PGlite answers lib/db.ts's Neon-over-HTTP calls; any other network
// call fails. Skips until @electric-sql/pglite is installed.

interface PgResult { fields: { name: string; dataTypeID: number }[]; rows: unknown[][] }
interface Pg {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[], options?: Record<string, unknown>): Promise<{ rows: T[] } & Partial<PgResult>>;
  transaction<T>(fn: (tx: Pg) => Promise<T>): Promise<T>;
}
// Plan shapes are added to contract/shapes.mjs with Object.assign, so TypeScript can't see them on `shapes`.
const shapes = allShapes as unknown as Record<"createPlanReq" | "createPlanRes" | "planUsedRes" | "planStatsRes", Parameters<typeof check>[0]>;
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
    throw new TypeError(`no network in this test: ${url}`);
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  delete process.env.OWED_BASE_URL;
  for (const f of migrationFiles()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  if (mod) await pg.exec("delete from funding_plans; delete from rate_events;");
});

const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const SENDER = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ORIGIN = "https://owed-preview.example";
const IP = "203.0.113.9";

async function newRequest(amount = "0.05"): Promise<string> {
  const res = await createRoute(new Request(`${ORIGIN}/api/v1/requests`, {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": "198.51.100.2" },
    body: JSON.stringify({ recipient: TEAM, amount, token: "USDC", source: "plugin", for: "F2 plans" }),
  }));
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { id: string }).id;
}
const body = (ids: string[], over: Record<string, unknown> = {}) => ({
  tool: "pay_link", sender: SENDER, request_ids: ids, shortfall: { token: "USDC", atomic: "50000" }, options: ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc"], ...over,
});
const offer = (b: unknown, ip = IP, contentType = "application/json") => planRoute(new Request(`${ORIGIN}/api/v1/plans`, {
  method: "POST", headers: { "content-type": contentType, "x-real-ip": ip }, body: typeof b === "string" ? b : JSON.stringify(b),
}));
const used = (id: string, sender: string) => usedRoute(
  new Request(`${ORIGIN}/api/v1/plans/${id}/used`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": IP }, body: JSON.stringify({ sender }) }),
  { params: Promise.resolve({ id }) } as never,
);
const stats = async () => {
  const res = await statsRoute();
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(check(shapes.planStatsRes, data).errors, []);
  return PlanStatsResponse.parse(data);
};
async function offered(ids: string[], over: Record<string, unknown> = {}): Promise<string> {
  const res = await offer(body(ids, over));
  assert.equal(res.status, 201, await res.clone().text());
  const data = await res.json();
  assert.deepEqual(check(shapes.createPlanRes, data).errors, []);
  return CreatePlanResponse.parse(data).plan_id;
}
async function markPaid(id: string, payer: string, at = "now()") {
  await sql(`update requests set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = amount_atomic, paid_at = ${at}, paid_rail = 'solana_pay' where id = $1`,
    [id, `sig-${id}-${Math.random().toString(36).slice(2)}`, payer]);
}

it("migration 0018 applies on top of 0001–0017 alone; the table holds no balance, price, IP or text, and refuses bad rows", async () => {
  const fresh = new mod!.PGlite();
  const files = migrationFiles();
  assert.ok(files.includes("0018_funding_plans.sql"));
  for (const f of files.filter((f) => f < "0018")) await fresh.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  await fresh.exec(readFileSync(new URL("0018_funding_plans.sql", MIGRATIONS), "utf8"));
  const cols = (await fresh.query<{ column_name: string; data_type: string }>(
    "select column_name, data_type from information_schema.columns where table_name = 'funding_plans' order by ordinal_position",
  )).rows;
  assert.deepEqual(cols.map((c) => [c.column_name, c.data_type]), [
    ["id", "text"], ["created_at", "timestamp with time zone"], ["tool", "text"], ["sender", "text"], ["request_ids", "ARRAY"],
    ["shortfall_token", "text"], ["shortfall_atomic", "numeric"], ["option_kinds", "ARRAY"], ["used_at", "timestamp with time zone"], ["paid_at", "timestamp with time zone"],
  ]);
  const rls = (await fresh.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'funding_plans'")).rows[0];
  assert.equal(rls?.relrowsecurity, true);
  const insert = (over: Partial<Record<"id" | "tool" | "sender" | "request_ids" | "token" | "atomic" | "kinds", string>>) => {
    const v = { id: "'P1anAbCdEfGh'", tool: "'pay_link'", sender: `'${SENDER}'`, request_ids: "'{}'", token: "'USDC'", atomic: "1", kinds: "'{buy_usdc}'", ...over };
    return fresh.exec(`insert into funding_plans (id, tool, sender, request_ids, shortfall_token, shortfall_atomic, option_kinds) values (${v.id}, ${v.tool}, ${v.sender}, ${v.request_ids}, ${v.token}, ${v.atomic}, ${v.kinds})`);
  };
  await insert({});
  for (const bad of [{ id: "'short'" }, { kinds: "'{teleport}'" }, { kinds: "'{}'" }, { atomic: "0" }, { token: "'BONK'" }, { sender: "'not a wallet'" }, { tool: "'pay_all'", id: "'P2anAbCdEfGh'" }]) {
    await assert.rejects(insert({ id: "'P3anAbCdEfGh'", ...bad }), /violates|invalid|malformed/, JSON.stringify(bad));
  }
  await insert({ id: "'B4seAbCdEfGh'", sender: "'0x52908400098527886E0F7030069857D2E4169EE7'" }); // a Base sender
});

it("POST /plans records the offer and nothing else; GET /plans/stats counts it", async () => {
  const id = await newRequest();
  const planId = await offered([id]);
  assert.match(planId, /^[1-9A-HJ-NP-Za-km-z]{12}$/);
  const [row] = await sql("select tool, sender, request_ids::text as ids, shortfall_token, shortfall_atomic::text as atomic, option_kinds::text as kinds, used_at, paid_at from funding_plans where id = $1", [planId]);
  assert.deepEqual(row, { tool: "pay_link", sender: SENDER, ids: `{${id}}`, shortfall_token: "USDC", atomic: "50000", kinds: "{swap_sol,bridge_base_usdc,swap_other,buy_usdc}", used_at: null, paid_at: null });
  assert.deepEqual(await stats(), { offered: 1, used: 0, paid: 0, since: PLANS_SINCE });
  const res = await statsRoute();
  assert.equal(res.headers.get("cache-control"), "public, s-maxage=10, stale-while-revalidate=50");
});

it("POST /plans: a link that isn't an Owed request has no ids; pay_all must name its requests; unknown ids are 404", async () => {
  assert.ok(await offered([]));
  const bad = await offer(body([], { tool: "pay_all" }));
  assert.equal(bad.status, 400);
  const unknown = await offer(body(["zzzzzzzzzzzz"]));
  assert.equal(unknown.status, 404);
  assert.match(ErrorResponse.parse(await unknown.json()).error.message, /no request with the id zzzzzzzzzzzz/);
  assert.equal((await sql("select count(*)::text as n from funding_plans"))[0]!.n, "1");
});

it("POST /plans refuses what isn't a plan: other kinds, extra fields, repeats, amounts, content types", async () => {
  const id = await newRequest();
  const cases: unknown[] = [
    body([id], { options: ["teleport"] }), body([id], { options: [] }), body([id], { options: ["buy_usdc", "buy_usdc"] }),
    body([id, id]), body([id], { balance: "0" }), body([id], { shortfall: { token: "USDC", atomic: "0" } }),
    body([id], { shortfall: { token: "USDC", atomic: "1.5" } }), body([id], { sender: "nope" }), body([id], { tool: "ask_for_money" }), "not json",
  ];
  for (const c of cases) assert.equal((await offer(c)).status, 400, JSON.stringify(c));
  assert.equal((await offer(body([id]), IP, "text/plain")).status, 400);
  // Each case's shape agrees with contract/shapes.mjs.
  for (const c of cases.slice(0, -1)) {
    const { errors, warnings } = check(shapes.createPlanReq, c);
    assert.ok(errors.length + warnings.length > 0, JSON.stringify(c)); // an extra field is a warning there ("not in the contract")
  }
  assert.deepEqual(check(shapes.createPlanReq, body([id])).errors, []);
  assert.equal(CreatePlanBody.safeParse(body([id])).success, true);
});

it(`POST /plans is capped at ${PLAN_LIMITS.perSenderPerHour} plans per sender per hour; another sender is unaffected`, async () => {
  const id = await newRequest();
  for (let i = 0; i < PLAN_LIMITS.perSenderPerHour; i++) assert.equal((await offer(body([id]))).status, 201, `plan ${i + 1}`);
  const limited = await offer(body([id]));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.match(ErrorResponse.parse(await limited.json()).error.message, /too many funding plans for this wallet/);
  assert.equal((await offer(body([id], { sender: OTHER }))).status, 201);
  assert.equal((await stats()).offered, PLAN_LIMITS.perSenderPerHour + 1);
});

it("POST /plans/<id>/used: only the plan's sender marks it, once; anyone else and unknown ids get 404", async () => {
  const id = await newRequest();
  const planId = await offered([id]);
  const first = await used(planId, SENDER);
  assert.equal(first.status, 200);
  const a = PlanUsedResponse.parse(await first.clone().json());
  assert.deepEqual(check(shapes.planUsedRes, await first.json()).errors, []);
  assert.equal(a.already_used, false);
  const again = PlanUsedResponse.parse(await (await used(planId, SENDER)).json());
  assert.deepEqual(again, { ...a, already_used: true }, "the first mark wins");
  assert.equal((await used(planId, OTHER)).status, 404);
  assert.equal((await used(newPlanId(), SENDER)).status, 404);
  assert.equal((await used("bad", SENDER)).status, 400);
  assert.deepEqual(await stats(), { offered: 1, used: 1, paid: 0, since: PLANS_SINCE });
});

it("paid comes from the requests table: every request paid by the plan's sender after the offer, nothing a caller says", async () => {
  const [a, b, c, d, e] = [await newRequest(), await newRequest(), await newRequest(), await newRequest(), await newRequest()];
  const both = await offered([a, b], { tool: "pay_all" });
  const byOther = await offered([c]);
  const before = await offered([d]);
  const raw = await offered([]);
  const baseSender = "0x52908400098527886E0F7030069857D2E4169EE7";
  const base = await offered([e], { sender: baseSender });
  await markPaid(a, SENDER);
  assert.equal(await attributePaidPlans(), 0, "one of two paid is not paid");
  await markPaid(b, SENDER);
  await markPaid(c, OTHER); // someone else paid it
  await markPaid(d, SENDER, "now() - interval '2 hours'"); // paid before the plan was offered
  await markPaid(e, baseSender.toLowerCase()); // Base payers can be stored lower-case
  const s = await stats();
  assert.deepEqual(s, { offered: 5, used: 0, paid: 2, since: PLANS_SINCE });
  const paid = (await sql("select id from funding_plans where paid_at is not null order by id")).map((r) => r.id).sort();
  assert.deepEqual(paid, [both, base].sort());
  for (const p of [byOther, before, raw]) assert.ok(!paid.includes(p));
  assert.equal(await attributePaidPlans(), 0, "settled once");
  // The /used call settles its own plan on the spot too.
  const f = await newRequest();
  const late = await offered([f]);
  await markPaid(f, SENDER);
  assert.equal((await used(late, SENDER)).status, 200);
  assert.ok((await sql("select paid_at from funding_plans where id = $1", [late]))[0]!.paid_at);
});

it("newPlanId: 12 base58 characters, different every time", () => {
  const ids = new Set(Array.from({ length: 200 }, newPlanId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[1-9A-HJ-NP-Za-km-z]{12}$/);
});

it("the plugin's own recorded body (contract fixture plans.create.req.json) is accepted, and the reply has the plugin's shape", async () => {
  const req = JSON.parse(readFileSync(new URL("../../contract/fixtures/plans.create.req.json", import.meta.url), "utf8"));
  // The fixture names the contract's canonical request (15 USDC to the team wallet); store it under that id.
  const canonical = JSON.parse(readFileSync(new URL("../../contract/fixtures/get-request.res.json", import.meta.url), "utf8"));
  await sql(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source)
     values ($1, $2, 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, 15000000, $3, 'plugin') on conflict (id) do nothing`,
    [canonical.id, canonical.recipient, canonical.reference],
  );
  assert.deepEqual(req.request_ids, [canonical.id]);
  const res = await offer(req);
  assert.equal(res.status, 201, await res.clone().text());
  assert.deepEqual(check(shapes.createPlanRes, await res.json()), { errors: [], warnings: [] });
});
