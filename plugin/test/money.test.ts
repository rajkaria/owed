import { test } from "node:test";
import assert from "node:assert/strict";
import { AmountError, MAX_SPLIT, TOKENS, U64_MAX, USDC_MINT, fromAtomic, splitEvenly, toAtomic } from "../src/money.ts";

test("token table matches the pinned mainnet facts", () => {
  assert.equal(USDC_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.deepEqual(TOKENS.USDC, { decimals: 6, mint: USDC_MINT, symbol: "USDC" });
  assert.deepEqual(TOKENS.SOL, { decimals: 9, mint: null, symbol: "SOL" });
  assert.equal(U64_MAX, 2n ** 64n - 1n);
});

test("toAtomic converts plain decimals to atomic units", () => {
  const cases: Array<[string, "USDC" | "SOL", bigint]> = [
    ["15", "USDC", 15_000_000n],
    ["0.5", "USDC", 500_000n],
    ["0.000001", "USDC", 1n],
    ["1.25", "USDC", 1_250_000n],
    ["1.250000", "USDC", 1_250_000n],
    ["10", "USDC", 10_000_000n],
    ["100", "USDC", 100_000_000n],
    ["0.01", "USDC", 10_000n],
    ["1", "SOL", 1_000_000_000n],
    ["0.000000001", "SOL", 1n],
    ["0.003", "SOL", 3_000_000n],
    ["2.5", "SOL", 2_500_000_000n],
  ];
  for (const [amount, token, atomic] of cases) {
    assert.equal(toAtomic(amount, token), atomic, `${amount} ${token}`);
  }
});

test("toAtomic accepts exactly u64 max and rejects one more", () => {
  // 2^64-1 atomic = 18446744073709.551615 USDC = 18446744073.709551615 SOL
  assert.equal(toAtomic("18446744073709.551615", "USDC"), U64_MAX);
  assert.equal(toAtomic("18446744073.709551615", "SOL"), U64_MAX);
  assert.throws(() => toAtomic("18446744073709.551616", "USDC"), { message: "Amount is too large." });
  assert.throws(() => toAtomic("18446744073.709551616", "SOL"), { message: "Amount is too large." });
  assert.throws(() => toAtomic("99999999999999999999999999", "USDC"), { message: "Amount is too large." });
  assert.throws(() => toAtomic("1".repeat(10_000), "USDC"), { message: "Amount is too large." });
});

test("toAtomic rejects zero in every spelling", () => {
  for (const zero of ["0", "0.0", "0.000000", "0.000000000"]) {
    assert.throws(() => toAtomic(zero, "SOL"), AmountError, zero);
    assert.throws(() => toAtomic(zero, "SOL"), { message: "Amount must be more than zero." });
  }
});

test("toAtomic rejects more decimals than the token has", () => {
  assert.throws(() => toAtomic("0.0000001", "USDC"), { message: "USDC amounts have at most 6 decimal places." });
  assert.throws(() => toAtomic("1.0000000", "USDC"), { message: "USDC amounts have at most 6 decimal places." });
  assert.throws(() => toAtomic("0.0000000001", "SOL"), { message: "SOL amounts have at most 9 decimal places." });
});

test("toAtomic accepts only ^(0|[1-9][0-9]*)(\\.[0-9]+)?$", () => {
  const bad = [
    "", " ", "-1", "+1", "-0.5", "01", "00", "00.5", ".5", "5.", "1..2", "1.2.3", "1e3", "1E3", "1e-6",
    "0x10", "Infinity", "NaN", " 15", "15 ", "1,5", "1_000", "١٥", "１５", "15\n", "1.5\u0000",
  ];
  for (const amount of bad) {
    assert.throws(() => toAtomic(amount, "USDC"), AmountError, JSON.stringify(amount));
    assert.throws(() => toAtomic(amount, "USDC"), { message: "Amount must be a plain decimal number like 15 or 0.5." });
  }
});

test("toAtomic and fromAtomic reject non-strings, non-bigints and unknown tokens at runtime", () => {
  assert.throws(() => toAtomic(15 as unknown as string, "USDC"), AmountError);
  assert.throws(() => toAtomic("15", "BONK" as unknown as "USDC"), { message: "Owed handles USDC or SOL only." });
  assert.throws(() => toAtomic("15", "toString" as unknown as "USDC"), { message: "Owed handles USDC or SOL only." });
  assert.throws(() => fromAtomic(15 as unknown as bigint, "USDC"), TypeError);
  assert.throws(() => fromAtomic(-1n, "USDC"), RangeError);
  assert.throws(() => fromAtomic(1n, "ETH" as unknown as "USDC"), AmountError);
});

test("fromAtomic gives the shortest decimal form", () => {
  const cases: Array<[bigint, "USDC" | "SOL", string]> = [
    [15_000_000n, "USDC", "15"],
    [500_000n, "USDC", "0.5"],
    [1n, "USDC", "0.000001"],
    [1_250_000n, "USDC", "1.25"],
    [10_000_000n, "USDC", "10"],
    [100_000_000n, "USDC", "100"],
    [0n, "USDC", "0"],
    [0n, "SOL", "0"],
    [1n, "SOL", "0.000000001"],
    [1_000_000_000n, "SOL", "1"],
    [3_000_000n, "SOL", "0.003"],
    [123_456_789_012n, "SOL", "123.456789012"],
    [U64_MAX, "USDC", "18446744073709.551615"],
    [U64_MAX, "SOL", "18446744073.709551615"],
  ];
  for (const [atomic, token, text] of cases) {
    assert.equal(fromAtomic(atomic, token), text, `${atomic} ${token}`);
  }
});

test("fromAtomic formats sums above u64 (summaries never truncate)", () => {
  assert.equal(fromAtomic(U64_MAX + 1n, "USDC"), "18446744073709.551616");
});

test("toAtomic(fromAtomic(x)) round-trips across magnitudes", () => {
  for (const token of ["USDC", "SOL"] as const) {
    for (let atomic = 1n; atomic <= U64_MAX; atomic = atomic * 7n + 3n) {
      assert.equal(toAtomic(fromAtomic(atomic, token), token), atomic, `${atomic} ${token}`);
    }
    assert.equal(toAtomic(fromAtomic(U64_MAX, token), token), U64_MAX);
  }
});

test("splitEvenly gives leftover atomic units to the first shares", () => {
  assert.deepEqual(splitEvenly(10_000_000n, 3), [3_333_334n, 3_333_333n, 3_333_333n]);
  assert.deepEqual(splitEvenly(60_000_000n, 4), [15_000_000n, 15_000_000n, 15_000_000n, 15_000_000n]);
  assert.deepEqual(splitEvenly(11n, 4), [3n, 3n, 3n, 2n]);
  assert.deepEqual(splitEvenly(5n, 5), [1n, 1n, 1n, 1n, 1n]);
  assert.deepEqual(splitEvenly(42n, 1), [42n]);
  assert.deepEqual(splitEvenly(U64_MAX, 2), [U64_MAX / 2n + 1n, U64_MAX / 2n]);
});

test("splitEvenly shares always sum to the total and differ by at most one unit", () => {
  for (let n = 1; n <= MAX_SPLIT; n++) {
    for (const total of [BigInt(n), BigInt(n) + 1n, 10_000_000n, 99_999_999n, 1_000_000_007n]) {
      const shares = splitEvenly(total, n);
      assert.equal(shares.length, n);
      assert.equal(shares.reduce((a, b) => a + b, 0n), total);
      const first = shares[0] ?? 0n;
      const last = shares[n - 1] ?? 0n;
      assert.ok(first - last <= 1n && first >= last);
      assert.ok(shares.every((s) => s > 0n));
    }
  }
});

test("splitEvenly accepts n from 1 to 20 only", () => {
  for (const n of [0, -1, 21, 100, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitEvenly(10_000_000n, n), { message: "A split needs between 1 and 20 people." }, String(n));
  }
  assert.equal(splitEvenly(20_000_000n, 20).length, 20);
});

test("splitEvenly rejects a total that is zero, negative or smaller than the number of shares", () => {
  assert.throws(() => splitEvenly(0n, 3), { message: "Amount must be more than zero." });
  assert.throws(() => splitEvenly(-10n, 3), { message: "Amount must be more than zero." });
  assert.throws(() => splitEvenly(2n, 3), { message: "Amount is too small to split 3 ways." });
  assert.throws(() => splitEvenly(10 as unknown as bigint, 3), AmountError);
});
