import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { POST as createRoute } from "@/app/api/v1/requests/route";
import { GET as getRoute } from "@/app/api/v1/requests/[id]/route";
import { POST as statusRoute } from "@/app/api/v1/status/route";
import { POST as groupsRoute } from "@/app/api/v1/groups/route";
import { POST as invoicesRoute } from "@/app/api/v1/invoices/route";
import { POST as schedulesRoute } from "@/app/api/v1/schedules/route";
import { CreateRequestResponse, GetRequestResponse, GroupResponse, InvoiceResponse, StatusResponse } from "@/lib/contract";
import { quoteProblem, usdcAtomicFor } from "@/lib/fiat";
import { resetFxCache } from "@/lib/fx";
import { requestIdFor } from "@/lib/ids";
import { getLedger } from "@/lib/ledger";
import { CSV_COLUMNS, ledgerCsv } from "@/lib/ledger-csv";
import { toAtomic } from "@/lib/money";
import { getPublicInvoice } from "@/lib/invoices";
import { invoiceModel } from "@/app/i/[id]/model";
import { getPublicRequest } from "@/lib/public-api";
import { modelFromRequest, pageDescription, pageTitle } from "@/lib/view/request-view";

// Local-currency asks on real Postgres: migration 0013, then every create route with `currency`, reading back through
// GET, /status, the ledger, the CSV and the page models. PGlite answers lib/db.ts's Neon calls; the two rate hosts
// answer with real replies captured 2026-10-17T21:06:41Z (test/fixtures/fx); Solana RPC sees no payments.
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
const WEB = new URL("../", import.meta.url);
const MIGRATIONS = new URL("db/migrations/", WEB);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));

async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const NEON = "https://api.us-east-1.aws.neon.tech/sql";
const fx = (name: string) => readFileSync(new URL(`fixtures/fx/${name}`, import.meta.url), "utf8");
let coinbase = fx("coinbase-usd.json");
const erApi = fx("er-api-usd.json");
const fxCalls: string[] = [];

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
    if (url === "https://api.coinbase.com/v2/exchange-rates?currency=USD") return fxCalls.push("coinbase"), new Response(coinbase);
    if (url === "https://open.er-api.com/v6/latest/USD") return fxCalls.push("er-api"), new Response(erApi);
    if (/^https:\/\/(solana-rpc\.publicnode\.com|api\.mainnet-beta\.solana\.com)/.test(url)) {
      // No payment has landed for any reference: every lookup is empty.
      const body = JSON.parse(String(init!.body));
      const answer = (m: { id: unknown }) => ({ jsonrpc: "2.0", id: m.id, result: [] });
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    }
    throw new TypeError(`no network in this test: ${url}`);
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  delete process.env.OWED_BASE_URL;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

beforeEach(async () => {
  resetFxCache();
  coinbase = fx("coinbase-usd.json");
  fxCalls.length = 0;
  if (mod) await pg.exec("delete from rate_events").catch(() => undefined);
});

const post = (route: (req: Request) => Promise<Response>, path: string, body: Record<string, unknown>) =>
  route(new Request(`https://owed-preview.example/api/v1/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recipient: RECIPIENT, source: "plugin", ...body }),
  }));
const read = (id: string) => getRoute(new Request(`https://owed-preview.example/api/v1/requests/${id}`), { params: Promise.resolve({ id }) } as Parameters<typeof getRoute>[1]);
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

it("0013 applies on top of every migration, is idempotent, and keeps a quote whole and on USDC", async () => {
  await pg.exec(readFileSync(new URL("0013_fiat_quotes.sql", MIGRATIONS), "utf8"));
  const res = await post(createRoute, "requests", { amount: "500", currency: "INR", for: "0013 check" });
  assert.equal(res.status, 201);
  const { id } = CreateRequestResponse.parse(await res.json());
  const bad: Array<[string, string]> = [
    ["update requests set fiat_rate = null where id = $1", "requests_fiat_shape"],
    ["update requests set fiat_currency = 'USD' where id = $1", "requests_fiat_shape"],
    ["update requests set fiat_amount = '1.0' where id = $1", "requests_fiat_shape"],
    ["update requests set fiat_rate = '0' where id = $1", "requests_fiat_shape"],
    ["update requests set fiat_rate = '1.1234567890123' where id = $1", "requests_fiat_shape"],
    ["update requests set token = 'SOL', mint = null, decimals = 9 where id = $1", "requests_fiat_shape"],
    ["update requests set fiat_quoted_at = null where id = $1", "requests_fiat_shape"],
  ];
  for (const [q, constraint] of bad) await assert.rejects(pg.query(q, [id]), (e: { message: string }) => e.message.includes(constraint), q);
});

it("POST /requests with currency INR: USDC locked at the live rate (rounded up), the id commits to it, the quote is stored", async () => {
  const res = await post(createRoute, "requests", { amount: "1200", currency: "INR", payer_name: "Priya", for: "dinner", requester_name: "Raj" });
  assert.equal(res.status, 201);
  const body = CreateRequestResponse.parse(await res.json());
  assert.equal(body.amount, "12.636934");
  assert.equal(body.fiat?.currency, "INR");
  assert.equal(body.fiat?.amount, "1200");
  assert.equal(body.fiat?.rate, "94.95975");
  assert.equal(body.fiat?.rate_source, "api.coinbase.com, checked against open.er-api.com");
  assert.match(body.fiat?.quoted_at ?? "", ISO_Z);
  assert.ok(body.solana_pay_url?.includes("amount=12.636934&"));
  assert.equal(body.id, requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 12_636_934n, reference: body.reference }));
  assert.deepEqual(fxCalls.sort(), ["coinbase", "er-api"]);

  // GET, /status and the ledger all carry the same quote; it still produces the USDC amount.
  const got = GetRequestResponse.parse(await (await read(body.id)).json());
  assert.deepEqual(got.fiat, body.fiat);
  assert.equal(got.amount, "12.636934");
  assert.equal(quoteProblem(got.fiat!, toAtomic(got.amount, "USDC")), null);
  const status = StatusResponse.parse(await (await statusRoute(new Request("https://owed-preview.example/api/v1/status", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [body.id] }),
  }))).json());
  assert.equal(status.results[0]!.status, "open");
  assert.deepEqual(status.results[0]!.fiat, body.fiat);
  const ledger = await getLedger(RECIPIENT, { base: "https://owed.example", chainBudgetMs: 500 });
  assert.deepEqual(ledger.open.find((e) => e.id === body.id)?.fiat, body.fiat);

  // The pay page: "₹1,200" over "= 12.636934 USDC", rate locked when, labelled a quote.
  const pub = await getPublicRequest(body.id);
  const model = modelFromRequest(pub!, "https://owed.example");
  assert.equal(model.fiat?.amount, "₹1,200");
  assert.equal(model.fiat?.usdc, "12.636934 USDC");
  assert.equal(model.fiat?.rate, "1 USDC = ₹94.96");
  assert.equal(pageTitle(model), "Raj is asking you for ₹1,200 (12.636934 USDC)");
  assert.match(pageDescription(model), /^₹1,200 = 12\.636934 USDC \(rate locked \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\) for “dinner”\./);
});

it("USDC asks are unchanged: no fiat columns set, no quote in any reply, no rate fetched", async () => {
  const res = await post(createRoute, "requests", { amount: "15", for: "plain" });
  const raw = (await res.json()) as Record<string, unknown>;
  assert.equal("fiat" in raw, false);
  assert.equal("amount" in raw, false);
  const got = (await (await read(raw.id as string)).json()) as Record<string, unknown>;
  assert.equal("fiat" in got, false);
  assert.deepEqual(fxCalls, []);
});

it("currency errors: USD, unknown codes, decimals, SOL, Base → 400; sources more than 2% apart → 503 and no row", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ amount: "10", currency: "USD" }, /^currency: USD needs no conversion/],
    [{ amount: "10", currency: "XYZ" }, /^currency: Owed can't quote XYZ yet/],
    [{ amount: "10.5", currency: "JPY" }, /^amount: JPY amounts are whole numbers/],
    [{ amount: "10", currency: "INR", token: "SOL" }, /^token: a local-currency ask is paid in USDC/],
    [{ amount: "10", currency: "INR", chain: "base", recipient: "0x1111111111111111111111111111111111111111" }, /^currency: local-currency asks are Solana USDC only/],
  ];
  for (const [body, message] of cases) {
    const res = await post(createRoute, "requests", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await errorOf(res)).message, message);
  }
  const before = (await pg.query<{ n: string }>("select count(*)::text as n from requests")).rows[0]!.n;
  coinbase = coinbase.replace(/"INR":"[^"]*"/, '"INR":"101.377"'); // Coinbase's USDC->INR market price, 2026-10-17
  const res = await post(createRoute, "requests", { amount: "1200", currency: "INR" });
  assert.equal(res.status, 503);
  assert.match((await errorOf(res)).message, /disagree on INR by 6\.6% \(more than 2%\), so no rate was locked/);
  assert.equal((await pg.query<{ n: string }>("select count(*)::text as n from requests")).rows[0]!.n, before);
});

it("POST /groups with currency EUR: split in euros (€10 → 3.34 + 3.33 + 3.33), each share locked at one rate", async () => {
  const res = await post(groupsRoute, "groups", { total: "10", currency: "EUR", title: "Taxi", people: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  assert.equal(res.status, 201);
  const g = GroupResponse.parse(await res.json());
  assert.deepEqual(g.shares.map((s) => s.fiat?.amount), ["3.34", "3.33", "3.33"]);
  const rate = g.fiat!.rate;
  assert.equal(rate, "0.889913");
  assert.deepEqual(g.shares.map((s) => s.amount), ["3.34", "3.33", "3.33"].map((a) => fromAtomic6(usdcAtomicFor(a, "EUR", rate))));
  assert.ok(g.shares.every((s) => s.fiat?.rate === rate && s.fiat.quoted_at === g.fiat!.quoted_at));
  assert.equal(g.fiat!.amount, "10");
  const sum = g.shares.reduce((n, s) => n + toAtomic(s.amount, "USDC"), 0n);
  assert.equal(toAtomic(g.total, "USDC"), sum);
  // Each share reads back as an ordinary request carrying its own quote.
  const share = GetRequestResponse.parse(await (await read(g.shares[0]!.id)).json());
  assert.deepEqual(share.fiat, g.shares[0]!.fiat);
});

it("POST /invoices with currency JPY: lines in yen, total locked to USDC; the invoice page shows both", async () => {
  const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const res = await post(invoicesRoute, "invoices", {
    currency: "JPY", business_name: "Raj Studio", client_name: "Kenji", due_date: due, invoice_number: "RS-042",
    items: [{ description: "Logo design", unit_price: "45000" }, { description: "Revision rounds", quantity: "2", unit_price: "7500" }],
  });
  assert.equal(res.status, 201);
  const inv = InvoiceResponse.parse(await res.json());
  assert.deepEqual(inv.items.map((i) => [i.unit_price, i.amount]), [["45000", "45000"], ["7500", "15000"]]);
  assert.equal(inv.fiat?.amount, "60000");
  assert.equal(inv.fiat?.rate, "158.0085");
  assert.equal(inv.total, "379.726408");
  assert.ok(inv.solana_pay_url.includes("amount=379.726408&"));
  const page = await getPublicInvoice(inv.id, "https://owed.example");
  const model = invoiceModel(page!, Date.now());
  assert.equal(model.itemUnit, "JPY");
  assert.deepEqual(model.lines.map((l) => l.amount), ["¥45,000", "¥15,000"]);
  assert.equal(model.totalLabel, "379.726408 USDC");
  assert.equal(model.fiat?.amount, "¥60,000");
  const fractional = await post(invoicesRoute, "invoices", {
    currency: "JPY", business_name: "Raj Studio", client_name: "Kenji", due_date: due, items: [{ description: "x", unit_price: "1.5" }],
  });
  assert.equal(fractional.status, 400);
  assert.match((await errorOf(fractional)).message, /items\[0\]: JPY amounts are whole numbers/);
});

it("POST /schedules refuses a currency with the reason; the CSV carries the quote columns", async () => {
  const res = await post(schedulesRoute, "schedules", { amount: "45000", currency: "INR", payer_name: "Sam", for: "rent", day_of_month: 1 });
  assert.equal(res.status, 400);
  assert.match((await errorOf(res)).message, /^currency: monthly requests are in USDC or SOL only/);

  const csv = await ledgerCsv(RECIPIENT, "https://owed.example");
  const lines = csv.text.replace(/^﻿/, "").trim().split("\r\n");
  assert.deepEqual(CSV_COLUMNS.slice(-4), ["quote_currency", "quote_amount", "quote_rate_per_usdc", "quote_locked_at"]);
  assert.ok(lines[1]!.endsWith('"quote_currency","quote_amount","quote_rate_per_usdc","quote_locked_at"'));
  const inr = lines.find((l) => l.includes('"INR","1200","94.95975"'));
  assert.ok(inr, "the ₹1,200 request's row");
  assert.match(inr!, /"12\.636934","USDC"/);
  assert.match(inr!, /"INR","1200","94\.95975","\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"$/);
  const plain = lines.find((l) => l.includes('"plain"'));
  assert.ok(plain!.endsWith('"","","",""'));
});

function fromAtomic6(atomic: bigint): string {
  const digits = atomic.toString().padStart(7, "0");
  const frac = digits.slice(-6).replace(/0+$/, "");
  return frac ? `${digits.slice(0, -6)}.${frac}` : digits.slice(0, -6);
}
