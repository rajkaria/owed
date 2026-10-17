import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BASE_USDC, eip681Transfer, isChecksumAddress, keccak256Hex, parseEip681Transfer, parseEvmAddress, sameEvmAddress,
  toChecksumAddress, TRANSFER_TOPIC,
} from "../src/evm.ts";
import { idMatchesTerms, requestIdFor } from "../src/request-id.ts";

// W3-B: the same vectors web/test/evm.test.ts runs against web/lib/evm/*.
const vectors = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/evm-vectors.json", import.meta.url)), "utf8")) as {
  keccak256: Array<{ input_utf8: string; keccak256: string }>;
  eip55: { valid: string[]; normalize: Array<{ input: string; checksummed: string }>; invalid: string[] };
  request_ids: Array<{ chain: "solana" | "base" | null; recipient: string; token: "USDC" | "SOL"; amount_atomic: string; reference: string; id: string }>;
  eip681: Array<{ recipient: string; amount_atomic: string; url: string }>;
};

test("keccak256 matches the recorded vectors, across the 136-byte block boundary", () => {
  for (const v of vectors.keccak256) assert.equal(keccak256Hex(v.input_utf8), v.keccak256, JSON.stringify(v.input_utf8.slice(0, 20)));
  assert.equal(`0x${keccak256Hex("Transfer(address,address,uint256)")}`, TRANSFER_TOPIC);
});

test("EIP-55: the EIP's examples are valid, lower/upper-case input is checksummed, a wrong checksum is refused", () => {
  for (const a of vectors.eip55.valid) {
    assert.equal(toChecksumAddress(a.toLowerCase()), /[a-f]/.test(a.slice(2)) && /[A-F]/.test(a.slice(2)) ? a : toChecksumAddress(a));
    assert.equal(parseEvmAddress(a), toChecksumAddress(a));
  }
  for (const v of vectors.eip55.normalize) assert.equal(parseEvmAddress(v.input), v.checksummed);
  for (const bad of vectors.eip55.invalid) assert.equal(parseEvmAddress(bad), null, bad);
  assert.ok(isChecksumAddress(BASE_USDC));
  assert.ok(!isChecksumAddress(BASE_USDC.toLowerCase()));
  assert.ok(sameEvmAddress(BASE_USDC, BASE_USDC.toLowerCase()));
  assert.ok(!sameEvmAddress(BASE_USDC, "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs"));
});

test("request ids: Solana ids are unchanged (JArQ6g9JvoWr); a Base id commits to the chain too", () => {
  for (const v of vectors.request_ids) {
    const terms = { recipient: v.recipient, token: v.token, amountAtomic: BigInt(v.amount_atomic), reference: v.reference, ...(v.chain ? { chain: v.chain } : {}) };
    assert.equal(requestIdFor(terms), v.id, JSON.stringify(v));
    assert.ok(idMatchesTerms(v.id, terms));
  }
  assert.equal(vectors.request_ids[0].id, "JArQ6g9JvoWr");
  const base = vectors.request_ids.find((v) => v.chain === "base")!;
  const terms = { recipient: base.recipient, token: "USDC" as const, amountAtomic: BigInt(base.amount_atomic), reference: base.reference };
  // The same terms without the chain hash to a different id: a Solana-only checker refuses a Base id.
  assert.notEqual(requestIdFor(terms), base.id);
  assert.ok(!idMatchesTerms(base.id, terms));
  assert.ok(!idMatchesTerms(base.id, { ...terms, chain: "base", recipient: base.recipient.toLowerCase() }));
});

test("EIP-681 transfer links: built exactly, parsed back, anything else refused", () => {
  for (const v of vectors.eip681) {
    assert.equal(eip681Transfer(v.recipient, BigInt(v.amount_atomic)), v.url);
    assert.deepEqual(parseEip681Transfer(v.url), { token: BASE_USDC, chainId: 8453, recipient: v.recipient, amountAtomic: BigInt(v.amount_atomic) });
  }
  const good = vectors.eip681[0].url;
  for (const bad of [good.replace("@8453", ""), good.replace("transfer", "approve"), good.replace("uint256=500000", "uint256=0"), `${good}&x=1`, good.replace("ethereum:", "solana:")]) {
    assert.equal(parseEip681Transfer(bad), null, bad);
  }
  assert.throws(() => eip681Transfer("FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", 1n));
  assert.throws(() => eip681Transfer(vectors.eip681[0].recipient, 0n));
});
