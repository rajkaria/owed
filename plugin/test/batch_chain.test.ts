import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { Transaction } from "@solana/web3.js";
import { assessBatch, ATA_RENT_LAMPORTS, FEE_RESERVE_LAMPORTS, findPayment, pairedAmount, readBatchAccounts, type BatchAccounts, type Rpc } from "../src/chain.ts";
import { batchMemo, buildBatchTx, MAX_TX_BYTES, planBatch, TxError } from "../src/tx.ts";

// F1 on the plugin side: check_payments' direct-RPC check pairs each reference with the transfer instruction that
// carries it (two requests to one recipient for one amount in one pay_all transaction each count their own transfer),
// the batch readiness reads every wallet once, and the batch builder lays out one transfer per request and one memo.
// Multi-transfer transactions are built in the jsonParsed shape mainnet returns (the recorded captures in
// test/fixtures/chain pin that shape and keep their old results in chain.test.ts).

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const key = (label: string) => bs58.encode(createHash("sha256").update(`batch_chain test: ${label}`).digest());
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const R = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const R_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";
const REF_A = key("ref a");
const REF_B = key("ref b");
const SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";

function usdcPair(amountA: bigint, amountB: bigint) {
  const keys = [PAYER, "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi", R_ATA, USDC, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", REF_A, REF_B];
  const transfer = (amount: bigint, ref: string) => ({
    program: "spl-token",
    parsed: { type: "transferChecked", info: { source: keys[1], mint: USDC, destination: R_ATA, multisigAuthority: PAYER, signers: [ref], tokenAmount: { amount: String(amount), decimals: 6 } } },
  });
  return {
    slot: 1, blockTime: 1_792_300_000,
    meta: {
      err: null, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1),
      preTokenBalances: [{ accountIndex: 2, mint: USDC, owner: R, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC, owner: R, uiTokenAmount: { amount: String(amountA + amountB) } }],
      innerInstructions: [],
    },
    transaction: {
      signatures: [SIG],
      message: { accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })), instructions: [transfer(amountA, REF_A), transfer(amountB, REF_B), { program: "spl-memo", parsed: "owed:a owed:b" }] },
    },
  };
}

function solPair(lamports: bigint) {
  const keys = [PAYER, R, "11111111111111111111111111111111", REF_A, REF_B];
  const parsed = {
    slot: 2, blockTime: 1_792_300_100,
    meta: { err: null, preBalances: [10_000_000_000, 0, 1, 1, 1], postBalances: [10_000_000_000 - 2 * Number(lamports) - 5000, 2 * Number(lamports), 1, 1, 1], innerInstructions: [] },
    transaction: {
      signatures: [SIG],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0 })),
        instructions: [
          { program: "system", parsed: { type: "transfer", info: { source: PAYER, destination: R, lamports: Number(lamports) } } },
          { program: "system", parsed: { type: "transfer", info: { source: PAYER, destination: R, lamports: Number(lamports) } } },
        ],
      },
    },
  };
  const raw = {
    meta: { loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] },
    transaction: { message: { accountKeys: keys, instructions: [{ programIdIndex: 2, accounts: [0, 1, 3] }, { programIdIndex: 2, accounts: [0, 1, 4] }] } },
  };
  return { parsed, raw };
}

/** Answers getSignaturesForAddress for both references and getTransaction by encoding; logs what was asked. */
function chainRpc(parsed: unknown, raw: unknown | "fail" | null = null): Rpc & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === "getSignaturesForAddress") return [{ signature: SIG, err: null }] as T;
      const encoding = (params[1] as { encoding: string }).encoding;
      log.push(`getTransaction ${encoding}`);
      if (encoding === "json") {
        if (raw === "fail") throw new Error("node is behind");
        return structuredClone(raw) as T;
      }
      return structuredClone(parsed) as T;
    },
  };
}

test("findPayment: two USDC requests to one recipient for one amount in one transaction each count their own transfer", async () => {
  const tx = usdcPair(100_000n, 100_000n);
  const a = await findPayment(chainRpc(tx), { reference: REF_A, recipient: R, token: "USDC", amountAtomic: 100_000n });
  const b = await findPayment(chainRpc(tx), { reference: REF_B, recipient: R, token: "USDC", amountAtomic: 100_000n });
  assert.deepEqual([a.status, a.amountPaidAtomic, b.status, b.amountPaidAtomic], ["paid", 100_000n, "paid", 100_000n]);
});

test("findPayment: a request's own transfer short of its amount is underpaid, whatever else the recipient got", async () => {
  const r = await findPayment(chainRpc(usdcPair(40_000n, 100_000n)), { reference: REF_A, recipient: R, token: "USDC", amountAtomic: 100_000n });
  assert.deepEqual([r.status, r.amountPaidAtomic], ["underpaid", 40_000n]);
});

test("findPayment: two SOL transfers into one wallet are read once more as json to pair each reference", async () => {
  const { parsed, raw } = solPair(3_000_000n);
  const rpc = chainRpc(parsed, raw);
  const r = await findPayment(rpc, { reference: REF_B, recipient: R, token: "SOL", amountAtomic: 3_000_000n });
  assert.deepEqual([r.status, r.amountPaidAtomic], ["paid", 3_000_000n]);
  assert.deepEqual(rpc.log, ["getTransaction jsonParsed", "getTransaction json"]);
  // When that read fails: the whole transaction's credit, as before F1.
  const fallback = await findPayment(chainRpc(parsed, "fail"), { reference: REF_B, recipient: R, token: "SOL", amountAtomic: 3_000_000n });
  assert.deepEqual([fallback.status, fallback.amountPaidAtomic], ["paid", 6_000_000n]);
});

test("pairedAmount keeps the old rule for a single transfer and for references that ride elsewhere", () => {
  const tx = usdcPair(100_000n, 0n);
  (tx.transaction.message.instructions as unknown[]).splice(1, 1); // one transfer, carrying REF_A
  assert.equal(pairedAmount(tx as never, { reference: REF_A, recipient: R, token: "USDC" }), 100_000n);
  // REF_B is in the keys but on no transfer: the one transfer into the recipient, as before.
  assert.equal(pairedAmount(tx as never, { reference: REF_B, recipient: R, token: "USDC" }), 100_000n);
});

// ---------------------------------------------------------------- readBatchAccounts + assessBatch

const chainFixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/chain/${name}.json`, import.meta.url), "utf8")) as {
  query: Record<string, string>; calls: Array<{ method: string; params: unknown[]; result: unknown }>;
};

test("readBatchAccounts reads sender, sender USDC account and each recipient's USDC account in one recorded call", async () => {
  const f = chainFixture("readiness-usdc-new-recipient");
  const sender = (f.calls[0]!.params[0] as string[])[0]!;
  const rpc: Rpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const hit = f.calls.find((c) => c.method === method && JSON.stringify(c.params) === JSON.stringify(params));
      if (!hit) throw new Error(`unrecorded ${method}`);
      return structuredClone(hit.result) as T;
    },
  };
  const a = await readBatchAccounts(rpc, { sender, usdcRecipients: [f.query.fresh!, f.query.fresh!], solRecipients: [] });
  assert.equal(a.senderUsdc, 69_063_710n);
  assert.equal(a.senderLamports, 35_992_412_910n);
  assert.deepEqual([...a.usdcAccounts], [[f.query.fresh, { exists: false, frozen: false }]]);
  const need = assessBatch(a, [{ recipient: f.query.fresh!, token: "USDC", amountAtomic: 15_000_000n }, { recipient: f.query.fresh!, token: "USDC", amountAtomic: 5_000_000n }]);
  assert.deepEqual([need.ok, need.usdcTotal, need.opensAccountFor, need.feeLamports], [true, 20_000_000n, [f.query.fresh], FEE_RESERVE_LAMPORTS]);
});

const accounts = (over: Partial<BatchAccounts> = {}): BatchAccounts => ({
  senderLamports: 10_000_000_000n, senderUsdc: 50_000_000n, senderUsdcFrozen: false, usdcAccounts: new Map(), newSolWallets: new Set(), rentMinimum: null, ...over,
});

test("assessBatch: totals per token, rent for each USDC account opened after the first, frozen accounts and new SOL wallets", () => {
  const [x, y, z] = [key("x"), key("y"), key("z")];
  const three = assessBatch(accounts({ usdcAccounts: new Map([[x, { exists: false, frozen: false }], [y, { exists: false, frozen: false }], [z, { exists: false, frozen: false }]]) }),
    [x, y, z].map((recipient) => ({ recipient, token: "USDC" as const, amountAtomic: 1_000_000n })));
  assert.equal(three.feeLamports, FEE_RESERVE_LAMPORTS + 2n * ATA_RENT_LAMPORTS);
  const short = assessBatch(accounts({ senderLamports: 5_000_000n, usdcAccounts: new Map([[x, { exists: false, frozen: false }], [y, { exists: false, frozen: false }]]) }),
    [x, y].map((recipient) => ({ recipient, token: "USDC" as const, amountAtomic: 1n })));
  assert.match(short.reason!, /needs about 0\.00503928 SOL for fees \(it also opens 2 recipient USDC accounts\); it has 0\.005 SOL/);
  const frozen = assessBatch(accounts({ usdcAccounts: new Map([[x, { exists: true, frozen: true }]]) }), [{ recipient: x, token: "USDC", amountAtomic: 1n }]);
  assert.match(frozen.reason!, /is frozen, so it cannot receive/);
  const fresh = assessBatch(accounts({ newSolWallets: new Set([z]), rentMinimum: 890_880n }), [{ recipient: z, token: "SOL", amountAtomic: 100_000n }]);
  assert.match(fresh.reason!, /has never been used, so the first payment to it must be at least 0\.00089088 SOL/);
  const solShort = assessBatch(accounts({ senderLamports: 1_000_000_000n }), [{ recipient: z, token: "SOL", amountAtomic: 1_000_000_000n }]);
  assert.match(solShort.reason!, /needs 1 SOL for the SOL requests plus about 0\.003 SOL for fees; it has 1 SOL/);
});

// ---------------------------------------------------------------- buildBatchTx + planBatch

test("buildBatchTx: one transfer per request with its references read-only, one ATA create per new recipient, one memo last", () => {
  const built = buildBatchTx({ sender: PAYER, transfers: [
    { id: "aaaaaaaaaaaa", recipient: R, token: "USDC", amountAtomic: 10n, references: [REF_A], createRecipientAta: true },
    { id: "bbbbbbbbbbbb", recipient: R, token: "USDC", amountAtomic: 10n, references: [REF_B], createRecipientAta: true },
    { id: "cccccccccccc", recipient: key("sol recipient"), token: "SOL", amountAtomic: 1_000_000n, references: [key("ref c")], createRecipientAta: false },
  ] });
  assert.deepEqual(built.instructions, ["Create the recipient's USDC account if missing", "Send USDC", "Send USDC", "Send SOL", "Attach memo"]);
  const tx = Transaction.from(Buffer.from(built.transactionBase64, "base64"));
  for (const [i, ref] of [[1, REF_A], [2, REF_B]] as const) {
    const extra = tx.instructions[i]!.keys.slice(4);
    assert.deepEqual(extra.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[ref, false, false]]);
  }
  assert.equal(Buffer.from(tx.instructions[4]!.data).toString("utf8"), batchMemo(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]));
  assert.throws(() => buildBatchTx({ sender: PAYER, transfers: [] }), TxError);
  assert.throws(() => buildBatchTx({ sender: PAYER, transfers: [{ id: "x", recipient: R, token: "USDC", amountAtomic: 0n, references: [], createRecipientAta: false }] }), /greater than zero/);
});

test("planBatch: the longest prefix that fits in 1,232 bytes", () => {
  const transfers = Array.from({ length: 20 }, (_, i) => ({
    id: `id${String(i).padStart(10, "0")}`.slice(0, 12), recipient: key(`r ${i}`), token: "USDC" as const, amountAtomic: 1n, references: [key(`ref ${i}`)], createRecipientAta: false,
  }));
  const plan = planBatch(PAYER, transfers);
  assert.ok(plan.count > 1 && plan.count < 20, String(plan.count));
  assert.ok(plan.built.bytes <= MAX_TX_BYTES);
  assert.throws(() => buildBatchTx({ sender: PAYER, transfers: transfers.slice(0, plan.count + 1) }), /don't fit in one Solana transaction/);
  // Without ATA creates more fit than with them.
  const withCreates = planBatch(PAYER, transfers.map((t) => ({ ...t, createRecipientAta: true })));
  assert.ok(withCreates.count < plan.count, `${withCreates.count} < ${plan.count}`);
});
