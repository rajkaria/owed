import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { buildTransferTx, type BuildInput } from "../src/tx.ts";
import { proposeSolana } from "../src/paybox.ts";

// Real mainnet keys: the team wallet, plus the payer, payee (a program-derived, off-curve
// address) and reference of SOL payment
// 3XgKY2pjaX4WjV23Fcav1xpQVXWKUQCgbh6RC6abDqP5Tid28LdcUmyarG2jzPPSwHrMuuBr1Ch6Gwn2oCcpaswE.
const SENDER = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
const RECIPIENT = "ASTW3RMbeKoHaU5GUt8E1gXuRnE1gwJky1bLYQiZ4rEg";
const PDA_RECIPIENT = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const REF = "5Q23XrMHYQz9YFiZd3hSW4PveFJLoj2VvNC2SXa2csbV";
const REF2 = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const senderAta = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(SENDER)).toBase58();
const recipientAta = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(RECIPIENT)).toBase58();

function usdc(over: Partial<BuildInput> = {}, request: Partial<BuildInput["request"]> = {}): BuildInput {
  return {
    sender: SENDER,
    token: "USDC",
    amountAtomic: 15_000_000n,
    createRecipientAta: true,
    request: { recipient: RECIPIENT, amount: "15", splToken: USDC, references: [REF], memo: "owed:7Gh2kQpXab", ...request },
    ...over,
  };
}

function sol(over: Partial<BuildInput> = {}, request: Partial<BuildInput["request"]> = {}): BuildInput {
  return {
    sender: SENDER,
    token: "SOL",
    amountAtomic: 3_027_000n,
    createRecipientAta: false,
    request: { recipient: RECIPIENT, amount: "0.003027", references: [REF], ...request },
    ...over,
  };
}

function decode(b64: string) {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  return {
    tx,
    programs: tx.instructions.map((ix) => ix.programId.toBase58()),
    keys: (i: number) => tx.instructions[i]!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  };
}

function u64le(n: bigint) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

test("USDC with recipient account create + memo + reference: spec instruction order", () => {
  const out = buildTransferTx(usdc());
  const { tx, programs, keys } = decode(out.transactionBase64);
  assert.equal(tx.feePayer?.toBase58(), SENDER);
  assert.equal(tx.recentBlockhash, "11111111111111111111111111111111");
  assert.deepEqual(programs, [ATA_PROGRAM, MEMO_PROGRAM, TOKEN_PROGRAM]);
  assert.deepEqual(out.instructions, [
    "Create the recipient's USDC account if missing",
    "Attach memo",
    "Send USDC",
  ]);

  // createAssociatedTokenAccountIdempotent: payer, ata, owner, mint, system, token; data = [1]
  assert.deepEqual(keys(0), [
    [SENDER, true, true],
    [recipientAta, false, true],
    [RECIPIENT, false, false],
    [USDC, false, false],
    [SYSTEM_PROGRAM, false, false],
    [TOKEN_PROGRAM, false, false],
  ]);
  assert.deepEqual([...tx.instructions[0]!.data], [1]);

  // memo: no accounts, UTF-8 data
  assert.deepEqual(keys(1), []);
  assert.equal(tx.instructions[1]!.data.toString("utf8"), "owed:7Gh2kQpXab");

  // transferChecked: source, mint, destination, owner, then the reference read-only non-signer.
  // Decoded flags are per message account, so the owner reads writable: it is also the fee payer.
  assert.deepEqual(keys(2), [
    [senderAta, false, true],
    [USDC, false, false],
    [recipientAta, false, true],
    [SENDER, true, true],
    [REF, false, false],
  ]);
  assert.deepEqual(tx.instructions[2]!.data, Buffer.concat([Buffer.from([12]), u64le(15_000_000n), Buffer.from([6])]));
});

test("USDC without account create (spike variant B) and without memo is a single transferChecked", () => {
  const out = buildTransferTx(usdc({ createRecipientAta: false }, { memo: undefined }));
  const { programs } = decode(out.transactionBase64);
  assert.deepEqual(programs, [TOKEN_PROGRAM]);
  assert.deepEqual(out.instructions, ["Send USDC"]);
});

test("references are appended in order after the transfer accounts", () => {
  const out = buildTransferTx(usdc({ createRecipientAta: false }, { references: [REF, REF2] }));
  const { keys } = decode(out.transactionBase64);
  assert.deepEqual(keys(1).slice(4), [
    [REF, false, false],
    [REF2, false, false],
  ]);
});

test("SOL: SystemProgram.transfer with reference, account-create flag ignored", () => {
  const out = buildTransferTx(sol({ createRecipientAta: true }, { memo: "thanks" }));
  const { tx, programs, keys } = decode(out.transactionBase64);
  assert.equal(tx.feePayer?.toBase58(), SENDER);
  assert.deepEqual(programs, [MEMO_PROGRAM, SYSTEM_PROGRAM]);
  assert.deepEqual(out.instructions, ["Attach memo", "Send SOL"]);
  assert.deepEqual(keys(1), [
    [SENDER, true, true],
    [RECIPIENT, false, true],
    [REF, false, false],
  ]);
  assert.deepEqual(tx.instructions[1]!.data, Buffer.concat([Buffer.from([2, 0, 0, 0]), u64le(3_027_000n)]));
});

test("output is canonical base64, byte count matches, unsigned, within the packet limit", () => {
  const out = buildTransferTx(usdc());
  const raw = Buffer.from(out.transactionBase64, "base64");
  assert.equal(raw.toString("base64"), out.transactionBase64);
  assert.equal(out.bytes, raw.length);
  assert.ok(out.bytes <= 1232);
  const { tx } = decode(out.transactionBase64);
  assert.equal(tx.signatures.length, 1);
  assert.equal(tx.signatures[0]!.signature, null);
});

test("same input builds byte-identical transactions", () => {
  assert.equal(buildTransferTx(usdc()).transactionBase64, buildTransferTx(usdc()).transactionBase64);
});

test("self-transfer (sender pays themselves) still builds", () => {
  const out = buildTransferTx(usdc({}, { recipient: SENDER }));
  assert.equal(decode(out.transactionBase64).programs.length, 3);
});

test("pays an off-curve (program-owned) recipient's USDC account", () => {
  const out = buildTransferTx(usdc({}, { recipient: PDA_RECIPIENT }));
  const pdaAta = getAssociatedTokenAddressSync(new PublicKey(USDC), new PublicKey(PDA_RECIPIENT), true).toBase58();
  const { keys } = decode(out.transactionBase64);
  assert.equal(keys(0)[1]![0], pdaAta);
  assert.equal(keys(2)[2]![0], pdaAta);
});

test("refuses an off-curve sender: it cannot sign", () => {
  assert.throws(() => buildTransferTx(usdc({ sender: PDA_RECIPIENT })), /sign/);
});

test("refuses zero and above-u64 amounts", () => {
  assert.throws(() => buildTransferTx(usdc({ amountAtomic: 0n })), /greater than zero/);
  assert.throws(() => buildTransferTx(usdc({ amountAtomic: -1n })), /greater than zero/);
  assert.throws(() => buildTransferTx(usdc({ amountAtomic: 2n ** 64n })), /too large/);
});

test("refuses a token that disagrees with the link's spl-token", () => {
  assert.throws(() => buildTransferTx(usdc({}, { splToken: undefined })), /USDC/);
  assert.throws(() => buildTransferTx(sol({}, { splToken: USDC })), /SOL/);
  assert.throws(
    () => buildTransferTx(usdc({}, { splToken: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" })),
    /USDC/,
  );
});

test("refuses bad addresses with a plain sentence", () => {
  assert.throws(() => buildTransferTx(usdc({ sender: "not-a-key" })), /sender/);
  assert.throws(() => buildTransferTx(usdc({}, { recipient: "0OIl" })), /recipient/);
  assert.throws(() => buildTransferTx(usdc({}, { references: ["abc"] })), /reference/);
});

test("refuses a transaction over 1,232 bytes", () => {
  assert.throws(() => buildTransferTx(usdc({}, { memo: "x".repeat(1000) })), /1,232/);
});

test("the starter's proposeSolana accepts every built layout unchanged", () => {
  for (const input of [usdc(), usdc({ createRecipientAta: false }), usdc({}, { memo: undefined }), sol()]) {
    const { transactionBase64 } = buildTransferTx(input);
    const out = proposeSolana({ transactionBase64 });
    const proposal = (out.structuredContent as Record<string, unknown>)["io.paybox/transactionProposal"] as {
      kind: string;
      chain: string;
      transaction: { transactionBase64: string };
    };
    assert.equal(proposal.kind, "solana");
    assert.equal(proposal.chain, "solana:mainnet");
    assert.equal(proposal.transaction.transactionBase64, transactionBase64);
  }
});

test("variant A for the spike's 0.01 USDC self-transfer is 399 bytes, as measured in the portal", () => {
  const out = buildTransferTx(usdc({ amountAtomic: 10_000n }, { recipient: SENDER, memo: "owed:spike", references: ["8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e"] }));
  assert.equal(out.bytes, 399);
});
