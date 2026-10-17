import { test } from "node:test";
import assert from "node:assert/strict";
import { AmountError, formatUnits, fromAtomic, toAtomic } from "@/lib/money";

test("toAtomic converts decimal strings exactly", () => {
  assert.equal(toAtomic("15", "USDC"), 15_000_000n);
  assert.equal(toAtomic("4.5", "USDC"), 4_500_000n);
  assert.equal(toAtomic("0.000001", "USDC"), 1n);
  assert.equal(toAtomic("0.05", "SOL"), 50_000_000n);
  assert.equal(toAtomic("0.000000001", "SOL"), 1n);
  assert.equal(toAtomic("18446744073709.551615", "USDC"), 18_446_744_073_709_551_615n);
});

test("toAtomic rejects anything that is not a positive plain decimal within precision and u64", () => {
  for (const bad of ["0", "0.0", "-1", "+1", "1e3", "01", ".5", "5.", "1,5", " 1", "1 ", "NaN", "Infinity", "", "0x10"]) {
    assert.throws(() => toAtomic(bad, "USDC"), AmountError, bad);
  }
  assert.throws(() => toAtomic("0.0000001", "USDC"), /at most 6 decimal places/);
  assert.throws(() => toAtomic("0.0000000001", "SOL"), /at most 9 decimal places/);
  assert.throws(() => toAtomic("18446744073709.551616", "USDC"), /too large/);
});

test("fromAtomic gives the shortest decimal", () => {
  assert.equal(fromAtomic(15_000_000n, "USDC"), "15");
  assert.equal(fromAtomic(4_500_000n, "USDC"), "4.5");
  assert.equal(fromAtomic(1n, "USDC"), "0.000001");
  assert.equal(fromAtomic(50_000_000n, "SOL"), "0.05");
  assert.equal(fromAtomic(0n, "USDC"), "0");
  assert.equal(formatUnits(-1_500_000n, 6), "-1.5");
});

test("round trip is lossless", () => {
  for (const s of ["1", "15", "4.5", "0.123456", "999999.999999", "1000000"]) {
    assert.equal(fromAtomic(toAtomic(s, "USDC"), "USDC"), s);
  }
});
