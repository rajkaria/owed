import { test } from "node:test";
import assert from "node:assert/strict";
import { allocate, decide, findPayments, type Credit } from "@/lib/validate";

// QA-03 (one transaction, two references) and QA-04 (reference spam) beyond W2-G's repro tests in
// e2e/qa/web/: check order, a request's own transaction, spam before the payment, and the read cap.
// Transactions follow the jsonParsed shape of the mainnet captures (as in e2e/qa/web/qa-harness.ts).

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const REF_A = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
const REF_B = "Bpo5quLAxFJj2eeQ9DrBGLEK69WwMD9k8ZbUF1aSeby9";
const RECIPIENT_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";
const sig = (n: number) => `5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2s${String(n).padStart(3, "1").replace(/0/g, "z")}`;

interface Tx { n: number; slot: number; refs: string[]; credit: bigint; err?: unknown }

function parsed(t: Tx) {
  const keys = [PAYER, "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi", RECIPIENT_ATA, USDC, ...t.refs];
  return {
    slot: t.slot, blockTime: 1_792_300_000 + t.slot,
    meta: {
      err: t.err ?? null, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1),
      preTokenBalances: [{ accountIndex: 2, mint: USDC, owner: RECIPIENT, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC, owner: RECIPIENT, uiTokenAmount: { amount: String(t.credit) } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [sig(t.n)],
      message: {
        accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: i < 3 })),
        instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { destination: RECIPIENT_ATA, multisigAuthority: PAYER } } }],
      },
    },
  };
}

/** Answers lib/solana's JSON-RPC posts from a list of transactions; records what was asked. */
async function onChain<T>(txs: Tx[], fn: (log: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const log: string[] = [];
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    const answer = (m: { id: number; method: string; params: [string, { limit?: number }] }) => {
      if (m.method === "getSignaturesForAddress") {
        log.push(`sigs limit=${m.params[1].limit}`);
        const list = txs.filter((t) => t.refs.includes(m.params[0])).sort((a, b) => b.slot - a.slot).slice(0, m.params[1].limit ?? 1000);
        return { jsonrpc: "2.0", id: m.id, result: list.map((t) => ({ signature: sig(t.n), err: t.err ?? null, slot: t.slot })) };
      }
      log.push(`tx ${m.params[0].slice(-3)}`);
      const t = txs.find((x) => sig(x.n) === m.params[0]);
      return { jsonrpc: "2.0", id: m.id, result: t ? parsed(t) : null };
    };
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  }) as typeof fetch;
  try {
    return await fn(log);
  } finally {
    globalThis.fetch = real;
  }
}

const RPC = { urls: ["https://rpc.example"] };
const q = (reference: string, extra: object = {}) => ({ reference, recipient: RECIPIENT, token: "USDC" as const, amountAtomic: 10_000n, ...extra });
const credit = (n: number, slot: number, amountAtomic = 10_000n): Credit => ({ signature: sig(n), payer: PAYER, amountAtomic, at: "2026-10-17T10:00:00Z", slot });

test("allocate: the shared transaction goes to the request with no alternative, whatever the order", () => {
  const t1 = credit(1, 100); // names A and B
  const t2 = credit(2, 110); // B's own payment
  for (const order of [["A", "B"], ["B", "A"]]) {
    const credits = order.map((r) => (r === "A" ? [t1] : [t1, t2]));
    const out = allocate(order.map(() => ({ amountAtomic: 10_000n })), credits);
    const byName = Object.fromEntries(order.map((r, i) => [r, out[i].payment?.signature]));
    assert.deepEqual(byName, { A: sig(1), B: sig(2) }, order.join());
  }
});

test("allocate on one request is exactly decide()", () => {
  const cases: Credit[][] = [[], [credit(1, 5, 1n)], [credit(2, 9), credit(1, 5, 1n)], [credit(3, 7), credit(4, 6, 20_000n)]];
  for (const c of cases) assert.deepEqual(allocate([{ amountAtomic: 10_000n }], [c])[0], decide(c, 10_000n));
});

test("allocate: a partial payment shared by two requests underpays only one of them", () => {
  const out = allocate([{ amountAtomic: 10_000n }, { amountAtomic: 10_000n }], [[credit(1, 1, 5n)], [credit(1, 1, 5n)]]);
  assert.deepEqual(out.map((o) => o.status), ["underpaid", "open"]);
});

test("claimed transactions are skipped for other requests but kept for their own", async () => {
  const txs: Tx[] = [{ n: 1, slot: 100, refs: [REF_A, REF_B], credit: 10_000n }, { n: 2, slot: 110, refs: [REF_B], credit: 10_000n }];
  await onChain(txs, async () => {
    const claimed = async () => new Map([[sig(1), "requestA"]]);
    const [a, b] = await findPayments([q(REF_A, { requestId: "requestA" }), q(REF_B, { requestId: "requestB" })], RPC, { claimed });
    assert.equal(a.payment?.signature, sig(1), "A keeps the transaction it already owns");
    assert.equal(b.payment?.signature, sig(2), "B is paid by its own transaction");
  });
});

test("spam before the payment: later rounds read further until the payment is found", async () => {
  const spam = Array.from({ length: 6 }, (_, i): Tx => ({ n: 10 + i, slot: 200 + i, refs: [REF_A], credit: 0n }));
  const pay: Tx = { n: 99, slot: 300, refs: [REF_A], credit: 10_000n };
  const after = Array.from({ length: 12 }, (_, i): Tx => ({ n: 30 + i, slot: 400 + i, refs: [REF_A], credit: 0n }));
  await onChain([...spam, pay, ...after], async (log) => {
    const [check] = await findPayments([q(REF_A)], RPC);
    assert.equal(check.status, "paid");
    assert.equal(check.payment?.signature, sig(99));
    assert.equal(log[0], "sigs limit=1000");
    // Round 1 reads the 4 oldest, round 2 the next 8 (which includes the payment), then it stops.
    assert.equal(log.filter((l) => l.startsWith("tx")).length, 12);
  });
});

test("the read cap holds: 70 successful spam transactions before the payment are not all read", async () => {
  const spam = Array.from({ length: 70 }, (_, i): Tx => ({ n: 100 + i, slot: 500 + i, refs: [REF_A], credit: 0n }));
  const pay: Tx = { n: 999, slot: 1000, refs: [REF_A], credit: 10_000n };
  await onChain([...spam, pay], async (log) => {
    const [check] = await findPayments([q(REF_A)], RPC);
    assert.equal(check.status, "open");
    assert.ok(log.filter((l) => l.startsWith("tx")).length <= 60);
  });
});
