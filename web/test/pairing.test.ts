import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJsonExact } from "@/lib/solana";
import { allocate, findPayments, pairedCredit, transfersInto, type Credit, type ParsedTransaction, type RawTransaction } from "@/lib/validate";

// F1 pay_all: one transaction pays several requests. Each reference is paired with the transfer instruction that
// carries it, so a request counts exactly its own transfer and a transfer never counts for two requests, including
// two requests to the same recipient for the same amount. The multi-transfer transactions here are built in the
// jsonParsed shape mainnet returns (the real captures below pin that shape), plus the "json" encoding a SOL pair
// needs. The recorded mainnet captures keep their old results (test/find-payments.test.ts, test/validate.test.ts).

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PAYER_ATA = "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi";
const R1 = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const R1_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x";
const R2 = "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD";
const R2_ATA = "Cc1aWeo2zKPxxUnEfKvVVBATZzwDFZp6XtygoiGGZcbo";
const REF_A = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
const REF_B = "Bpo5quLAxFJj2eeQ9DrBGLEK69WwMD9k8ZbUF1aSeby9";
const REF_C = "Ef4piUis5ttTWrkJDeU4hNPDN4MZh4KmonkDHSwgnnTg";
const SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv";
const SIG2 = "3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE";

interface UsdcTransfer { to: string; ata: string; amount: bigint; refs: string[] }

/** A pay_all-style USDC transaction: one transferChecked per request (references as extra accounts), then one memo. */
function usdcTx(transfers: UsdcTransfer[], { sig = SIG, slot = 100, memo = "owed:A owed:B" } = {}): ParsedTransaction {
  const keys = [PAYER, PAYER_ATA, ...new Set(transfers.map((t) => t.ata)), USDC, TOKEN, MEMO, ...new Set(transfers.flatMap((t) => t.refs))];
  const at = (k: string) => keys.indexOf(k);
  const owners = new Map(transfers.map((t) => [t.ata, t.to]));
  const credited = new Map<string, bigint>();
  for (const t of transfers) credited.set(t.ata, (credited.get(t.ata) ?? 0n) + t.amount);
  const total = transfers.reduce((s, t) => s + t.amount, 0n);
  return {
    slot, blockTime: 1_792_300_000,
    meta: {
      err: null, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1),
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: String(total + 1_000_000n) } },
        ...[...owners].map(([ata, owner]) => ({ accountIndex: at(ata), mint: USDC, owner, uiTokenAmount: { amount: "0" } })),
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: PAYER, uiTokenAmount: { amount: "1000000" } },
        ...[...owners].map(([ata, owner]) => ({ accountIndex: at(ata), mint: USDC, owner, uiTokenAmount: { amount: String(credited.get(ata)) } })),
      ],
      innerInstructions: [],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i <= 1 || owners.has(pubkey) })),
        instructions: [
          ...transfers.map((t) => ({
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: t.refs.length
                ? { source: PAYER_ATA, mint: USDC, destination: t.ata, multisigAuthority: PAYER, signers: t.refs, tokenAmount: { amount: String(t.amount), decimals: 6 } }
                : { source: PAYER_ATA, mint: USDC, destination: t.ata, authority: PAYER, tokenAmount: { amount: String(t.amount), decimals: 6 } },
            },
          })),
          { program: "spl-memo", parsed: memo },
        ],
      },
    },
  };
}

interface SolTransfer { to: string; lamports: bigint; refs: string[] }

/** A pay_all-style SOL transaction in both encodings: jsonParsed drops a system transfer's extra accounts. */
function solTx(transfers: SolTransfer[], { sig = SIG2, slot = 200 } = {}): { parsed: ParsedTransaction; raw: RawTransaction } {
  const keys = [PAYER, ...new Set(transfers.map((t) => t.to)), SYSTEM, MEMO, ...new Set(transfers.flatMap((t) => t.refs))];
  const at = (k: string) => keys.indexOf(k);
  const pre = keys.map(() => 10_000_000_000n);
  const post = [...pre];
  for (const t of transfers) {
    post[at(t.to)] += t.lamports;
    post[0] -= t.lamports;
  }
  post[0] -= 5000n;
  return {
    parsed: {
      slot, blockTime: 1_792_300_100,
      meta: { err: null, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
      transaction: {
        signatures: [sig],
        message: {
          accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i === 0 || transfers.some((t) => t.to === pubkey) })),
          instructions: [
            ...transfers.map((t) => ({ program: "system", parsed: { type: "transfer", info: { source: PAYER, destination: t.to, lamports: Number(t.lamports) } } })),
            { program: "spl-memo", parsed: "owed:A owed:B" },
          ],
        },
      },
    },
    raw: {
      meta: { err: null, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] },
      transaction: {
        message: {
          accountKeys: keys,
          instructions: [
            ...transfers.map((t) => ({ programIdIndex: at(SYSTEM), accounts: [0, at(t.to), ...t.refs.map(at)] })),
            { programIdIndex: at(MEMO), accounts: [] },
          ],
        },
      },
    },
  };
}

const target = (reference: string, recipient: string, token: "USDC" | "SOL" = "USDC") => ({ reference, recipient, token });
const asCredit = (c: Credit | null | "raw") => {
  assert.ok(c && c !== "raw", `expected a credit, got ${String(c)}`);
  return c;
};

test("two USDC requests to the same recipient for the same amount, one transaction: each counts its own transfer", () => {
  const tx = usdcTx([{ to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_A] }, { to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_B] }]);
  const a = asCredit(pairedCredit(tx, target(REF_A, R1)));
  const b = asCredit(pairedCredit(tx, target(REF_B, R1)));
  assert.equal(a.amountAtomic, 100_000n, "its own transfer, not the 0.2 USDC net credit");
  assert.equal(b.amountAtomic, 100_000n);
  assert.deepEqual([a.instruction, b.instruction], [0, 1]);
  assert.equal(a.payer, PAYER);
  // Both are paid by the same signature, from different transfers.
  const out = allocate([{ amountAtomic: 100_000n }, { amountAtomic: 100_000n }], [[a], [b]]);
  assert.deepEqual(out.map((o) => [o.status, o.payment?.signature, o.payment?.instruction]), [["paid", SIG, 0], ["paid", SIG, 1]]);
});

test("one transfer carrying two references pays only one of them (QA-03 holds per transfer)", () => {
  const tx = usdcTx([{ to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_A, REF_B] }]);
  const a = asCredit(pairedCredit(tx, target(REF_A, R1)));
  const b = asCredit(pairedCredit(tx, target(REF_B, R1)));
  assert.equal(a.instruction, b.instruction);
  const out = allocate([{ amountAtomic: 100_000n }, { amountAtomic: 100_000n }], [[a], [b]]);
  assert.deepEqual(out.map((o) => o.status).sort(), ["open", "paid"]);
});

test("two recipients in one transaction: each request gets its recipient's transfer", () => {
  const tx = usdcTx([{ to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_A] }, { to: R2, ata: R2_ATA, amount: 250_000n, refs: [REF_B] }]);
  assert.equal(asCredit(pairedCredit(tx, target(REF_A, R1))).amountAtomic, 100_000n);
  assert.equal(asCredit(pairedCredit(tx, target(REF_B, R2))).amountAtomic, 250_000n);
  // A reference that isn't in the transaction at all.
  assert.equal(pairedCredit(tx, target(REF_C, R1)), null);
  // A credit that only shares a recipient's single transfer never takes it from the request whose reference it carries.
  const sharer = asCredit(pairedCredit(tx, target(REF_A, R2)));
  const owner = asCredit(pairedCredit(tx, target(REF_B, R2)));
  assert.equal(sharer.instruction, owner.instruction);
  assert.equal(owner.byReference, true);
  assert.equal(sharer.byReference, undefined);
  for (const order of [[sharer, owner], [owner, sharer]] as const) {
    const out = allocate([{ amountAtomic: 250_000n }, { amountAtomic: 250_000n }], [[order[0]], [order[1]]]);
    assert.deepEqual(out.map((o) => o.payment?.byReference === true ? "owner" : o.status), order[0] === owner ? ["owner", "open"] : ["open", "owner"]);
  }
});

test("an underpaid transfer stays underpaid even when another transfer to the same recipient makes the net credit enough", () => {
  const tx = usdcTx([{ to: R1, ata: R1_ATA, amount: 40_000n, refs: [REF_A] }, { to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_B] }]);
  const out = allocate([{ amountAtomic: 100_000n }, { amountAtomic: 100_000n }], [[asCredit(pairedCredit(tx, target(REF_A, R1)))], [asCredit(pairedCredit(tx, target(REF_B, R1)))]]);
  assert.deepEqual(out.map((o) => [o.status, o.payment?.amountAtomic]), [["underpaid", 40_000n], ["paid", 100_000n]]);
});

test("SOL: two transfers into one wallet need each instruction's accounts; with them each request counts its own", () => {
  const { parsed, raw } = solTx([{ to: R1, lamports: 3_000_000n, refs: [REF_A] }, { to: R1, lamports: 3_000_000n, refs: [REF_B] }]);
  assert.equal(pairedCredit(parsed, target(REF_A, R1, "SOL")), "raw", "jsonParsed hides a system transfer's references");
  const a = asCredit(pairedCredit(parsed, target(REF_A, R1, "SOL"), raw));
  const b = asCredit(pairedCredit(parsed, target(REF_B, R1, "SOL"), raw));
  assert.deepEqual([a.amountAtomic, a.instruction, b.amountAtomic, b.instruction], [3_000_000n, 0, 3_000_000n, 1]);
  // When the second read failed: the whole transaction's net credit, as before F1 (one of the two is paid now).
  const whole = asCredit(pairedCredit(parsed, target(REF_A, R1, "SOL"), null));
  assert.equal(whole.amountAtomic, 6_000_000n);
  assert.equal(whole.instruction, undefined);
});

test("SOL: one transfer per recipient needs no second read", () => {
  const { parsed } = solTx([{ to: R1, lamports: 3_000_000n, refs: [REF_A] }, { to: R2, lamports: 5_000_000n, refs: [REF_B] }]);
  const a = asCredit(pairedCredit(parsed, target(REF_A, R1, "SOL")));
  const b = asCredit(pairedCredit(parsed, target(REF_B, R2, "SOL")));
  assert.deepEqual([a.amountAtomic, a.instruction, b.amountAtomic, b.instruction], [3_000_000n, 0, 5_000_000n, 1]);
  assert.equal(transfersInto(parsed, R1, "SOL")[0]!.refs, null);
});

test("a single transfer whose reference rides on another instruction keeps the old rule (paired with that transfer)", () => {
  const tx = usdcTx([{ to: R1, ata: R1_ATA, amount: 100_000n, refs: [] }]);
  // The reference is somewhere in the transaction (here: a memo signer slot), not on the transfer.
  tx.transaction.message.accountKeys.push({ pubkey: REF_A, signer: false, writable: false });
  const a = asCredit(pairedCredit(tx, target(REF_A, R1)));
  assert.deepEqual([a.amountAtomic, a.instruction], [100_000n, 0]);
});

const load = (name: string) =>
  (parseJsonExact(readFileSync(new URL(`fixtures/mainnet/${name}`, import.meta.url), "utf8")) as { result: ParsedTransaction }).result;

test("real mainnet captures pair the way the old rule credited them", () => {
  const usdcTx5 = load("usdc-5-to-team-ata-created.json");
  const credit = asCredit(pairedCredit(usdcTx5, target("DeJBGdMFa1uynnnKiwrVioatTuHmNLpyFKnmB5kaFdzQ", R1)));
  assert.equal(credit.amountAtomic, 5_000_000n);
  // Its stand-in reference rides on another instruction, and its wallet appended the owner as an extra signer of the
  // transferChecked: the one transfer into the recipient is still the payment (the old rule), now paired with it.
  assert.equal(credit.instruction, 4);
  assert.equal(credit.payer, "GSWhsLLNRj3D4XbtMaghk1UHoPa2CNqsctX28jYK8dcD");
  const sol = load("sol-0.05-to-team.json");
  const solCredit = asCredit(pairedCredit(sol, target(SYSTEM, R1, "SOL")));
  assert.equal(solCredit.amountAtomic, 50_000_000n);
});

// ---- findPayments end to end: one transaction, two requests, a stored claim, and the SOL second read ----

async function onChain<T>(txs: Array<{ refs: string[]; parsed: ParsedTransaction; raw?: RawTransaction }>, fn: (log: string[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const log: string[] = [];
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body));
    const answer = (m: { id: number; method: string; params: [string, { encoding?: string }] }) => {
      if (m.method === "getSignaturesForAddress") {
        const list = txs.filter((t) => t.refs.includes(m.params[0]));
        return { jsonrpc: "2.0", id: m.id, result: list.map((t) => ({ signature: t.parsed.transaction.signatures[0], err: null, slot: t.parsed.slot })) };
      }
      const t = txs.find((x) => x.parsed.transaction.signatures[0] === m.params[0]);
      log.push(`tx ${m.params[1].encoding}`);
      return { jsonrpc: "2.0", id: m.id, result: t ? (m.params[1].encoding === "json" ? t.raw ?? null : t.parsed) : null };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body), (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  }) as typeof fetch;
  try {
    return await fn(log);
  } finally {
    globalThis.fetch = real;
  }
}
const RPC = { urls: ["https://rpc.example"] };

test("findPayments: both same-amount requests are paid by the one pay_all transaction", async () => {
  const tx = usdcTx([{ to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_A] }, { to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_B] }]);
  await onChain([{ refs: [REF_A, REF_B], parsed: tx }], async (log) => {
    const [a, b] = await findPayments([
      { ...target(REF_A, R1), amountAtomic: 100_000n, requestId: "requestA" },
      { ...target(REF_B, R1), amountAtomic: 100_000n, requestId: "requestB" },
    ], RPC);
    assert.deepEqual([a.status, a.payment?.instruction, b.status, b.payment?.instruction], ["paid", 0, "paid", 1]);
    assert.deepEqual(log, ["tx jsonParsed"], "the shared transaction is read once");
  });
});

test("findPayments: a request whose transfer is already stored for it keeps it; the other request still gets its own", async () => {
  const tx = usdcTx([{ to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_A] }, { to: R1, ata: R1_ATA, amount: 100_000n, refs: [REF_B] }]);
  await onChain([{ refs: [REF_A, REF_B], parsed: tx }], async () => {
    const claimedUnits = async () => new Map([[SIG, [{ requestId: "requestA", instruction: 0 }]]]);
    const [b] = await findPayments([{ ...target(REF_B, R1), amountAtomic: 100_000n, requestId: "requestB" }], RPC, { claimedUnits });
    assert.deepEqual([b.status, b.payment?.instruction], ["paid", 1]);
    // A transfer another request already counts is never counted again.
    const taken = async () => new Map([[SIG, [{ requestId: "requestX", instruction: 1 }]]]);
    const [again] = await findPayments([{ ...target(REF_B, R1), amountAtomic: 100_000n, requestId: "requestB" }], RPC, { claimedUnits: taken });
    assert.equal(again.status, "open");
    // A transaction stored as a whole (before 0017) still blocks everyone else, as before.
    const whole = async () => new Map([[SIG, [{ requestId: "requestX", instruction: null }]]]);
    const [blocked] = await findPayments([{ ...target(REF_B, R1), amountAtomic: 100_000n, requestId: "requestB" }], RPC, { claimedUnits: whole });
    assert.equal(blocked.status, "open");
  });
});

test("findPayments: two SOL transfers into one wallet are read once more, then paired", async () => {
  const { parsed, raw } = solTx([{ to: R1, lamports: 3_000_000n, refs: [REF_A] }, { to: R1, lamports: 3_000_000n, refs: [REF_B] }]);
  await onChain([{ refs: [REF_A, REF_B], parsed, raw }], async (log) => {
    const [a, b] = await findPayments([
      { ...target(REF_A, R1, "SOL"), amountAtomic: 3_000_000n, requestId: "a" },
      { ...target(REF_B, R1, "SOL"), amountAtomic: 3_000_000n, requestId: "b" },
    ], RPC);
    assert.deepEqual([a.status, a.payment?.amountAtomic, b.status, b.payment?.amountAtomic], ["paid", 3_000_000n, "paid", 3_000_000n]);
    assert.deepEqual(log, ["tx jsonParsed", "tx json"]);
  });
});

test("findPayments: when the second read fails, the SOL pair falls back to one payment for the whole transaction", async () => {
  const { parsed } = solTx([{ to: R1, lamports: 3_000_000n, refs: [REF_A] }, { to: R1, lamports: 3_000_000n, refs: [REF_B] }]);
  await onChain([{ refs: [REF_A, REF_B], parsed }], async () => {
    const out = await findPayments([
      { ...target(REF_A, R1, "SOL"), amountAtomic: 3_000_000n, requestId: "a" },
      { ...target(REF_B, R1, "SOL"), amountAtomic: 3_000_000n, requestId: "b" },
    ], RPC);
    assert.deepEqual(out.map((o) => o.status).sort(), ["open", "paid"]);
  });
});
