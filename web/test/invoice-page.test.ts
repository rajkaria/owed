import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daysUntil, dueLabel, formatDate, invoiceDescription, invoiceModel, invoiceTitle } from "@/app/i/[id]/model";
import type { PublicInvoice } from "@/lib/invoices";

const fixtures = new URL("../../contract/fixtures/", import.meta.url);
const fixture = (name: string): PublicInvoice => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const at = (iso: string) => Date.parse(iso);

test("dates: calendar dates in UTC, due labels relative to today", () => {
  assert.equal(formatDate("2026-10-31"), "Oct 31, 2026");
  assert.equal(formatDate("2026-01-01"), "Jan 1, 2026");
  assert.equal(daysUntil("2026-10-31", at("2026-10-17T23:59:00Z")), 14);
  assert.equal(daysUntil("2026-10-17", at("2026-10-17T00:00:01Z")), 0);
  assert.equal(dueLabel("2026-10-31", at("2026-10-17T07:00:00Z")), "Due Oct 31, 2026");
  assert.equal(dueLabel("2026-10-18", at("2026-10-17T07:00:00Z")), "Due tomorrow");
  assert.equal(dueLabel("2026-10-17", at("2026-10-17T07:00:00Z")), "Due today");
  assert.equal(dueLabel("2026-10-16", at("2026-10-17T07:00:00Z")), "Overdue · was due Oct 16, 2026");
});

test("open invoice: lines, totals and links come straight from the API, formatted for people", () => {
  const m = invoiceModel(fixture("invoices.create.res.json"), at("2026-10-17T07:00:00Z"));
  assert.equal(m.number, "NT-2026-017");
  assert.equal(m.numberIsId, false);
  assert.equal(m.totalLabel, "1 USDC");
  assert.equal(m.issued, "Oct 17, 2026");
  assert.equal(m.due, "Oct 31, 2026");
  assert.equal(m.overdue, false);
  assert.deepEqual(m.lines[2], {
    description: "Call to review terms (hours)", quantity: "1.5", unitPrice: "0.1 USDC", amount: "0.15 USDC", unitPriceValue: "0.1", amountValue: "0.15",
  });
  assert.deepEqual(m.initial, { status: "open" });
  assert.equal(m.agentPrompt, `Use the Owed plugin in PayBox to pay this invoice: ${m.requestLink}`);
  assert.ok(m.requestLink.endsWith(`/r/${m.id}`));
  assert.deepEqual(m.brandWords, []);
});

test("overdue only while unpaid; no invoice number falls back to the Owed id", () => {
  const open = fixture("invoices.create.res.json");
  assert.equal(invoiceModel(open, at("2026-11-02T00:00:00Z")).overdue, true);
  assert.equal(invoiceModel(fixture("invoices.get.res.json"), at("2026-11-02T00:00:00Z")).overdue, false);
  const unnumbered = invoiceModel({ ...open, invoice_number: null }, at("2026-10-17T07:00:00Z"));
  assert.equal(unnumbered.number, open.id);
  assert.equal(unnumbered.numberIsId, true);
});

test("paid invoice: the stamp data comes from the stored payment", () => {
  const paid = fixture("invoices.get.res.json");
  const m = invoiceModel(paid, at("2026-10-17T07:00:00Z"));
  assert.deepEqual(m.initial, {
    status: "paid", amount: "1", payer: paid.paid!.payer, signature: paid.paid!.signature, at: paid.paid!.at, rail: "solana_pay",
  });
  assert.equal(invoiceDescription(m), "Invoice for 1 USDC: paid on Solana.");
});

test("title and preview text never carry sender-written text; brand words from any field raise the caution", () => {
  const flagged = {
    ...fixture("invoices.create.res.json"),
    business_name: "MoonPay Billing", notes: "IRS refund", flags: [],
    items: [{ description: "Phantom wallet support", quantity: "1", unit_price: "1", amount: "1" }],
  };
  const m = invoiceModel(flagged, at("2026-10-17T07:00:00Z"));
  assert.equal(invoiceTitle(m), "Invoice for 1 USDC");
  assert.equal(invoiceDescription(m), "Invoice for 1 USDC, due Oct 31, 2026. Pay with any Solana wallet or your AI agent.");
  assert.doesNotMatch(invoiceTitle(m) + invoiceDescription(m), /MoonPay|IRS|Phantom|Northwind|Lena/);
  assert.deepEqual([...m.brandWords].sort(), ["IRS", "MoonPay", "Phantom", "refund"]);
});
