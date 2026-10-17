import { test } from "node:test";
import assert from "node:assert/strict";
import {
  askEveryMonth, dayLabel, inputSchema, monthlyShareText, outputSchema, readableDate, type EveryMonthOutput,
} from "../src/tools/ask_every_month.ts";
import type { checkFromDomain } from "../src/payee.ts";
import { requestIdFor } from "../src/request-id.ts";
import { fixture, json, makeDeps, RECIPIENT, textOf } from "./helpers.ts";
import { dohFixture, dohRoutes } from "./payee-helpers.ts";

// ask_every_month (W3-D): the request body it sends, the server reply it accepts (contract/fixtures/schedules.*),
// and every reply it refuses because the schedule or this month's payment isn't what was asked.

const created = fixture("schedules.create.res.json");
const sent = fixture("schedules.create.req.json");
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const input = (extra: Record<string, unknown> = {}) => inputSchema.parse({
  recipient: RECIPIENT, amount: "450", payer_name: "Sam", for: "rent", requester_name: "Raj", day_of_month: 17, ...extra,
});
const reply = (patch: Record<string, unknown> = {}) => ({ "POST /api/v1/schedules": () => json(201, { ...created, ...patch }) });
const later = { first_request: null, day_of_month: 5, first_period: "2026-11", next_request_on: "2026-11-05" };
const isRefusal = (result: unknown) => (result as { isError?: boolean }).isError === true;

function structured(result: Awaited<ReturnType<typeof askEveryMonth>>): EveryMonthOutput {
  assert.ok(!isRefusal(result), `unexpected refusal: ${textOf(result)}`);
  const out = (result as { structuredContent: EveryMonthOutput }).structuredContent;
  outputSchema.parse(out);
  return out;
}

test("helpers: day labels, readable dates, the monthly message", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(dayLabel),
    ["the 1st", "the 2nd", "the 3rd", "the 4th", "the 11th", "the 12th", "the 13th", "the 21st", "the 22nd", "the 23rd", "the 28th"]);
  assert.equal(readableDate("2026-11-01"), "1 Nov 2026");
  assert.equal(readableDate("2027-01-28"), "28 Jan 2027");
  assert.equal(monthlyShareText({ payerName: "Sam", requesterName: "Raj", forText: 'the "flat"', amount: "450", token: "USDC", day: 1, link: "https://www.getowed.xyz/r/x" }),
    "Hey Sam, it's Raj. Here's this month's request for \"the 'flat'\": 450 USDC, due on the 1st each month. Pay with any Solana wallet here: https://www.getowed.xyz/r/x");
});

test("schema: day 1–28 only, months 1–120, payer_name and for required, strict", () => {
  for (const day of [0, 29, 31, 1.5]) assert.equal(inputSchema.safeParse({ ...input(), day_of_month: day }).success, false, `day ${day}`);
  assert.equal(inputSchema.safeParse({ ...input(), months: 0 }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), months: 121 }).success, false);
  assert.equal(inputSchema.safeParse({ recipient: RECIPIENT, amount: "1", day_of_month: 1, for: "rent" }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), note: "x" }).success, false);
  assert.equal(input().token, "USDC");
});

test("today is the day: sends the cleaned schedule, checks this month's request and returns its link to send", async () => {
  const { deps, rec } = makeDeps({ routes: reply() });
  const result = await askEveryMonth(input(), deps);
  const out = structured(result);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.url, "https://owed-omega.vercel.app/api/v1/schedules");
  assert.deepEqual(rec.calls[0]!.body, sent);
  const first = created.first_request;
  assert.deepEqual(out, {
    schedule_id: created.id, recipient: RECIPIENT, amount: "450", token: "USDC", payer_name: "Sam", for: "rent", day_of_month: 17,
    months: null, status: "active", next_request_on: "2026-11-17",
    first_request: { id: first.id, period: "2026-10", link: first.link, solana_pay_url: first.solana_pay_url, qr_url: first.qr_url, reference: first.reference },
    share_text: `Hey Sam, it's Raj. Here's this month's request for "rent": 450 USDC, due on the 17th each month. Pay with any Solana wallet here: ${first.link}`,
  });
  const text = textOf(result);
  assert.match(text, /^Monthly request set: 450 USDC from "Sam" for "rent" on the 17th of each month \(UTC\), every month, no end date\./);
  assert.ok(text.includes(`Today is the day, so this month's request is open now. Send this link: ${first.link}`));
  assert.ok(text.includes("The next one opens on 17 Nov 2026."));
  assert.ok(text.includes(`Schedule id: ${created.id}.`));
});

test("any other day: stores the schedule and says when the first request opens", async () => {
  const { deps } = makeDeps({ routes: reply({ ...later, months: 6 }) });
  const result = await askEveryMonth(input({ day_of_month: 5, months: 6 }), deps);
  const out = structured(result);
  assert.equal(out.first_request, null);
  assert.equal(out.share_text, undefined);
  assert.equal(out.months, 6);
  assert.equal(out.next_request_on, "2026-11-05");
  const text = textOf(result);
  assert.match(text, /on the 5th of each month \(UTC\), 6 months in all\./);
  assert.match(text, /The first request opens on 5 Nov 2026\. Owed opens one each month on that day; who_owes_me lists each/);
});

test("requester text is cleaned before it is sent; text that is only invisible characters is refused with no network", async () => {
  const { deps, rec } = makeDeps({ routes: reply() });
  await askEveryMonth(input({ for: "rent https://evil.example/pay", payer_name: "Sam\u0007" }), deps);
  const body = rec.calls[0]!.body as { for: string; payer_name: string };
  assert.equal(body.for, "rent [link removed]");
  assert.ok(!/[\u0000-\u001f]/.test(body.payer_name));

  const bare = makeDeps({ routes: reply() });
  const refused = await askEveryMonth(input({ for: "\u200b\u0007\u202e" }), bare.deps);
  assert.ok(isRefusal(refused));
  assert.match(textOf(refused), /payer_name and for need some text once links are removed/);
  assert.equal(bare.rec.calls.length, 0);
});

test("bad recipient or amount is refused before any network", async () => {
  for (const extra of [{ recipient: "not-an-address-0000000000000000000000" }, { amount: "1.0000001" }, { amount: "0" }]) {
    const { deps, rec } = makeDeps({ routes: reply() });
    const parsed = inputSchema.safeParse({ ...input(), ...extra });
    if (!parsed.success) continue; // the schema already refuses it
    const result = await askEveryMonth(parsed.data, deps);
    assert.ok(isRefusal(result), JSON.stringify(extra));
    assert.equal(rec.calls.length, 0);
  }
});

test("a reply that asks for anything else, or pays anyone else, is refused", async () => {
  const first = created.first_request;
  const otherRef = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
  const swappedRecipientUrl = first.solana_pay_url.replace(RECIPIENT, OTHER);
  const swappedAmountUrl = first.solana_pay_url.replace("amount=450", "amount=4500");
  const consistentOther = requestIdFor({ recipient: OTHER, token: "USDC", amountAtomic: 450_000_000n, reference: first.reference });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["amount", { amount: "45" }],
    ["recipient", { recipient: OTHER }],
    ["token", { token: "SOL" }],
    ["day", { day_of_month: 18 }],
    ["months", { months: 12 }],
    ["domain", { from_domain: "getowed.xyz", from_domain_verified_at: "2026-10-17T14:02:11Z" }],
    ["first: recipient", { first_request: { ...first, solana_pay_url: swappedRecipientUrl } }],
    ["first: amount", { first_request: { ...first, solana_pay_url: swappedAmountUrl } }],
    ["first: reference", { first_request: { ...first, reference: otherRef } }],
    ["first: id", { first_request: { ...first, id: consistentOther } }],
    ["first: link to another request", { first_request: { ...first, link: first.link.replace(first.id, consistentOther) } }],
  ];
  for (const [name, patch] of cases) {
    const { deps } = makeDeps({ routes: reply(patch) });
    const result = await askEveryMonth(input(), deps);
    assert.ok(isRefusal(result), name);
    assert.match(textOf(result), /doesn't match what was asked, so it wasn't used\. Check who_owes_me/, name);
  }
  // A plain-http link never gets past the contract: an off-contract reply.
  const { deps } = makeDeps({ routes: reply({ first_request: { ...first, link: first.link.replace("https:", "http:") } }) });
  assert.ok(isRefusal(await askEveryMonth(input(), deps)));
});

test("from_domain is checked over DNS first: verified → sent and shown; unpublished → refused with no API call", async () => {
  // Real DoH answers for _owed.getowed.xyz (published-record): it publishes the team wallet, RECIPIENT.
  const domainReply = {
    from_domain: "getowed.xyz", from_domain_verified_at: "2026-10-17T14:02:11Z",
    first_request: { ...created.first_request, from_domain: "getowed.xyz" },
  };
  const { deps, rec } = makeDeps({ routes: { ...dohRoutes(dohFixture("published-record")), ...reply(domainReply) } });
  const result = await askEveryMonth(input({ from_domain: "GetOwed.xyz" }), deps);
  const out = structured(result);
  assert.equal(out.from_domain, "getowed.xyz");
  const apiCall = rec.calls.find((c) => c.url.endsWith("/api/v1/schedules"))!;
  assert.equal((apiCall.body as { from_domain: string }).from_domain, "getowed.xyz");
  assert.match(textOf(result), /From getowed\.xyz: verified, getowed\.xyz publishes this wallet in its DNS/);

  // The server dropping the domain: refused.
  const dropped = makeDeps({ routes: { ...dohRoutes(dohFixture("published-record")), ...reply() } });
  assert.ok(isRefusal(await askEveryMonth(input({ from_domain: "getowed.xyz" }), dropped.deps)));

  // Another wallet: getowed.xyz doesn't publish it, so nothing is sent to Owed.
  const other = makeDeps({ routes: { ...dohRoutes(dohFixture("published-record")), ...reply() } });
  const refused = await askEveryMonth(input({ recipient: OTHER, from_domain: "getowed.xyz" }), other.deps);
  assert.ok(isRefusal(refused));
  assert.match(textOf(refused), /no monthly request was set up/);
  assert.equal(other.rec.calls.filter((c) => c.url.includes("/api/v1/")).length, 0);
});

test("the DNS check and screening run side by side and either can refuse", async () => {
  const unverified: typeof checkFromDomain = async () => ({
    ok: false, message: "example.com doesn't publish this wallet, so the request wasn't created.",
    payee: { status: "unverified", domain: "example.com", display_domain: "example.com", dnssec: false, records: 0, warnings: [] },
  });
  const { deps, rec } = makeDeps({ routes: reply() });
  const refused = await askEveryMonth(input({ from_domain: "example.com" }), deps, async () => ({ ok: true, screening: "clear" }), unverified);
  assert.match(textOf(refused), /example\.com doesn't publish this wallet, so no monthly request was set up\./);
  assert.equal(rec.calls.length, 0);

  const blocked = makeDeps({ routes: reply() });
  const screened = await askEveryMonth(input(), blocked.deps, async () => ({ ok: false, message: "This address is on a sanctions list." }));
  assert.equal(textOf(screened), "This address is on a sanctions list.");
  assert.equal(blocked.rec.calls.length, 0);

  const unavailable = makeDeps({ routes: reply() });
  const r = await askEveryMonth(input(), unavailable.deps, async () => ({ ok: true, screening: "unavailable" }));
  assert.match(textOf(r), /Recipient screening was unavailable/);
});

test("server refusals and outages say what happened and what to do", async () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["invalid", { "POST /api/v1/schedules": () => json(400, { error: { code: "invalid_input", message: "this recipient already has 20 active monthly requests, the most Owed keeps" } }) },
      /^Owed rejected the monthly request: this recipient already has 20 active monthly requests/],
    ["rate", { "POST /api/v1/schedules": () => json(429, { error: { code: "rate_limited", message: "slow down" } }) }, /limiting new requests/],
    ["down", { "POST /api/v1/schedules": () => "network_error" }, /may not have been saved\. Run who_owes_me to check before asking again/],
    ["5xx", { "POST /api/v1/schedules": () => json(500, { error: { code: "upstream_unavailable", message: "x" } }) }, /may not have been saved/],
    ["off contract", { "POST /api/v1/schedules": () => json(201, { id: "nope" }) }, /may not have been saved/],
  ];
  for (const [name, routes, pattern] of cases) {
    const { deps } = makeDeps({ routes });
    const result = await askEveryMonth(input(), deps);
    assert.ok(isRefusal(result), name);
    assert.match(textOf(result), pattern, name);
  }
});

test("a hung server is given up on inside the 10 s budget", async () => {
  let now = Date.parse("2026-10-17T14:00:00Z");
  const { deps } = makeDeps({ now: () => now, routes: { "POST /api/v1/schedules": () => "hang" } });
  const started = Date.now();
  const result = await askEveryMonth(input(), deps);
  now += 1; // keep the injected clock moving
  assert.ok(isRefusal(result));
  assert.ok(Date.now() - started < 6000, "gave up after the schedule API timeout");
});

test("brand words in the reply's flags add the caution line", async () => {
  const { deps } = makeDeps({ routes: reply({ flags: ["brand_word:paybox"], first_request: { ...created.first_request, flags: ["brand_word:paybox"] } }) });
  const result = await askEveryMonth(input({ for: "PayBox rent" }), deps);
  assert.match(textOf(result), /Caution: this request mentions "PayBox"/i);
});
