import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInvoice, dueDateProblem, formatQuantity, inputSchema, invoiceShareText, outputSchema, parseQuantity, priceItems,
  type CheckFromDomain, type InvoiceOutput,
} from "../src/tools/create_invoice.ts";
import { requestIdFor } from "../src/request-id.ts";
import { fixture, html, json, makeDeps, RECIPIENT, textOf, USDC_MINT } from "./helpers.ts";

const created = fixture("invoices.create.res.json");
const request = fixture("invoices.create.req.json");
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const input = (extra: Record<string, unknown> = {}) => inputSchema.parse({
  recipient: RECIPIENT,
  business_name: "Northwind Translation",
  client_name: "Lena",
  items: [
    { description: "Translation, English to Hindi (pages)", quantity: 3, unit_price: "0.2" },
    { description: "Proofreading", unit_price: "0.25" },
    { description: "Call to review terms (hours)", quantity: "1.5", unit_price: "0.1" },
  ],
  due_date: "2026-10-31",
  invoice_number: "NT-2026-017",
  notes: "Thanks, Lena. Payment within 14 days, please.",
  ...extra,
});
const ok = { "POST /api/v1/invoices": () => json(201, created) };
const isRefusal = (result: unknown) => (result as { isError?: boolean }).isError === true;

function structured(result: Awaited<ReturnType<typeof createInvoice>>): InvoiceOutput {
  assert.ok(!isRefusal(result), `unexpected refusal: ${textOf(result)}`);
  const out = (result as { structuredContent: InvoiceOutput }).structuredContent;
  outputSchema.parse(out);
  return out;
}

// ---- pure helpers ----

test("quantities: whole numbers and up to 4 decimal places, bigint-scaled", () => {
  assert.equal(parseQuantity(3), 30_000n);
  assert.equal(parseQuantity("1.5"), 15_000n);
  assert.equal(parseQuantity("0.0001"), 1n);
  assert.equal(parseQuantity("1000000"), 10_000_000_000n);
  assert.equal(formatQuantity(15_000n), "1.5");
  assert.equal(formatQuantity(30_000n), "3");
  assert.equal(formatQuantity(parseQuantity("2.5000")), "2.5");
  for (const bad of ["0", "0.0000", "1.23456", "-1", "1e3", "", "1,5", "1000000.0001"]) {
    assert.throws(() => parseQuantity(bad), undefined, bad);
  }
});

test("priceItems: exact bigint line amounts and total, refusing anything that would need rounding", () => {
  const { deps } = makeDeps();
  const { lines, totalAtomic } = priceItems(input().items, "USDC", deps);
  assert.deepEqual(lines.map((l) => [l.quantity, l.unitPriceAtomic, l.amountAtomic]), [["3", 200_000n, 600_000n], ["1", 250_000n, 250_000n], ["1.5", 100_000n, 150_000n]]);
  assert.equal(totalAtomic, 1_000_000n);
  // 0.1 + 0.2 must be exactly 0.3: no floats anywhere.
  assert.equal(priceItems([{ description: "a", quantity: 1, unit_price: "0.1" }, { description: "b", quantity: 1, unit_price: "0.2" }], "USDC", deps).totalAtomic, 300_000n);
  assert.throws(() => priceItems([{ description: "a", quantity: "1.5", unit_price: "0.000001" }], "USDC", deps), /Line 1: 1.5 × 0.000001 USDC doesn't come to a whole number/);
  assert.throws(() => priceItems([{ description: "a", quantity: 1, unit_price: "1" }, { description: "b", quantity: 1, unit_price: "0" }], "USDC", deps), /Line 2/);
  assert.throws(() => priceItems([{ description: "a", quantity: 1, unit_price: "0.0000001" }], "USDC", deps), /Line 1/);
  assert.equal(priceItems([{ description: "a", quantity: "0.5", unit_price: "0.000000002" }], "SOL", deps).totalAtomic, 1n);
});

test("due dates: real dates from yesterday (UTC) to 3 years ahead", () => {
  const now = Date.parse("2026-10-17T07:14:00Z");
  assert.equal(dueDateProblem("2026-10-17", now), null);
  assert.equal(dueDateProblem("2026-10-16", now), null, "yesterday is allowed for time zones");
  assert.match(dueDateProblem("2026-10-15", now)!, /in the past/);
  assert.match(dueDateProblem("2025-10-31", now)!, /in the past/);
  assert.match(dueDateProblem("2026-02-30", now)!, /isn't a real date/);
  assert.match(dueDateProblem("2030-01-01", now)!, /more than 3 years away/);
  assert.equal(dueDateProblem("2029-10-17", now), null);
});

test("share text names the client, the sender, the number, the total and the due date", () => {
  assert.equal(
    invoiceShareText({ clientName: "Lena", businessName: "Northwind Translation", invoiceNumber: "NT-2026-017", total: "1", token: "USDC", dueDate: "2026-10-31", link: "https://owed.link/i/x" }),
    "Hi Lena, here is invoice NT-2026-017 from Northwind Translation for 1 USDC, due Oct 31, 2026. View it and pay with any Solana wallet: https://owed.link/i/x",
  );
  assert.match(invoiceShareText({ clientName: "Sam", businessName: "Raj", invoiceNumber: null, total: "2", token: "SOL", dueDate: "2026-11-01", link: "l" }), /^Hi Sam, here is an invoice from Raj for 2 SOL, due Nov 1, 2026\./);
});

test("input schema: quantity defaults to 1, strict objects, 1 to 20 items", () => {
  assert.equal(input().items[1]!.quantity, 1);
  assert.equal(input().token, "USDC");
  assert.equal(inputSchema.safeParse({ ...input(), extra: 1 }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), items: [] }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), items: Array(21).fill({ description: "x", unit_price: "1" }) }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), items: [{ description: "x", unit_price: "1", quantity: 1.5 }] }).success, false, "decimal quantities are strings");
  assert.equal(inputSchema.safeParse({ ...input(), items: [{ description: "x", unit_price: "1", colour: "red" }] }).success, false);
  assert.equal(inputSchema.safeParse({ ...input(), due_date: "31/10/2026" }).success, false);
});

// ---- the tool ----

test("hosted: sends the contract request, checks the reply and returns the invoice, share text and next step", async () => {
  const { deps, rec } = makeDeps({ routes: ok });
  const result = await createInvoice(input(), deps);
  const out = structured(result);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.url, "https://owed-omega.vercel.app/api/v1/invoices");
  assert.deepEqual(rec.calls[0]!.body, request);
  assert.deepEqual(out, {
    id: created.id,
    invoice_link: created.link,
    pay_link: created.request_link,
    solana_pay_url: created.solana_pay_url,
    qr_url: created.qr_url,
    reference: created.reference,
    recipient: RECIPIENT,
    token: "USDC",
    business_name: "Northwind Translation",
    client_name: "Lena",
    invoice_number: "NT-2026-017",
    items: created.items,
    total: "1",
    due_date: "2026-10-31",
    from_domain: null,
    share_text: `Hi Lena, here is invoice NT-2026-017 from Northwind Translation for 1 USDC, due Oct 31, 2026. View it and pay with any Solana wallet: ${created.link}`,
    status: "open",
  });
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], `Invoice ready: 1 USDC to "Lena", due Oct 31, 2026 (3 items). Send this link: ${created.link}`);
  assert.match(textOf(result), /check_payments/);
  assert.equal(created.id, requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 1_000_000n, reference: created.reference }));
});

test("refuses before any network call: bad recipient, past due date, items that need rounding", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ recipient: "not-an-address-but-long-enough-to-pass-zod-11" }, /recipient must be a Solana wallet address/],
    [{ due_date: "2026-01-01" }, /in the past/],
    [{ items: [{ description: "x", quantity: "1.5", unit_price: "0.000001" }] }, /Line 1: .* whole number/],
    [{ business_name: "\u200b\u200b" }, /business_name and client_name need some text/],
    [{ items: [{ description: "ok", unit_price: "1" }, { description: "\u200b\u2060", unit_price: "1" }] }, /Line 2 needs a description/],
  ];
  for (const [extra, expected] of cases) {
    const { deps, rec } = makeDeps({ routes: ok });
    const parsed = inputSchema.safeParse({ ...input(), ...extra });
    if (!parsed.success) continue; // zod already refuses it
    const result = await createInvoice(parsed.data, deps);
    assert.ok(isRefusal(result), JSON.stringify(extra));
    assert.match(textOf(result), expected);
    assert.equal(rec.calls.length, 0, "nothing was sent");
  }
});

test("untrusted text is cleaned before it is sent; brand words in the reply add a caution", async () => {
  const flagged = { ...created, flags: ["brand_word:moonpay"] };
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, flagged) } });
  const result = await createInvoice(input({
    business_name: `Northwind${String.fromCodePoint(0x202e)} Translation`,
    notes: "Pay at https://evil.example now",
    items: [
      { description: "Translation\u0000 see www.evil.io", quantity: 3, unit_price: "0.2" },
      { description: "Proofreading", unit_price: "0.25" },
      { description: "Call to review terms (hours)", quantity: "1.5", unit_price: "0.1" },
    ],
  }), deps);
  structured(result);
  const body = rec.calls[0]!.body as { business_name: string; notes: string; items: Array<{ description: string }> };
  assert.equal(body.business_name, "Northwind Translation");
  assert.equal(body.notes, "Pay at [link removed] now");
  assert.equal(body.items[0]!.description, "Translation see [link removed]");
  assert.match(textOf(result), /Caution: this invoice mentions "MoonPay"/);
});

test("refuses a reply that pays anyone or anything else than this call priced", async () => {
  const swap = (s: string) => s.replace(RECIPIENT, OTHER);
  const tampered: Array<[string, Record<string, unknown>]> = [
    ["recipient in the URL", { solana_pay_url: swap(created.solana_pay_url) }],
    ["recipient field", { recipient: OTHER }],
    ["amount in the URL", { solana_pay_url: created.solana_pay_url.replace("amount=1&", "amount=10&") }],
    ["token in the URL", { solana_pay_url: created.solana_pay_url.replace(`&spl-token=${USDC_MINT}`, "") }],
    ["total", { total: "10" }],
    ["a line amount", { items: [{ ...created.items[0], amount: "0.7" }, ...created.items.slice(1)] }],
    ["a line quantity", { items: [{ ...created.items[0], quantity: "4" }, ...created.items.slice(1)] }],
    ["a dropped line", { items: created.items.slice(0, 2) }],
    ["the due date", { due_date: "2026-12-31" }],
    ["the reference", { reference: OTHER }],
    ["an id that doesn't hash the terms", { id: "3ERgzxsixBMx", link: created.link.replace(created.id, "3ERgzxsixBMx"), request_link: created.request_link.replace(created.id, "3ERgzxsixBMx") }],
    ["a link to another page", { link: created.link.replace("/i/", "/r/") }],
    ["a checkout URL", { solana_pay_url: "solana:https%3A%2F%2Fevil.example%2Fcheckout" }],
    ["a paid status", { status: "paid" }],
    ["a domain nobody asked for", { from_domain: "evil.example", from_domain_verified_at: "2026-10-17T05:00:00Z" }],
  ];
  for (const [what, patch] of tampered) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, { ...created, ...patch }) } });
    const result = await createInvoice(input(), deps);
    assert.ok(isRefusal(result), what);
    assert.match(textOf(result), /doesn't match what was asked/, what);
  }
  // Off-contract shapes (a plain-http link) never even parse: refused as an unexpected reply.
  const { deps } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, { ...created, link: created.link.replace("https:", "http:") }) } });
  assert.ok(isRefusal(await createInvoice(input(), deps)));
});

test("server down: refuses with a way forward, never a half-made invoice", async () => {
  for (const [what, route] of Object.entries({
    unreachable: () => "network_error" as const,
    "503": () => json(503, { error: { code: "upstream_unavailable", message: "db" } }),
    "missing route (HTML 404)": () => html(404),
    "off-contract reply": () => json(201, { id: 1 }),
  })) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/invoices": route } });
    const result = await createInvoice(input(), deps);
    assert.ok(isRefusal(result), what);
    assert.match(textOf(result), /invoice wasn't created.*ask_for_money/, what);
  }
});

test("server hangs: the call ends inside the API budget", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/invoices": () => "hang" } });
  const started = Date.now();
  const result = await createInvoice(input(), { ...deps, now: () => Date.now() });
  assert.ok(isRefusal(result));
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("API refusals are passed on in plain words", async () => {
  const cases = [
    [429, "rate_limited", /limiting new requests/],
    [400, "invalid_input", /Owed rejected the invoice: items\[0\]: bad/],
    [403, "blocked", /can't create an invoice for this recipient/],
  ] as const;
  for (const [status, code, expected] of cases) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(status, { error: { code, message: "items[0]: bad" } }) } });
    const result = await createInvoice(input(), deps);
    assert.ok(isRefusal(result), code);
    assert.match(textOf(result), expected);
  }
});

test("screening: a hit refuses before anything is created; unavailable is said out loud", async () => {
  {
    const { deps, rec } = makeDeps({ routes: ok });
    const result = await createInvoice(input(), deps, async () => ({ ok: false, message: "This address is on a sanctions list." }));
    assert.ok(isRefusal(result));
    assert.equal(textOf(result), "This address is on a sanctions list.");
    assert.equal(rec.calls.length, 0);
  }
  {
    const { deps } = makeDeps({ routes: ok });
    const result = await createInvoice(input(), deps, async () => ({ ok: true, screening: "unavailable" }));
    structured(result);
    assert.match(textOf(result), /screening was unavailable/);
  }
});

test("from_domain: refused until verified payee is wired, checked over DNS once it is, and echoed by the server", async () => {
  {
    const { deps, rec } = makeDeps({ routes: ok });
    const result = await createInvoice(input({ from_domain: "northwind.example" }), deps);
    assert.ok(isRefusal(result));
    assert.match(textOf(result), /can't verify from_domain yet/);
    assert.equal(rec.calls.length, 0);
  }
  const verified: CheckFromDomain = async (domain, recipient) =>
    domain === "northwind.example" && recipient === RECIPIENT
      ? { ok: true, from_domain: "northwind.example", lines: ["Verified: northwind.example publishes this wallet (DNSSEC)."] }
      : { ok: false, message: `${domain} does not publish this wallet. Add a TXT record at _owed.${domain}.` };
  {
    const withDomain = { ...created, from_domain: "northwind.example", from_domain_verified_at: "2026-10-17T05:00:00Z" };
    const { deps, rec } = makeDeps({ routes: { "POST /api/v1/invoices": () => json(201, withDomain) } });
    const result = await createInvoice(input({ from_domain: "northwind.example" }), deps, undefined, verified);
    const out = structured(result);
    assert.equal((rec.calls[0]!.body as { from_domain: string }).from_domain, "northwind.example");
    assert.equal(out.from_domain, "northwind.example");
    assert.match(textOf(result), /Verified: northwind\.example/);
  }
  {
    // The server dropped the verified domain: the payer would never see it, so the invoice isn't handed out.
    const { deps } = makeDeps({ routes: ok });
    const result = await createInvoice(input({ from_domain: "northwind.example" }), deps, undefined, verified);
    assert.ok(isRefusal(result));
    assert.match(textOf(result), /doesn't match/);
  }
  {
    const { deps, rec } = makeDeps({ routes: ok });
    const result = await createInvoice(input({ from_domain: "n0rthwind.example" }), deps, undefined, verified);
    assert.ok(isRefusal(result));
    assert.match(textOf(result), /does not publish this wallet/);
    assert.equal(rec.calls.length, 0);
  }
});

test("SOL invoices carry no spl-token and price in lamports", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/invoices": () => "network_error" } });
  await createInvoice(input({ token: "SOL", items: [{ description: "x", quantity: "0.5", unit_price: "0.000000002" }] }), deps);
  const body = rec.calls[0]!.body as { token: string; items: Array<{ quantity: string; unit_price: string }> };
  assert.equal(body.token, "SOL");
  assert.deepEqual(body.items[0], { description: "x", quantity: "0.5", unit_price: "0.000000002" });
});
