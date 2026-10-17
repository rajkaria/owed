import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { POST as createGroupRoute } from "@/app/api/v1/groups/route";
import { POST as createInvoiceRoute } from "@/app/api/v1/invoices/route";
import { POST as createRequestRoute } from "@/app/api/v1/requests/route";
import { POST as statusRawRoute } from "@/app/api/v1/status-raw/route";
import { ErrorResponse } from "@/lib/contract";
import { sql } from "@/lib/db";
import { toErrorResponse } from "@/lib/http";
import { clientIp, CREATE_LIMITS, DNS_LIMITS, STATUS_RAW_LIMITS, take, takeCreateSlot, takeX402Attempt, X402_LIMITS } from "@/lib/ratelimit";

// W2-E abuse limits on real Postgres: every migration, lib/ratelimit.ts's SQL and the create, status-raw
// routes, with PGlite (Postgres compiled to WASM) answering lib/db.ts's Neon-over-HTTP calls. DNS answers
// come from plugin/test/fixtures/doh (real resolver captures); Solana RPC answers "no signatures".
// Skips until the devDependency @electric-sql/pglite is installed.

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
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 2278, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

interface DohFixture { responses: Array<{ url: string; status: number; body: string }> }
const doh = JSON.parse(readFileSync(new URL("../../plugin/test/fixtures/doh/nodata-signed.json", import.meta.url), "utf8")) as DohFixture;
let dnsLookups = 0;
let rpcCalls = 0;

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
    if (/^https:\/\/(cloudflare-dns\.com|dns\.google)\//.test(url)) {
      dnsLookups += 1;
      // The real example.com NODATA answer, renamed to the domain asked about.
      const domain = new URL(url).searchParams.get("name")!.replace(/^_owed\./, "");
      const r = doh.responses.find((x) => url.startsWith(x.url.slice(0, x.url.indexOf("?"))))!;
      return new Response(r.body.replaceAll("example.com", domain), { status: r.status });
    }
    // Solana RPC: no transaction references anything.
    rpcCalls += 1;
    const calls = JSON.parse(String(init?.body ?? "null"));
    const answer = (c: { id: number }) => ({ jsonrpc: "2.0", id: c.id, result: [] });
    return Response.json(Array.isArray(calls) ? calls.map(answer) : answer(calls));
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.OWED_BASE_URL = "https://owed-preview.example";
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  if (mod) await pg.exec("delete from rate_events");
});

const wallet = () => Keypair.generate().publicKey.toBase58();
const post = (route: (req: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  route(new Request(`https://owed-preview.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const createRequest = (recipient: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(createRequestRoute, "/api/v1/requests", { recipient, amount: "0.01", source: "web", ...extra }, headers);
async function errorOf(res: Response) {
  const body = ErrorResponse.parse(await res.json());
  return body.error;
}

// ---------------------------------------------------------------- creates

it("60 creates for one recipient in a minute → 201s, the 61st is 429 rate_limited with Retry-After; other recipients unaffected", async () => {
  const recipient = wallet();
  const statuses: number[] = [];
  for (let i = 0; i < CREATE_LIMITS.perRecipientPerHour; i++) statuses.push((await createRequest(recipient)).status);
  assert.deepEqual([...new Set(statuses)], [201]);
  const res = await createRequest(recipient);
  assert.equal(res.status, 429);
  const retry = Number(res.headers.get("retry-after"));
  assert.ok(retry >= 3500 && retry <= 3600, `Retry-After ${retry}`);
  assert.deepEqual(await errorOf(res), { code: "rate_limited", message: "too many requests for this recipient in the last hour, try again later" });
  assert.equal((await sql("select count(*) as n from requests where recipient = $1", [recipient]))[0].n, "60");
  assert.equal((await createRequest(wallet())).status, 201);
});

it("under concurrency the limit holds exactly: 70 parallel creates → 60 created, 10 refused", async () => {
  const recipient = wallet();
  const results = await Promise.all(Array.from({ length: 70 }, () => createRequest(recipient)));
  const counts = results.reduce<Record<number, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { 201: 60, 429: 10 });
  assert.equal((await sql("select count(*) as n from rate_events where key = $1", [`create:recipient:${recipient}`]))[0].n, "60");
});

it("QA-07: one client spreading creates over throwaway wallets hits its own cap, not everyone's", async () => {
  const attacker = { "x-real-ip": "203.0.113.7" };
  let created = 0;
  for (let w = 0; w < 6; w++) {
    const recipient = wallet();
    for (let i = 0; i < CREATE_LIMITS.perRecipientPerHour; i++) if ((await createRequest(recipient, {}, attacker)).status === 201) created++;
  }
  assert.equal(created, CREATE_LIMITS.perIpPerHour, "the client's creates stop at its own hourly cap");
  const more = await createRequest(wallet(), {}, attacker);
  assert.equal(more.status, 429);
  assert.equal((await errorOf(more)).message, "too many new requests from this client in the last hour, try again later");
  assert.equal((await createRequest(wallet(), {}, { "x-real-ip": "198.51.100.9" })).status, 201, "another client still creates");
});

it("the global limit refuses with its own message, and a refused create records nothing", async () => {
  await pg.query(`insert into rate_events (key) select 'create:global' from generate_series(1, $1::int)`, [CREATE_LIMITS.globalPerHour]);
  const recipient = wallet();
  const res = await createRequest(recipient);
  assert.equal(res.status, 429);
  assert.equal((await errorOf(res)).message, "Owed is handling too many new requests right now, try again later");
  assert.equal((await sql("select count(*) as n from rate_events where key = $1", [`create:recipient:${recipient}`]))[0].n, "0");
  const slot = await takeCreateSlot(recipient);
  assert.deepEqual([slot.allowed, slot.scope], [false, "global"]);
});

it("events older than the window don't count", async () => {
  const recipient = wallet();
  await pg.query(`insert into rate_events (key, at) select $1, now() - interval '61 minutes' from generate_series(1, 60)`, [`create:recipient:${recipient}`]);
  assert.equal((await createRequest(recipient)).status, 201);
});

it("groups take one slot per share, invoices one; both answer 429 once the recipient is full", async () => {
  const recipient = wallet();
  const group = await post(createGroupRoute, "/api/v1/groups", { recipient, total: "1", token: "USDC", title: "Pizza", people: [{ name: "A" }, { name: "B" }, { name: "C" }], source: "web" });
  assert.equal(group.status, 201);
  assert.equal((await sql("select count(*) as n from rate_events where key = $1", [`create:recipient:${recipient}`]))[0].n, "3");
  await pg.query(`insert into rate_events (key) select $1 from generate_series(1, 57)`, [`create:recipient:${recipient}`]);
  const invoice = await post(createInvoiceRoute, "/api/v1/invoices", {
    recipient, token: "USDC", business_name: "B", client_name: "C", items: [{ description: "x", quantity: "1", unit_price: "1" }],
    due_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), source: "web",
  });
  assert.equal(invoice.status, 429);
  assert.equal((await errorOf(invoice)).code, "rate_limited");
});

// ---------------------------------------------------------------- DNS lookups for from_domain

it("from_domain DNS checks are capped per domain (30 / 10 min) and per client IP (60 / 10 min)", async () => {
  dnsLookups = 0;
  const recipient = wallet();
  for (let i = 0; i < DNS_LIMITS.perDomain; i++) {
    const res = await createRequest(recipient, { from_domain: "example.com" }, { "x-real-ip": `198.51.100.${i}` });
    assert.equal(res.status, 400, "example.com doesn't publish the wallet"); // a real NODATA answer
  }
  const lookupsBefore = dnsLookups;
  const capped = await createRequest(recipient, { from_domain: "Example.COM." }, { "x-real-ip": "198.51.100.200" });
  assert.equal(capped.status, 429);
  assert.match((await errorOf(capped)).message, /from_domain checks for this domain/);
  assert.equal(dnsLookups, lookupsBefore, "no DNS lookup once capped");

  await pg.exec("delete from rate_events");
  for (let i = 0; i < DNS_LIMITS.perIp; i++) {
    assert.equal((await createRequest(wallet(), { from_domain: `d${i}.example.com` }, { "x-real-ip": "203.0.113.9" })).status, 400);
  }
  const ip = await createRequest(wallet(), { from_domain: "another.example.com" }, { "x-real-ip": "203.0.113.9" });
  assert.equal(ip.status, 429);
  assert.match((await errorOf(ip)).message, /from this client/);
  assert.equal((await createRequest(wallet(), { from_domain: "another.example.com" }, { "x-real-ip": "203.0.113.10" })).status, 400, "another IP still gets its lookup");
});

it("a malformed from_domain is a 400 that spends no DNS slot", async () => {
  const res = await createRequest(wallet(), { from_domain: "https://example.com/pay" });
  assert.equal(res.status, 400);
  assert.equal((await sql("select count(*) as n from rate_events where key like 'dns:%'"))[0].n, "0");
});

// ---------------------------------------------------------------- x402 and status-raw

it("x402 payment attempts: 10 per request and 30 per IP in 10 minutes", async () => {
  for (let i = 0; i < X402_LIMITS.perRequest; i++) assert.equal((await takeX402Attempt("JArQ6g9JvoWr", "192.0.2.1")).allowed, true);
  const full = await takeX402Attempt("JArQ6g9JvoWr", "192.0.2.2");
  assert.deepEqual([full.allowed, full.scope], [false, "request"]);
  assert.ok(full.retryAfterSeconds! > 590 && full.retryAfterSeconds! <= 600);
  for (let i = 0; i < X402_LIMITS.perIp - X402_LIMITS.perRequest; i++) await takeX402Attempt(`id${i}x`, "192.0.2.1");
  const ip = await takeX402Attempt("another1234x", "192.0.2.1");
  assert.deepEqual([ip.allowed, ip.scope], [false, "ip"]);
});

it("POST /status-raw: 60 per IP per minute, then 429 before any chain read", async () => {
  const url = `solana:${wallet()}?amount=1&reference=${wallet()}`;
  for (let i = 0; i < STATUS_RAW_LIMITS.perIp; i++) {
    const res = await post(statusRawRoute, "/api/v1/status-raw", { solana_pay_url: url }, { "x-real-ip": "192.0.2.50" });
    assert.equal(res.status, 200);
  }
  const reads = rpcCalls;
  const res = await post(statusRawRoute, "/api/v1/status-raw", { solana_pay_url: url }, { "x-real-ip": "192.0.2.50" });
  assert.equal(res.status, 429);
  assert.equal((await errorOf(res)).code, "rate_limited");
  assert.equal(rpcCalls, reads, "no chain read once capped");
  assert.equal((await post(statusRawRoute, "/api/v1/status-raw", { solana_pay_url: url }, { "x-real-ip": "192.0.2.51" })).status, 200);
});

test("POST /status-raw still answers from the chain when the database is down (the /p page needs it)", async () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith(NEON)) throw new TypeError("fetch failed");
    const calls = JSON.parse(String(init?.body ?? "null"));
    const answer = (c: { id: number }) => ({ jsonrpc: "2.0", id: c.id, result: [] });
    return Response.json(Array.isArray(calls) ? calls.map(answer) : answer(calls));
  }) as typeof fetch;
  try {
    const res = await post(statusRawRoute, "/api/v1/status-raw", { solana_pay_url: `solana:${wallet()}?amount=1&reference=${wallet()}` });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "open");
    assert.match(logged.join("\n"), /status-raw rate limit skipped/);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});

it("take(): all rules or none; the first full rule in the caller's order is reported", async () => {
  const rules = [{ key: "t:a", max: 2, windowSeconds: 60, scope: "a" }, { key: "t:b", max: 1, windowSeconds: 60, scope: "b" }];
  assert.equal((await take(rules)).allowed, true);
  assert.deepEqual(await take(rules).then((d) => [d.allowed, d.scope]), [false, "b"]);
  const counts = await sql("select key, count(*) as n from rate_events where key like 't:%' group by key order by key");
  assert.deepEqual(counts.map((r) => [r.key, r.n]), [["t:a", "1"], ["t:b", "1"]], "the refused call recorded nothing");
});

// ---------------------------------------------------------------- input bounds and error shapes (no database)

test("a recipient that isn't 32 bytes is a 400 on every create route, never a 500", async () => {
  for (const bad of ["z".repeat(44), "2".repeat(32), "1".repeat(31) + "zz"]) {
    for (const [route, path, body] of [
      [createRequestRoute, "/api/v1/requests", { recipient: bad, amount: "1" }],
      [createGroupRoute, "/api/v1/groups", { recipient: bad, total: "1", token: "USDC", title: "t", people: [{ name: "a" }, { name: "b" }] }],
      [createInvoiceRoute, "/api/v1/invoices", { recipient: bad, token: "USDC", business_name: "b", client_name: "c", items: [{ description: "x", unit_price: "1" }], due_date: "2030-01-01" }],
    ] as const) {
      const res = await post(route, path, body);
      assert.equal(res.status, 400, `${path} ${bad}`);
      assert.match((await errorOf(res)).message, /recipient: must be a base58 Solana address/);
    }
  }
});

test("bodies over the limit are refused while streaming, without reading the rest", async () => {
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(8192).fill(0x20));
    },
  });
  const res = await createRequestRoute(new Request("https://owed-preview.example/api/v1/requests", { method: "POST", body: endless, duplex: "half" } as RequestInit));
  assert.equal(res.status, 400);
  assert.deepEqual(await errorOf(res), { code: "invalid_input", message: "request body is too large" });
  assert.ok(pulled <= 10, `pulled ${pulled} chunks`);
  const declared = await createRequestRoute(new Request("https://owed-preview.example/api/v1/requests", { method: "POST", body: "{}", headers: { "content-length": "999999" } }));
  assert.equal(declared.status, 400);
});

test("an unexpected error is a 500 with the contract shape and no stack or message from inside", async () => {
  const realError = console.error;
  console.error = () => undefined;
  try {
    const res = toErrorResponse(new Error("connect ECONNREFUSED 10.0.0.5:5432 at Object.<anonymous> (/var/task/lib/db.ts:42:7)"));
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.equal(text, JSON.stringify({ error: { code: "upstream_unavailable", message: "internal error" } }));
  } finally {
    console.error = realError;
  }
});

test("clientIp: Vercel's x-real-ip, else the first x-forwarded-for, else one shared bucket", () => {
  const ip = (headers: Record<string, string>) => clientIp(new Request("https://x.example/", { headers }));
  assert.equal(ip({ "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), "203.0.113.1");
  assert.equal(ip({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" }), "198.51.100.1");
  assert.equal(ip({}), "unknown");
  assert.equal(ip({ "x-real-ip": "a".repeat(500) }).length, 64);
});

test("every API route runs on Node.js (runtime = \"nodejs\")", () => {
  const routes = ["api/qr/[id]", "api/v1/groups", "api/v1/groups/[id]", "api/v1/invoices", "api/v1/invoices/[id]", "api/v1/requests",
    "api/v1/requests/[id]", "api/v1/stats", "api/v1/status", "api/v1/status-raw", "x/[id]"];
  const found = readdirSync(new URL("../app/", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith("route.ts")).map((f) => f.replace(/\/route\.ts$/, "")).sort();
  for (const r of routes) assert.ok(found.includes(r), `${r} exists`);
  for (const r of found) {
    const source = readFileSync(new URL(`../app/${r}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /export const runtime = "nodejs";/, `${r} declares the Node.js runtime`);
  }
});
