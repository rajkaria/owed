import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addDays, addMonths, bpsText, chaseStage, checkChaseDays, checkInterval, daysBetween, lateFeeOpensOn, paidOnTime, percentBps, percentOf,
  planEarlyDiscount, planInstallments, planLateFee, reminderTone, splitUnits, TermsError, CHASE_DEFAULT_DAYS,
} from "@/lib/invoice-terms-core";
import { needsTermsRow, planTerms } from "@/lib/invoice-terms";
import { refundability, refundIdFor, refundPrefix, refundTotals, type RefundRow } from "@/lib/refunds";
import { fold, parseClient, requestEvents, monthRange } from "@/lib/statements";
import type { RequestRow } from "@/lib/requests";
import { AmountError } from "@/lib/money";

// F8 invoices, pure parts: the terms core (byte-identical in the plugin), the plan the server stores, refund rules and the
// statement's arithmetic. The database paths are in invoice-terms-db.test.ts, refunds-db.test.ts, statements-db.test.ts.

test("the terms core is byte-identical in plugin/src and web/lib", () => {
  const web = readFileSync(new URL("../lib/invoice-terms-core.ts", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../../plugin/src/invoice-terms-core.ts", import.meta.url), "utf8");
  assert.equal(plugin, web);
});

test("splitUnits: parts add up exactly; the first total % count get one unit more (splitEvenly's rule)", () => {
  assert.deepEqual(splitUnits(100n, 3), [34n, 33n, 33n]);
  assert.deepEqual(splitUnits(300_000_000n, 3), [100_000_000n, 100_000_000n, 100_000_000n]);
  assert.deepEqual(splitUnits(10n, 4), [3n, 3n, 2n, 2n]);
  const parts = splitUnits(1_000_000_007n, 12);
  assert.equal(parts.reduce((a, b) => a + b, 0n), 1_000_000_007n);
  assert.throws(() => splitUnits(2n, 3), TermsError);
});

test("dates: calendar months keep the day where the month has it; day arithmetic in UTC", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(addMonths("2026-01-31", 2), "2026-03-31");
  assert.equal(addMonths("2026-11-15", 2), "2027-01-15");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(daysBetween("2026-10-31", "2026-11-14"), 14);
  assert.throws(() => addDays("2026-02-30", 1), TermsError);
});

test("installments: amounts sum to the total, dates follow the interval, later ones open 7 days before they're due", () => {
  const monthly = planInstallments({ totalUnits: 300_000_001n, count: 3, interval: "monthly", firstDue: "2026-11-01", issueDate: "2026-10-18" });
  assert.deepEqual(monthly.map((i) => [i.seq, i.units, i.dueDate, i.opensOn]), [
    [1, 100_000_001n, "2026-11-01", "2026-10-18"],
    [2, 100_000_000n, "2026-12-01", "2026-11-24"],
    [3, 100_000_000n, "2027-01-01", "2026-12-25"],
  ]);
  const weekly = planInstallments({ totalUnits: 40n, count: 4, interval: 7, firstDue: "2026-10-20", issueDate: "2026-10-18" });
  assert.deepEqual(weekly.map((i) => [i.dueDate, i.opensOn]), [
    ["2026-10-20", "2026-10-18"], ["2026-10-27", "2026-10-20"], ["2026-11-03", "2026-10-27"], ["2026-11-10", "2026-11-03"],
  ]);
  // An open day is never before the invoice was made.
  assert.equal(planInstallments({ totalUnits: 20n, count: 2, interval: 7, firstDue: "2026-10-18", issueDate: "2026-10-18" })[1]!.opensOn, "2026-10-18");
  assert.throws(() => planInstallments({ totalUnits: 100n, count: 1, interval: "monthly", firstDue: "2026-11-01", issueDate: "2026-10-18" }), /2 to 12/);
  assert.throws(() => planInstallments({ totalUnits: 100n, count: 13, interval: "monthly", firstDue: "2026-11-01", issueDate: "2026-10-18" }), /2 to 12/);
  assert.throws(() => checkInterval(6), /7 to 365/);
  assert.throws(() => checkInterval("weekly"), /monthly/);
  assert.throws(() => planInstallments({ totalUnits: 2n, count: 3, interval: "monthly", firstDue: "2026-11-01", issueDate: "2026-10-18" }), /too small/);
});

test("early-pay discount: by amount or percent (rounded down), until tomorrow at the earliest and by the due date", () => {
  const byPct = planEarlyDiscount({ totalUnits: 300_000_000n, bps: percentBps("10"), until: "2026-10-31", issueDate: "2026-10-18", dueDate: "2026-11-30" });
  assert.deepEqual([byPct.earlyUnits, byPct.discountUnits, byPct.bps, byPct.earlyExpiresOn, byPct.fullOpensOn], [270_000_000n, 30_000_000n, 1000n, "2026-11-01", "2026-11-01"]);
  const byAmount = planEarlyDiscount({ totalUnits: 1_000_000n, amountUnits: 50_000n, until: "2026-10-19", issueDate: "2026-10-18", dueDate: "2026-10-31" });
  assert.equal(byAmount.earlyUnits, 950_000n);
  assert.equal(percentOf(333n, percentBps("2.5")), 8n); // 8.325 rounds down
  const base = { totalUnits: 1_000_000n, issueDate: "2026-10-18", dueDate: "2026-10-31" };
  assert.throws(() => planEarlyDiscount({ ...base, until: "2026-10-18", bps: 100n }), /tomorrow or later/);
  assert.throws(() => planEarlyDiscount({ ...base, until: "2026-11-01", bps: 100n }), /after the due date/);
  assert.throws(() => planEarlyDiscount({ ...base, dueDate: "2027-12-31", until: "2027-01-16", bps: 100n }), /more than 89 days/);
  assert.throws(() => planEarlyDiscount({ ...base, until: "2026-10-20" }), /exactly one/);
  assert.throws(() => planEarlyDiscount({ ...base, until: "2026-10-20", amountUnits: 1n, bps: 1n }), /exactly one/);
  assert.throws(() => planEarlyDiscount({ ...base, until: "2026-10-20", amountUnits: 1_000_000n }), /less than the invoice total/);
  assert.throws(() => planEarlyDiscount({ ...base, totalUnits: 50n, until: "2026-10-20", bps: 100n }), /comes to nothing/);
});

test("late fee: an amount or a percent of the total, printed at issue; it may open the day after the due date", () => {
  assert.deepEqual(planLateFee({ totalUnits: 300_000_000n, bps: percentBps("1.5") }), { feeUnits: 4_500_000n, bps: 150n });
  assert.deepEqual(planLateFee({ totalUnits: 300_000_000n, amountUnits: 10_000_000n }), { feeUnits: 10_000_000n, bps: null });
  assert.throws(() => planLateFee({ totalUnits: 10n, bps: 1n }), /comes to nothing/);
  assert.equal(lateFeeOpensOn("2026-10-31"), "2026-11-01");
  assert.equal(paidOnTime("2026-10-31T23:59:59Z", "2026-10-31"), true);
  assert.equal(paidOnTime("2026-11-01T00:00:00Z", "2026-10-31"), false);
  assert.equal(paidOnTime(null, "2026-10-31"), false);
});

test("percent parsing: up to 2 decimals, over 0, at most 100", () => {
  assert.equal(percentBps("10"), 1000n);
  assert.equal(percentBps("2.5"), 250n);
  assert.equal(percentBps("0.01"), 1n);
  assert.equal(percentBps("100"), 10_000n);
  for (const bad of ["0", "0.00", "100.01", "101", "1.234", "-1", "1e2", "", "5%"]) assert.throws(() => percentBps(bad), TermsError, bad);
  assert.equal(bpsText(250n), "2.5");
  assert.equal(bpsText(1000n), "10");
  assert.equal(bpsText(1n), "0.01");
});

test("chase: polite on day 3, firm on day 7, formal from day 14 by default; custom days; off", () => {
  const at = (today: string, days: readonly number[] | null = CHASE_DEFAULT_DAYS) => chaseStage("2026-10-31", today, days)?.tone ?? null;
  assert.equal(at("2026-11-02"), null);
  assert.equal(at("2026-11-03"), "polite");
  assert.equal(at("2026-11-06"), "polite");
  assert.equal(at("2026-11-07"), "firm");
  assert.equal(at("2026-11-14"), "formal");
  assert.equal(at("2027-01-01"), "formal");
  assert.equal(at("2026-11-03", null), null);
  assert.equal(at("2026-11-01", [1]), "polite");
  assert.equal(at("2026-12-31", [1]), "polite");
  assert.deepEqual(chaseStage("2026-10-31", "2026-11-08", [3, 7, 14]), { tone: "firm", daysOverdue: 8, day: 7, nextDay: 14 });
  assert.deepEqual(checkChaseDays([5, 10]), [5, 10]);
  for (const bad of [[], [7, 3], [0], [91], [3, 3], [1, 2, 3, 4], [1.5]]) assert.throws(() => checkChaseDays(bad), TermsError, JSON.stringify(bad));
  assert.equal(reminderTone("polite"), "friendly");
  assert.equal(reminderTone("formal"), "formal");
});

test("planTerms: what the invoice's own request asks, and the combinations refused", () => {
  const ctx = { totalUnits: 300_000_000n, token: "USDC" as const, currency: null, issueDate: "2026-10-18", dueDate: "2026-11-01", expiresInDays: null };
  const plan = planTerms({ installments: { count: 3, interval: "monthly" }, late_fee: { amount: "5" } }, ctx);
  assert.equal(plan.ownUnits, 100_000_000n);
  assert.equal(plan.lateFee?.feeUnits, 5_000_000n);
  assert.deepEqual(plan.chaseDays, [3, 7, 14]);
  assert.equal(needsTermsRow(plan), true);
  assert.equal(needsTermsRow(planTerms({ chase: { days: [3, 7, 14] } }, ctx)), false);
  assert.equal(needsTermsRow(planTerms({ chase: false }, ctx)), true);
  assert.equal(planTerms({ early_discount: { percent: "10", until: "2026-10-25" } }, ctx).ownUnits, 270_000_000n);
  const refuses = (body: Parameters<typeof planTerms>[0], re: RegExp, extra: Partial<typeof ctx> = {}) =>
    assert.throws(() => planTerms(body, { ...ctx, ...extra }), (e: unknown) => e instanceof AmountError && re.test(e.message));
  refuses({ installments: { count: 2 }, early_discount: { percent: "5", until: "2026-10-20" } }, /not both/);
  refuses({ installments: { count: 2 } }, /USDC or SOL only/, { currency: "INR" as never });
  refuses({ installments: { count: 2 } }, /expires_in_days/, { expiresInDays: 30 as never });
  refuses({ installments: { count: 2, first_due: "2026-11-05" } }, /first installment's due date/);
  refuses({ late_fee: { amount: "0.0000001" } }, /late_fee\.amount/);
  refuses({ chase: { days: [14, 7] } }, /each later/);
});

// ---------------------------------------------------------------- refunds (pure)

const ME = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";
const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: "Ab3dEf6hJk9m", kind: "single", recipient: ME, token: "USDC", mint: null, decimals: 6, amountAtomic: 1_000_000n,
  reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e", payerName: null, forText: null, note: null, requesterName: null, flags: [],
  status: "paid", paidSignature: SIG, paidPayer: PAYER, paidAmountAtomic: 1_000_000n, paidAt: "2026-10-17T10:00:00Z", paidRail: "solana_pay",
  source: "plugin", createdAt: "2026-10-17T09:00:00Z", ...over,
});

test("refundability: paid Solana payments go back to the paying wallet; card, matched, Base and unpaid ones don't", () => {
  assert.deepEqual(refundability(row()), { ok: true, paidAtomic: 1_000_000n, payer: PAYER });
  assert.deepEqual(refundability(row({ status: "underpaid", paidAmountAtomic: 400_000n })), { ok: true, paidAtomic: 400_000n, payer: PAYER });
  assert.deepEqual(refundability(row({ paidAmountAtomic: 1_500_000n })), { ok: true, paidAtomic: 1_500_000n, payer: PAYER }); // overpaid: all of it
  const no = (r: RequestRow, re: RegExp) => { const v = refundability(r); assert.ok(!v.ok && re.test(v.message), JSON.stringify(v)); };
  no(row({ status: "open", paidSignature: null, paidPayer: null, paidAmountAtomic: null }), /isn't paid/);
  no(row({ paidRail: "moonpay_card" }), /MoonPay/);
  no(row({ paidRail: "matched" }), /matched by you/);
  no(row({ chain: "base" }), /Base/);
  no(row({ paidPayer: ME }), /its own wallet/);
});

test("refund ids commit to the request, payer, token, amount and reference; the signed text names all of them", () => {
  const t = { requestId: "Ab3dEf6hJk9m", payer: PAYER, token: "USDC" as const, amountAtomic: 250_000n, reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e" };
  const id = refundIdFor(t);
  assert.match(id, /^[1-9A-HJ-NP-Za-km-z]{12}$/);
  assert.notEqual(refundIdFor({ ...t, amountAtomic: 250_001n }), id);
  assert.notEqual(refundIdFor({ ...t, payer: ME }), id);
  assert.equal(refundPrefix("0.25", "USDC", t.requestId, PAYER, ME), `Owed refund 0.25 USDC of Ab3dEf6hJk9m to ${PAYER} for ${ME}`);
  const r = (status: RefundRow["status"], amount: bigint) => ({ status, amountAtomic: amount }) as RefundRow;
  assert.deepEqual(refundTotals([r("confirmed", 5n), r("pending", 3n), r("lapsed", 100n)]), { refundedAtomic: 5n, pendingAtomic: 3n });
});

// ---------------------------------------------------------------- statements (pure)

test("statement arithmetic: opening balance, the month's lines, closing; a double payment shows as a credit", () => {
  const { from, to } = monthRange("2026-11");
  const meta = { invoiceId: "Ab3dEf6hJk9m", invoiceNumber: "INV-7", description: "Invoice INV-7", link: "https://www.getowed.xyz/i/Ab3dEf6hJk9m", countsAsInvoiced: true };
  const oct = row({ createdAt: "2026-10-20T00:00:00Z", status: "open", paidSignature: null, paidPayer: null, paidAmountAtomic: null, paidAt: null });
  const nov = row({ id: "Bc4eFg7iKm2n", createdAt: "2026-11-02T00:00:00Z", paidAt: "2026-11-05T00:00:00Z", paidAmountAtomic: 1_000_000n });
  const refund = { requestId: "Bc4eFg7iKm2n", status: "confirmed", amountAtomic: 200_000n, confirmed: { at: "2026-11-06T00:00:00Z", signature: SIG } } as RefundRow;
  const events = [...requestEvents(oct, meta, []), ...requestEvents(nov, { ...meta, invoiceId: nov.id }, [refund])];
  const { lines, totals } = fold(events, from, to);
  assert.deepEqual(lines.map((l) => [l.kind, l.amountAtomic]), [["invoiced", 1_000_000n], ["paid", 1_000_000n], ["refunded", 200_000n]]);
  assert.deepEqual(totals, [{ token: "USDC", opening: 1_000_000n, invoiced: 1_000_000n, cancelled: 0n, paid: 1_000_000n, refunded: 200_000n, closing: 1_200_000n }]);
  // Cancelled (the other price was paid) and then paid anyway: the client is owed it back.
  const twice = row({ cancelledAt: "2026-11-03T00:00:00Z", paidAt: "2026-11-04T00:00:00Z", createdAt: "2026-11-01T00:00:00Z" });
  assert.equal(fold(requestEvents(twice, meta, []), from, to).totals[0]!.closing, -1_000_000n);
  assert.deepEqual(monthRange("2026-12"), { from: Date.UTC(2026, 11, 1), to: Date.UTC(2027, 0, 1) });
  assert.throws(() => monthRange("2026-13"), /YYYY-MM/);
});

test("statement clients: a wallet, or a name compared without case (sanitized like requester text)", () => {
  assert.deepEqual(parseClient(PAYER), { kind: "wallet", wallet: PAYER, label: PAYER });
  assert.deepEqual(parseClient("  Acme Corp "), { kind: "name", name: "acme corp", label: "Acme Corp" });
  assert.throws(() => parseClient(""), /client is required/);
  assert.throws(() => parseClient("https://evil.example"), /empty once links/);
});

// ---------------------------------------------------------------- the invoice page's model (app/i/[id]/model.ts)
import { invoiceModel } from "@/app/i/[id]/model";
import type { PublicInvoiceWithTerms } from "@/lib/invoice-terms";

const termsFixture = (name: string): PublicInvoiceWithTerms => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));

test("invoice page: an installment plan pays installment 1 now, lists the plan, and prints the late fee", () => {
  const inv = termsFixture("invoice.terms.create.res.json");
  const m = invoiceModel(inv, Date.parse("2026-10-18T10:00:00Z"));
  assert.equal(m.payId, inv.id);
  assert.equal(m.payTitle, "Pay installment 1 of 3: 100.000001 USDC");
  assert.equal(m.payable, true);
  assert.equal(m.refreshOnChange, true);
  assert.equal(m.terms?.kind, "installments");
  assert.deepEqual(m.terms?.rows.map((r) => [r.label, r.amount, r.status]), [
    ["Installment 1 of 3", "100.000001 USDC", "Open"], ["Installment 2 of 3", "100 USDC", "Opens Nov 24, 2026"], ["Installment 3 of 3", "100 USDC", "Opens Dec 25, 2026"],
  ]);
  assert.equal(m.terms?.lateFeeNote, "Late fee: 4.5 USDC (1.5% of the total) if an installment isn't paid by its due date, added once.");
  assert.equal(m.dueLabel, "Due Nov 1, 2026");
});

test("invoice page: after installment 1 is paid and before the next opens, nothing is payable and the chip says so", () => {
  const inv = structuredClone(termsFixture("invoice.terms.create.res.json"));
  inv.status = "underpaid";
  inv.terms!.status = "underpaid";
  inv.terms!.installments!.plan[0]!.status = "paid";
  inv.terms!.pay_now = null;
  const m = invoiceModel(inv, Date.parse("2026-11-02T10:00:00Z"));
  assert.equal(m.payable, false);
  assert.deepEqual(m.initial, { status: "open" });
  assert.equal(m.dueLabel, "1 of 3 paid");
  assert.equal(m.due, "Dec 1, 2026");
  assert.equal(m.terms?.waiting, "Installment 2 of 3 opens Nov 24, 2026, a week before it is due.");
});

test("invoice page: an early price paid shows Paid with the price it was paid at; a plan's child names its invoice", () => {
  const m = invoiceModel(termsFixture("invoice.terms.get.res.json"), Date.parse("2026-10-18T10:00:00Z"));
  assert.equal(m.initial.status, "paid");
  assert.equal(m.terms?.summary, "Paid at the early price, 190 USDC.");
  assert.match(m.terms?.earlyNote ?? "", /^Pay 190 USDC by Oct 28, 2026 \(5% off\)\. After that the full 200 USDC is due by Nov 17, 2026\.$/);
  const child = invoiceModel(termsFixture("invoice.terms.child.res.json"), Date.parse("2026-11-24T10:00:00Z"));
  assert.deepEqual(child.termOf, { label: "Installment 2 of 3", link: termsFixture("invoice.terms.child.res.json").term_of!.link, parentId: termsFixture("invoice.terms.child.res.json").term_of!.invoice_id });
  assert.equal(child.terms, null);
  assert.equal(child.payTitle, "Pay 100 USDC");
});
