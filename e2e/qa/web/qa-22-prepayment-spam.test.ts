// QA-22 (Low), regression guard for W2-B's QA-04 fix (w2b-settle 922c798): oldest-first reading stops at 60 reads,
// so spam that lands BEFORE the payment hides it again. The reference is in the link, so anyone holding the
// link (another share payer, anyone the board was shared with) can send 61 zero-credit transactions (~0.0003 SOL)
// before the victim pays. Passes on main (newest-10 window: the payment is the newest); fails on 922c798.
// Owner: W2-B. Run: command node e2e/qa/run.mjs QA-22
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequest, settleFromChain } from "@/lib/requests";
import { hasPglite, sig, startChain, startDb } from "./qa-harness.ts";

const it = hasPglite ? test : test.skip;
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const GRIEFER = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const chain = await startChain();
before(startDb);
after(() => chain.close());

for (const n of [30, 61, 200]) {
  it(`QA-22 ${n} zero-credit transactions before the payment: still paid`, async () => {
    const r = await createRequest({ recipient: RECIPIENT, token: "USDC", amountAtomic: 10_000n, payerName: null, forText: null, note: null, requesterName: null, flags: [], source: "web" });
    for (let i = 0; i < n; i++) chain.land({ signature: sig(1000 * n + i), slot: 10_000 * n + i, blockTime: 1_792_300_000 + i, refs: [r.reference], credit: 0n }, GRIEFER, RECIPIENT, 0n);
    chain.land({ signature: sig(1000 * n + 999), slot: 10_000 * n + 999, blockTime: 1_792_301_000, refs: [r.reference], credit: 10_000n }, PAYER, RECIPIENT, 0n);
    const [settled] = await settleFromChain([r], chain.rpc);
    assert.equal(settled.status, "paid", `shows ${settled.status}`);
  });
}
