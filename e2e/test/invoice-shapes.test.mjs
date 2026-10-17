// contract/shapes.mjs invoice shapes: the fixtures pass, and every way a server could misstate an invoice fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, fixtureShapes, invoiceLineAtomic, requestIdFor, shapes } from "../../contract/shapes.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errors = (shape, value) => check(shapes[shape], value).errors;

test("invoice fixtures are mapped and pass with no warnings", () => {
  for (const [name, shape] of [["invoices.create.req.json", "createInvoiceReq"], ["invoices.create.res.json", "invoiceRes"], ["invoices.get.res.json", "invoiceRes"]]) {
    assert.equal(fixtureShapes[name], shape);
    assert.deepEqual(check(shapes[shape], fixture(name)), { errors: [], warnings: [] }, name);
  }
});

test("line math is bigint and exact", () => {
  assert.equal(invoiceLineAtomic("1.5", "0.1", 6), 150_000n);
  assert.equal(invoiceLineAtomic("3", "0.2", 6), 600_000n);
  assert.equal(invoiceLineAtomic("1.5", "0.000001", 6), null);
  assert.equal(invoiceLineAtomic("0.5", "0.000000002", 9), 1n);
});

test("invoiceRes rejects a misstated invoice", () => {
  const ok = fixture("invoices.create.res.json");
  const other = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const cases = {
    "total that isn't the sum": { ...ok, total: "2" },
    "line amount that isn't quantity × unit price": { ...ok, items: [{ ...ok.items[0], amount: "0.7" }, ...ok.items.slice(1)] },
    "solana: URL for another amount": { ...ok, solana_pay_url: ok.solana_pay_url.replace("amount=1&", "amount=2&") },
    "solana: URL to another wallet": { ...ok, solana_pay_url: ok.solana_pay_url.replace(ok.recipient, other) },
    "id that doesn't hash the terms": { ...ok, id: "3ERgzxsixBMx", link: ok.link.replace(ok.id, "3ERgzxsixBMx"), request_link: ok.request_link.replace(ok.id, "3ERgzxsixBMx") },
    "page link to another invoice": { ...ok, link: ok.link.replace(ok.id, "JArQ6g9JvoWr") },
    "issue date that isn't created_at's": { ...ok, issue_date: "2026-10-16" },
    "impossible due date": { ...ok, due_date: "2026-02-30" },
    "domain without a verified time": { ...ok, from_domain: "example.com" },
    "upper-case domain": { ...ok, from_domain: "Example.com", from_domain_verified_at: ok.created_at },
    "paid without a payment": { ...ok, status: "paid" },
    "quantity with 5 decimal places": { ...ok, items: [{ ...ok.items[0], quantity: "3.00001" }, ...ok.items.slice(1)] },
    "a URL in sender text": { ...ok, notes: "pay at https://evil.example" },
  };
  for (const [what, value] of Object.entries(cases)) assert.notDeepEqual(errors("invoiceRes", value), [], what);
  assert.equal(ok.id, requestIdFor({ recipient: ok.recipient, token: "USDC", amountAtomic: 1_000_000n, reference: ok.reference }));
});

test("createInvoiceReq rejects lines that would need rounding and out-of-range sizes", () => {
  const req = fixture("invoices.create.req.json");
  assert.notDeepEqual(errors("createInvoiceReq", { ...req, items: [{ description: "x", quantity: "1.5", unit_price: "0.000001" }] }), []);
  assert.notDeepEqual(errors("createInvoiceReq", { ...req, items: [] }), []);
  assert.notDeepEqual(errors("createInvoiceReq", { ...req, items: Array(21).fill(req.items[0]) }), []);
  assert.notDeepEqual(errors("createInvoiceReq", { ...req, business_name: "x".repeat(61) }), []);
  assert.deepEqual(errors("createInvoiceReq", { ...req, items: [{ description: "x", unit_price: "1" }] }), [], "quantity defaults to 1");
});
