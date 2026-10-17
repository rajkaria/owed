import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import { POST as hook } from "@/app/api/hooks/helius/route";
import { POST as createGroupRoute } from "@/app/api/v1/groups/route";
import { POST as createRequestRoute } from "@/app/api/v1/requests/route";
import { GET as readRequest } from "@/app/api/v1/requests/[id]/route";
import { sql, DbError } from "@/lib/db";
import { requestIdFor } from "@/lib/ids";
import { TOKENS, type Token } from "@/lib/money";
import { hookTarget, publicBase } from "@/lib/notify/config";
import { drain } from "@/lib/notify/defer";
import { syncWatch, watchSoon } from "@/lib/notify/helius";
import { authorized, reportedTransactions } from "@/lib/notify/payload";
import { deliveryTiming } from "@/lib/notify/webhook";
import { parseJsonExact } from "@/lib/solana";

// W3-A paid-request webhooks on real Postgres: migrations 0001 → 0009 on PGlite (Postgres compiled to
// WASM) answering lib/db.ts's Neon-over-HTTP calls. Solana RPC is replayed from real mainnet recordings
// (test/fixtures/chain, publicnode, 2026-10-17); the Helius webhooks API is a stateful double whose
// answers copy the real exchanges in test/fixtures/helius/webhooks-api.json (status codes, bodies, the
// list omitting accountAddresses). Any other network call fails the test.

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
const MIGRATIONS = new URL("db/migrations/", WEB);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

// ---------------------------------------------------------------- recorded mainnet RPC

interface RecordedCall { method: string; params: unknown[]; result: unknown }
const chain = (name: string) =>
  parseJsonExact(readFileSync(new URL(`fixtures/chain/${name}.json`, import.meta.url), "utf8")) as { calls: RecordedCall[] };
const USDC_KEY = chain("usdc-appended-key-transfers");
const SOL_PAY = chain("sol-reference-payment");
const UNUSED = chain("unused-reference");
const RECORDED = [...USDC_KEY.calls, ...SOL_PAY.calls, ...UNUSED.calls];
const toJson = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(x.toString()) : x));

const USDC_REF = "Ef4piUis5ttTWrkJDeU4hNPDN4MZh4KmonkDHSwgnnTg";
const OLDEST = "2zsb1Wk1RP7npYZf9sPFUkPDuF4wGMaFVivDbxVDpaCgfkB4nfY19iuu4cHJjdw5MDcodBu8APEJHhsNbuRDpuMK";
const MIDDLE = "3ZdwwA4rYiiXodsuZ7374PEahd9iXeiq1VSvVXz17acEcpv1XhV45hu2gPZCXgun4gbm3Sh7vS72NS59rzTsmD2a";
const OLDEST_OWNER = "iksxPfWrHBzj7iZfD3Up3ft5Mz5DSGwm328v2349Zcc";
const GAQ = "GAqbB5TDD6G6KSZwtuTMicuKiyZH9XwkanBkdDs2FLie"; // credited 387 (oldest), 141101 (middle), 155588 (newest)
const SOL_REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const SOL_SIG = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";
const SOL_PAYEE = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const UNUSED_REF = "Bpo5quLAxFJj2eeQ9DrBGLEK69WwMD9k8ZbUF1aSeby9";
const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";

/** A delivery shaped like Helius's raw webhook (an array of getTransaction results), from a recorded transaction. */
const txOf = (signature: string) => RECORDED.find((c) => c.method === "getTransaction" && c.params[0] === signature)!.result;
const delivery = (...signatures: string[]) => toJson(signatures.map(txOf));

const RPC_HOSTS = /^https:\/\/(mainnet\.helius-rpc\.com|solana-rpc\.publicnode\.com|api\.mainnet-beta\.solana\.com)(\/|\?|$)/;
let rpcCalls: string[] = [];
function answerRpc(body: string): Response {
  const parsed = JSON.parse(body);
  const answer = (m: { id: number; method: string; params: unknown[] }) => {
    rpcCalls.push(`${m.method} ${String(m.params[0])}`);
    const hit = RECORDED.find((c) => c.method === m.method && c.params[0] === m.params[0]);
    return hit ? { jsonrpc: "2.0", id: m.id, result: hit.result } : { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "unrecorded call" } };
  };
  return new Response(toJson(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)), { headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- Helius webhooks API double

interface Exchange { name: string; status: number; body: string }
const api = JSON.parse(readFileSync(new URL("fixtures/helius/webhooks-api.json", import.meta.url), "utf8")) as { exchanges: Exchange[] };
const recordedBody = (name: string) => api.exchanges.find((e) => e.name === name)!;
const TEMPLATE = JSON.parse(recordedBody("create").body) as Record<string, unknown>;
const HELIUS_API = "https://api-mainnet.helius-rpc.com/v0/webhooks";

interface Hook { webhookURL: string; webhookType: string; transactionTypes: string[]; accountAddresses: string[]; authHeader: string }
const helius = {
  mode: "ok" as "ok" | "throw" | "500",
  hooks: new Map<string, Hook>(),
  calls: [] as { method: string; id: string | null; addresses?: string[] }[],
  next: 0,
};
function answerHelius(url: URL, init: RequestInit): Response {
  if (helius.mode === "throw") throw new TypeError("fetch failed");
  if (helius.mode === "500") return new Response("upstream error", { status: 500 });
  if (url.searchParams.get("api-key") !== "helius-test-key") return new Response(recordedBody("list-wrong-key").body, { status: 401 });
  const id = url.pathname.split("/")[3] ?? null;
  const method = init.method ?? "GET";
  const body = init.body ? (JSON.parse(String(init.body)) as Hook) : null;
  helius.calls.push({ method, id, ...(body && { addresses: body.accountAddresses }) });
  const view = (hid: string, h: Hook) => ({ ...TEMPLATE, ...h, webhookID: hid });
  const notFound = (hid: string) => new Response(recordedBody("update-unknown-id").body.replace(/[0-9a-f-]{36}/, hid), { status: 404 });
  if (method === "POST" && !id) {
    const hid = `00000000-0000-4000-8000-${String(++helius.next).padStart(12, "0")}`;
    helius.hooks.set(hid, body!);
    return Response.json(view(hid, body!), { status: 201 });
  }
  if (method === "GET" && !id) {
    // Like the real list: no accountAddresses.
    return Response.json([...helius.hooks].map(([hid, h]) => {
      const listed: Record<string, unknown> = view(hid, h);
      delete listed.accountAddresses;
      return listed;
    }));
  }
  if (!id || !helius.hooks.has(id)) return notFound(id ?? "");
  if (method === "PUT") {
    helius.hooks.set(id, body!);
    return Response.json(view(id, body!));
  }
  if (method === "GET") return Response.json(view(id, helius.hooks.get(id)!));
  if (method === "DELETE") {
    helius.hooks.delete(id);
    return new Response(recordedBody("delete").body, { status: 200 });
  }
  return new Response("method not allowed", { status: 405 });
}

// ---------------------------------------------------------------- wiring

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const SECRET = "whsec-test-0123456789abcdef";
const BASE = "https://owed.example";
const HOOK_URL = `${BASE}/api/hooks/helius`;
const warnings: string[] = [];

before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith(NEON)) {
      const body = JSON.parse(String(init.body));
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
    if (RPC_HOSTS.test(url)) return answerRpc(String(init.body));
    if (url.startsWith(HELIUS_API)) return answerHelius(new URL(url), init);
    throw new TypeError(`no network in this test: ${url}`);
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
    if (!String(args[0]).startsWith("helius:")) warn(...args);
  };
  console.log = () => undefined; // processDelivery's one line per transaction
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.HELIUS_API_KEY = "helius-test-key";
  process.env.HELIUS_WEBHOOK_SECRET = SECRET;
  process.env.OWED_BASE_URL = BASE;
  for (const name of ["VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"]) delete process.env[name];
  deliveryTiming.attempts = 2;
  deliveryTiming.retryMs = 5;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  await drain();
  rpcCalls = [];
  helius.calls = [];
  helius.mode = "ok";
  warnings.length = 0;
  process.env.HELIUS_API_KEY = "helius-test-key";
  process.env.HELIUS_WEBHOOK_SECRET = SECRET;
});

const post = (body: string, auth: string | null = SECRET) =>
  hook(new Request(HOOK_URL, { method: "POST", headers: { "content-type": "application/json", ...(auth !== null && { authorization: auth }) }, body }));

async function insertRequest(recipient: string, token: Token, amountAtomic: bigint, reference: string): Promise<string> {
  const id = requestIdFor({ recipient, token, amountAtomic, reference });
  await sql(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source) values ($1, $2, $3, $4, $5, $6, $7, 'web')`,
    [id, recipient, token, TOKENS[token].mint, TOKENS[token].decimals, amountAtomic, reference],
  );
  return id;
}
const row = async (id: string) =>
  (await sql(`select status, paid_signature, paid_payer, paid_amount_atomic::text as paid, paid_at::text as paid_at from requests where id = $1`, [id]))[0];
const logged = async (signature: string) =>
  (await sql(`select outcome, request_ids::text, marked_paid::text, deliveries, payload is not null as has_payload from helius_deliveries where signature = $1`, [signature]))[0];
const watched = () => {
  assert.equal(helius.hooks.size, 1, "one webhook for this deployment");
  return [...helius.hooks.values()][0];
};
const openReferences = async () =>
  (await sql(`select reference from requests where status in ('open', 'underpaid') order by reference`)).map((r) => r.reference!);
const createRequest = (body: Record<string, unknown> = {}) =>
  createRequestRoute(new Request(`${BASE}/api/v1/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: TEAM, amount: "0.01", source: "web", ...body }),
  }));

// ---------------------------------------------------------------- pure parts

test("authorized: the exact secret or 'Bearer <secret>', nothing else", () => {
  assert.equal(authorized(SECRET, SECRET), true);
  assert.equal(authorized(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(authorized(`  ${SECRET} `, SECRET), true);
  for (const bad of [null, "", "Bearer", SECRET.slice(0, -1), `${SECRET}x`, `bearer ${SECRET}x`, SECRET.toUpperCase()]) {
    assert.equal(authorized(bad, SECRET), false, String(bad));
  }
  assert.equal(authorized(SECRET, null), false, "no secret configured: nothing is authorized");
  assert.equal(authorized(SECRET, ""), false);
});

test("reportedTransactions: raw and enhanced shapes, by signature, junk skipped", () => {
  const raw = JSON.parse(delivery(OLDEST));
  const [tx] = reportedTransactions(raw);
  assert.equal(tx.signature, OLDEST);
  assert.ok(tx.keys.includes(USDC_REF), "the reference key is among the account keys");
  assert.ok(tx.keys.includes(GAQ));
  assert.ok(tx.payload && JSON.parse(tx.payload).transaction.signatures[0] === OLDEST);
  // Helius's raw format lists account keys as plain strings; jsonParsed as {pubkey}. Both work.
  const plainKeys = [{ transaction: { signatures: [SOL_SIG], message: { accountKeys: [SOL_REF, SOL_PAYEE] } }, meta: { loadedAddresses: { readonly: [UNUSED_REF], writable: [] } } }];
  assert.deepEqual(reportedTransactions(plainKeys)[0].keys.sort(), [SOL_REF, SOL_PAYEE, UNUSED_REF].sort());
  const enhanced = { signature: SOL_SIG, type: "TRANSFER", accountData: [{ account: SOL_REF, nativeBalanceChange: 0 }] };
  assert.deepEqual(reportedTransactions(enhanced), [{ signature: SOL_SIG, keys: [SOL_REF], payload: JSON.stringify(enhanced) }]);
  assert.deepEqual(reportedTransactions([null, 7, "x", [], { signature: "not-base58!" }, { transaction: { signatures: ["short"] } }]), []);
  assert.equal(reportedTransactions([...Array(150)].map(() => ({ signature: bs58.encode(randomBytes(64)) }))).length, 100);
  const dup = reportedTransactions([{ signature: SOL_SIG, a: SOL_REF }, { signature: SOL_SIG, b: UNUSED_REF }]);
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0].keys.sort(), [SOL_REF, UNUSED_REF].sort());
});

test("hookTarget: OWED_BASE_URL, else the stable Vercel URL; protected previews carry the bypass; never http or localhost", () => {
  const names = ["OWED_BASE_URL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    process.env.OWED_BASE_URL = "https://www.getowed.xyz/";
    assert.deepEqual(hookTarget(), { key: "https://www.getowed.xyz/api/hooks/helius", url: "https://www.getowed.xyz/api/hooks/helius" });
    delete process.env.OWED_BASE_URL;
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_BRANCH_URL = "owed-git-w3a-notify-team.vercel.app";
    process.env.VERCEL_URL = "owed-abc123-team.vercel.app";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "by pass";
    assert.deepEqual(hookTarget(), {
      key: "https://owed-git-w3a-notify-team.vercel.app/api/hooks/helius",
      url: "https://owed-git-w3a-notify-team.vercel.app/api/hooks/helius?x-vercel-protection-bypass=by%20pass",
    });
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "owed-omega.vercel.app";
    assert.deepEqual(hookTarget(), { key: "https://owed-omega.vercel.app/api/hooks/helius", url: "https://owed-omega.vercel.app/api/hooks/helius" });
    for (const name of ["VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_AUTOMATION_BYPASS_SECRET"]) delete process.env[name];
    assert.equal(publicBase(), null);
    assert.equal(hookTarget(), null, "nothing public to post to (next dev)");
    process.env.OWED_BASE_URL = "http://owed.example";
    assert.equal(hookTarget(), null, "Helius posts over https only");
    process.env.OWED_BASE_URL = "https://localhost:3000";
    assert.equal(hookTarget(), null);
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
});

// ---------------------------------------------------------------- the route and the settle path (PGlite)

it("auth: a missing or wrong Authorization header is 401 and nothing is processed; no secret configured is 503", async () => {
  const id = await insertRequest(TEAM, "USDC", 10_000n, UNUSED_REF);
  const body = delivery(OLDEST);
  for (const auth of [null, "", "Bearer nope", SECRET.slice(1)]) {
    const res = await post(body, auth);
    assert.equal(res.status, 401, String(auth));
    assert.deepEqual(await res.json(), { error: { code: "unauthorized", message: "missing or wrong Authorization header" } });
  }
  delete process.env.HELIUS_WEBHOOK_SECRET;
  const unconfigured = await post(body);
  assert.equal(unconfigured.status, 503);
  assert.equal(((await unconfigured.json()) as { error: { code: string } }).error.code, "upstream_unavailable");
  await drain();
  assert.deepEqual(rpcCalls, []);
  assert.equal((await sql(`select count(*)::int as n from helius_deliveries`))[0].n, "0");
  process.env.HELIUS_WEBHOOK_SECRET = SECRET;

  const notJson = await post("{nope", SECRET);
  assert.equal(notJson.status, 400);
  const empty = await post("[]", `Bearer ${SECRET}`);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { received: 0 });
  assert.equal((await row(id)).status, "open");
  await sql(`delete from requests where id = $1`, [id]);
});

it("Helius down when requests are created: they are still created (201), and the next sync watches them all", async () => {
  helius.mode = "throw";
  const a = await createRequest({ for: "while Helius is unreachable" });
  assert.equal(a.status, 201);
  await drain();
  helius.mode = "500";
  const b = await createRequest({ for: "while Helius answers 500" });
  assert.equal(b.status, 201);
  await drain();
  assert.equal(helius.hooks.size, 0);
  assert.ok(warnings.some((w) => /watch sync failed: Helius webhooks API unreachable/.test(w)), warnings.join("\n"));
  assert.ok(warnings.some((w) => /watch sync failed: Helius webhooks API answered HTTP 500 to GET/.test(w)), warnings.join("\n"));
  assert.ok(!warnings.some((w) => w.includes("helius-test-key")), "the API key never reaches a log line");
  const ids = await Promise.all([a, b].map(async (r) => ((await r.json()) as { id: string }).id));
  for (const id of ids) assert.equal((await row(id)).status, "open");

  helius.mode = "ok";
  const c = await createRequest({ for: "Helius is back" });
  assert.equal(c.status, 201);
  await drain();
  const hook = watched();
  assert.deepEqual(hook.accountAddresses, await openReferences(), "every open request, including the two made during the outage");
  assert.equal(hook.accountAddresses.length, 3);
  assert.deepEqual(
    { url: hook.webhookURL, type: hook.webhookType, types: hook.transactionTypes, auth: hook.authHeader },
    { url: HOOK_URL, type: "raw", types: ["ANY"], auth: SECRET },
  );
  const [reg] = await sql(`select helius_id, address_count, synced_at is not null as synced, last_error from notify_webhooks where url = $1`, [HOOK_URL]);
  assert.deepEqual(reg, { helius_id: [...helius.hooks.keys()][0], address_count: "3", synced: "t", last_error: null });
  assert.deepEqual(helius.calls.map((c) => c.method), ["GET", "POST"], "adopt-or-create: list, then create");
});

it("a delivery for a real payment marks the open request paid through the chain, and it leaves the watch", async () => {
  const id = await insertRequest(GAQ, "USDC", 387n, USDC_REF);
  watchSoon();
  await drain();
  assert.ok(watched().accountAddresses.includes(USDC_REF));
  helius.calls = [];

  const res = await post(delivery(OLDEST));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: 1 });
  await drain();
  const r = await row(id);
  assert.equal(r.status, "paid");
  assert.equal(r.paid_signature, OLDEST, "the oldest transaction that pays in full, as the chain lists it");
  assert.equal(r.paid_payer, OLDEST_OWNER);
  assert.equal(r.paid, "387");
  assert.deepEqual(await logged(OLDEST), { outcome: "paid", request_ids: `{${id}}`, marked_paid: `{${id}}`, deliveries: "1", has_payload: "t" });
  assert.equal(rpcCalls[0], `getSignaturesForAddress ${USDC_REF}`, "re-checked on chain by the reference, not read from the body");
  assert.equal(rpcCalls.length, 11);
  assert.ok(!watched().accountAddresses.includes(USDC_REF), "paid: no longer watched");
  assert.deepEqual(watched().accountAddresses, await openReferences());
  assert.deepEqual(helius.calls.map((c) => c.method), ["PUT"]);
  // A public read of the paid row needs no chain call.
  rpcCalls = [];
  const pub = (await (await readRequest(new Request(`${BASE}/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof readRequest>[1])).json()) as { status: string; paid: { signature: string } };
  assert.equal(pub.status, "paid");
  assert.equal(pub.paid.signature, OLDEST);
  assert.deepEqual(rpcCalls, []);
});

it("the same delivery again (a Helius retry) settles nothing twice: no chain call, paid_at unchanged", async () => {
  const [id] = (await sql(`select id from requests where reference = $1`, [USDC_REF])).map((r) => r.id!);
  const before = await row(id);
  const res = await post(delivery(OLDEST));
  assert.equal(res.status, 200);
  await drain();
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(await row(id), before);
  assert.deepEqual(await logged(OLDEST), { outcome: "paid", request_ids: `{${id}}`, marked_paid: `{${id}}`, deliveries: "2", has_payload: "t" });
});

it("two copies of a delivery at once: one chain check, one paid write", async () => {
  const id = await insertRequest(SOL_PAYEE, "SOL", 3_027_000n, SOL_REF);
  const body = delivery(SOL_SIG);
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  await drain();
  assert.equal(rpcCalls.filter((c) => c.startsWith("getSignaturesForAddress")).length, 1);
  const r = await row(id);
  assert.equal(r.status, "paid");
  assert.equal(r.paid_signature, SOL_SIG);
  assert.deepEqual(await logged(SOL_SIG), { outcome: "paid", request_ids: `{${id}}`, marked_paid: `{${id}}`, deliveries: "2", has_payload: "t" });
});

it("a forged delivery for an unpaid request doesn't mark it paid: the chain has no such payment", async () => {
  const id = await insertRequest(TEAM, "USDC", 10_000n, UNUSED_REF);
  watchSoon(); // what createRequest does
  await drain();
  rpcCalls = [];
  const fake = bs58.encode(randomBytes(64));
  const forged = [{
    slot: 999_999_999, blockTime: 1_792_300_000,
    transaction: { signatures: [fake], message: { accountKeys: [TEAM, UNUSED_REF] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 0, mint: TOKENS.USDC.mint, owner: TEAM, uiTokenAmount: { amount: "10000000000" } }] },
  }];
  const res = await post(JSON.stringify(forged));
  assert.equal(res.status, 200);
  await drain();
  assert.equal((await row(id)).status, "open");
  assert.equal((await row(id)).paid_signature, null);
  assert.equal(rpcCalls[0], `getSignaturesForAddress ${UNUSED_REF}`);
  assert.deepEqual(await logged(fake), { outcome: "open", request_ids: `{${id}}`, marked_paid: "{}", deliveries: "1", has_payload: "t" });
  assert.ok(watched().accountAddresses.includes(UNUSED_REF), "still open, still watched");
});

it("a delivery whose payment doesn't cover the request leaves it underpaid", async () => {
  await sql(`delete from requests where reference = $1`, [USDC_REF]);
  const id = await insertRequest(GAQ, "USDC", 200_000n, USDC_REF);
  await post(delivery(MIDDLE));
  await drain();
  const r = await row(id);
  assert.equal(r.status, "underpaid");
  assert.equal(r.paid_signature, OLDEST, "the oldest partial credit is what the chain shows");
  assert.equal((await logged(MIDDLE)).outcome, "open");
  assert.equal((await logged(MIDDLE)).marked_paid, "{}");
});

it("a delivery naming no Owed request is logged as no_request and costs one query", async () => {
  const sig = bs58.encode(randomBytes(64));
  await post(JSON.stringify([{ transaction: { signatures: [sig], message: { accountKeys: [bs58.encode(randomBytes(32))] } } }]));
  await drain();
  assert.deepEqual(rpcCalls, []);
  assert.equal((await logged(sig)).outcome, "no_request");
});

it("a split's shares are watched from creation, in one sync", async () => {
  helius.calls = [];
  const res = await createGroupRoute(new Request(`${BASE}/api/v1/groups`, {
    method: "POST",
    body: JSON.stringify({ recipient: TEAM, total: "0.03", title: "W3-A watch", people: [{ name: "A" }, { name: "B" }, { name: "C" }] }),
  }));
  assert.equal(res.status, 201);
  const group = (await res.json()) as { shares: { reference: string }[] };
  await drain();
  for (const s of group.shares) assert.ok(watched().accountAddresses.includes(s.reference));
  assert.deepEqual(helius.calls.map((c) => c.method), ["PUT"]);
});

it("the registry heals: a lost row adopts the webhook already pointing here; one deleted in the dashboard is re-created", async () => {
  const [hid] = [...helius.hooks.keys()];
  await sql(`delete from notify_webhooks`);
  helius.calls = [];
  assert.deepEqual(await syncWatch(), { status: "synced", webhookId: hid, addresses: (await openReferences()).length });
  assert.deepEqual(helius.calls.map((c) => c.method), ["GET", "PUT"], "adopted, not duplicated");
  assert.equal(helius.hooks.size, 1);

  helius.hooks.delete(hid); // deleted in the Helius dashboard
  helius.calls = [];
  const result = await syncWatch();
  assert.equal(result.status, "synced");
  assert.deepEqual(helius.calls.map((c) => c.method), ["PUT", "GET", "POST"]);
  const [newId] = [...helius.hooks.keys()];
  assert.notEqual(newId, hid);
  assert.equal((await sql(`select helius_id from notify_webhooks`))[0].helius_id, newId);
});

it("when nothing is open the webhook is deleted, and the next request registers a fresh one", async () => {
  await sql(`update requests set status = 'cancelled' where status in ('open', 'underpaid')`);
  helius.calls = [];
  assert.deepEqual(await syncWatch(), { status: "synced", webhookId: null, addresses: 0 });
  assert.deepEqual(helius.calls.map((c) => c.method), ["DELETE"]);
  assert.equal(helius.hooks.size, 0);
  assert.equal((await sql(`select count(*)::int as n from notify_webhooks`))[0].n, "0");
  const res = await createRequest();
  const { reference } = (await res.json()) as { reference: string };
  await drain();
  assert.deepEqual(watched().accountAddresses, [reference]);
});

it("without HELIUS_API_KEY nothing changes: no Helius call on create or paid, and deliveries still settle", async () => {
  delete process.env.HELIUS_API_KEY;
  helius.calls = [];
  const res = await createRequest({ for: "no Helius key" });
  assert.equal(res.status, 201);
  await sql(`delete from requests where reference = $1`, [SOL_REF]);
  await sql(`delete from helius_deliveries where signature = $1`, [SOL_SIG]);
  // A different amount (so a different id) than the earlier SOL test, which settleFromChain re-checks at most every 3 s.
  const id = await insertRequest(SOL_PAYEE, "SOL", 3_026_999n, SOL_REF);
  await post(delivery(SOL_SIG));
  await drain();
  assert.equal((await row(id)).status, "paid", "the route only needs the secret; the chain check uses the public RPC");
  assert.ok(rpcCalls.length > 0);
  assert.deepEqual(helius.calls, []);
  assert.deepEqual(await syncWatch(), { status: "off" });
});

it("0006 constraints: a delivery's signature must be base58, its outcome one of four", async () => {
  for (const [sig, outcome] of [["not a signature", "paid"], [bs58.encode(randomBytes(64)), "maybe"]] as const) {
    await assert.rejects(
      sql(`insert into helius_deliveries (signature, outcome) values ($1, $2)`, [sig, outcome]),
      (e: unknown) => e instanceof DbError && e.code === "23514",
    );
  }
});
