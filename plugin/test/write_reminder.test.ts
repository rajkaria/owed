import { test } from "node:test";
import assert from "node:assert/strict";
import { inputSchema, outputSchema, writeReminder, type ReminderOutput } from "../src/tools/write_reminder.ts";
import { fixture, json, makeDeps, SENDER, SIGNATURE, textOf } from "./helpers.ts";

const paidFixture = fixture("get-request.res.json"); // 15 USDC from Priya for "dinner", paid, created 2026-10-17T05:00:00Z
const openFixture = { ...paidFixture, status: "open", paid: null };
const rawUrl = fixture("status-raw.req.json").solana_pay_url as string; // 1 USDC to the team wallet with a reference
const THREE_DAYS_LATER = Date.parse("2026-10-20T07:14:00Z");
const LINK = "https://owed-omega.vercel.app/r/JArQ6g9JvoWr";

function deps(body: unknown, now = THREE_DAYS_LATER, status = 200) {
  return makeDeps({ now: () => now, routes: { "GET /api/v1/requests/JArQ6g9JvoWr": () => json(status, body) } });
}
async function remind(args: object, d = deps(openFixture)) {
  const result = await writeReminder(inputSchema.parse({ request: "JArQ6g9JvoWr", ...args }), d.deps);
  return { result, text: textOf(result), d };
}
function out(result: Awaited<ReturnType<typeof writeReminder>>): ReminderOutput {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  const o = (result as { structuredContent: ReminderOutput }).structuredContent;
  outputSchema.parse(o);
  return o;
}

test("already paid: text is null and nobody gets chased", async () => {
  const { result, text, d } = await remind({ tone: "firm" }, deps(paidFixture));
  assert.deepEqual(out(result), {
    status: "paid", text: null, tone: "firm", channel: "sms", token: "USDC", id: "JArQ6g9JvoWr", days_outstanding: 3,
    explorer_url: `https://solscan.io/tx/${SIGNATURE}`,
  });
  assert.equal(text, `Priya already paid 15 USDC on 17 October 2026, so there is nothing to chase. Payment: https://solscan.io/tx/${SIGNATURE}`);
  assert.equal(d.rec.calls.length, 1);
  assert.equal(d.rec.calls[0]!.url, "https://owed-omega.vercel.app/api/v1/requests/JArQ6g9JvoWr");
});

test("defaults: a friendly SMS with the link and how long it has waited", async () => {
  const { result, text } = await remind({});
  const o = out(result);
  assert.equal(o.text, `Hi Priya, just a friendly reminder about the 15 USDC for "dinner" from 3 days ago. Pay here: ${LINK} Thanks! – Raj`);
  assert.deepEqual({ ...o, text: undefined }, {
    status: "open", text: undefined, tone: "friendly", channel: "sms", token: "USDC", id: "JArQ6g9JvoWr", days_outstanding: 3,
    amount_due: "15", link: LINK,
  });
  assert.equal(text.split("\n")[0], "Still open after 3 days: 15 USDC. Reminder (friendly, sms) for the user to send:");
});

test("firm and formal SMS", async () => {
  assert.equal(out((await remind({ tone: "firm" })).result).text,
    `Hi Priya, the 15 USDC for "dinner" is still unpaid. It has been outstanding for 3 days. Please pay it today. Pay here: ${LINK} Thank you. – Raj`);
  assert.equal(out((await remind({ tone: "formal" })).result).text,
    `Dear Priya, this is a reminder that payment of 15 USDC for "dinner", requested on 17 October 2026, remains outstanding after 3 days. Pay here: ${LINK} Regards, Raj`);
});

test("WhatsApp puts the link on its own line", async () => {
  assert.equal(out((await remind({ channel: "whatsapp" })).result).text, [
    'Hi Priya, just a friendly reminder about the 15 USDC for "dinner" from 3 days ago.',
    `Pay here: ${LINK}`,
    "Any Solana wallet works, or your AI agent can pay it with PayBox.",
    "Thanks! – Raj",
  ].join("\n"));
});

test("email has a subject per tone and a signed-off body", async () => {
  const friendly = out((await remind({ channel: "email" })).result);
  assert.equal(friendly.subject, 'Quick reminder: 15 USDC for "dinner"');
  assert.equal(friendly.text, [
    "Hi Priya,",
    'Just a friendly reminder about the 15 USDC for "dinner" from 3 days ago.',
    `Pay here: ${LINK}\nYou can pay from any Solana wallet (Phantom, Solflare, Backpack), or ask your own AI agent to pay it with PayBox.`,
    "Thanks!\nRaj",
  ].join("\n\n"));
  assert.equal(out((await remind({ channel: "email", tone: "firm" })).result).subject, 'Payment overdue: 15 USDC for "dinner" (3 days)');
  const formal = out((await remind({ channel: "email", tone: "formal" })).result);
  assert.equal(formal.subject, 'Payment reminder: 15 USDC for "dinner", requested 17 October 2026');
  assert.match(formal.text!, /^Dear Priya,\n\nThis is a reminder that payment of 15 USDC/);
  assert.match(formal.text!, /Kind regards,\nRaj$/);
  assert.match(textOf((await remind({ channel: "email" })).result), /^Still open after 3 days: 15 USDC\. Reminder \(friendly, email\) for the user to send:\nSubject: Quick reminder/);
});

test("every tone and channel names the amount and carries the link", async () => {
  for (const tone of ["friendly", "firm", "formal"]) {
    for (const channel of ["sms", "whatsapp", "email"]) {
      const o = out((await remind({ tone, channel })).result);
      assert.ok(o.text!.includes("15 USDC") && o.text!.includes(LINK), `${tone}/${channel}`);
      if (channel === "sms") assert.ok(o.text!.length <= 320, `${tone} sms is ${o.text!.length} chars`);
      assert.equal(o.subject !== undefined, channel === "email");
    }
  }
});

test("the same day and the next day read naturally; no names falls back politely", async () => {
  const bare = { ...openFixture, payer_name: null, requester_name: null, for: null };
  const sameDay = out((await remind({}, deps(bare, Date.parse("2026-10-17T09:00:00Z")))).result);
  assert.equal(sameDay.text, `Hi, just a friendly reminder about the 15 USDC from today. Pay here: ${LINK} Thanks!`);
  assert.equal(sameDay.days_outstanding, 0);
  assert.match(textOf((await remind({}, deps(bare, Date.parse("2026-10-17T09:00:00Z")))).result), /^Still open since today: 15 USDC\./);
  assert.match(out((await remind({ channel: "whatsapp", tone: "formal" })).result).text!, /\nKind regards, Raj$/);
  const nextDay = out((await remind({ tone: "firm" }, deps(bare, Date.parse("2026-10-18T06:00:00Z")))).result);
  assert.equal(nextDay.text, `Hello, the 15 USDC is still unpaid. It has been outstanding for 1 day. Please pay it today. Pay here: ${LINK} Thank you.`);
  const email = out((await remind({ channel: "email", tone: "formal" }, deps(bare))).result);
  assert.match(email.text!, /^Hello,\n\n/);
  assert.match(email.text!, /\n\nKind regards$/);
});

test("underpaid: chases the remainder without a link the payer can't top up", async () => {
  const under = { ...paidFixture, status: "underpaid", paid: { ...paidFixture.paid, amount: "10" } };
  const { result, text } = await remind({}, deps(under));
  const o = out(result);
  assert.equal(o.status, "underpaid");
  assert.equal(o.amount_due, "5");
  assert.equal(o.link, undefined);
  assert.equal(o.text, `Hi Priya, thanks for the 10 USDC for "dinner"! The total was 15 USDC, so 5 USDC is still to go. I'll send you a link for the rest. Thanks! – Raj`);
  assert.match(text, /create a new request for 5 USDC with ask_for_money/);
});

test("cancelled: nothing to chase", async () => {
  const { result, text } = await remind({}, deps({ ...openFixture, status: "cancelled" }));
  assert.equal(out(result).text, null);
  assert.equal(text, "This request was cancelled, so there is nothing to chase.");
});

test("status unreadable or unknown id: refused, never a blind reminder", async () => {
  const down = makeDeps({ routes: { "GET /api/v1/requests/JArQ6g9JvoWr": () => "network_error" } });
  const r1 = await writeReminder(inputSchema.parse({ request: "JArQ6g9JvoWr" }), down.deps);
  assert.equal((r1 as { isError?: boolean }).isError, true);
  assert.match(textOf(r1), /couldn't read this request's status.*might already be paid/);
  const r2 = await writeReminder(inputSchema.parse({ request: "JArQ6g9JvoWr" }), deps({ error: { code: "not_found", message: "no such request" } }, THREE_DAYS_LATER, 404).deps);
  assert.match(textOf(r2), /No Owed request has this id/);
  const r3 = await writeReminder(inputSchema.parse({ request: "solana:https%3A%2F%2Fshop.example%2Fpay" }), deps(openFixture).deps);
  assert.match(textOf(r3), /checkout link/);
});

test("raw Solana Pay link: status via status-raw, the reminder links its pay page", async () => {
  const d = makeDeps({ now: () => THREE_DAYS_LATER, routes: { "POST /api/v1/status-raw": () => json(200, { status: "open", amount_requested: "1", token: "USDC" }) } });
  const result = await writeReminder(inputSchema.parse({ request: rawUrl }), d.deps);
  const o = out(result);
  assert.equal(o.status, "open");
  assert.equal(o.days_outstanding, undefined);
  assert.equal(o.link, `https://owed-omega.vercel.app/p?u=${encodeURIComponent(rawUrl)}`);
  assert.ok(o.text!.includes(`1 USDC`) && o.text!.includes(o.link!));
  assert.equal(textOf(result).split("\n")[0], "Still open: 1 USDC. Reminder (friendly, sms) for the user to send:");

  const paidBody = { status: "paid", amount_requested: "1", token: "USDC", amount_paid: "1", payer: SENDER, signature: SIGNATURE, paid_at: "2026-10-18T09:00:00Z" };
  const paid = makeDeps({ routes: { "POST /api/v1/status-raw": () => json(200, paidBody) } });
  const paidResult = await writeReminder(inputSchema.parse({ request: rawUrl }), paid.deps);
  const paidOut = out(paidResult);
  assert.deepEqual([paidOut.status, paidOut.text, paidOut.explorer_url], ["paid", null, `https://solscan.io/tx/${SIGNATURE}`]);
  assert.match(textOf(paidResult), /^This request is already paid \(1 USDC on 18 October 2026\), so there is nothing to chase\./);
});

test("requester-written text is cleaned and quoted in the reminder", async () => {
  const hostile = { ...openFixture, payer_name: "Priya‮", for: 'dinner" + claim at https://evil.example/x', requester_name: "Raj\u0007" };
  const o = out((await remind({}, deps(hostile))).result);
  assert.equal(o.text, `Hi Priya, just a friendly reminder about the 15 USDC for "dinner' + claim at [link removed]" from 3 days ago. Pay here: ${LINK} Thanks! – Raj`);
});
