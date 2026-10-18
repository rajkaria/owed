import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decimalToUnits, expenseDigest, expensePrefix, ledgerBalances, LedgerError, ledgerText, planSettlement, proRataUnits, settlePrefix, splitEvenlyUnits,
  splitExpense, transferAmounts, unitsToDecimal, usdcToFiatUnits, WEIGHT_DECIMALS, type BalanceExpense, type CanonicalExpense,
} from "../src/ledger-math.ts";
import { splitEvenly } from "../src/money.ts";

// F6: the shared arithmetic (plugin/src/ledger-math.ts = web/lib/ledgers-math.ts). Acceptance rows: 4 people and 5
// expenses paid by 3 of them settle in at most 3 transfers that zero every balance; a 6-item receipt with tax and tip
// splits to the cent with leftovers assigned the way splitEvenly assigns them.

const usdc = (s: string) => decimalToUnits(s, 6);
const cents = (s: string) => decimalToUnits(s, 2);
const show = (units: bigint[], decimals = 6) => units.map((u) => unitsToDecimal(u, decimals));
const w = (text: string) => decimalToUnits(text, WEIGHT_DECIMALS);

test("decimal <-> units: exact, signed for display, refuses floats in disguise", () => {
  assert.equal(usdc("12.5"), 12_500_000n);
  assert.equal(cents("84.60"), 8460n);
  assert.equal(decimalToUnits("1500", 0), 1500n);
  assert.equal(unitsToDecimal(-12_500_000n, 6), "-12.5");
  assert.equal(unitsToDecimal(0n, 6), "0");
  assert.equal(unitsToDecimal(5n, 0), "5");
  assert.throws(() => cents("1.234"), /more than 2 decimal places/);
  assert.throws(() => decimalToUnits("1.5", 0), /whole number/);
  for (const bad of ["1e3", "-1", ".5", "01", "1,5", " 1"]) assert.throws(() => usdc(bad), LedgerError, bad);
});

test("splitEvenlyUnits gives leftovers exactly like money.ts splitEvenly", () => {
  for (const [total, n] of [[10_000_000n, 3], [1n, 1], [100n, 7], [20_000_001n, 4], [99n, 20]] as const) {
    assert.deepEqual(splitEvenlyUnits(total, n), splitEvenly(total, n), `${total}/${n}`);
  }
});

test("proRataUnits rounds down and hands leftovers to the first members with a weight", () => {
  assert.deepEqual(proRataUnits(100n, [1n, 1n, 1n]), [34n, 33n, 33n]);
  assert.deepEqual(proRataUnits(100n, [0n, 1n, 1n, 1n]), [0n, 34n, 33n, 33n], "a zero weight never picks up a unit");
  assert.deepEqual(proRataUnits(10n, [3n, 1n]), [8n, 2n]); // 7.5 -> 7 + 1, 2.5 -> 2
  assert.deepEqual(proRataUnits(0n, [0n, 0n]), [0n, 0n]);
  assert.throws(() => proRataUnits(5n, [0n, 0n]), /Nothing to spread/);
});

test("even split: everyone by default, or `among`; leftovers to the first in ledger order", () => {
  const all = splitExpense(usdc("10"), { split: "even" }, 3);
  assert.deepEqual(show(all.units), ["3.333334", "3.333333", "3.333333"]);
  assert.deepEqual(all.participants, [0, 1, 2]);
  const some = splitExpense(usdc("0.000005"), { split: "even", among: [1, 3] }, 4);
  assert.deepEqual(some.units, [0n, 3n, 0n, 2n]);
  assert.throws(() => splitExpense(2n, { split: "even", among: [0, 1, 2] }, 3), /too small to split 3 ways/);
  assert.throws(() => splitExpense(9n, { split: "even", among: [2, 1] }, 3), /each member once, in ledger order/);
  assert.throws(() => splitExpense(9n, { split: "even", among: [0, 3] }, 3), /isn't in this ledger/);
  assert.throws(() => splitExpense(9n, { split: "even", among: [] }, 3), /names no one/);
});

test("shares split: weights in proportion, decimals allowed, zero refused", () => {
  const r = splitExpense(usdc("30"), { split: "shares", shares: [{ member: 0, weight: w("2") }, { member: 2, weight: w("1") }] }, 3);
  assert.deepEqual(show(r.units), ["20", "0", "10"]);
  const odd = splitExpense(100n, { split: "shares", shares: [{ member: 0, weight: w("1.5") }, { member: 1, weight: w("1.5") }, { member: 2, weight: w("1") }] }, 3);
  assert.deepEqual(odd.units, [38n, 37n, 25n]); // 37.5 + 37.5 + 25: the leftover unit goes to the first member
  assert.throws(() => splitExpense(100n, { split: "shares", shares: [{ member: 0, weight: 0n }] }, 2), /more than zero/);
  assert.throws(() => w("1.00001"), /more than 4 decimal places/);
});

test("exact split: must add up to the amount", () => {
  const r = splitExpense(cents("50"), { split: "exact", amounts: [{ member: 0, units: cents("20") }, { member: 1, units: cents("30") }] }, 2);
  assert.deepEqual(r.units, [2000n, 3000n]);
  assert.throws(() => splitExpense(cents("50"), { split: "exact", amounts: [{ member: 0, units: cents("20") }] }, 2), /add up to 2000 units, not the expense's 5000/);
  assert.throws(() => splitExpense(cents("50"), { split: "even", amounts: [{ member: 0, units: 5000n }] }, 2), /amounts doesn't go with split "even"/);
  assert.throws(() => splitExpense(cents("50"), { split: "even", taxUnits: 5n }, 2), /tax and tip go with split "items" only/);
});

// A real-looking restaurant bill in euros, read off a receipt photo by the agent. Every amount in cents.
//   Raj 0, Priya 1, Sam 2, Alex 3
const RECEIPT = {
  items: [
    { units: cents("18.50"), members: [0] },          // Raj's bacalhau
    { units: cents("16.90"), members: [1] },          // Priya's risotto
    { units: cents("21.00"), members: [2, 3] },       // shared octopus
    { units: cents("9.99"), members: [0, 1, 2] },     // olives and bread (3 ways: 3.33 + 3.33 + 3.33 = 9.99)
    { units: cents("24.00"), members: [0, 1, 2, 3] }, // a bottle of wine
    { units: cents("7.01"), members: [1, 3] },        // espressos (7.01 / 2: Priya pays the extra cent)
  ],
  taxUnits: cents("6.73"),
  tipUnits: cents("10.00"),
};

test("acceptance: a 6-item receipt with tax and tip splits to the cent, leftovers assigned like splitEvenly", () => {
  const total = cents("114.13"); // 97.40 of items + 6.73 tax + 10.00 tip
  const r = splitExpense(total, { split: "items", ...RECEIPT }, 4);
  // Item subtotals, each item split with splitEvenly's rule (leftover cents to the first member listed).
  // Raj 18.50 + 3.33 + 6.00; Priya 16.90 + 3.33 + 6.00 + 3.51; Sam 10.50 + 3.33 + 6.00; Alex 10.50 + 6.00 + 3.50.
  assert.deepEqual(show(r.detail!.subtotal, 2), ["27.83", "29.74", "19.83", "20"]);
  const raj = 1850n + splitEvenly(999n, 3)[0]! + splitEvenly(2400n, 4)[0]!;
  const priya = 1690n + splitEvenly(999n, 3)[1]! + splitEvenly(2400n, 4)[1]! + splitEvenly(701n, 2)[0]!;
  assert.equal(r.detail!.subtotal[0], raj);
  assert.equal(r.detail!.subtotal[1], priya);
  // Tax and tip follow each subtotal, rounded down, the cents left over to the first members (ledger order).
  // 6.73 x 27.83 / 97.40 = 1.92.. -> 1.92, then 2.05, 1.37, 1.38: 6.72, so the one cent left goes to Raj.
  assert.deepEqual(show(r.detail!.tax, 2), ["1.93", "2.05", "1.37", "1.38"]);
  // 10.00: 2.85 + 3.05 + 2.03 + 2.05 = 9.98, so Raj and Priya get one cent each.
  assert.deepEqual(show(r.detail!.tip, 2), ["2.86", "3.06", "2.03", "2.05"]);
  assert.deepEqual(show(r.units, 2), ["32.62", "34.85", "23.23", "23.43"]);
  // To the cent: the shares add up to the receipt exactly, tax and tip each to their own total.
  assert.equal(r.units.reduce((a, b) => a + b, 0n), total);
  assert.equal(r.detail!.tax.reduce((a, b) => a + b, 0n), RECEIPT.taxUnits);
  assert.equal(r.detail!.tip.reduce((a, b) => a + b, 0n), RECEIPT.tipUnits);
  assert.deepEqual(r.participants, [0, 1, 2, 3]);
});

test("items: the receipt must add up, and items name members in ledger order", () => {
  assert.throws(() => splitExpense(cents("114.12"), { split: "items", ...RECEIPT }, 4), /add up to 11413 units, not the expense's 11412/);
  assert.throws(() => splitExpense(100n, { split: "items", items: [] }, 2), /1 to 30 items/);
  assert.throws(() => splitExpense(100n, { split: "items", items: [{ units: 100n, members: [1, 0] }] }, 2), /Item 1 must list each member once/);
  const noTax = splitExpense(101n, { split: "items", items: [{ units: 101n, members: [0, 1] }] }, 2);
  assert.deepEqual(noTax.units, [51n, 50n]);
  const someoneSkipped = splitExpense(300n, { split: "items", items: [{ units: 200n, members: [1] }], taxUnits: 100n }, 3);
  assert.deepEqual(someoneSkipped.units, [0n, 300n, 0n]);
  assert.deepEqual(someoneSkipped.participants, [1]);
});

// The acceptance ledger: Raj (owner), Priya, Sam and Alex; 5 expenses paid by Raj, Priya and Sam. Alex paid nothing.
function tripExpenses(): BalanceExpense[] {
  const e = (paidBy: number, amount: string, split: Parameters<typeof splitExpense>[1]) => {
    const shares = splitExpense(usdc(amount), split, 4).units;
    return { paidBy, amountAtomic: shares.reduce((a, b) => a + b, 0n), sharesAtomic: shares };
  };
  return [
    e(0, "120", { split: "even" }),                                    // Raj: the apartment
    e(1, "45.5", { split: "even", among: [1, 2, 3] }),                 // Priya: groceries for three
    e(2, "60", { split: "shares", shares: [{ member: 0, weight: w("1") }, { member: 2, weight: w("2") }, { member: 3, weight: w("1") }] }), // Sam: car
    e(0, "33.33", { split: "exact", amounts: [{ member: 1, units: usdc("13.33") }, { member: 3, units: usdc("20") }] }),      // Raj: museum
    e(1, "114.13", { split: "items", items: RECEIPT.items.map((i) => ({ ...i, units: i.units * 10_000n })), taxUnits: RECEIPT.taxUnits * 10_000n, tipUnits: RECEIPT.tipUnits * 10_000n }), // Priya: dinner
  ];
}

test("acceptance: 4 people, 5 expenses by 3 payers settle in at most 3 transfers that zero every balance", () => {
  const expenses = tripExpenses();
  const before = ledgerBalances(4, expenses, []);
  assert.equal(before.reduce((a, m) => a + m.net, 0n), 0n, "balances net to zero");
  assert.deepEqual(before.map((m) => unitsToDecimal(m.net, 6)), ["75.719754", "66.290873", "-38.402785", "-103.607842"]);
  assert.ok(before[3]!.paid === 0n && before[3]!.net < 0n, "Alex paid nothing and owes");

  const plan = planSettlement(before.map((m) => m.toSettle));
  assert.ok(plan.length <= 3, `${plan.length} transfers`);
  assert.deepEqual(plan.map((t) => [t.from, t.to, unitsToDecimal(t.amountAtomic, 6)]), [
    [3, 0, "75.719754"], // Alex, the largest debtor, pays Raj, the largest creditor, all he is owed
    [2, 1, "38.402785"], // Sam now owes more than Alex: he pays Priya
    [3, 1, "27.888088"], // and Alex pays Priya the rest
  ]);
  const owed = before.filter((m) => m.net < 0n).reduce((a, m) => a - m.net, 0n);
  assert.equal(plan.reduce((a, t) => a + t.amountAtomic, 0n), owed, "the transfers add up exactly to what is owed");

  // Requested: every transfer pending, nothing left to settle, nothing moved yet.
  const open = plan.map((t) => ({ ...t, ...transferAmounts("open", t.amountAtomic, null) }));
  const pending = ledgerBalances(4, expenses, open);
  assert.ok(pending.every((m) => m.toSettle === 0n));
  assert.deepEqual(pending.map((m) => m.net), before.map((m) => m.net));
  assert.deepEqual(planSettlement(pending.map((m) => m.toSettle)), [], "a second settle-up has nothing to do");

  // Paid: every balance is zero.
  const paid = plan.map((t) => ({ ...t, ...transferAmounts("paid", t.amountAtomic, t.amountAtomic) }));
  const after = ledgerBalances(4, expenses, paid);
  assert.ok(after.every((m) => m.net === 0n && m.toSettle === 0n && m.pendingIn === 0n && m.pendingOut === 0n));
});

test("cancelled requests put the debt back; underpaid ones count what arrived", () => {
  const expenses = tripExpenses();
  const plan = planSettlement(ledgerBalances(4, expenses, []).map((m) => m.toSettle));
  const [first, second, third] = plan;
  const transfers = [
    { ...first!, ...transferAmounts("paid", first!.amountAtomic, first!.amountAtomic) },
    { ...second!, ...transferAmounts("cancelled", second!.amountAtomic, null) },
    { ...third!, ...transferAmounts("underpaid", third!.amountAtomic, usdc("10")) },
  ];
  const b = ledgerBalances(4, expenses, transfers);
  const again = planSettlement(b.map((m) => m.toSettle));
  // Raj is square; Sam still owes all of his (cancelled) transfer, Alex the 17.888088 that didn't arrive.
  assert.deepEqual(again.map((t) => [t.from, t.to, unitsToDecimal(t.amountAtomic, 6)]), [[2, 1, "38.402785"], [3, 1, "17.888088"]]);
  assert.deepEqual(transferAmounts("expired", 5n, null), { settledAtomic: 0n, pendingAtomic: 0n });
  assert.deepEqual(transferAmounts("underpaid", 5n, 9n), { settledAtomic: 5n, pendingAtomic: 0n });
});

test("planSettlement: at most n-1 transfers, exact sums, ties to the earlier member, on 500 random ledgers", () => {
  let seed = 0x6f776564n;
  const rand = (max: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return (seed >> 33n) % max;
  };
  for (let run = 0; run < 500; run++) {
    const n = 2 + Number(rand(19n));
    const nets = Array.from({ length: n }, () => rand(3n) === 0n ? 0n : rand(2_000_000_000n) - 1_000_000_000n);
    nets[n - 1] = nets[n - 1]! - nets.reduce((a, v) => a + v, 0n);
    const plan = planSettlement(nets);
    const nonZero = nets.filter((v) => v !== 0n).length;
    assert.ok(plan.length <= Math.max(0, nonZero - 1), `run ${run}: ${plan.length} transfers for ${nonZero} non-zero members`);
    const left = [...nets];
    for (const t of plan) {
      assert.ok(t.amountAtomic > 0n && t.from !== t.to);
      left[t.from] = left[t.from]! + t.amountAtomic;
      left[t.to] = left[t.to]! - t.amountAtomic;
    }
    assert.ok(left.every((v) => v === 0n), `run ${run}: not zeroed`);
  }
  assert.deepEqual(planSettlement([5n, 5n, -10n]), [{ from: 2, to: 0, amountAtomic: 5n }, { from: 2, to: 1, amountAtomic: 5n }]);
  assert.throws(() => planSettlement([5n, -4n]), /don't add up to zero/);
});

test("digest and signed-message prefixes are fixed strings over the expense in units", () => {
  const body: CanonicalExpense = {
    description: "Dinner at Taberna", paidBy: 1, currency: "EUR", totalUnits: 11413n, split: "items", among: null, shares: null, amounts: null,
    items: [{ description: "Wine", units: 2400n, members: [0, 1, 2, 3] }], taxUnits: 673n, tipUnits: 1000n,
  };
  const d = expenseDigest("Ab3dEf5hJk7m", body);
  assert.match(d, /^[0-9a-f]{16}$/);
  assert.equal(expenseDigest("Ab3dEf5hJk7m", { ...body }), d, "deterministic");
  for (const changed of [
    { tipUnits: 1001n }, { taxUnits: null }, { paidBy: 0 }, { currency: "GBP" }, { description: "Dinner" }, { totalUnits: 11414n },
    { items: [{ description: "Wine", units: 2400n, members: [0, 1, 2] }] }, { split: "even" as const },
  ]) {
    assert.notEqual(expenseDigest("Ab3dEf5hJk7m", { ...body, ...changed }), d, JSON.stringify(changed, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
  }
  assert.notEqual(expenseDigest("Ab3dEf5hJk7n", body), d, "bound to the ledger");
  assert.equal(
    expensePrefix("Ab3dEf5hJk7m", d, "114.13", "EUR", "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs"),
    `Owed add expense ${d} (114.13 EUR) to ledger Ab3dEf5hJk7m by FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs`,
  );
  assert.equal(
    settlePrefix("Ab3dEf5hJk7m", 5, 3, "120.54", "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs"),
    "Owed settle up ledger Ab3dEf5hJk7m v5: 3 requests, 120.54 USDC by FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs",
  );
  assert.match(settlePrefix("Ab3dEf5hJk7m", 1, 1, "1", "x"), /: 1 request, 1 USDC by x$/);
  // The longest message still fits the 200-character signed-message cap (amounts are at most u64 units).
  const longest = `${expensePrefix("Ab3dEf5hJk7m", d, unitsToDecimal((1n << 64n) - 1n, 6), "USDC", "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs")} at 2026-10-18T10:00:00Z`;
  assert.ok(longest.length <= 200, `${longest.length}`);
});

test("ledgerText: drops links, domains, schemes and addresses, keeps plain words, and is idempotent", () => {
  assert.equal(ledgerText("Dinner at Joe’s – 2 pizzas & wine (50%)", 80), "Dinner at Joe’s – 2 pizzas & wine (50%)");
  assert.equal(ledgerText("Pay at https://evil.example/x now", 80), "Pay at now");
  assert.equal(ledgerText("see www.evil or paybox.help or solana:abc or 10.0.0.1 or sam@mail.com", 80), "see or or or or sam", "an @ becomes a space, then the domain goes");
  assert.equal(ledgerText("Taxi\u202E\u200B home\n\ttonight", 80), "Taxi home tonight");
  assert.equal(ledgerText('He said "hi" <b>bold</b> [x] {y} `z`', 80), "He said hi b bold /b x y z");
  assert.equal(ledgerText("a<www.x>", 80), "a", "a link that appears once markup goes is still dropped");
  assert.equal(ledgerText("   ", 80), null);
  assert.equal(ledgerText("---", 80), null, "nothing readable");
  assert.equal(ledgerText(undefined, 80), null);
  assert.equal(ledgerText("x".repeat(100), 60), "x".repeat(60));
  assert.equal(ledgerText("ｆｕｌｌｗｉｄｔｈ", 80), "fullwidth", "NFKC");
  // Idempotent on a deterministic sample of awkward strings.
  const pieces = ["a", ".", "co", "m", "<", ">", "www", ":", "/", "@", "1", " ", "\u200b", "é", "\u0301", "ｗ", "\"", "’", "x", "-", "_"];
  let seed = 7;
  for (let i = 0; i < 3000; i++) {
    let t = "";
    for (let k = 0; k < 12; k++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      t += pieces[seed % pieces.length];
    }
    const once = ledgerText(t, 40);
    assert.equal(ledgerText(once, 40), once, JSON.stringify(t));
  }
});

test("USDC to a local currency for display: half away from zero, signed", () => {
  assert.equal(usdcToFiatUnits(usdc("10"), "0.8899", 2), 890n); // 8.899 -> 8.90
  assert.equal(usdcToFiatUnits(-usdc("10"), "0.8899", 2), -890n);
  assert.equal(usdcToFiatUnits(usdc("1"), "94.95975", 2), 9496n);
  assert.equal(usdcToFiatUnits(usdc("3"), "151.2", 0), 454n); // 453.6 yen -> 454
  assert.equal(usdcToFiatUnits(0n, "94.9", 2), 0n);
});
