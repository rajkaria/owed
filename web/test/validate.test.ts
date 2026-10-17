import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonExact } from "@/lib/solana";
import { creditFromTransaction, decide, usdcAta, type Credit, type ParsedTransaction } from "@/lib/validate";

// Real mainnet getTransaction (jsonParsed) responses, captured 2026-10-17 from
// solana-rpc.publicnode.com: the two transactions that funded the team wallet.
const load = (name: string) =>
  (parseJsonExact(readFileSync(new URL(`fixtures/mainnet/${name}`, import.meta.url), "utf8")) as { result: ParsedTransaction }).result;
const clone = <T>(v: T): T => structuredClone(v);

const TEAM = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const SENDER = "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// usdc: ATA create for TEAM + transferChecked 5 USDC; DeJB… is a read-only non-signer key in it.
const usdcTx = load("usdc-5-to-team-ata-created.json");
const USDC_REF = "DeJBGdMFa1uynnnKiwrVioatTuHmNLpyFKnmB5kaFdzQ";
// sol: SystemProgram.transfer of 0.05 SOL to TEAM; the System Program id is its read-only key.
const solTx = load("sol-0.05-to-team.json");
const SOL_REF = "11111111111111111111111111111111";

test("derives the team's USDC associated token account", () => {
  assert.equal(usdcAta(TEAM), "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x");
});

test("USDC transfer into a freshly created ATA credits the recipient", () => {
  const credit = creditFromTransaction(usdcTx, { reference: USDC_REF, recipient: TEAM, token: "USDC" });
  assert.deepEqual(credit, {
    signature: "44rMqgCKXeZbvpKQTFDDpVdVQ9zJimEgjDvUPsZ2pjmpRu5wjSo4dQ1uvGZgkN6xsxXi5Q1YbNwA3HwFR2iJ8Gbo",
    payer: SENDER,
    amountAtomic: 5_000_000n,
    at: new Date(1792212373 * 1000).toISOString().replace(".000", ""),
    slot: usdcTx.slot,
  });
});

test("SOL transfer credits the recipient wallet and names the sender", () => {
  const credit = creditFromTransaction(solTx, { reference: SOL_REF, recipient: TEAM, token: "SOL" });
  assert.equal(credit?.amountAtomic, 50_000_000n);
  assert.equal(credit?.payer, SENDER);
  assert.equal(credit?.signature, "2y8Jw4ynuzPbTn1XFc1k1xGMPvmBh46dDZ3fqvAFLeC3u9ALEEAn3EvmUDMSfZgde4dUYQu7mLm4moRoNR471GrG");
});

test("a transaction without the reference key does not count", () => {
  assert.equal(creditFromTransaction(usdcTx, { reference: OTHER, recipient: TEAM, token: "USDC" }), null);
});

test("a transfer to someone else does not count", () => {
  assert.equal(creditFromTransaction(usdcTx, { reference: USDC_REF, recipient: OTHER, token: "USDC" }), null);
  assert.equal(creditFromTransaction(solTx, { reference: SOL_REF, recipient: OTHER, token: "SOL" }), null);
});

test("the wrong token does not count (USDC tx checked as SOL, SOL tx checked as USDC)", () => {
  assert.equal(creditFromTransaction(usdcTx, { reference: USDC_REF, recipient: TEAM, token: "SOL" }), null);
  assert.equal(creditFromTransaction(solTx, { reference: SOL_REF, recipient: TEAM, token: "USDC" }), null);
});

test("a failed transaction does not count", () => {
  const failed = clone(usdcTx);
  failed.meta!.err = { InstructionError: [4, { Custom: 1 }] };
  assert.equal(creditFromTransaction(failed, { reference: USDC_REF, recipient: TEAM, token: "USDC" }), null);
  assert.equal(creditFromTransaction(null, { reference: USDC_REF, recipient: TEAM, token: "USDC" }), null);
});

test("a USDC-like token with another mint does not count", () => {
  const fake = clone(usdcTx);
  for (const b of fake.meta!.postTokenBalances!) b.mint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
  assert.equal(creditFromTransaction(fake, { reference: USDC_REF, recipient: TEAM, token: "USDC" }), null);
});

test("lamport balances above 2^53 stay exact", () => {
  const whale = clone(solTx);
  whale.meta!.preBalances[1] = 9_007_199_254_740_993n; // 2^53 + 1
  whale.meta!.postBalances[1] = 9_007_199_254_740_993n + 50_000_000n;
  const credit = creditFromTransaction(whale, { reference: SOL_REF, recipient: TEAM, token: "SOL" });
  assert.equal(credit?.amountAtomic, 50_000_000n);
  const parsed = parseJsonExact('{"a":9007199254740993,"b":5,"c":1.5}') as Record<string, unknown>;
  assert.deepEqual(parsed, { a: 9_007_199_254_740_993n, b: 5, c: 1.5 });
});

const credit = (slot: number, amount: bigint): Credit => ({
  signature: `sig${slot}`,
  payer: SENDER,
  amountAtomic: amount,
  at: "2026-10-17T05:00:09Z",
  slot,
});

test("decide: full payment is paid, more than asked is paid", () => {
  assert.equal(decide([credit(1, 15_000_000n)], 15_000_000n).status, "paid");
  assert.equal(decide([credit(1, 20_000_000n)], 15_000_000n).status, "paid");
});

test("decide: less than asked is underpaid and reports the largest partial", () => {
  const check = decide([credit(1, 3_000_000n), credit(2, 10_000_000n)], 15_000_000n);
  assert.equal(check.status, "underpaid");
  assert.equal(check.payment?.amountAtomic, 10_000_000n);
});

test("decide: partial payments are not summed (one transaction must pay in full)", () => {
  assert.equal(decide([credit(1, 10_000_000n), credit(2, 5_000_000n)], 15_000_000n).status, "underpaid");
});

test("decide: the earliest full payment wins", () => {
  const check = decide([credit(9, 15_000_000n), credit(3, 15_000_000n), credit(5, 1n)], 15_000_000n);
  assert.equal(check.payment?.signature, "sig3");
});

test("decide: nothing is open; no amount means any credit pays", () => {
  assert.deepEqual(decide([], 15_000_000n), { status: "open" });
  assert.equal(decide([credit(1, 1n)], null).status, "paid");
});
