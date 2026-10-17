import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import type { GroupRes } from "../src/contract.ts";
import {
  disagreementPercent, divideRates, FIAT_CODES, fiatCurrency, fiatLine, formatFiat, formatRate, fromMinor, normalizeRate, quoteProblem,
  ratesDisagree, toMinor, usdcAtomicFor,
} from "../src/fiat.ts";
import { checkQuote, fiatApiRefusal } from "../src/local-currency.ts";
import { ApiError } from "../src/api.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { askEveryMonth, inputSchema as monthlyInput, MONTHLY_FIAT_REFUSAL } from "../src/tools/ask_every_month.ts";
import { checkPayments } from "../src/tools/check_payments.ts";
import { createInvoice, inputSchema as invoiceInput, outputSchema as invoiceOutput } from "../src/tools/create_invoice.ts";
import { payLink, inputSchema as payInput, REFUSE_FIAT_MISMATCH } from "../src/tools/pay_link.ts";
import { checkSplitQuotes, inputSchema as splitInput, outputSchema as splitOutput, splitBill } from "../src/tools/split_bill.ts";
import { ledgerMessage, outputSchema as whoOutput, whoOwesMe } from "../src/tools/who_owes_me.ts";
import { inputSchema as reminderInput, outputSchema as reminderOutput, writeReminder } from "../src/tools/write_reminder.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf, USDC_MINT as USDC } from "./helpers.ts";
import { requestIdFor } from "../src/request-id.ts";
import { buildTransferUrl } from "../src/solana-pay.ts";
import { groupIdFor } from "../src/tools/split_bill.ts";
import { fromAtomic } from "../src/money.ts";

const fromAtomicUsdc = (atomic: bigint) => fromAtomic(atomic, "USDC");

// Local-currency asks: the plugin never fetches a rate; it checks the server's quote produces the USDC every
// link and id commit to, and shows the quote (labelled as one) wherever the amount is shown.

const reqBody = fixture("fiat.create-request.req.json");
const created = fixture("fiat.create-request.res.json");
const getRes = fixture("fiat.get-request.res.json");
const groupRes: GroupRes = fixture("fiat.groups.create.res.json");
const invoiceRes = fixture("fiat.invoices.create.res.json");
const isRefusal = (r: unknown) => (r as { isError?: boolean }).isError === true;
const sc = <T>(r: unknown): T => {
  assert.ok(!isRefusal(r), `unexpected refusal: ${textOf(r as never)}`);
  return (r as { structuredContent: T }).structuredContent;
};

// ---- the shared math (src/fiat.ts, byte-identical to web/lib/fiat.ts)

test("fiat amounts: minor units by ISO 4217, zero-decimal currencies, normalised", () => {
  assert.equal(toMinor("1200", "INR"), 120_000n);
  assert.equal(toMinor("1200.5", "INR"), 120_050n);
  assert.equal(toMinor("1200.50", "INR"), 120_050n); // trailing zeros are fine
  assert.equal(toMinor("1500", "JPY"), 1500n);
  assert.equal(toMinor("1500.0", "JPY"), 1500n);
  assert.throws(() => toMinor("1500.5", "JPY"), /JPY amounts are whole numbers/);
  assert.throws(() => toMinor("12.345", "EUR"), /at most 2 decimal places/);
  for (const bad of ["0", "0.00", "-1", "1e3", "1,200", " 1", ""]) assert.throws(() => toMinor(bad, "INR"), bad);
  assert.equal(fromMinor(120_050n, "INR"), "1200.5");
  assert.equal(fromMinor(1500n, "JPY"), "1500");
});

test("currency codes: the allowlist, lower case accepted, USD refused with the reason", () => {
  assert.ok(FIAT_CODES.length >= 30);
  for (const code of ["INR", "NGN", "EUR", "GBP", "BRL", "KES", "PHP", "IDR", "MXN", "CAD", "AUD", "JPY"]) assert.ok(FIAT_CODES.includes(code as never), code);
  assert.equal(fiatCurrency("inr"), "INR");
  assert.throws(() => fiatCurrency("USD"), /1 USDC is 1 US dollar/);
  assert.throws(() => fiatCurrency("XYZ"), /can't quote XYZ yet/);
  assert.throws(() => fiatCurrency("rupees"), /can't quote that currency/);
});

test("USDC = amount / rate, rounded UP to 6 decimals, with bigint only", () => {
  assert.equal(usdcAtomicFor("1200", "INR", "94.95975"), 12_636_934n); // 12.63693400...4 -> up
  assert.equal(usdcAtomicFor("100", "INR", "100"), 1_000_000n); // exact, no rounding
  assert.equal(usdcAtomicFor("1", "INR", "3"), 333_334n); // 0.333333.. -> 0.333334
  assert.equal(usdcAtomicFor("0.01", "INR", "94.95975"), 106n); // a paisa is still at least 1 atomic unit
  assert.equal(usdcAtomicFor("60000", "JPY", "158.0085"), 379_726_408n);
  assert.equal(usdcAtomicFor("15", "EUR", "0.889913294882"), 16_855_575n);
  // Never below the exact value, never more than 1 atomic unit above it.
  for (const [amount, rate] of [["1200", "94.95975"], ["45", "0.889913294882"], ["999999.99", "1331.355"]] as const) {
    const atomic = usdcAtomicFor(amount, "INR", rate);
    const [aw, af = ""] = amount.split(".");
    const [rw, rf = ""] = rate.split(".");
    const num = BigInt(aw! + af) * 10n ** BigInt(rf.length + 6);
    const den = BigInt(rw! + rf) * 10n ** BigInt(af.length);
    assert.ok(atomic * den >= num && (atomic - 1n) * den < num, `${amount} / ${rate}`);
  }
});

test("rates: truncated to 12 places, derived exactly, compared within 2%", () => {
  assert.equal(normalizeRate("94.959750000"), "94.95975");
  assert.equal(normalizeRate("0.88991329488211223344"), "0.889913294882");
  assert.throws(() => normalizeRate("0.0000000000001"), /more than zero/);
  assert.equal(divideRates("94.95975", "1"), "94.95975");
  assert.equal(divideRates("100", "1.0001"), "99.9900009999"); // 99.99000099990000… cut at 12 places, zeros dropped
  assert.equal(ratesDisagree("100", "102"), false); // exactly 2% of the lower
  assert.equal(ratesDisagree("100", "102.0001"), true);
  assert.equal(ratesDisagree("101.377", "94.95975"), true); // Coinbase's USDC->INR market price vs mid-market, 2026-10-17
  assert.equal(disagreementPercent("101.377", "94.95975"), "6.8%");
});

test("display: grouped, symbol first, minor units shown; rate rounded for reading only", () => {
  assert.equal(formatFiat("1200", "INR"), "₹1,200");
  assert.equal(formatFiat("1200.5", "INR"), "₹1,200.50");
  assert.equal(formatFiat("1500000", "JPY"), "¥1,500,000");
  assert.equal(formatFiat("1200", "KES"), "KSh 1,200");
  assert.equal(formatFiat("45", "EUR"), "€45");
  assert.equal(formatRate("94.95975", "INR"), "1 USDC = ₹94.96");
  assert.equal(formatRate("0.889913294882", "EUR"), "1 USDC = €0.8899");
  assert.equal(formatRate("158.0085", "JPY"), "1 USDC = ¥158.01");
  assert.equal(fiatLine({ currency: "INR", amount: "1200", quoted_at: "2026-10-17T21:04:31Z" }, "12.636934"),
    "₹1,200 · 12.636934 USDC (rate locked 2026-10-17 21:04 UTC)");
});

test("quoteProblem: only a quote that produces exactly the USDC amount is accepted", () => {
  const q = getRes.fiat;
  assert.equal(quoteProblem(q, 12_636_934n), null);
  assert.match(quoteProblem(q, 12_636_933n)!, /isn't the USDC amount asked/);
  assert.match(quoteProblem(q, 12_636_935n)!, /isn't the USDC amount asked/);
  assert.match(quoteProblem({ ...q, currency: "XXX" }, 12_636_934n)!, /doesn't quote/);
});

// ---- ask_for_money

const ask = (extra: Record<string, unknown> = {}) => askInput.parse({
  recipient: RECIPIENT, amount: "1200", currency: "INR", payer_name: "Priya", for: "dinner", requester_name: "Raj", ...extra,
});

test("ask_for_money in INR: sends currency + amount, checks the quote, returns both amounts and the caveat", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, created) } });
  const result = await askForMoney(ask(), deps);
  const out = askOutput.parse(sc(result));
  assert.deepEqual(rec.calls[0]!.body, reqBody);
  assert.equal(out.amount, "12.636934");
  assert.equal(out.token, "USDC");
  assert.deepEqual(out.fiat, created.fiat);
  assert.equal(out.share_text, `Hey Priya, it's Raj. Your share for "dinner" is ₹1,200 (12.636934 USDC). Pay with any Solana wallet here: ${created.link}`);
  const lines = textOf(result).split("\n");
  assert.equal(lines[0], `Request ready: ₹1,200 = 12.636934 USDC (rate locked 2026-10-17 20:45 UTC) from Priya for "dinner". Send this link: ${created.link}`);
  assert.match(textOf(result), /1 USDC = ₹94\.96 \(api\.coinbase\.com, checked against open\.er-api\.com\), rounded up/);
  assert.match(textOf(result), /the Indian rupee amount is a quote, not a guarantee/);
});

test("ask_for_money in INR refuses a reply whose quote doesn't produce its USDC, or that has no quote", async () => {
  const cases = {
    "a different rate": { ...created, fiat: { ...created.fiat, rate: "90" } },
    "a different amount asked": { ...created, fiat: { ...created.fiat, amount: "1300" } },
    "another currency": { ...created, fiat: { ...created.fiat, currency: "PKR" } },
    "no quote (a server that ignored currency)": (({ fiat: _f, amount: _a, ...rest }) => rest)(created),
  };
  for (const [label, reply] of Object.entries(cases)) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, reply) } });
    const result = await askForMoney(ask(), deps);
    assert.ok(isRefusal(result), label);
    assert.match(textOf(result), /quote that doesn't match/, label);
  }
});

test("ask_for_money in INR has no offline fallback: only the server can lock a rate, and it says why", async () => {
  const detail = "the two exchange-rate sources disagree on INR by 6.8% (more than 2%), so no rate was locked; try again later, or ask in USDC";
  const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => json(503, { error: { code: "upstream_unavailable", message: detail } }) } });
  const result = await askForMoney(ask(), deps);
  assert.ok(isRefusal(result));
  assert.equal(textOf(result), `Owed couldn't lock an exchange rate right now (${detail}), so the request wasn't created. Try again in a minute, or ask in USDC.`);
  const down = makeDeps({ routes: { "POST /api/v1/requests": () => "network_error" } });
  assert.match(textOf(await askForMoney(ask(), down.deps)), /^Owed couldn't lock an exchange rate right now, so the request/);
});

test("ask_for_money refuses USD, unknown codes, SOL, Base and too many decimals before any call", async () => {
  const { deps, rec } = makeDeps();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ currency: "USD" }, /1 USDC is 1 US dollar/],
    [{ currency: "ZZZ" }, /can't quote ZZZ/],
    [{ token: "SOL" }, /paid in USDC/],
    [{ chain: "base" }, /Solana USDC only/],
    [{ currency: "JPY", amount: "10.5" }, /JPY amounts are whole numbers/],
  ];
  for (const [extra, expected] of cases) {
    const result = await askForMoney(ask(extra), deps);
    assert.ok(isRefusal(result));
    assert.match(textOf(result), expected);
  }
  assert.equal(rec.calls.length, 0);
});

test("checkQuote: amount normalisation is fine, anything else is a mismatch", () => {
  assert.equal(checkQuote(created.fiat, created.amount, { code: "INR", amount: "1200.00" }).ok, true);
  assert.equal(checkQuote(created.fiat, "12.636934", { code: "INR", amount: "1200.01" }).ok, false);
  assert.equal(checkQuote(undefined, created.amount, { code: "INR", amount: "1200" }).ok, false);
  assert.equal(checkQuote(created.fiat, undefined, { code: "INR", amount: "1200" }).ok, false);
  assert.equal(fiatApiRefusal(new ApiError("invalid_input", "x"), "request"), null);
});

// ---- split_bill

const clear = async () => ({ ok: true as const, screening: "skipped" as const });

test("split_bill in EUR: the bill is split in euros, each share locked to USDC at one rate", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": () => json(201, groupRes) } });
  const input = splitInput.parse({
    recipient: RECIPIENT, total: "45", currency: "EUR", title: "Team lunch", requester_name: "Raj",
    people: [{ name: "Priya" }, { name: "Sam" }, { name: "Alex" }],
  });
  const result = await splitBill(input, deps, clear);
  const out = splitOutput.parse(sc(result));
  assert.deepEqual(rec.calls[0]!.body, fixture("fiat.groups.create.req.json"));
  assert.equal(out.total, groupRes.total);
  assert.deepEqual(out.fiat, groupRes.fiat);
  assert.deepEqual(out.shares.map((s) => [s.amount, s.fiat?.amount]), groupRes.shares.map((s) => [s.amount, "15"]));
  assert.match(out.shares[0]!.share_text, /is €15 \(16\.855575 USDC\)/);
  const text = textOf(result);
  assert.match(text, /^Split ready: "Team lunch", €45 = 50\.566725 USDC \(rate locked 2026-10-17 20:45 UTC\) from 3 people\./);
  assert.match(text, /- Priya: €15 = 16\.855575 USDC https:\/\/owed\.link\/r\//);
  assert.match(text, /Together they pay 50\.566725 USDC/);
});

test("split_bill in EUR has no offline links: only the server can lock a rate", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/groups": () => "network_error" } });
  const input = splitInput.parse({ recipient: RECIPIENT, total: "10", currency: "EUR", title: "Taxi", people: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  const result = await splitBill(input, deps, clear);
  assert.ok(isRefusal(result));
  assert.match(textOf(result), /couldn't lock an exchange rate/);
});

/** A stand-in for POST /api/v1/groups in a currency, building what web/lib/groups.ts builds at `rate`. */
function fiatGroupServer(rate: string) {
  return (call: { body: unknown }) => {
    const body = call.body as { recipient: string; total: string; currency: "EUR"; title: string; people: Array<{ name: string; amount: string }> };
    const fiat = (amount: string) => ({ currency: body.currency, amount, rate, rate_source: "api.coinbase.com", quoted_at: "2026-10-17T20:45:45Z" });
    const shares = body.people.map((p, i) => {
      const atomic = usdcAtomicFor(p.amount, body.currency, rate);
      const amount = fromAtomicUsdc(atomic);
      const reference = bs58.encode(createHash("sha256").update(`fiat-reference-${i}`).digest());
      const id = requestIdFor({ recipient: body.recipient, token: "USDC", amountAtomic: atomic, reference });
      const solana_pay_url = buildTransferUrl({ recipient: body.recipient, amount, splToken: USDC, references: [reference], message: body.title, memo: `owed:${id}` });
      return { id, name: p.name, amount, atomic, status: "open", link: `https://owed.link/r/${id}`, solana_pay_url, reference, paid: null, from_domain: null, fiat: fiat(p.amount) };
    });
    const total = shares.reduce((sum, x) => sum + x.atomic, 0n);
    const id = groupIdFor({ recipient: body.recipient, token: "USDC", totalAtomic: total, shareIds: shares.map((x) => x.id) });
    return json(201, {
      id, link: `https://owed.link/g/${id}`, title: body.title, recipient: body.recipient, token: "USDC", total: fromAtomicUsdc(total),
      requester_name: null, created_at: "2026-10-17T20:45:46Z", flags: [], from_domain: null, from_domain_verified_at: null,
      share_count: shares.length, paid_count: 0, amount_received: "0", shares: shares.map(({ atomic: _a, ...x }) => x), fiat: fiat(body.total),
    });
  };
}

test("split_bill in EUR: €10 three ways is €3.34 + €3.33 + €3.33, each locked to USDC, and the note says so in euros", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/groups": fiatGroupServer("0.889913294882") } });
  const input = splitInput.parse({ recipient: RECIPIENT, total: "10", currency: "EUR", title: "Taxi", people: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  const result = await splitBill(input, deps, clear);
  const out = splitOutput.parse(sc(result));
  assert.deepEqual((rec.calls[0]!.body as { people: unknown }).people, [{ name: "A", amount: "3.34" }, { name: "B", amount: "3.33" }, { name: "C", amount: "3.33" }]);
  assert.deepEqual(out.shares.map((x) => x.fiat!.amount), ["3.34", "3.33", "3.33"]);
  assert.deepEqual(out.shares.map((x) => x.amount), ["3.753175", "3.741938", "3.741938"]);
  assert.equal(out.total, "11.237051");
  assert.equal(out.remainder_note, "10 EUR doesn't split evenly 3 ways, so A pays 0.01 EUR more.");
});

test("checkSplitQuotes refuses a share at another rate or amount, and a board total that isn't the bill", () => {
  const amounts = ["15", "15", "15"];
  assert.ok(checkSplitQuotes(groupRes, "EUR", "45", amounts));
  const otherRate = { ...groupRes, shares: groupRes.shares.map((s, i) => (i === 1 ? { ...s, fiat: { ...s.fiat!, rate: "0.88" } } : s)) };
  assert.equal(checkSplitQuotes(otherRate, "EUR", "45", amounts), null);
  assert.equal(checkSplitQuotes(groupRes, "EUR", "45", ["20", "15", "10"]), null);
  assert.equal(checkSplitQuotes(groupRes, "EUR", "46", amounts), null);
  assert.equal(checkSplitQuotes(groupRes, "GBP", "45", amounts), null);
});

// ---- create_invoice

test("create_invoice in JPY: items priced in yen, total locked to USDC, both shown", async () => {
  const { deps, rec } = makeDeps({ now: () => Date.parse("2026-10-17T21:00:00Z"), routes: { "POST /api/v1/invoices": () => json(201, invoiceRes) } });
  const input = invoiceInput.parse({
    recipient: RECIPIENT, currency: "JPY", business_name: "Raj Studio", client_name: "Kenji", due_date: "2026-10-31", invoice_number: "RS-042",
    items: [{ description: "Logo design", unit_price: "45000" }, { description: "Revision rounds", quantity: 2, unit_price: "7500" }],
  });
  const result = await createInvoice(input, deps, clear);
  const out = invoiceOutput.parse(sc(result));
  assert.deepEqual(rec.calls[0]!.body, fixture("fiat.invoices.create.req.json"));
  assert.equal(out.total, "379.726408");
  assert.deepEqual(out.items.map((i) => i.amount), ["45000", "15000"]);
  assert.deepEqual(out.fiat, invoiceRes.fiat);
  assert.match(out.share_text, /for ¥60,000 \(379\.726408 USDC\), due Oct 31, 2026/);
  assert.match(textOf(result), /^Invoice ready: ¥60,000 = 379\.726408 USDC \(rate locked 2026-10-17 20:45 UTC\) to "Kenji"/);
  assert.match(textOf(result), /The client pays 379\.726408 USDC/);
});

test("create_invoice in JPY refuses a fractional yen price, and a reply whose items or quote differ", async () => {
  const base = {
    recipient: RECIPIENT, currency: "JPY", business_name: "Raj Studio", client_name: "Kenji", due_date: "2026-10-31", invoice_number: "RS-042",
    items: [{ description: "Logo design", unit_price: "45000" }, { description: "Revision rounds", quantity: 2, unit_price: "7500" }],
  };
  const now = () => Date.parse("2026-10-17T21:00:00Z");
  const fractional = await createInvoice(invoiceInput.parse({ ...base, items: [{ description: "x", unit_price: "1.5" }] }), makeDeps({ now }).deps, clear);
  assert.match(textOf(fractional), /JPY amounts are whole numbers/);
  for (const reply of [
    { ...invoiceRes, fiat: { ...invoiceRes.fiat, rate: "150" } },
    { ...invoiceRes, items: [{ ...invoiceRes.items[0], unit_price: "40000", amount: "40000" }, invoiceRes.items[1]] },
  ]) {
    const { deps } = makeDeps({ now, routes: { "POST /api/v1/invoices": () => json(201, reply) } });
    assert.ok(isRefusal(await createInvoice(invoiceInput.parse(base), deps, clear)));
  }
});

// ---- ask_every_month

test("ask_every_month refuses a currency with the reason, before any call", async () => {
  const { deps, rec } = makeDeps();
  const input = monthlyInput.parse({ recipient: RECIPIENT, amount: "45000", currency: "INR", payer_name: "Sam", for: "rent", day_of_month: 1 });
  const result = await askEveryMonth(input, deps, clear);
  assert.ok(isRefusal(result));
  assert.equal(textOf(result), MONTHLY_FIAT_REFUSAL);
  assert.equal(rec.calls.length, 0);
});

// ---- pay_link, check_payments, who_owes_me, write_reminder

test("pay_link shows the quote beside the USDC, and refuses a request whose quote doesn't add up", async () => {
  const id = getRes.id as string;
  const link = `https://owed.link/r/${id}`;
  const ok = makeDeps({ routes: { [`GET /api/v1/requests/${id}`]: () => json(200, getRes) } });
  const result = await payLink(payInput.parse({ link, sender: SENDER }), ok.deps);
  assert.ok(!isRefusal(result), textOf(result));
  assert.equal(ok.rec.built[0]!.amountAtomic, 12_636_934n);
  assert.match(textOf(result), /^Pay 12\.636934 USDC to FN6G…cbvs\. Asked as ₹1,200 · 12\.636934 USDC \(rate locked 2026-10-17 20:45 UTC\); a quote, not a guarantee\./);
  const bad = makeDeps({ routes: { [`GET /api/v1/requests/${id}`]: () => json(200, { ...getRes, fiat: { ...getRes.fiat, amount: "1100" } }) } });
  assert.equal(textOf(await payLink(payInput.parse({ link, sender: SENDER }), bad.deps)), REFUSE_FIAT_MISMATCH);
  assert.equal(bad.rec.built.length, 0);
});

test("check_payments lists the quote under the status, and drops one that doesn't add up", async () => {
  const status = fixture("fiat.status.res.json");
  const { deps } = makeDeps({ now: () => Date.parse("2026-10-17T22:45:46Z"), routes: { "POST /api/v1/status": () => json(200, status) } });
  const result = await checkPayments({ requests: [getRes.id] }, deps);
  const out = sc<{ results: Array<{ fiat?: unknown }> }>(result);
  assert.deepEqual(out.results[0]!.fiat, getRes.fiat);
  assert.match(textOf(result), /Open, request \w+: 12\.636934 USDC, waiting 2h 0m\n {2}Asked as ₹1,200 · 12\.636934 USDC \(rate locked 2026-10-17 20:45 UTC\); a quote, not a guarantee\./);
  const tampered = { results: [{ ...status.results[0], fiat: { ...getRes.fiat, rate: "80" } }] };
  const t = makeDeps({ routes: { "POST /api/v1/status": () => json(200, tampered) } });
  const r2 = await checkPayments({ requests: [getRes.id] }, t.deps);
  assert.equal(sc<{ results: Array<{ fiat?: unknown }> }>(r2).results[0]!.fiat, undefined);
  assert.doesNotMatch(textOf(r2), /Asked as/);
});

function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv) };
}

test("who_owes_me shows each local-currency ask as asked, labelled a quote", async () => {
  const me = signer("owed test signer: local_currency.test.ts");
  const now = Date.parse("2026-10-17T21:00:00Z");
  const message = ledgerMessage(me.address, now);
  const { deps } = makeDeps({ now: () => now + 30_000, routes: { "POST /api/v1/ledger": () => json(200, { ...fixture("fiat.ledger.res.json"), recipient: me.address }) } });
  const result = await whoOwesMe({ recipient: me.address, signed_message: message, signature: me.sign(message).toString("hex") }, deps);
  const out = whoOutput.parse(sc(result)) as { open?: Array<{ fiat?: unknown }> };
  assert.deepEqual(out.open![0]!.fiat, getRes.fiat);
  assert.match(textOf(result), /Owed: 12\.636934 USDC \(asked as ₹1,200 · 12\.636934 USDC \(rate locked 2026-10-17 20:45 UTC\), a quote\)/);
});

test("write_reminder names both amounts in the message and the quote in the lead", async () => {
  const id = getRes.id as string;
  const { deps } = makeDeps({ now: () => Date.parse("2026-10-20T09:00:00Z"), routes: { [`GET /api/v1/requests/${id}`]: () => json(200, getRes) } });
  const result = await writeReminder(reminderInput.parse({ request: id }), deps);
  const out = reminderOutput.parse(sc(result));
  assert.deepEqual(out.fiat, getRes.fiat);
  assert.match(out.text!, /the ₹1,200 \(12\.636934 USDC\) for "dinner"/);
  assert.match(textOf(result), /^Still open after 2 days: ₹1,200 · 12\.636934 USDC \(rate locked 2026-10-17 20:45 UTC\), a quote\. Reminder/);
});
