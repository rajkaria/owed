// F6 shapes: contract/shapes.mjs re-derives a group ledger with its own code (expense digests and signatures, splits,
// USDC quotes, balances, the greedy plan, settle-up requests' terms), so a fixture or a live reply that doesn't add up
// fails the contract check and the smoke test.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { check, groupLedgerPlan, shapes } from "../../contract/shapes.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errorsOf = (shape, value) => check(shapes[shape], value).errors.join("\n");
const clone = (x) => JSON.parse(JSON.stringify(x));

test("every ledger fixture passes", async () => {
  for (const [name, shape] of [
    ["ledgers.create.req.json", "groupLedgerCreateReq"], ["ledgers.create.res.json", "groupLedgerRes"], ["ledgers.get.res.json", "groupLedgerRes"],
    ["ledgers.expense.req.json", "groupLedgerExpenseReq"], ["ledgers.expense.res.json", "groupLedgerExpenseRes"],
    ["ledgers.expense.fiat.req.json", "groupLedgerExpenseReq"], ["ledgers.expense.fiat.res.json", "groupLedgerExpenseRes"],
    ["ledgers.settle.req.json", "groupLedgerSettleReq"], ["ledgers.settle.res.json", "groupLedgerSettleRes"],
  ]) assert.equal(errorsOf(shape, await fixture(name)), "", name);
});

test("an expense body's digest and signature are checked: other amounts, splits or a forged signature fail", async () => {
  const req = await fixture("ledgers.expense.req.json");
  assert.match(errorsOf("groupLedgerExpenseReq", { ...req, tip: "10.01", amount: "114.14" }), /names 114\.13 USDC, not the body's 114\.14|digest/);
  assert.match(errorsOf("groupLedgerExpenseReq", { ...req, items: req.items.map((i, k) => (k === 0 ? { ...i, members: [1] } : i)) }), /digest [0-9a-f]{16}, the body gives/);
  assert.match(errorsOf("groupLedgerExpenseReq", { ...req, signature: "ab".repeat(64) }), /does not verify/);
  assert.match(errorsOf("groupLedgerExpenseReq", { ...req, signed_message: req.signed_message.replace("Owed add expense", "Owed add expenses") }), /must read "Owed add expense/);
});

test("a ledger reply must add up: shares, USDC quotes, balances, the plan, signatures", async () => {
  const res = await fixture("ledgers.get.res.json");
  const cases = [
    [(x) => { x.expenses[0].shares[0].share = "31"; x.expenses[0].shares[0].amount = "31"; }, /shares: add up to 121 USDC, not the total 120/],
    [(x) => { x.expenses[3].shares[0].amount = "13"; }, /shares\[0\]\.amount: 13 USDC, but 13\.33 USDC gives 13\.33/],
    [(x) => { x.balances[1].net = "60"; }, /balances\[1\]\.net: 60, the expenses and requests give 66\.290873/],
    [(x) => { x.plan = [{ from: 3, to: 1, amount: "1", payable: true }]; }, /plan: .* the balances give \[\]/],
    [(x) => { x.expenses[2].recorded_by = x.members[1].wallet; }, /must read "Owed add expense [0-9a-f]{16} \(60 USDC\) to ledger \w+ by 7n34/],
    [(x) => { x.expenses[2].signature = x.expenses[3].signature; }, /expenses\[2\]\.signature: does not verify/],
    [(x) => { x.expenses[1].description = "Groceries and wine"; }, /does not verify|must read/],
    [(x) => { x.settlements[0].transfers[1].status = "paid"; }, /paid: missing for status paid/],
    [(x) => { x.totals.spent = "1"; }, /totals\.spent: 1, the expenses add up to 372\.96/],
    [(x) => { x.members[0].wallet = x.members[1].wallet; }, /not the owner|listed twice/],
  ];
  for (const [tamper, why] of cases) {
    const bad = clone(res);
    tamper(bad);
    assert.match(errorsOf("groupLedgerRes", bad), why, String(tamper));
  }
});

test("a local-currency expense: each share's USDC is its euros at the one rate, rounded up", async () => {
  const res = await fixture("ledgers.expense.fiat.res.json");
  const bad = clone(res);
  bad.ledger.expenses[0].shares[2].amount = "27";
  assert.match(errorsOf("groupLedgerExpenseRes", bad), /shares\[2\]\.amount: 27 USDC, but 23\.23 EUR gives 27\.06/);
  const noQuote = clone(res);
  noQuote.ledger.expenses[0].fiat = null;
  assert.match(errorsOf("groupLedgerExpenseRes", noQuote), /missing on a local-currency expense/);
});

test("settle-up requests: each pays the creditor exactly the planned amount and hashes its terms", async () => {
  const res = await fixture("ledgers.settle.res.json");
  const cases = [
    [(x) => { x.created[0].request.recipient = x.ledger.members[2].wallet; }, /recipient: not the creditor's wallet/],
    [(x) => { x.created[1].request.reference = x.created[0].request.reference; }, /does not hash its terms/],
    [(x) => { x.created[1].request.payer = null; }, /payer: not the debtor's wallet/],
    [(x) => { x.created[0].request.note = "Pay me"; }, /doesn't name the ledger/],
    [(x) => { x.round = 9; }, /the ledger has no settle-up 9/],
  ];
  for (const [tamper, why] of cases) {
    const bad = clone(res);
    tamper(bad);
    assert.match(errorsOf("groupLedgerSettleRes", bad), why, String(tamper));
  }
  const req = await fixture("ledgers.settle.req.json");
  assert.match(errorsOf("groupLedgerSettleReq", { ...req, version: 4 }), /version: 4, but the message settles v5/);
});

test("groupLedgerPlan: at most n - 1 transfers that square everyone", () => {
  const plan = groupLedgerPlan([75_719_754n, 66_290_873n, -38_402_785n, -103_607_842n]);
  assert.deepEqual(plan.map((t) => [t.from, t.to, t.amountAtomic]), [[3, 0, 75_719_754n], [2, 1, 38_402_785n], [3, 1, 27_888_088n]]);
});
