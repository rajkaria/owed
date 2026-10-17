import { test } from "node:test";
import assert from "node:assert/strict";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { checkPayments } from "../src/tools/check_payments.ts";
import { createInvoice, expiryBeforeDue, inputSchema as invoiceInput, outputSchema as invoiceOutput } from "../src/tools/create_invoice.ts";
import { payLink, inputSchema as payInput } from "../src/tools/pay_link.ts";
import { splitBill, inputSchema as splitInput, outputSchema as splitOutput } from "../src/tools/split_bill.ts";
import { writeReminder, inputSchema as reminderInput } from "../src/tools/write_reminder.ts";
import { expiryProblem } from "../src/expiry.ts";
import type { Screening } from "../src/screen.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf, type Call, type Route } from "./helpers.ts";

// W3-C: expiry and cancellation as every other tool sees them. The server sets expires_at; the tools pass
// expires_in_days, check the server did what was asked, and treat expired and cancelled requests as ended.

const NOW = Date.parse("2026-10-17T07:14:00Z"); // makeDeps' clock
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
const clear = async (): Promise<Screening> => ({ ok: true, screening: "skipped" });

test("expiryProblem: the server's expires_at must match the days asked for, within an hour of clock skew", () => {
  assert.equal(expiryProblem(undefined, null, NOW), null);
  assert.equal(expiryProblem(7, iso(NOW + 7 * DAY), NOW), null);
  assert.equal(expiryProblem(7, iso(NOW + 7 * DAY + 50 * 60_000), NOW), null);
  assert.match(expiryProblem(7, null, NOW)!, /didn't set the expiry you asked for/);
  assert.match(expiryProblem(7, iso(NOW + 8 * DAY), NOW)!, /set a different expiry/);
  assert.match(expiryProblem(7, "garbage", NOW)!, /didn't set the expiry/);
});

// ---- ask_for_money ----

const created = fixture("create-request.res.json");
test("ask_for_money: expires_in_days goes to the server; its expires_at comes back with a plain line", async () => {
  const expires_at = iso(NOW + 3 * DAY);
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, { ...created, expires_at }) } });
  const result = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "15", expires_in_days: 3 }), deps);
  assert.ok(!isError(result), textOf(result));
  const out = askOutput.parse((result as { structuredContent: unknown }).structuredContent);
  assert.equal(out.expires_at, expires_at);
  assert.equal((rec.calls[0]!.body as { expires_in_days?: number }).expires_in_days, 3);
  assert.match(textOf(result), new RegExp(`Expires ${expires_at} \\(in 3 days\\): after that the link stops taking payments\\.`));
});

test("ask_for_money: a server that ignores or changes the expiry is refused; offline says it can't expire", async () => {
  for (const patch of [{}, { expires_at: null }, { expires_at: iso(NOW + 30 * DAY) }]) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, { ...created, ...patch }) } });
    const r = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "15", expires_in_days: 3 }), deps);
    assert.ok(isError(r));
    assert.match(textOf(r), /expiry/);
  }
  const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => "network_error" } });
  const offline = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "15", expires_in_days: 3 }), deps);
  assert.ok(!isError(offline));
  assert.equal("expires_at" in (offline as { structuredContent: object }).structuredContent, false);
  assert.match(textOf(offline), /Offline links can't expire/);
  assert.equal(askInput.safeParse({ recipient: RECIPIENT, amount: "1", expires_in_days: 0 }).success, false);
  assert.equal(askInput.safeParse({ recipient: RECIPIENT, amount: "1", expires_in_days: 91 }).success, false);
  assert.equal(askInput.safeParse({ recipient: RECIPIENT, amount: "1", expires_in_days: 2.5 }).success, false);
});

// ---- split_bill ----

const groupFixture = fixture("groups.create.res.json");
test("split_bill: expires_in_days goes to the server and every share's expiry comes back", async () => {
  const expires_at = iso(NOW + 7 * DAY);
  const calls: Call[] = [];
  const route: Route = (call) => { calls.push(call); return json(201, { ...groupFixture, expires_at }); };
  const { deps } = makeDeps({ routes: { "POST /api/v1/groups": route } });
  const people = [{ name: "Priya" }, { name: "Sam" }, { name: "Alex" }];
  const result = await splitBill(splitInput.parse({ recipient: RECIPIENT, total: "1.5", title: "Pizza night", people, requester_name: "Raj", expires_in_days: 7 }), deps, clear);
  assert.ok(!isError(result), textOf(result));
  assert.equal(splitOutput.parse((result as { structuredContent: unknown }).structuredContent).expires_at, expires_at);
  assert.equal((calls[0]!.body as { expires_in_days?: number }).expires_in_days, 7);
  assert.match(textOf(result), /after that every share stops taking payments/);

  const { deps: d2 } = makeDeps({ routes: { "POST /api/v1/groups": () => json(201, groupFixture) } });
  const missing = await splitBill(splitInput.parse({ recipient: RECIPIENT, total: "1.5", title: "Pizza night", people, requester_name: "Raj", expires_in_days: 7 }), d2, clear);
  assert.ok(isError(missing));
  assert.match(textOf(missing), /didn't set the expiry/);
});

// ---- create_invoice ----

const invoiceFixture = fixture("invoices.create.res.json");
const invoiceArgs = (extra: Record<string, unknown> = {}) => invoiceInput.parse({
  recipient: RECIPIENT, business_name: "Northwind Translation", client_name: "Lena",
  items: [
    { description: "Translation, English to Hindi (pages)", quantity: 3, unit_price: "0.2" },
    { description: "Proofreading", unit_price: "0.25" },
    { description: "Call to review terms (hours)", quantity: "1.5", unit_price: "0.1" },
  ],
  due_date: "2026-10-31", invoice_number: "NT-2026-017", notes: "Thanks, Lena. Payment within 14 days, please.", ...extra,
});

test("create_invoice: an expiry before the due date is refused before any network; one that reaches it is passed on", async () => {
  assert.match(expiryBeforeDue("2026-10-31", 7, NOW)!, /^expires_in_days 7 would end the invoice before its due date 2026-10-31\. Use at least 14, or leave it out\.$/);
  assert.equal(expiryBeforeDue("2026-10-31", 14, NOW), null);
  const { deps, rec } = makeDeps({});
  const early = await createInvoice(invoiceArgs({ expires_in_days: 7 }), deps, clear);
  assert.ok(isError(early));
  assert.equal(rec.calls.length, 0);

  const expires_at = iso(NOW + 14 * DAY);
  const { deps: d2, rec: r2 } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, { ...invoiceFixture, expires_at }) } });
  const result = await createInvoice(invoiceArgs({ expires_in_days: 14 }), d2, clear);
  assert.ok(!isError(result), textOf(result));
  assert.equal(invoiceOutput.parse((result as { structuredContent: unknown }).structuredContent).expires_at, expires_at);
  assert.equal((r2.calls[0]!.body as { expires_in_days?: number }).expires_in_days, 14);
  assert.match(textOf(result), /after that the invoice stops taking payments/);
});

// ---- pay_link ----

const paidRequest = fixture("get-request.res.json");
const openRequest = { ...paidRequest, status: "open", paid: null };
const owed = (body: unknown) => ({ "GET /api/v1/requests/JArQ6g9JvoWr": () => json(200, body) });
const pay = () => payInput.parse({ link: "https://owed.link/r/JArQ6g9JvoWr", sender: SENDER });

test("pay_link refuses an expired request before any balance check or proposal, by the server's word or its own clock", async () => {
  const at = "2026-10-17T07:00:00Z";
  for (const body of [{ ...openRequest, status: "expired", expires_at: at }, { ...openRequest, expires_at: at }]) {
    const { deps, rec } = makeDeps({ routes: owed(body) });
    const r = await payLink(pay(), deps);
    assert.ok(isError(r));
    assert.equal(textOf(r), `This request expired at ${at} and no longer takes payments. Nothing was sent; ask the requester for a new link.`);
    assert.equal(rec.readiness.length, 0);
    assert.equal(rec.built.length, 0);
  }
  const cancelled = { ...openRequest, status: "cancelled", cancelled: { at, signed_message: "x", signature: "y".repeat(128) } };
  const { deps, rec } = makeDeps({ routes: owed(cancelled) });
  assert.equal(textOf(await payLink(pay(), deps)), "This request was cancelled by the requester.");
  assert.equal(rec.built.length, 0);
  // Still open with an expiry ahead: pays as before.
  const { deps: d3, rec: r3 } = makeDeps({ routes: owed({ ...openRequest, expires_at: iso(NOW + DAY) }) });
  assert.ok(!isError(await payLink(pay(), d3)));
  assert.equal(r3.built.length, 1);
});

// ---- check_payments ----

test("check_payments reports cancelled and expired requests with when they ended, and doesn't count them as owed", async () => {
  const status = fixture("status.ended.res.json");
  const [expired, cancelled] = status.results;
  const { deps } = makeDeps({ routes: { "POST /api/v1/status": () => json(200, status) } });
  const result = await checkPayments({ requests: [expired.id, cancelled.id] }, deps);
  const out = (result as { structuredContent: { results: Array<Record<string, unknown>>; summary: string } }).structuredContent;
  assert.deepEqual(out.results.map((r) => [r.status, r.expires_at, r.cancelled_at]), [
    ["expired", "2026-10-17T09:00:00Z", undefined], ["cancelled", "2026-10-24T13:40:00Z", "2026-10-17T14:02:13Z"],
  ]);
  assert.equal(out.summary, "0 of 2 paid · 1 cancelled · 1 expired");
  const lines = textOf(result).split("\n");
  assert.equal(lines[1], `Expired, request ${expired.id}: 0.5 USDC at 2026-10-17T09:00:00Z; it takes no payment.`);
  assert.equal(lines[2], `Cancelled, request ${cancelled.id}: 15 USDC at 2026-10-17T14:02:13Z; it takes no payment.`);
});

// ---- write_reminder ----

test("write_reminder writes nothing for an expired request and says how to ask again", async () => {
  const { deps } = makeDeps({ routes: owed({ ...openRequest, status: "expired", expires_at: "2026-10-17T07:00:00Z" }) });
  const result = await writeReminder(reminderInput.parse({ request: "JArQ6g9JvoWr" }), deps);
  const out = (result as { structuredContent: { status: string; text: string | null } }).structuredContent;
  assert.deepEqual([out.status, out.text], ["expired", null]);
  assert.equal(textOf(result), "This request expired at 2026-10-17T07:00:00Z, so its link no longer takes payments and there is nothing to chase with it. If it's still owed, make a new request with ask_for_money and send that.");
});
