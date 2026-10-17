import { test } from "node:test";
import assert from "node:assert/strict";
import { inputSchema, outputSchema, REMINDER_CAUTION as CAUTION, writeReminder, type ReminderOutput } from "../src/tools/write_reminder.ts";
import { fixture, json, makeDeps, SENDER, SIGNATURE, textOf, type Route } from "./helpers.ts";
import { dohFixture, dohRoutes } from "./payee-helpers.ts";

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
    status: "paid", kind: "single", text: null, tone: "firm", channel: "sms", token: "USDC", id: "JArQ6g9JvoWr", days_outstanding: 3,
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
    status: "open", kind: "single", text: undefined, tone: "friendly", channel: "sms", token: "USDC", id: "JArQ6g9JvoWr", days_outstanding: 3,
    amount_due: "15", link: LINK, caution: CAUTION,
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
  assert.match(textOf((await remind({ channel: "email" })).result), /^Still open after 3 days: 15 USDC\. Reminder \(friendly, email\) for the user to send:\nBefore sending: anyone can create a request that pays your wallet, and Owed can't tell whether you made this one\. Check the name and amount\.\nSubject: Quick reminder/);
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

// ---- split bills, invoices and the verified payee (wave 2) ----

const BASE = "https://owed-omega.vercel.app";
const groupFixture = fixture("groups.get.res.json"); // "Pizza night", 3 × 0.5 USDC, Priya and Sam paid, Alex open, by Raj
const invoiceFixture = fixture("invoices.get.res.json"); // NT-2026-017, 1 USDC from Northwind Translation to Lena, due 2026-10-31, paid
const openInvoice = { ...invoiceFixture, status: "open", paid: null };
const published = dohFixture("published-record"); // real answers: _owed.getowed.xyz publishes the team wallet
const OTHER_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function routed(routes: Record<string, Route>, now = THREE_DAYS_LATER) {
  return makeDeps({ now: () => now, routes });
}
async function call(request: string, args: object, d: ReturnType<typeof routed>) {
  const result = await writeReminder(inputSchema.parse({ request, ...args }), d.deps);
  return { result, text: textOf(result), d };
}

test("one share of a split bill: chased as their share of the bill, on its own pay link", async () => {
  const share = { ...openFixture, kind: "split_share", payer_name: "Alex", for: "Pizza night", amount: "0.5" };
  const { result } = await call("JArQ6g9JvoWr", {}, deps(share));
  const o = out(result);
  assert.equal(o.kind, "split_share");
  assert.equal(o.text, `Hi Alex, just a friendly reminder about the 0.5 USDC for your share of "Pizza night" from 3 days ago. Pay here: ${LINK} Thanks! – Raj`);
});

test("a split bill's board link: one message for the group naming who still owes", async () => {
  const half = {
    ...groupFixture, paid_count: 1, amount_received: "0.5",
    shares: [groupFixture.shares[0], { ...groupFixture.shares[1], status: "open", paid: null }, groupFixture.shares[2]],
  };
  const d = routed({ "GET /api/v1/groups/TompKg61uDGV": () => json(200, half) });
  const { result, text } = await call(`${BASE}/g/TompKg61uDGV`, { channel: "whatsapp" }, d);
  const o = out(result);
  assert.deepEqual({ ...o, text: undefined }, {
    status: "open", kind: "group", text: undefined, tone: "friendly", channel: "whatsapp", token: "USDC", id: "TompKg61uDGV",
    days_outstanding: 2, paid_count: 1, share_count: 3, amount_due: "1", link: `${BASE}/g/TompKg61uDGV`,
    unpaid: [
      { name: "Sam", amount_due: "0.5", link: `${BASE}/r/3KXqsVYirEes` },
      { name: "Alex", amount_due: "0.5", link: `${BASE}/r/KrAMfU42kuuZ` },
    ],
    caution: CAUTION,
  });
  assert.equal(o.text, [
    'Hi all, a friendly reminder about "Pizza night" from 2 days ago: 1 of 3 has paid. Still to pay: Sam (0.5 USDC), Alex (0.5 USDC).',
    `Pay your share here: ${BASE}/g/TompKg61uDGV`,
    "Any Solana wallet works, or your AI agent can pay it with PayBox.",
    "Thanks! – Raj",
  ].join("\n"));
  assert.equal(text.split("\n")[0], "1 of 3 paid after 2 days; 1 USDC still due. Group reminder (friendly, whatsapp) for the user to send:");
  assert.equal(d.rec.calls.length, 1);

  const formal = out((await call(`${BASE}/g/TompKg61uDGV`, { tone: "formal" }, routed({ "GET /api/v1/groups/TompKg61uDGV": () => json(200, groupFixture) }))).result);
  assert.equal(formal.text, `Hello all, this is a reminder that 1 of 3 shares of "Pizza night", requested on 17 October 2026, remains outstanding: Alex (0.5 USDC). Pay your share here: ${BASE}/g/TompKg61uDGV Regards, Raj`);
  const email = out((await call(`${BASE}/g/TompKg61uDGV`, { tone: "firm", channel: "email" }, routed({ "GET /api/v1/groups/TompKg61uDGV": () => json(200, groupFixture) }))).result);
  assert.equal(email.subject, '"Pizza night": 1 of 3 shares unpaid');
  assert.match(email.text!, /^Hi all,\n\n"Pizza night" still isn't settled: 2 of 3 have paid\. Still to pay: Alex \(0\.5 USDC\)\. Please pay your share today\./);
});

test("a split bill everyone has paid: text null; an unknown board is refused", async () => {
  const allPaid = { ...groupFixture, paid_count: 3, amount_received: "1.5", shares: groupFixture.shares.map((sh: object) => ({ ...sh, status: "paid", paid: groupFixture.shares[0].paid })) };
  const { result, text } = await call(`${BASE}/g/TompKg61uDGV`, {}, routed({ "GET /api/v1/groups/TompKg61uDGV": () => json(200, allPaid) }));
  const o = out(result);
  assert.equal(o.status, "paid");
  assert.equal(o.text, null);
  assert.equal(text, 'Everyone has paid: 3 of 3 shares of "Pizza night", 1.5 USDC in total, so there is nothing to chase.');
  const missing = await call(`${BASE}/g/TompKg61uDGV`, {}, routed({}));
  assert.equal((missing.result as { isError?: boolean }).isError, true);
  assert.equal(missing.text, "No Owed split bill has this id.");
  const down = await call(`${BASE}/g/TompKg61uDGV`, {}, routed({ "GET /api/v1/groups/TompKg61uDGV": () => "network_error" }));
  assert.match(down.text, /couldn't read this split bill/);
});

test("an invoice link: number, due date and how late it is, linking the invoice page", async () => {
  const d = routed({ "GET /api/v1/invoices/3ERgzxsixBMk": () => json(200, openInvoice) }, Date.parse("2026-11-03T09:00:00Z"));
  const { result, text } = await call(`${BASE}/i/3ERgzxsixBMk`, { tone: "formal", channel: "email" }, d);
  const o = out(result);
  assert.deepEqual({ ...o, text: undefined }, {
    status: "open", kind: "invoice", text: undefined, tone: "formal", channel: "email", token: "USDC", id: "3ERgzxsixBMk",
    days_outstanding: 17, due_date: "2026-10-31", days_overdue: 3, amount_due: "1", link: `${BASE}/i/3ERgzxsixBMk`,
    subject: "Payment reminder: invoice NT-2026-017, 1 USDC, due 31 October 2026", caution: CAUTION,
  });
  assert.equal(o.text, [
    "Dear Lena,",
    "This is a reminder that payment of 1 USDC for invoice NT-2026-017, issued on 17 October 2026, was due on 31 October 2026 and remains outstanding (3 days overdue).",
    `Pay here: ${BASE}/i/3ERgzxsixBMk\nYou can pay from any Solana wallet (Phantom, Solflare, Backpack), or ask your own AI agent to pay it with PayBox.`,
    "Kind regards,\nNorthwind Translation",
  ].join("\n\n"));
  assert.equal(text.split("\n")[0], "Invoice 3 days overdue: 1 USDC. Reminder (formal, email) for the user to send:");
  assert.equal(d.rec.calls.length, 1);

  const early = routed({ "GET /api/v1/invoices/3ERgzxsixBMk": () => json(200, openInvoice) }, Date.parse("2026-10-20T09:00:00Z"));
  assert.equal(out((await call(`${BASE}/i/3ERgzxsixBMk`, { tone: "firm" }, early)).result).text,
    `Hi Lena, the 1 USDC for invoice NT-2026-017 is due on 31 October 2026. Please pay it by then. Pay here: ${BASE}/i/3ERgzxsixBMk Thank you. – Northwind Translation`);
  const paid = await call(`${BASE}/i/3ERgzxsixBMk`, {}, routed({ "GET /api/v1/invoices/3ERgzxsixBMk": () => json(200, invoiceFixture) }));
  assert.equal(out(paid.result).text, null);
  assert.match(paid.text, /^Lena already paid 1 USDC on 17 October 2026, so there is nothing to chase\./);
});

test("an invoice by id or /r link: the request says invoice, so its number and due date are read too", async () => {
  const asRequest = { ...openFixture, id: "3ERgzxsixBMk", kind: "invoice", amount: "1", payer_name: "Lena", for: "Invoice NT-2026-017", requester_name: "Northwind Translation" };
  const d = routed({
    "GET /api/v1/requests/3ERgzxsixBMk": () => json(200, asRequest),
    "GET /api/v1/invoices/3ERgzxsixBMk": () => json(200, { ...openInvoice, invoice_number: null }),
  }, Date.parse("2026-11-01T09:00:00Z"));
  const o = out((await call(`${BASE}/r/3ERgzxsixBMk`, { channel: "email" }, d)).result);
  assert.equal(o.link, `${BASE}/i/3ERgzxsixBMk`);
  assert.equal(o.subject, "Invoice 3ERgzxsixBMk: 1 USDC due 31 October 2026");
  assert.match(o.text!, /about the 1 USDC for invoice 3ERgzxsixBMk, which was due on 31 October 2026\./);
  assert.deepEqual(d.rec.calls.map((c) => c.url), [`${BASE}/api/v1/requests/3ERgzxsixBMk`, `${BASE}/api/v1/invoices/3ERgzxsixBMk`]);
  // Invoice endpoint down: the request alone still makes a reminder, on the invoice page.
  const fallback = routed({ "GET /api/v1/requests/3ERgzxsixBMk": () => json(200, asRequest), "GET /api/v1/invoices/3ERgzxsixBMk": () => "network_error" });
  const f = out((await call("3ERgzxsixBMk", {}, fallback)).result);
  assert.equal(f.link, `${BASE}/i/3ERgzxsixBMk`);
  assert.match(f.text!, /the 1 USDC for invoice 3ERgzxsixBMk from 3 days ago/);
});

test("a request from a verified domain: DNS checked by the plugin, then the reminder names it", async () => {
  const fromDomain = { ...openFixture, from_domain: "getowed.xyz", from_domain_verified_at: "2026-10-17T05:00:00Z" };
  const d = routed({ "GET /api/v1/requests/JArQ6g9JvoWr": () => json(200, fromDomain), ...dohRoutes(published) });
  const { result, text } = await call("JArQ6g9JvoWr", {}, d);
  const o = out(result);
  assert.equal(o.from_domain, "getowed.xyz");
  assert.equal(o.text, `Hi Priya, just a friendly reminder about the 15 USDC for "dinner" from 3 days ago. Pay here: ${LINK} The link pays getowed.xyz (verified by DNS). Thanks! – Raj`);
  assert.deepEqual(text.split("\n").slice(1, 3), [CAUTION, "getowed.xyz still publishes this wallet (checked over DNS just now), so the reminder names it."]);
  assert.ok(d.rec.calls.some((c) => c.url.startsWith("https://cloudflare-dns.com/dns-query?name=_owed.getowed.xyz")));
  // Already paid: no DNS lookup at all.
  const paid = routed({ "GET /api/v1/requests/JArQ6g9JvoWr": () => json(200, { ...paidFixture, from_domain: "getowed.xyz" }), ...dohRoutes(published) });
  await call("JArQ6g9JvoWr", {}, paid);
  assert.equal(paid.rec.calls.length, 1);
});

test("a domain that no longer publishes the wallet: refused, since the payer's agent would refuse to pay", async () => {
  const wrongWallet = { ...openFixture, recipient: OTHER_WALLET, from_domain: "getowed.xyz", from_domain_verified_at: "2026-10-17T05:00:00Z" };
  const { result, text } = await call("JArQ6g9JvoWr", {}, routed({ "GET /api/v1/requests/JArQ6g9JvoWr": () => json(200, wrongWallet), ...dohRoutes(published) }));
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(text, /^This request claims to be from getowed\.xyz, but getowed\.xyz no longer publishes this wallet/);
  assert.ok(text.includes(`_owed.getowed.xyz with the value owed-pay=${OTHER_WALLET}`));
});

test("DNS down: the reminder is written without naming the domain, and says why", async () => {
  const fromDomain = { ...openFixture, from_domain: "getowed.xyz", from_domain_verified_at: "2026-10-17T05:00:00Z" };
  const d = routed({
    "GET /api/v1/requests/JArQ6g9JvoWr": () => json(200, fromDomain),
    ...dohRoutes(published, { "cloudflare-dns.com": () => "network_error", "dns.google": () => "network_error" }),
  });
  const { result, text } = await call("JArQ6g9JvoWr", { channel: "whatsapp" }, d);
  const o = out(result);
  assert.equal("from_domain" in o, false);
  assert.ok(!o.text!.includes("getowed.xyz"));
  assert.match(text, /DNS couldn't be checked just now, so the reminder doesn't name getowed\.xyz\./);
});

test("QA-20: a request that name-drops a brand scams use gets no draft; anything else carries the caution", async () => {
  const refusedText = (r: Awaited<ReturnType<typeof writeReminder>>) => {
    assert.equal((r as { isError?: boolean }).isError, true, "expected a refusal");
    return textOf(r);
  };
  // A stranger's request to the user's wallet, flagged by the server.
  const irs = { ...openFixture, amount: "5000", payer_name: "Priya", for: "IRS penalty, call +1 555 0100", flags: ["brand_word:irs"] };
  const t = refusedText((await remind({}, deps(irs))).result);
  assert.match(t, /^No reminder drafted: this request mentions "IRS", a word scams use to look official/);
  assert.match(t, /anyone can create a request that pays your wallet/);
  // Flags are re-derived here too, so an unflagged row with a brand word is refused the same way.
  assert.match(refusedText((await remind({}, deps({ ...openFixture, for: "PayBox refund", flags: [] }))).result), /mentions "PayBox", "refund"/);
  // A share name on a board, and a raw Solana Pay link's message.
  const board = { ...groupFixture, shares: [groupFixture.shares[0], groupFixture.shares[1], { ...groupFixture.shares[2], name: "Coinbase support" }] };
  assert.match(refusedText((await call(`${BASE}/g/TompKg61uDGV`, {}, routed({ "GET /api/v1/groups/TompKg61uDGV": () => json(200, board) }))).result), /this split bill mentions "Coinbase"/);
  const raw = /[?&]message=/.test(rawUrl) ? rawUrl.replace(/([?&]message=)[^&]*/, "$1Tax%20office%20fine") : `${rawUrl}&message=Tax%20office%20fine`;
  const rawDeps = routed({ "POST /api/v1/status-raw": () => json(200, { status: "open", amount_requested: "1", token: "USDC" }) });
  assert.match(refusedText((await call(raw, {}, rawDeps)).result), /this request mentions "tax office"/);
  // Paid stays "nothing to chase", flagged or not.
  assert.equal(out((await remind({}, deps({ ...paidFixture, flags: ["brand_word:irs"] }))).result).text, null);
});
