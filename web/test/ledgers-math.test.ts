import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AddExpenseBody } from "@/lib/contract";
import { ledgerText } from "@/lib/ledgers-math";
import { prepareExpense, storedText } from "@/lib/ledgers-write";
import { sanitizeText } from "@/lib/safety";

// F6: the server and the plugin run one arithmetic file, and the server builds exactly the signed message the plugin
// builds for the same expense (the contract fixtures were signed over the plugin's).

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = (name: string) => JSON.parse(read(`../../contract/fixtures/${name}`));

test("web/lib/ledgers-math.ts is plugin/src/ledger-math.ts, byte for byte", () => {
  assert.equal(read("../lib/ledgers-math.ts"), read("../../plugin/src/ledger-math.ts"));
});

test("prepareExpense builds the fixtures' signed messages (USDC receipt and euro receipt)", () => {
  for (const [req, res] of [["ledgers.expense.req.json", "ledgers.expense.res.json"], ["ledgers.expense.fiat.req.json", "ledgers.expense.fiat.res.json"]]) {
    const body = AddExpenseBody.parse(fixture(req));
    const ledger = fixture(res).ledger;
    const prepared = prepareExpense(ledger.id, ledger.members.length, body, body.signer);
    assert.equal(`${prepared.prefix} at `, body.signed_message.slice(0, body.signed_message.lastIndexOf(" at ") + 4), req);
    const stored = ledger.expenses.at(-1);
    assert.deepEqual(prepared.split.participants, stored.shares.map((s: { member: number }) => s.member));
  }
});

test("ledgerText output never changes under the general sanitizer, so stored descriptions pass both", () => {
  const pieces = ["Dinner", " ", "at", ".", "com", "www", "://", "​", "‮", '"', "'", "’", "<b>", "[x]", "{", "`", "\\", "@", "€", "1.5", "é", "ﬁ", "\n", "paybox", "-", "–"];
  let seed = 11;
  for (let i = 0; i < 4000; i++) {
    let t = "";
    for (let k = 0; k < 10; k++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      t += pieces[seed % pieces.length];
    }
    const cleaned = ledgerText(t, 80);
    if (cleaned !== null) assert.equal(sanitizeText(cleaned, 80), cleaned, JSON.stringify(t));
    assert.equal(storedText(t, 80, "description"), cleaned);
  }
});
