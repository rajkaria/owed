import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { isRequestId, newReference, newRequestId } from "@/lib/ids";

test("request ids are 10-char base58 and distinct", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const id = newRequestId();
    assert.ok(isRequestId(id), id);
    ids.add(id);
  }
  assert.equal(ids.size, 2000);
});

test("request id characters are spread across the whole alphabet", () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 3000; i++) for (const c of newRequestId()) counts.set(c, (counts.get(c) ?? 0) + 1);
  assert.equal(counts.size, 58);
  // 30,000 draws over 58 symbols: mean ~517; a biased generator lands far outside this band.
  for (const [c, n] of counts) assert.ok(n > 380 && n < 660, `${c}: ${n}`);
});

test("isRequestId rejects look-alikes and wrong lengths", () => {
  assert.ok(isRequestId("7Gh2kQpXa9"));
  for (const bad of ["7Gh2kQpXa", "7Gh2kQpXa9x", "0Gh2kQpXa9", "OGh2kQpXa9", "IGh2kQpXa9", "lGh2kQpXa9", "7Gh2kQpXa ", 1234567890, null]) {
    assert.equal(isRequestId(bad), false, String(bad));
  }
});

test("references are 32 random bytes in base58", () => {
  const a = newReference();
  const b = newReference();
  assert.notEqual(a, b);
  assert.equal(bs58.decode(a).length, 32);
});
