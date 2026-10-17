import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { check, shapes } from "../../contract/shapes.mjs";
import { InvoiceResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import {
  checkDueDate, fit, invoiceForText, isInvoiceId, MAX_ITEMS, parseQuantity, priceItems, toPublicInvoice, type InvoiceWithRequest,
} from "@/lib/invoices";
import { AmountError } from "@/lib/money";
import { POST } from "@/app/api/v1/invoices/route";
import { GET } from "@/app/api/v1/invoices/[id]/route";

const fixtures = new URL("../../contract/fixtures/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
// The team wallet's own USDC token account: off curve, the common paste-the-wrong-address mistake.
const OFF_CURVE = getAssociatedTokenAddressSync(new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), new PublicKey(RECIPIENT)).toBase58();
const NOW = Date.parse("2026-10-17T07:30:00Z");

// ---- pure helpers ----

test("quantities: up to 4 decimal places, scaled by 10^4, never zero", () => {
  assert.equal(parseQuantity("1.5"), 15_000n);
  assert.equal(parseQuantity("3"), 30_000n);
  assert.equal(parseQuantity("0.0001"), 1n);
  for (const bad of ["0", "0.00", "1.00001", "-1", "1e2", "", " 1", "1000000.5"]) {
    assert.throws(() => parseQuantity(bad), AmountError, bad);
  }
});

test("priceItems: bigint line amounts and total; 0.1 + 0.2 is exactly 0.3", () => {
  const { lines, totalAtomic } = priceItems(fixture("invoices.create.req.json").items, "USDC");
  assert.deepEqual(lines.map((l) => [l.quantity, l.unitPriceAtomic, l.amountAtomic]), [["3", 200_000n, 600_000n], ["1", 250_000n, 250_000n], ["1.5", 100_000n, 150_000n]]);
  assert.equal(totalAtomic, 1_000_000n);
  const tenths = priceItems([{ description: "a", quantity: "1", unit_price: "0.1" }, { description: "b", quantity: "1", unit_price: "0.2" }], "USDC");
  assert.equal(tenths.totalAtomic, 300_000n);
});

test("priceItems: refuses what would need rounding, empty text and bad counts, naming the line", () => {
  const refuses = (items: Parameters<typeof priceItems>[0], message: RegExp, token: "USDC" | "SOL" = "USDC") =>
    assert.throws(() => priceItems(items, token), (e: unknown) => e instanceof AmountError && message.test(e.message));
  refuses([{ description: "a", quantity: "1.5", unit_price: "0.000001" }], /^items\[0\]: 1\.5 × 0\.000001 USDC isn't a whole number/);
  refuses([{ description: "a", quantity: "1", unit_price: "1" }, { description: "b", quantity: "1", unit_price: "0" }], /^items\[1\]: amount must be/);
  refuses([{ description: "a", quantity: "0", unit_price: "1" }], /^items\[0\]: quantity/);
  refuses([{ description: "https://evil.example", quantity: "1", unit_price: "1" }], /^items\[0\]\.description is empty/);
  refuses([], /between 1 and 20 items/);
  refuses(Array(MAX_ITEMS + 1).fill({ description: "x", quantity: "1", unit_price: "1" }), /between 1 and 20 items/);
  assert.equal(priceItems([{ description: "a", quantity: "0.5", unit_price: "0.000000002" }], "SOL").totalAtomic, 1n);
});

test("due dates: real calendar dates from yesterday (UTC) to 3 years out", () => {
  assert.equal(checkDueDate("2026-10-17", NOW), "2026-10-17");
  assert.equal(checkDueDate("2026-10-16", NOW), "2026-10-16");
  assert.throws(() => checkDueDate("2026-10-15", NOW), /in the past/);
  assert.throws(() => checkDueDate("2026-02-29", NOW), /real date/);
  assert.throws(() => checkDueDate("2026-10-1", NOW), /real date/);
  assert.throws(() => checkDueDate("2029-10-18", NOW), /more than 3 years/);
  assert.equal(checkDueDate("2028-02-29", NOW), "2028-02-29");
});

test("request-row text: fit keeps the request caps and shows the cut; the wallet message names the invoice", () => {
  assert.equal(fit("Short", 40), "Short");
  const long = "Northwind Translation and Localisation Services";
  assert.equal(fit(long, 40), "Northwind Translation and Localisation…", "the cut drops a dangling space");
  assert.equal(fit("x".repeat(45), 40), `${"x".repeat(39)}…`);
  assert.equal(fit(null, 40), null);
  assert.equal(invoiceForText("NT-2026-017", "2026-10-31"), "Invoice NT-2026-017");
  assert.equal(invoiceForText(null, "2026-10-31"), "Invoice due 2026-10-31");
  assert.equal(isInvoiceId("3ERgzxsixBMk"), true);
  assert.equal(isInvoiceId("JArQ6g9Jvo"), false, "invoices only ever have derived 12-char ids");
});

function rowsFromFixture(f: ReturnType<typeof fixture>): InvoiceWithRequest {
  const usdc = (s: string) => {
    const [w, fr = ""] = s.split(".");
    return BigInt(w) * 1_000_000n + BigInt(fr.padEnd(6, "0"));
  };
  return {
    invoice: {
      id: f.id, recipient: f.recipient, token: f.token, totalAtomic: usdc(f.total), businessName: f.business_name, clientName: f.client_name,
      invoiceNumber: f.invoice_number, notes: f.notes, dueDate: f.due_date,
      items: f.items.map((i: { description: string; quantity: string; unit_price: string; amount: string }) => ({
        description: i.description, quantity: i.quantity, unitPriceAtomic: usdc(i.unit_price), amountAtomic: usdc(i.amount),
      })),
      flags: f.flags, source: "plugin", fromDomain: f.from_domain, fromDomainVerifiedAt: f.from_domain_verified_at, createdAt: f.created_at,
    },
    request: {
      id: f.id, kind: "invoice", recipient: f.recipient, token: f.token, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6,
      amountAtomic: usdc(f.total), reference: f.reference, payerName: f.client_name, forText: `Invoice ${f.invoice_number}`, note: null,
      requesterName: f.business_name, flags: f.flags, status: f.status, paidSignature: f.paid?.signature ?? null, paidPayer: f.paid?.payer ?? null,
      paidAmountAtomic: f.paid ? usdc(f.paid.amount) : null, paidAt: f.paid?.at ?? null, paidRail: f.paid ? "solana_pay" : null,
      source: "plugin", createdAt: f.created_at,
    },
  };
}

test("toPublicInvoice produces exactly the contract fixtures (open and paid)", () => {
  for (const name of ["invoices.create.res.json", "invoices.get.res.json"]) {
    const expected = fixture(name);
    assert.deepEqual(toPublicInvoice(rowsFromFixture(expected), "https://owed-omega.vercel.app"), expected, name);
  }
});

// ---- the routes against an in-memory Neon endpoint and an empty chain ----

interface Stored { [column: string]: string | null }
const db = { invoices: new Map<string, Stored>(), requests: new Map<string, Stored>(), rateEvents: 0, batches: 0 };
const realFetch = globalThis.fetch;
const realEnv = { DATABASE_URL: process.env.DATABASE_URL, OWED_BASE_URL: process.env.OWED_BASE_URL };
const CREATED = "2026-10-17T07:30:00Z";
const REQUEST_COLUMNS = ["id", "kind", "recipient", "token", "mint", "decimals", "amount_atomic", "reference", "payer_name", "for_text", "note",
  "requester_name", "flags", "status", "paid_signature", "paid_payer", "paid_amount_atomic", "paid_at", "paid_rail", "source", "created_at"];
const INVOICE_COLUMNS = ["id", "recipient", "token", "total_atomic", "business_name", "client_name", "invoice_number", "notes", "due_date",
  "items", "flags", "source", "from_domain", "from_domain_verified_at", "created_at"];

const result = (fields: string[], rows: Array<Array<string | null>>) => ({ fields: fields.map((name) => ({ name, dataTypeID: 25 })), rows });
/** Postgres text array literal from lib/db.ts → the JSON that array_to_json would give. */
const pgArrayToJson = (s: string | null) => JSON.stringify(!s || s === "{}" ? [] : s.slice(2, -2).split('","'));
const pick = (row: Stored, columns: string[]) => columns.map((c) => (c === "flags" ? pgArrayToJson(row.flags) : (row[c] ?? null)));

function runQuery(text: string, params: Array<string | null>) {
  if (text.startsWith("delete from rate_events")) return result([], []);
  if (text.includes("from rate_events")) {
    db.rateEvents += 1;
    return result(["allowed", "recipient_ok", "retry_recipient", "retry_global", "recorded"], [["t", "t", "1", "1", "2"]]);
  }
  if (text.startsWith("insert into requests")) {
    assert.match(text, /values \(\$1, 'invoice', \$1,/);
    const [id, recipient, token, mint, decimals, amount, reference, payerName, forText, requesterName, flags, source] = params;
    db.requests.set(id!, {
      id, kind: "invoice", invoice_id: id, recipient, token, mint, decimals, amount_atomic: amount, reference, payer_name: payerName,
      for_text: forText, note: null, requester_name: requesterName, flags, status: "open", paid_signature: null, paid_payer: null,
      paid_amount_atomic: null, paid_at: null, paid_rail: null, source, created_at: CREATED,
    });
    return result(["created_at"], [[CREATED]]);
  }
  if (text.startsWith("insert into invoices")) {
    const [id, recipient, token, total, business, client, number, notes, due, items, flags, source, fromDomain] = params;
    assert.ok(db.requests.has(id!), "the invoice is inserted after its request, in the same batch");
    const row: Stored = {
      id, recipient, token, total_atomic: total, business_name: business, client_name: client, invoice_number: number, notes,
      due_date: due, items, flags, source, from_domain: fromDomain, from_domain_verified_at: fromDomain ? CREATED : null, created_at: CREATED,
    };
    db.invoices.set(id!, row);
    return result(INVOICE_COLUMNS, [pick(row, INVOICE_COLUMNS)]);
  }
  if (text.includes("from invoices where id = $1")) {
    const row = db.invoices.get(params[0]!);
    return result(INVOICE_COLUMNS, row ? [pick(row, INVOICE_COLUMNS)] : []);
  }
  if (text.includes("from requests where id = $1")) {
    const row = db.requests.get(params[0]!);
    return result(REQUEST_COLUMNS, row ? [pick(row, REQUEST_COLUMNS)] : []);
  }
  throw new Error(`unexpected query: ${text.slice(0, 80)}`);
}

beforeEach(() => {
  db.invoices.clear();
  db.requests.clear();
  db.rateEvents = 0;
  db.batches = 0;
  process.env.DATABASE_URL = "postgresql://u:p@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.OWED_BASE_URL = "https://owed-omega.vercel.app";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "null"));
    if (url.host === "api.us-east-1.aws.neon.tech") {
      if (body.queries) {
        db.batches += 1;
        return Response.json({ results: body.queries.map((q: { query: string; params: Array<string | null> }) => runQuery(q.query.trim(), q.params)) });
      }
      return Response.json(runQuery(body.query.trim(), body.params));
    }
    // Solana RPC: nothing references this invoice yet.
    const calls = Array.isArray(body) ? body : [body];
    return Response.json(calls.map((c: { id: number }) => ({ jsonrpc: "2.0", id: c.id, result: [] })));
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(realEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const post = (body: unknown) => POST(new Request("https://owed-omega.vercel.app/api/v1/invoices", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const get = (id: string) => GET(new Request(`https://owed-omega.vercel.app/api/v1/invoices/${id}`), { params: Promise.resolve({ id }) } as never);
// The routes check due dates against the real clock; keep the fixture's date in the future.
const future = (() => {
  const d = new Date(Date.now() + 14 * 86_400_000);
  return d.toISOString().slice(0, 10);
})();
const request = (extra: Record<string, unknown> = {}) => ({ ...fixture("invoices.create.req.json"), due_date: future, ...extra });

test("POST /invoices: 201, contract-valid, one request row + one invoice row in one batch, derived id", async () => {
  const res = await post(request());
  assert.equal(res.status, 201);
  const body = await res.json();
  InvoiceResponse.parse(body);
  const shaped = check(shapes.invoiceRes, body);
  assert.deepEqual([shaped.errors, shaped.warnings], [[], []]);
  assert.equal(db.batches, 1);
  assert.equal(db.rateEvents, 1);
  assert.equal(body.total, "1");
  assert.equal(body.link, `https://owed-omega.vercel.app/i/${body.id}`);
  assert.equal(body.request_link, `https://owed-omega.vercel.app/r/${body.id}`);
  assert.equal(body.id, requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 1_000_000n, reference: body.reference }));
  assert.match(body.solana_pay_url, new RegExp(`amount=1&.*&label=Northwind%20Translation&message=Invoice%20NT-2026-017&memo=owed%3A${body.id}$`));
  assert.deepEqual(body.items.map((i: { amount: string }) => i.amount), ["0.6", "0.25", "0.15"]);
  const row = db.requests.get(body.id)!;
  assert.deepEqual([row.kind, row.invoice_id, row.amount_atomic, row.for_text, row.requester_name, row.payer_name, row.note],
    ["invoice", body.id, "1000000", "Invoice NT-2026-017", "Northwind Translation", "Lena", null]);
  const stored = JSON.parse(db.invoices.get(body.id)!.items!);
  assert.deepEqual(stored[2], { description: "Call to review terms (hours)", quantity: "1.5", unit_price_atomic: "100000", amount_atomic: "150000" });
  assert.equal(body.due_date, future);
  assert.equal(body.issue_date, CREATED.slice(0, 10));
});

test("POST /invoices: untrusted text is sanitized; brand words flag the invoice and its request; long names fit the request caps", async () => {
  const res = await post(request({
    business_name: "Northwind Translation and Localisation Services (MoonPay partner)",
    client_name: "Lena\u202e at https://evil.example",
    notes: "Pay fast: www.evil.io",
    items: [{ description: "Refund processing <script>", quantity: "1", unit_price: "1" }],
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.business_name, "Northwind Translation and Localisation Services (MoonPay par");
  assert.equal(body.client_name, "Lena at");
  assert.equal(body.notes, "Pay fast:");
  assert.equal(body.items[0].description, "Refund processing script");
  assert.deepEqual(body.flags, ["brand_word:moonpay", "brand_word:refund"]);
  const row = db.requests.get(body.id)!;
  assert.equal(row.requester_name, "Northwind Translation and Localisation…");
  assert.ok(Array.from(row.requester_name!).length <= 40);
  assert.equal(pgArrayToJson(row.flags), JSON.stringify(["brand_word:moonpay", "brand_word:refund"]));
  assert.deepEqual(check(shapes.invoiceRes, body).errors, []);
});

test("POST /invoices: invalid input is a 400 that names the problem, and spends no rate-limit slot", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [request({ recipient: OFF_CURVE }), /wallet address, not a token account/],
    [request({ items: [{ description: "x", quantity: "1.5", unit_price: "0.000001" }] }), /items\[0\]: 1\.5 × 0\.000001 USDC isn't a whole number/],
    [request({ due_date: "2020-01-01" }), /in the past/],
    [request({ due_date: "2026-13-01" }), /real date/],
    [request({ items: [] }), /items/],
    [request({ items: Array(21).fill({ description: "x", unit_price: "1" }) }), /items/],
    [request({ business_name: "https://only-a-link.example" }), /business_name is empty/],
    [request({ from_domain: "northwind.example" }), /from_domain can't be verified by this server yet/],
    [request({ token: "BONK" }), /token/],
    ["{not json", /must be JSON/],
  ];
  for (const [body, message] of cases) {
    const res = await post(body);
    assert.equal(res.status, 400, String(message));
    const err = await res.json();
    assert.equal(err.error.code, "invalid_input");
    assert.match(err.error.message, message);
    assert.deepEqual(check(shapes.errorRes, err).errors, []);
  }
  assert.equal(db.rateEvents, 0);
  assert.equal(db.requests.size, 0);
});

test("GET /invoices/:id: round trip, 404 for unknown, 400 for a malformed id", async () => {
  const created = await (await post(request())).json();
  const res = await get(created.id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), created);
  const missing = await get("3ERgzxsixBMk");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
  assert.equal((await get("not-an-id")).status, 400);
  assert.equal((await get("JArQ6g9Jvo")).status, 400, "10-char legacy ids are never invoices");
});

test("GET /invoices/:id: a paid invoice carries the payment; rows that disagree on the terms are never served", async () => {
  const created = await (await post(request())).json();
  const row = db.requests.get(created.id)!;
  Object.assign(row, {
    status: "paid", paid_signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
    paid_payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", paid_amount_atomic: "1000000", paid_at: "2026-10-17T07:41:09Z", paid_rail: "solana_pay",
  });
  const paid = await (await get(created.id)).json();
  assert.equal(paid.status, "paid");
  assert.deepEqual(paid.paid, { signature: row.paid_signature, payer: row.paid_payer, amount: "1", at: "2026-10-17T07:41:09Z", rail: "solana_pay" });
  assert.deepEqual(check(shapes.invoiceRes, paid).errors, []);
  row.amount_atomic = "2000000";
  assert.equal((await get(created.id)).status, 404);
});
