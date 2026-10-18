import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ledgerDescription, ledgerTitle, ledgerView, liveIds } from "@/app/l/[id]/model";
import { GroupLedgerResponse } from "@/lib/contract";
import { verifyMessageSignature } from "@/lib/verify-signature";

// F6: the ledger page's view model (/l/<id>), from the contract fixtures. Names and descriptions are quoted and
// cleaned again; signatures are checked on the server render; the page title never echoes recorder text.

const fixture = (name: string) => GroupLedgerResponse.parse(JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8")));
const ORIGIN = "https://www.getowed.xyz";

test("balances read as owed / owes / square, with what is pending; settle-ups list their live status", () => {
  const view = ledgerView(fixture("ledgers.get.res.json"), ORIGIN, verifyMessageSignature);
  assert.deepEqual(view.members.map((m) => [m.label, m.direction, m.net, m.pendingIn, m.pendingOut]), [
    ["Raj", "square", "0 USDC", null, null],
    ["Priya", "owed", "66.290873 USDC", "66.290873 USDC", null],
    ["Sam", "owes", "38.402785 USDC", null, "38.402785 USDC"],
    ["Alex", "owes", "27.888088 USDC", null, "27.888088 USDC"],
  ]);
  assert.equal(view.members[0]!.owner, true);
  assert.deepEqual(view.plan, []);
  assert.equal(view.rounds.length, 1);
  assert.equal(view.rounds[0]!.recordedBy, "“Sam”");
  assert.equal(view.rounds[0]!.signatureOk, true);
  assert.deepEqual(view.rounds[0]!.transfers.map((t) => [t.from, t.to, t.amount, t.status, t.addressed]), [
    ["“Alex”", "“Raj”", "75.719754 USDC", "paid", false],
    ["“Sam”", "“Priya”", "38.402785 USDC", "open", true],
    ["“Alex”", "“Priya”", "27.888088 USDC", "open", false],
  ]);
  assert.deepEqual(liveIds(view), view.rounds[0]!.transfers.slice(1).map((t) => t.id));
  assert.equal(view.spent, "372.96 USDC");
  assert.equal(view.settled, false);
});

test("expenses: every split explained, receipts line by line, recorders' signatures checked", () => {
  const view = ledgerView(fixture("ledgers.get.res.json"), ORIGIN, verifyMessageSignature);
  assert.deepEqual(view.expenses.map((e) => [e.description, e.paidBy, e.total, e.splitLine, e.signatureOk]), [
    ["Apartment, 3 nights", "“Raj”", "120 USDC", "split evenly between all 4", true],
    ["Groceries", "“Priya”", "45.5 USDC", "split evenly between 3", true],
    ["Car rental", "“Sam”", "60 USDC", "split by shares", true],
    ["Museum tickets", "“Raj”", "33.33 USDC", "exact amounts", true],
    ["Dinner at Taberna", "“Priya”", "114.13 USDC", "receipt items: 6 lines", true],
  ]);
  const dinner = view.expenses[4]!;
  assert.equal(dinner.items.length, 6);
  assert.deepEqual(dinner.items[2], { description: "Octopus to share", amount: "21 USDC", who: "Sam, Alex" });
  assert.equal(dinner.extras, "tax 6.73 USDC, tip 10 USDC");
  assert.equal(dinner.recordedBy, "“Raj”");
  assert.deepEqual(view.expenses[2]!.shares.map((s) => [s.label, s.weight, s.share]), [["Raj", "1", "15 USDC"], ["Sam", "2", "30 USDC"], ["Alex", "1", "15 USDC"]]);
  // Without the server's check (e.g. a test double), nothing claims to be signed.
  assert.ok(ledgerView(fixture("ledgers.get.res.json"), ORIGIN).expenses.every((e) => !e.signatureOk));
});

test("a local-currency ledger shows euros, the USDC locked, the rate, and approximate euro balances", () => {
  const l = GroupLedgerResponse.parse(JSON.parse(readFileSync(new URL("../../contract/fixtures/ledgers.expense.fiat.res.json", import.meta.url), "utf8")).ledger);
  const v = ledgerView(l, ORIGIN, verifyMessageSignature);
  const e = v.expenses[0]!;
  assert.equal(e.total, "€114.13");
  assert.match(e.usdc!, /^132\.\d+ USDC$/);
  assert.match(e.rateLine!, /^Locked 2026-10-18 11:05 UTC: 1 USDC = €0\.8584 \(api\.coinbase\.com, checked against open\.er-api\.com\)/);
  assert.deepEqual(e.shares.map((s) => s.share), ["€32.62", "€34.85", "€23.23", "€23.43"]);
  assert.match(v.members[0]!.netFiat!, /^≈ €\d+\.\d{2}$/);
  assert.match(v.fiatNote!, /^Amounts in EUR are approximate/);
  assert.equal(v.members[2]!.wallet, null);
});

test("titles and descriptions never echo recorder text when it carries a brand word", () => {
  const l = fixture("ledgers.get.res.json");
  const plain = ledgerView(l, ORIGIN);
  assert.equal(ledgerTitle(plain), "Group ledger: 2 settle-up requests open");
  assert.equal(ledgerDescription(plain), "372.96 USDC spent by 4 people for “Lisbon trip”. Settle up with any Solana wallet, or with your AI agent in PayBox.");
  const flagged = ledgerView({ ...l, title: "PayBox support refund", flags: ["brand_word:paybox"] }, ORIGIN);
  assert.ok(flagged.brandWords.includes("PayBox"), JSON.stringify(flagged.brandWords));
  assert.equal(ledgerDescription(flagged), "372.96 USDC spent by 4 people. Settle up with any Solana wallet, or with your AI agent in PayBox.");
  assert.equal(ledgerTitle({ settled: true, expenseCount: 5, openRequests: 0 }), "Group ledger: settled");
  assert.equal(ledgerTitle({ settled: false, expenseCount: 1, openRequests: 0 }), "Group ledger: 1 expense");
});

test("links and recorder text are cleaned again on render", () => {
  const l = fixture("ledgers.get.res.json");
  const dirty = { ...l, members: l.members.map((m, i) => (i === 3 ? { ...m, name: "Alex https://evil.example" } : m)) };
  const v = ledgerView(dirty, ORIGIN);
  assert.equal(v.members[3]!.label, "Alex");
  const gone = ledgerView({ ...l, members: l.members.map((m, i) => (i === 3 ? { ...m, name: "https://evil.example" } : m)) }, ORIGIN);
  assert.deepEqual([gone.members[3]!.label, gone.members[3]!.quoted], ["Member 4", false]);
});
