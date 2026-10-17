// QA-04 (Medium): a request's reference is public (it is in the solana: URL and, once paid, on chain
// next to an "owed:<id>" memo). Anyone can append it to cheap transactions. getSignaturesForAddress is
// asked for the newest 10 only, so 10 transactions that mention the reference after the real payment
// (and before anyone checks) push the payment out of view: the request shows "open" (or "underpaid"
// with dust) for good, inviting the payer to pay again. Failed transactions count against the 10 too.
// Cost to the attacker: about 10 × 5,000 lamports. Same window in plugin/src/chain.ts (offline links).
// Owner: web/lib/validate.ts + plugin/src/chain.ts (W1-D / W1-B closed: LEAD to assign).
// Run: command node e2e/qa/run.mjs QA-04
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequest, settleFromChain } from "@/lib/requests";
import { findPayments } from "@/lib/validate";
import { hasPglite, sig, startChain, startDb } from "./qa-harness.ts";

const it = hasPglite ? test : test.skip;
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const GRIEFER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const chain = await startChain();
before(startDb);
after(() => chain.close());

const make = () => createRequest({
  recipient: RECIPIENT, token: "USDC", amountAtomic: 10_000n, payerName: null, forText: "QA-04", note: null,
  requesterName: null, flags: [], source: "web",
});

it("QA-04 control (passes today): nine zero-credit transactions after the payment leave it inside the window", async () => {
  const r = await make();
  chain.land({ signature: sig(50), slot: 4000, blockTime: 1_792_249_000, refs: [r.reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
  for (let i = 1; i <= 9; i++) {
    chain.land({ signature: sig(50 + i), slot: 4000 + i, blockTime: 1_792_249_000 + i, refs: [r.reference], credit: 0n }, GRIEFER, RECIPIENT, 10_000n);
  }
  const [settled] = await settleFromChain([r], chain.rpc);
  assert.equal(settled.status, "paid");
});

it("QA-04 ten zero-credit transactions after the payment: the request still settles as paid", async () => {
  const r = await make();
  chain.land({ signature: sig(100), slot: 5000, blockTime: 1_792_250_000, refs: [r.reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
  for (let i = 1; i <= 10; i++) {
    chain.land({ signature: sig(100 + i), slot: 5000 + i, blockTime: 1_792_250_000 + i, refs: [r.reference], credit: 0n }, GRIEFER, RECIPIENT, 10_000n);
  }
  const [settled] = await settleFromChain([r], chain.rpc);
  assert.equal(settled.status, "paid", `shows ${settled.status}: the real payment fell out of the newest-10 window`);
  assert.equal(settled.paidSignature, sig(100));
});

it("QA-04 ten failed transactions after the payment: still paid (failed ones are filtered after the limit)", async () => {
  const r = await make();
  chain.land({ signature: sig(200), slot: 6000, blockTime: 1_792_260_000, refs: [r.reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
  for (let i = 1; i <= 10; i++) {
    chain.land({ signature: sig(200 + i), slot: 6000 + i, blockTime: 1_792_260_000 + i, refs: [r.reference], credit: 0n, err: { InstructionError: [0, "Custom"] } }, GRIEFER, RECIPIENT, 10_000n);
  }
  const [settled] = await settleFromChain([r], chain.rpc);
  assert.equal(settled.status, "paid", `shows ${settled.status}`);
});

it("QA-04 status-raw path (findPayments, nothing stored): ten 1-unit dust credits don't turn a full payment into underpaid", async () => {
  const reference = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
  chain.land({ signature: sig(300), slot: 7000, blockTime: 1_792_270_000, refs: [reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
  for (let i = 1; i <= 10; i++) {
    chain.land({ signature: sig(300 + i), slot: 7000 + i, blockTime: 1_792_270_000 + i, refs: [reference], credit: 1n }, GRIEFER, RECIPIENT, 10_000n + BigInt(i));
  }
  const [check] = await findPayments([{ reference, recipient: RECIPIENT, token: "USDC", amountAtomic: 10_000n }], chain.rpc);
  assert.equal(check.status, "paid", `shows ${check.status}`);
  assert.equal(check.payment?.signature, sig(300));
});
