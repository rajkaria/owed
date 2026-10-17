import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { isRequestId, newReference, requestIdFor } from "@/lib/ids";

const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";

test("request ids hash the payment terms: the contract fixture's id, same as the plugin computes", () => {
  assert.equal(requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 15_000_000n, reference: REFERENCE }), "JArQ6g9JvoWr");
  assert.equal(requestIdFor({ recipient: RECIPIENT, token: "SOL", amountAtomic: 15_000_000n, reference: REFERENCE }), "NAsyaiM7RoHi");
});

test("changing any term changes the id", () => {
  const base = { recipient: RECIPIENT, token: "USDC" as const, amountAtomic: 15_000_000n, reference: REFERENCE };
  const id = requestIdFor(base);
  const variants = [
    { ...base, recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
    { ...base, token: "SOL" as const },
    { ...base, amountAtomic: 15_000_001n },
    { ...base, reference: "AZLsgyxKZQ9fiqCig4G8drfgCtB96ZfcLQsEQNKmPQ5z" },
  ];
  for (const v of variants) assert.notEqual(requestIdFor(v), id, JSON.stringify(v, (_, x) => typeof x === "bigint" ? String(x) : x));
});

test("ids from fresh references are 12-char base58, distinct, and spread over the alphabet", () => {
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  for (let i = 0; i < 3000; i++) {
    const id = requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 1_000_000n, reference: newReference() });
    assert.equal(id.length, 12);
    assert.ok(isRequestId(id), id);
    ids.add(id);
    for (const c of id) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  assert.equal(ids.size, 3000);
  assert.equal(counts.size, 58);
  // 36,000 draws over 58 symbols: mean ~621; a biased slice of the digest lands far outside this band.
  for (const [c, n] of counts) assert.ok(n > 470 && n < 780, `${c}: ${n}`);
});

test("isRequestId takes 12-char ids and older 10-char ids, nothing else", () => {
  assert.ok(isRequestId("JArQ6g9JvoWr"));
  assert.ok(isRequestId("1RRer81ufk"));
  for (const bad of ["JArQ6g9JvoW", "JArQ6g9JvoWrx", "0ArQ6g9JvoWr", "OArQ6g9JvoWr", "IArQ6g9JvoWr", "lArQ6g9JvoWr", "JArQ6g9JvoW ", 123456789012, null]) {
    assert.equal(isRequestId(bad), false, String(bad));
  }
});

test("references are 32 random bytes in base58", () => {
  const a = newReference();
  const b = newReference();
  assert.notEqual(a, b);
  assert.equal(bs58.decode(a).length, 32);
});
