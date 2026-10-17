// The decoder is checked against @solana/web3.js and @solana/spl-token (the plugin's pinned versions) building the
// exact SPEC §4 layout, so a disagreement means our decoder is wrong, not the library.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { TEAM_WALLET, USDC_MINT } from "../../contract/shapes.mjs";
import { decodeTransaction, inspectProposal, PLACEHOLDER_BLOCKHASH, PROPOSAL_KEY } from "../lib/solana-tx.mjs";

const require = createRequire(new URL("../../plugin/package.json", import.meta.url));
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const { PublicKey, SystemProgram, Transaction, TransactionInstruction } = web3;

const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const sender = new PublicKey(TEAM_WALLET);
const recipient = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const reference = new PublicKey("8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e");
const mint = new PublicKey(USDC_MINT);
const ataFor = (owner, mintAddress) => spl.getAssociatedTokenAddressSync(new PublicKey(mintAddress), new PublicKey(owner)).toBase58();

function usdcTx({ amount = 10_000n, createAta = true, memo = "owed:7Gh2kQpXa9", referenceWritable = false } = {}) {
  const source = spl.getAssociatedTokenAddressSync(mint, sender);
  const destination = spl.getAssociatedTokenAddressSync(mint, recipient);
  const tx = new Transaction({ feePayer: sender, recentBlockhash: PLACEHOLDER_BLOCKHASH });
  if (createAta) tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(sender, destination, recipient, mint));
  if (memo) tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(memo, "utf8") }));
  const transfer = spl.createTransferCheckedInstruction(source, mint, destination, sender, amount, 6);
  transfer.keys.push({ pubkey: reference, isSigner: false, isWritable: referenceWritable });
  tx.add(transfer);
  return tx;
}

const serialize = (tx) => tx.serialize({ requireAllSignatures: false, verifySignatures: false });
const proposalOf = (bytes, expiresAt = new Date(Date.now() + 240_000).toISOString().replace(/\.\d{3}Z$/, "Z")) => ({
  [PROPOSAL_KEY]: { version: "1", expiresAt, kind: "solana", chain: "solana:mainnet", transaction: { transactionBase64: Buffer.from(bytes).toString("base64") } },
});
const expected = { recipient: recipient.toBase58(), amount: "0.01", token: "USDC", splToken: USDC_MINT, references: [reference.toBase58()], memo: "owed:7Gh2kQpXa9" };

test("decoder agrees with web3.js on keys, flags, blockhash and instructions", () => {
  const tx = usdcTx();
  const bytes = serialize(tx);
  const decoded = decodeTransaction(bytes);
  const message = tx.compileMessage();
  assert.equal(decoded.size, bytes.length);
  assert.equal(decoded.unsigned, true);
  assert.deepEqual(decoded.header, {
    requiredSignatures: message.header.numRequiredSignatures,
    readonlySigned: message.header.numReadonlySignedAccounts,
    readonlyUnsigned: message.header.numReadonlyUnsignedAccounts,
  });
  assert.deepEqual(decoded.accounts.map((account) => account.address), message.accountKeys.map((key) => key.toBase58()));
  decoded.accounts.forEach((account, index) => {
    assert.equal(account.signer, message.isAccountSigner(index), `signer flag of ${index}`);
    assert.equal(account.writable, message.isAccountWritable(index), `writable flag of ${index}`);
  });
  assert.equal(decoded.blockhash, PLACEHOLDER_BLOCKHASH);
  assert.deepEqual(decoded.instructions.map((ix) => ix.programName), ["AssociatedToken", "Memo", "Token"]);
  decoded.instructions.forEach((ix, index) => assert.deepEqual(Buffer.from(ix.data), Buffer.from(tx.instructions[index].data)));
});

test("a correct USDC proposal passes and summarizes what it pays", () => {
  const { errors, warnings, summary } = inspectProposal(proposalOf(serialize(usdcTx())), { sender: TEAM_WALLET, expected, ataFor });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(summary.transfer.token, "USDC");
  assert.equal(summary.transfer.amount, "0.01");
  assert.equal(summary.transfer.atomic, "10000");
  assert.equal(summary.transfer.destinationOwner, recipient.toBase58());
  assert.deepEqual(summary.transfer.references, [reference.toBase58()]);
  assert.equal(summary.memo, "owed:7Gh2kQpXa9");
  assert.deepEqual(summary.instructions, ["ata_create_idempotent", "memo", "spl_transfer_checked"]);
});

test("without an ATA create the destination is matched by derivation", () => {
  const { errors, summary } = inspectProposal(proposalOf(serialize(usdcTx({ createAta: false }))), { sender: TEAM_WALLET, expected, ataFor });
  assert.deepEqual(errors, []);
  assert.equal(summary.createsRecipientAta, false);
  assert.equal(summary.transfer.destination, ataFor(recipient.toBase58(), USDC_MINT));
});

test("wrong amount, wrong payer, writable reference, missing memo and stale expiry are caught", () => {
  const run = (tx, options = {}) => inspectProposal(proposalOf(serialize(tx), options.expiresAt), { sender: TEAM_WALLET, expected, ataFor, ...options }).errors.join("\n");
  assert.match(run(usdcTx({ amount: 20_000n })), /pays 0\.02 USDC, request is for 0\.01/);
  assert.match(run(usdcTx(), { sender: recipient.toBase58() }), /fee payer .* expected the sender/);
  assert.match(run(usdcTx({ referenceWritable: true })), /must be a read-only non-signer/);
  assert.match(run(usdcTx({ memo: null })), /memo null, request memo is "owed:7Gh2kQpXa9"/);
  assert.match(run(usdcTx(), { expiresAt: "2020-01-01T00:00:00Z" }), /not within the next 5 minutes/);
  assert.match(run(usdcTx(), { expected: { ...expected, recipient: TEAM_WALLET } }), /token account owner/);
});

test("SOL transfers decode with lamports and references", () => {
  const tx = new Transaction({ feePayer: sender, recentBlockhash: PLACEHOLDER_BLOCKHASH });
  const transfer = SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports: 4_500_000_000n });
  transfer.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  tx.add(transfer);
  const solExpected = { recipient: recipient.toBase58(), amount: "4.5", token: "SOL", splToken: null, references: [reference.toBase58()], memo: null };
  const { errors, summary } = inspectProposal(proposalOf(serialize(tx)), { sender: TEAM_WALLET, expected: solExpected });
  assert.deepEqual(errors, []);
  assert.equal(summary.transfer.amount, "4.5");
  assert.equal(summary.transfer.atomic, "4500000000");
  assert.equal(summary.transfer.destination, recipient.toBase58());
});

test("garbage, versioned and oversized transactions are rejected", () => {
  assert.match(inspectProposal(proposalOf(Buffer.from([1, 2, 3]))).errors.join(), /does not decode/);
  const legacy = serialize(usdcTx());
  const signatures = 1 + 64;
  const versioned = Buffer.concat([legacy.subarray(0, signatures), Buffer.from([0x80]), legacy.subarray(signatures)]);
  assert.match(inspectProposal(proposalOf(versioned)).errors.join(), /versioned transaction/);
  assert.match(inspectProposal({ [PROPOSAL_KEY]: { version: "1", expiresAt: "x", kind: "solana", chain: "solana:mainnet", transaction: { transactionBase64: "not base64!" } } }).errors.join(), /canonical/);
  // web3.js refuses to serialize past 1,232 bytes, so build one oversized legacy tx by hand: one memo of 1,200 bytes.
  const oversized = Buffer.concat([
    Buffer.from([1]), Buffer.alloc(64), Buffer.from([1, 0, 1, 2]), sender.toBuffer(), MEMO.toBuffer(), Buffer.alloc(32),
    Buffer.from([1, 1, 0]), Buffer.from([0xb0, 0x09]), Buffer.alloc(1200, 97),
  ]);
  const result = inspectProposal(proposalOf(oversized), { sender: TEAM_WALLET });
  assert.match(result.errors.join(), /1370 bytes > 1232/);
  assert.match(result.errors.join(), /0 transfer instructions/);
});
