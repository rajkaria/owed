// QA-03 (Medium): one transaction that carries two requests' references can settle only one of them
// (requests_paid_signature_key, by design), but on main 13f0507 it also blocks the other request
// forever: settleFromChain never excludes signatures already recorded on another request, decide()
// keeps picking that earliest full credit, recordPayment hits the unique index and returns the row
// unchanged, so the other request's own later payment is never chosen. Split-bill shares share a
// recipient and usually an amount, so one share payer can do this to another share.
// Mainnet repro: PAY ASK W2-G M1 (requests HeiQKE21Qu2f + zwJwhWJ8APRR). Owner: web/lib/requests.ts +
// web/lib/validate.ts (W1-D closed: LEAD to assign). Run: command node e2e/qa/run.mjs QA-03
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequest, getRequest, settleFromChain } from "@/lib/requests";
import { hasPglite, sig, startChain, startDb } from "./qa-harness.ts";

const it = hasPglite ? test : test.skip;
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const chain = await startChain();
before(startDb);
after(() => chain.close());

const make = () => createRequest({
  recipient: RECIPIENT, token: "USDC", amountAtomic: 10_000n, payerName: null, forText: "QA-03", note: null,
  requesterName: null, flags: [], source: "web",
});

it("QA-03 control (passes today): a transaction naming only A's reference settles A", async () => {
  const a = await make();
  chain.land({ signature: sig(9), slot: 900, blockTime: 1_792_239_000, refs: [a.reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
  const [settled] = await settleFromChain([a], chain.rpc);
  assert.equal(settled.status, "paid");
  assert.equal(settled.paidSignature, sig(9));
});

it("QA-03 checked one at a time: B is paid by its own transaction after a shared one settled A", async () => {
  const a = await make();
  const b = await make();
  // T1 pays 0.01 once but names both references; T2 later pays B on its own.
  chain.land({ signature: sig(1), slot: 1000, blockTime: 1_792_240_000, refs: [a.reference, b.reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
  chain.land({ signature: sig(2), slot: 1010, blockTime: 1_792_240_010, refs: [b.reference], credit: 10_000n }, PAYER, RECIPIENT, 10_000n);

  const [settledA] = await settleFromChain([a], chain.rpc);
  assert.equal(settledA.status, "paid");
  assert.equal(settledA.paidSignature, sig(1));

  const [settledB] = await settleFromChain([b], chain.rpc);
  assert.equal(settledB.status, "paid", "B was paid by T2 but stays open: T1 (already A's) keeps being chosen");
  assert.equal(settledB.paidSignature, sig(2));
});

it("QA-03 checked together (one /status call): each request ends up paid by a different transaction", async () => {
  const a = await make();
  const b = await make();
  chain.land({ signature: sig(3), slot: 2000, blockTime: 1_792_241_000, refs: [a.reference, b.reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
  chain.land({ signature: sig(4), slot: 2010, blockTime: 1_792_241_010, refs: [b.reference], credit: 10_000n }, PAYER, RECIPIENT, 10_000n);

  await settleFromChain([a, b], chain.rpc);
  const [ra, rb] = [await getRequest(a.id), await getRequest(b.id)];
  assert.equal(ra!.status, "paid");
  assert.equal(rb!.status, "paid", `B stays ${rb!.status}`);
  assert.notEqual(ra!.paidSignature, rb!.paidSignature);
});
