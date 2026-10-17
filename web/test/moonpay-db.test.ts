import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as requests from "@/lib/requests";
import { WIDGET_SANDBOX, type MoonpayConfig } from "@/lib/moonpay/config";
import { settlePendingMoonpay, type CardDeps } from "@/lib/moonpay/settle";
import { store } from "@/lib/moonpay/store";
import { parseMoonpayTx, type MoonpayTx } from "@/lib/moonpay/transaction";
import { processWebhook } from "@/lib/moonpay/webhook";
import type { ParsedTransaction } from "@/lib/validate";

// Pay by card with MoonPay on real Postgres (PGlite answering lib/db.ts's Neon-over-HTTP calls, as in
// x402-store.test.ts): migration 0014, the checkout/poll/verify path through settlePendingMoonpay, the
// webhook path, and every way a MoonPay report fails to mark a request paid. MoonPay and the chain are
// fakes passed in as deps.

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

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
before(async () => {
  if (!mod) return;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    // No real network in these tests: Solana RPC and api.moonpay.com answer 503 (both paths fall back).
    if (!String(input).startsWith(NEON)) return /^https:\/\/(solana-rpc\.publicnode\.com|api\.mainnet-beta\.solana\.com|api\.moonpay\.com)/.test(String(input)) ? new Response("down", { status: 503 }) : realFetch(input, init);
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
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  const dir = new URL("db/migrations/", WEB);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, dir), "utf8"));
});

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MOONPAY_WALLET = "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi";
const RECIPIENT_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";
const SOURCE_ATA = "Bpo5quLAxFJj2eeQ9DrBGLEK69WwMD9k8ZbUF1aSeby9";
const SIG = (n: number) => `5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUY${"abcdefghij"[n]}`;
const AMOUNT = 12_500_000n;

const CONFIG: MoonpayConfig = { publishableKey: "pk_test_x", secretKey: "sk_test_y", webhookKey: "wk", sandbox: true, widgetBase: WIDGET_SANDBOX, ipMatch: true };

const newRequest = (amountAtomic = AMOUNT) => requests.createRequest({
  recipient: RECIPIENT, token: "USDC", amountAtomic, payerName: null, forText: "dinner", note: null, requesterName: null, flags: [], source: "web",
});
async function load(id: string): Promise<requests.RequestRow> {
  const row = await requests.getRequest(id);
  assert.ok(row, `request ${id} exists`);
  return row;
}

let nextMoonpayId = 0;
function moonpayTx(requestId: string, over: Record<string, unknown> = {}): MoonpayTx {
  const tx = parseMoonpayTx({
    id: `mp-${++nextMoonpayId}`, status: "completed", externalTransactionId: requestId, walletAddress: RECIPIENT,
    currency: { code: "usdc_sol" }, cryptoTransactionId: SIG(1), quoteCurrencyAmount: 12.5,
    updatedAt: new Date().toISOString(), failureReason: null, ...over,
  });
  assert.ok(tx);
  return tx;
}

function chainTx(signature: string, { credit = AMOUNT, owner = RECIPIENT } = {}): ParsedTransaction {
  const keys = [MOONPAY_WALLET, SOURCE_ATA, RECIPIENT_ATA, USDC];
  return {
    slot: 400_000_000, blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1),
      preTokenBalances: [{ accountIndex: 2, mint: USDC, owner, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC, owner, uiTokenAmount: { amount: String(credit) } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
        instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { source: SOURCE_ATA, destination: RECIPIENT_ATA, authority: MOONPAY_WALLET } } }],
      },
    },
  };
}

/** Fakes for MoonPay's API and the chain, counting calls. */
function fakes(moonpay: (id: string) => MoonpayTx[], chain: (sig: string) => ParsedTransaction | null) {
  const calls = { moonpay: 0, chain: 0 };
  const deps: CardDeps = {
    config: CONFIG,
    store,
    fetchTransactions: async (id) => { calls.moonpay++; return moonpay(id); },
    getTransaction: async (sig) => { calls.chain++; return chain(sig); },
  };
  return { deps, calls };
}

async function purchases(requestId: string) {
  return (await pg.query<{ state: string; signature: string | null; error: string | null; moonpay_status: string }>(
    "select state, signature, error, moonpay_status from moonpay_purchases where request_id = $1 order by created_at, moonpay_id", [requestId])).rows;
}
/** Free the 15 s poll slot, as if time passed. */
const freePoll = (requestId: string) => pg.query("update moonpay_checkouts set last_polled_at = now() - interval '1 minute' where request_id = $1", [requestId]);

it("0014: requests accept paid_rail 'moonpay_card' on Solana; the new tables exist and start empty", async () => {
  const row = await newRequest();
  await pg.query("update requests set paid_rail = 'moonpay_card' where id = $1", [row.id]);
  await assert.rejects(pg.query("update requests set paid_rail = 'card' where id = $1", [row.id]), /requests_paid_rail_check/);
  await pg.query("update requests set paid_rail = null where id = $1", [row.id]);
  const n = await pg.query<{ n: number }>("select (select count(*) from moonpay_checkouts) + (select count(*) from moonpay_purchases) as n");
  assert.equal(Number(n.rows[0]!.n), 0);
});

it("feature off (no config): no queries, no MoonPay calls, nothing settles", async () => {
  const row = await newRequest();
  const { deps, calls } = fakes(() => { throw new Error("must not be called"); }, () => null);
  const throwing = new Proxy(store, { get: () => () => { throw new Error("must not touch the database"); } });
  assert.equal((await settlePendingMoonpay([row], {}, { ...deps, config: null, store: throwing })).size, 0);
  assert.deepEqual(calls, { moonpay: 0, chain: 0 });
});

it("no checkout opened: MoonPay is never asked", async () => {
  const row = await newRequest();
  const { deps, calls } = fakes(() => [moonpayTx(row.id)], (sig) => chainTx(sig));
  assert.equal((await settlePendingMoonpay([row], {}, deps)).size, 0);
  assert.deepEqual(calls, { moonpay: 0, chain: 0 });
});

it("checkout -> MoonPay pending -> completed with a transaction -> chain confirms -> paid by card, once", async () => {
  const row = await newRequest();
  await store.startCheckout(row.id);
  let report = moonpayTx(row.id, { status: "pending", cryptoTransactionId: null, updatedAt: "2026-10-18T10:00:00.000Z" });
  const { deps, calls } = fakes(() => [report], (sig) => chainTx(sig));

  assert.equal((await settlePendingMoonpay([row], {}, deps)).size, 0);
  assert.deepEqual(await purchases(row.id), [{ state: "pending", signature: null, error: null, moonpay_status: "pending" }]);
  assert.equal(calls.moonpay, 1);

  // Within 15 s the poll slot is taken: no second MoonPay call.
  await settlePendingMoonpay([row], {}, deps);
  assert.equal(calls.moonpay, 1);

  report = { ...report, status: "completed", cryptoTransactionId: SIG(1), updatedAt: "2026-10-18T10:03:00.000Z" };
  await freePoll(row.id);
  const settled = await settlePendingMoonpay([row], {}, deps);
  assert.deepEqual([...settled], [row.id]);
  assert.equal(calls.chain, 1);
  const paid = await load(row.id);
  assert.deepEqual([paid.status, paid.paidRail, paid.paidSignature, paid.paidPayer, paid.paidAmountAtomic], ["paid", "moonpay_card", SIG(1), MOONPAY_WALLET, AMOUNT]);
  assert.equal(requests.toPublic(paid).paid?.rail, "moonpay_card");
  assert.deepEqual((await purchases(row.id)).map((p) => p.state), ["verified"]);

  // A paid request is no longer checked; a replayed report changes nothing.
  await freePoll(row.id);
  assert.equal((await settlePendingMoonpay([paid], {}, deps)).size, 0);
  assert.equal(calls.moonpay, 2, "a paid request is not polled");
  const before = { ...calls };
  await processWebhook(report, row.id, deps);
  assert.deepEqual(calls, before);
  assert.deepEqual((await purchases(row.id)).map((p) => p.state), ["verified"]);
});

it("POST /api/v1/status reports rail moonpay_card for a request paid by card", async () => {
  const row = await newRequest();
  await store.startCheckout(row.id);
  const { deps } = fakes((id) => [moonpayTx(id, { cryptoTransactionId: SIG(2) })], (sig) => chainTx(sig));
  await settlePendingMoonpay([row], {}, deps);
  const { POST } = await import("@/app/api/v1/status/route");
  const res = await POST(new Request("https://owed.example/api/v1/status", { method: "POST", body: JSON.stringify({ ids: [row.id] }), headers: { "content-type": "application/json" } }));
  const body = (await res.json()) as { results: Record<string, unknown>[] };
  assert.equal(body.results[0]!.status, "paid");
  assert.equal(body.results[0]!.rail, "moonpay_card");
  assert.equal(body.results[0]!.signature, SIG(2));
});

it("webhook: a transaction that doesn't credit the recipient is refused (mismatch), the request stays open", async () => {
  const row = await newRequest();
  await store.startCheckout(row.id);
  const { deps } = fakes(() => [], (sig) => chainTx(sig, { owner: OTHER }));
  await processWebhook(moonpayTx(row.id, { cryptoTransactionId: SIG(3) }), row.id, deps);
  const [p] = await purchases(row.id);
  assert.equal(p!.state, "mismatch");
  assert.match(p!.error ?? "", /did not credit the recipient/);
  const after = await load(row.id);
  assert.deepEqual([after.status, after.paidRail, after.paidSignature], ["open", null, null]);
});

it("webhook: a report for another wallet or currency is ignored outright; nothing is stored", async () => {
  const row = await newRequest();
  await store.startCheckout(row.id);
  const { deps, calls } = fakes(() => [], (sig) => chainTx(sig));
  await processWebhook(moonpayTx(row.id, { walletAddress: OTHER }), row.id, deps);
  await processWebhook(moonpayTx(row.id, { currency: { code: "usdc" } }), row.id, deps);
  assert.deepEqual(await purchases(row.id), []);
  assert.equal(calls.chain, 0);
  assert.equal((await load(row.id)).status, "open");
});

it("webhook: MoonPay says completed but the chain doesn't show it yet -> stays sent; later confirmed", async () => {
  const row = await newRequest();
  await store.startCheckout(row.id);
  let visible = false;
  const { deps } = fakes(() => [], (sig) => (visible ? chainTx(sig) : null));
  await processWebhook(moonpayTx(row.id, { cryptoTransactionId: SIG(4) }), row.id, deps);
  assert.deepEqual((await purchases(row.id)).map((p) => p.state), ["sent"]);
  assert.equal((await load(row.id)).status, "open");
  visible = true;
  await freePoll(row.id);
  assert.deepEqual([...(await settlePendingMoonpay([await load(row.id)], {}, deps))], [row.id]);
  assert.equal((await load(row.id)).paidRail, "moonpay_card");
});

it("a smaller delivery marks the request underpaid by card, never paid", async () => {
  const row = await newRequest();
  await store.startCheckout(row.id);
  const { deps } = fakes((id) => [moonpayTx(id, { cryptoTransactionId: SIG(5) })], (sig) => chainTx(sig, { credit: 10_000_000n }));
  await settlePendingMoonpay([row], {}, deps);
  const after = await load(row.id);
  assert.deepEqual([after.status, after.paidRail, after.paidAmountAtomic], ["underpaid", "moonpay_card", 10_000_000n]);
  assert.deepEqual((await purchases(row.id)).map((p) => p.state), ["underpaid"]);
});

it("MoonPay failure is recorded and marks nothing; a transaction already settling another request is refused", async () => {
  const failedRow = await newRequest();
  await store.startCheckout(failedRow.id);
  const failing = fakes((id) => [moonpayTx(id, { status: "failed", cryptoTransactionId: null, failureReason: "card declined" })], () => null);
  await settlePendingMoonpay([failedRow], {}, failing.deps);
  assert.deepEqual(await purchases(failedRow.id), [{ state: "failed", signature: null, error: "card declined", moonpay_status: "failed" }]);
  assert.equal((await load(failedRow.id)).status, "open");

  const first = await newRequest();
  const second = await newRequest();
  await pg.query("update requests set status = 'paid', paid_signature = $2, paid_rail = 'solana_pay' where id = $1", [first.id, SIG(6)]);
  await store.startCheckout(second.id);
  const reused = fakes((id) => [moonpayTx(id, { cryptoTransactionId: SIG(6) })], (sig) => chainTx(sig));
  assert.equal((await settlePendingMoonpay([second], {}, reused.deps)).size, 0);
  assert.deepEqual((await purchases(second.id)).map((p) => [p.state, p.error]), [["mismatch", "transaction already settles another request"]]);
  assert.equal((await load(second.id)).status, "open");
});

it("one Solana transaction can't be two purchases", async () => {
  const a = await newRequest();
  const b = await newRequest();
  for (const r of [a, b]) await store.startCheckout(r.id);
  const { deps } = fakes((id) => [moonpayTx(id, { cryptoTransactionId: SIG(7) })], () => null);
  await settlePendingMoonpay([a], {}, deps);
  await settlePendingMoonpay([b], {}, deps);
  assert.deepEqual((await purchases(a.id)).map((p) => p.state), ["sent"]);
  assert.deepEqual((await purchases(b.id)).map((p) => [p.state, p.error]), [["mismatch", "transaction already reported for another purchase"]]);
});

/** Run with MoonPay configured through the environment, as a deployment would be. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
const ENV = {
  NEXT_PUBLIC_OWED_MOONPAY: "1", MOONPAY_PUBLISHABLE_KEY: "pk_test_owedtest", MOONPAY_SECRET_KEY: "sk_test_owedtest",
  MOONPAY_WEBHOOK_KEY: "wk_test_owedtest", OWED_BASE_URL: "https://owed.example",
};

it("GET /api/moonpay/:id: 303 to the signed sandbox widget, records the checkout; 404 when the feature is off", async () => {
  const row = await newRequest();
  const { GET } = await import("@/app/api/moonpay/[id]/route");
  const call = (id: string, query = "") => GET(
    new Request(`https://owed.example/api/moonpay/${id}${query}`, { headers: { "x-real-ip": "203.0.113.42" } }),
    { params: Promise.resolve({ id }) } as Parameters<typeof GET>[1],
  );
  const off = await call(row.id);
  assert.equal(off.status, 404);
  assert.match(await off.text(), /isn&#39;t available/);

  const res = await withEnv(ENV, () => call(row.id, "?back=i"));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const url = new URL(res.headers.get("location")!);
  assert.equal(url.origin, "https://buy-sandbox.moonpay.com");
  const p = url.searchParams;
  assert.deepEqual(
    [p.get("apiKey"), p.get("currencyCode"), p.get("walletAddress"), p.get("quoteCurrencyAmount"), p.get("externalTransactionId"), p.get("redirectURL"), p.get("unsupportedRegionRedirectUrl")],
    ["pk_test_owedtest", "usdc_sol", RECIPIENT, "12.5", row.id, `https://owed.example/i/${row.id}?card=return`, `https://owed.example/i/${row.id}?card=region`],
  );
  assert.equal(p.get("allowedIpAddress"), createHmac("sha256", "sk_test_owedtest").update("203.0.113.42").digest("base64"));
  const [signed] = url.search.split("&signature=");
  assert.equal(p.get("signature"), createHmac("sha256", "sk_test_owedtest").update(signed).digest("base64"));
  const checkout = await pg.query<{ starts: number }>("select starts from moonpay_checkouts where request_id = $1", [row.id]);
  assert.equal(Number(checkout.rows[0]!.starts), 1);

  // Below MoonPay's minimum: no widget, straight back to the pay page (which says why).
  const small = await newRequest(1_000_000n);
  const back = await withEnv(ENV, () => call(small.id));
  assert.equal(back.status, 303);
  assert.equal(back.headers.get("location"), `https://owed.example/r/${small.id}`);
  assert.equal((await pg.query("select 1 from moonpay_checkouts where request_id = $1", [small.id])).rows.length, 0);

  assert.equal((await withEnv(ENV, () => call("nope"))).status, 404);
});

it("POST /api/hooks/moonpay: refuses a missing or wrong Moonpay-Signature-V2; acknowledges a signed one", async () => {
  const { POST } = await import("@/app/api/hooks/moonpay/route");
  const body = JSON.stringify({ type: "sell_transaction_updated", data: {} });
  const post = (signature: string | null) => POST(new Request("https://owed.example/api/hooks/moonpay", {
    method: "POST", body, headers: { "content-type": "application/json", ...(signature && { "moonpay-signature-v2": signature }) },
  }));
  assert.equal((await post(null)).status, 503, "no webhook key configured: refused");
  await withEnv(ENV, async () => {
    const t = Math.floor(Date.now() / 1000);
    const good = `t=${t},s=${createHmac("sha256", "wk_test_owedtest").update(`${t}.${body}`).digest("hex")}`;
    assert.equal((await post(null)).status, 401);
    assert.equal((await post(good.replace(/s=./, "s=0"))).status, 401);
    assert.equal((await post(`t=${t},s=${createHmac("sha256", "other").update(`${t}.${body}`).digest("hex")}`)).status, 401);
    const ok = await post(good);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { received: false });
  });
});
