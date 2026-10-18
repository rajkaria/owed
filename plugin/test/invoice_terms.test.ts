import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInvoice, inputSchema, outputSchema, type InvoiceOutput } from "../src/tools/create_invoice.ts";
import { checkTerms, payAtomicOf, planLocal, termsSentence } from "../src/invoice-terms.ts";
import { invoiceTermsResSchema } from "../src/contract.ts";
import * as money from "../src/money.ts";
import { fixture, json, makeDeps, textOf } from "./helpers.ts";

// F8 invoices in create_invoice: installments, an early-pay price, a late fee and chase days. The plugin works every
// term out itself (src/invoice-terms-core.ts, byte-identical on the server) and refuses a reply whose plan differs.
// The server's replies are contract/fixtures/invoice.terms.*.json, made by the real routes on PGlite.

const req = fixture("invoice.terms.create.req.json");
const res = fixture("invoice.terms.create.res.json");
const early = fixture("invoice.terms.get.res.json");
const NOW = Date.parse(res.created_at);
const POST = "POST /api/v1/invoices";

const input = (extra: Record<string, unknown> = {}) => inputSchema.parse({
  recipient: req.recipient, business_name: req.business_name, client_name: req.client_name, invoice_number: req.invoice_number,
  items: [{ description: req.items[0].description, quantity: 30, unit_price: "10" }, { description: req.items[1].description, unit_price: "0.000001" }],
  due_date: req.due_date, notes: req.notes, installments: { count: 3 }, late_fee: { percent: "1.5" }, chase: { days: [3, 10] }, ...extra,
});
const structured = (result: Awaited<ReturnType<typeof createInvoice>>): InvoiceOutput => {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  return outputSchema.parse((result as { structuredContent: InvoiceOutput }).structuredContent);
};
const refused = (result: Awaited<ReturnType<typeof createInvoice>>) => {
  assert.equal((result as { isError?: boolean }).isError, true, `expected a refusal, got ${textOf(result)}`);
  return textOf(result);
};

test("the plugin's terms core is the server's, byte for byte", () => {
  const plugin = readFileSync(new URL("../src/invoice-terms-core.ts", import.meta.url), "utf8");
  const web = readFileSync(new URL("../../web/lib/invoice-terms-core.ts", import.meta.url), "utf8");
  assert.equal(plugin, web);
});

test("3 monthly installments: the body carries the terms, the reply's plan is checked, and the output and message show it", async () => {
  const { deps, rec } = makeDeps({ now: () => NOW, routes: { [POST]: () => json(201, res) } });
  const out = structured(await createInvoice(input(), deps));
  const body = rec.calls[0]!.body as Record<string, unknown>;
  assert.deepEqual(body.installments, { count: 3, interval: "monthly" });
  assert.deepEqual(body.late_fee, { percent: "1.5" });
  assert.deepEqual(body.chase, { days: [3, 10] });
  assert.equal(out.total, "300.000001");
  assert.equal(out.terms?.installments?.plan.length, 3);
  assert.equal(out.terms?.pay_now?.amount, "100.000001");
  assert.match(out.share_text, /It is payable in 3 monthly installments: 100\.000001 USDC by Nov 1, 2026, then 100 USDC each due Dec 1, 2026, Jan 1, 2027\. A late fee of 4\.5 USDC applies if it isn't paid by Nov 1, 2026 \(each installment by its own date\)\.$/);
  const text = textOf(await createInvoice(input(), makeDeps({ now: () => NOW, routes: { [POST]: () => json(201, res) } }).deps));
  assert.match(text, /Installments: 1\) 100\.000001 due 2026-11-01; 2\) 100 due 2026-12-01 \(opens 2026-11-24\); 3\) 100 due 2027-01-01 \(opens 2026-12-25\)/);
  assert.match(text, /Reminders: who_owes_me says one is due 3, 10 days after the due date/);
});

test("a reply whose plan, fee or chase days differ from what was asked is refused", async () => {
  const tamper = (f: (t: typeof res.terms) => void) => {
    const copy = structuredClone(res);
    f(copy.terms);
    return copy;
  };
  for (const [what, bad] of [
    ["installment amount", tamper((t) => { t.installments.plan[1].amount = "101"; })],
    ["due date", tamper((t) => { t.installments.plan[2].due_date = "2027-01-02"; })],
    ["open day", tamper((t) => { t.installments.plan[1].opens_on = "2026-11-01"; })],
    ["late fee", tamper((t) => { t.late_fee.request.amount = "5"; })],
    ["chase", tamper((t) => { t.chase = null; })],
    ["no terms", { ...res, terms: undefined }],
  ] as const) {
    const { deps } = makeDeps({ now: () => NOW, routes: { [POST]: () => json(201, bad) } });
    assert.match(refused(await createInvoice(input(), deps)), /terms|wasn't used/, what);
  }
  // The invoice's own request must ask installment 1, not the total.
  const total = { ...res, solana_pay_url: res.solana_pay_url.replace("amount=100.000001", "amount=300.000001") };
  const { deps } = makeDeps({ now: () => NOW, routes: { [POST]: () => json(201, total) } });
  assert.match(refused(await createInvoice(input(), deps)), /doesn't match what was asked/);
});

test("refused before any call: installments with an early price, in a local currency, with expires_in_days, a different first_due", async () => {
  const { deps, rec } = makeDeps({ now: () => NOW, routes: { [POST]: () => json(201, res) } });
  assert.match(refused(await createInvoice(input({ early_discount: { percent: "5", until: "2026-10-25" } }), deps)), /not both/);
  assert.match(refused(await createInvoice(input({ currency: "INR", items: [{ description: "Translation", unit_price: "30000" }] }), deps)), /USDC or SOL only/);
  assert.match(refused(await createInvoice(input({ expires_in_days: 30 }), deps)), /expires_in_days can't be combined/);
  assert.match(refused(await createInvoice(input({ installments: { count: 3, first_due: "2026-11-05" } }), deps)), /first installment's due date/);
  assert.match(refused(await createInvoice(input({ late_fee: { amount: "1", percent: "1" } }), deps)), /exactly one of amount and percent/);
  assert.throws(() => input({ installments: { count: 13 } })); // the input schema caps it at 12
  assert.throws(() => input({ installments: { count: 3, interval: 3 } })); // and intervals at 7 days or more
  assert.equal(rec.calls.length, 0);
});

test("an early-pay price: the plan matches the server's two prices and the date between them", () => {
  const units = (a: string) => money.toAtomic(a, "USDC");
  const planned = planLocal({ early_discount: { percent: "5", until: early.terms.early_discount.until }, late_fee: { amount: "10" } }, {
    totalUnits: 200_000_000n, issueDate: early.issue_date, dueDate: early.due_date, currency: null, expiresInDays: undefined, units,
  });
  assert.ok(planned.ok);
  if (!planned.ok) return;
  assert.equal(planned.plan.ownUnits, 190_000_000n);
  const terms = invoiceTermsResSchema.parse(early).terms;
  assert.equal(checkTerms(terms, planned.plan, { id: early.id, token: "USDC", toAtomic: money.toAtomic, pay: (u) => payAtomicOf(u, null, null) }), null);
  assert.equal(termsSentence(terms!, "USDC"), `Pay 190 USDC by ${"Oct 28, 2026"} (5% off); after that it's 200 USDC. A late fee of 10 USDC applies if it isn't paid by Nov 17, 2026.`);
  const wrongDay = structuredClone(terms!);
  wrongDay.early_discount!.until = "2026-10-27";
  assert.notEqual(checkTerms(wrongDay, planned.plan, { id: early.id, token: "USDC", toAtomic: money.toAtomic, pay: (u) => u }), null);
});

test("an invoice without terms is created exactly as before (same body, no terms in the output)", async () => {
  const plain = fixture("invoices.create.res.json");
  const { deps, rec } = makeDeps({ routes: { [POST]: () => json(201, plain) } });
  const out = structured(await createInvoice(inputSchema.parse({
    recipient: plain.recipient, business_name: "Northwind Translation", client_name: "Lena",
    items: [
      { description: "Translation, English to Hindi (pages)", quantity: 3, unit_price: "0.2" },
      { description: "Proofreading", unit_price: "0.25" },
      { description: "Call to review terms (hours)", quantity: "1.5", unit_price: "0.1" },
    ],
    due_date: "2026-10-31", invoice_number: "NT-2026-017", notes: "Thanks, Lena. Payment within 14 days, please.",
  }), deps));
  assert.equal(out.terms, undefined);
  const body = rec.calls[0]!.body as Record<string, unknown>;
  for (const key of ["installments", "early_discount", "late_fee", "chase"]) assert.equal(key in body, false, key);
});

// ---- write_reminder on an invoice with terms (src/tools/write_reminder.ts reads them from GET /api/v1/invoices/:id)
import { writeReminder, inputSchema as reminderInput } from "../src/tools/write_reminder.ts";

test("write_reminder chases what is due now on an invoice with installments, and nothing when nothing is open", async () => {
  const id = res.id;
  const paidOne = structuredClone(res);
  paidOne.status = "underpaid";
  paidOne.paid = { signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv", payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "100.000001", at: "2026-10-30T10:00:00Z", rail: "solana_pay" };
  paidOne.terms.status = "underpaid";
  paidOne.terms.installments.plan[0].status = "paid";
  paidOne.terms.installments.plan[1] = { ...paidOne.terms.installments.plan[1], status: "open", id: "438EhamrPRUD", link: "https://www.getowed.xyz/i/438EhamrPRUD" };
  paidOne.terms.pay_now = { id: "438EhamrPRUD", link: "https://www.getowed.xyz/i/438EhamrPRUD", amount: "100", due_date: "2026-12-01", role: "installment", seq: 2 };
  const { deps } = makeDeps({ now: () => Date.parse("2026-12-04T10:00:00Z"), routes: { [`GET /api/v1/invoices/${id}`]: () => json(200, paidOne) } });
  const r = await writeReminder(reminderInput.parse({ request: `https://www.getowed.xyz/i/${id}`, tone: "firm" }), deps);
  const o = (r as { structuredContent: { status: string; amount_due?: string; link?: string; due_date?: string } }).structuredContent;
  assert.equal(o.status, "open");
  assert.equal(o.amount_due, "100");
  assert.equal(o.link, "https://www.getowed.xyz/i/438EhamrPRUD");
  assert.equal(o.due_date, "2026-12-01");

  const waiting = structuredClone(paidOne);
  waiting.terms.installments.plan[1].status = "paid";
  waiting.terms.pay_now = null;
  const { deps: d2 } = makeDeps({ now: () => Date.parse("2026-12-04T10:00:00Z"), routes: { [`GET /api/v1/invoices/${id}`]: () => json(200, waiting) } });
  const none = await writeReminder(reminderInput.parse({ request: `https://www.getowed.xyz/i/${id}` }), d2);
  assert.equal((none as { isError?: boolean }).isError, true);
  assert.match(textOf(none), /^Nothing to chase on this invoice right now: its next payment opens 2026-12-25\. Paid so far: 0 USDC\.$/);
});
