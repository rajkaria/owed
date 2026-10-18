// Owned by sprint W1-B (tx + chain). Builds the unsigned Solana Pay transfer that PayBox signs.
//
// Layout (SPEC §4, PayBox validation spike variant A): legacy tx, fee payer = sender, placeholder
// blockhash (PayBox sets the real one), then
//   1. createAssociatedTokenAccountIdempotent for the recipient (USDC, only when asked),
//   2. SPL Memo (only when the link carries a memo; Solana Pay puts it right before the transfer),
//   3. transferChecked (USDC) or SystemProgram.transfer (SOL), every reference appended as a
//      read-only non-signer.
// The spike's Validate result for A is still pending funding (docs/FACTS.md). Variant B (no account
// create) is `createRecipientAta: false`; variant C (no memo) is a request without `memo`.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TOKENS, U64_MAX, USDC_MINT } from "./money.js";
import type { TransferRequest } from "./solana-pay.js";

export interface BuildInput {
  sender: string;
  request: TransferRequest;
  token: "USDC" | "SOL";
  amountAtomic: bigint;
  createRecipientAta: boolean;
}

/** Message is shown to the user verbatim. */
export class TxError extends Error {}

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Solana Pay: "Leave blank to have the wallet set it". PayBox replaces it before signing. */
export const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";
/** Solana packet data limit for a serialized transaction. */
export const MAX_TX_BYTES = 1232;
const TOO_BIG = "This payment does not fit in one Solana transaction (limit 1,232 bytes). The memo is probably too long.";

export function buildTransferTx(i: BuildInput): { transactionBase64: string; bytes: number; instructions: string[] } {
  if (i.amountAtomic <= 0n) throw new TxError("The amount must be greater than zero.");
  if (i.amountAtomic > U64_MAX) throw new TxError("The amount is too large to send.");
  if (i.token === "USDC" && i.request.splToken !== USDC_MINT) {
    throw new TxError("This link is not a USDC request, so it cannot be paid in USDC.");
  }
  if (i.token === "SOL" && i.request.splToken !== undefined) {
    throw new TxError("This link asks for a token, so it cannot be paid in SOL.");
  }

  const sender = key(i.sender, "sender");
  // A fee payer must sign, and only on-curve keys have a private key.
  if (!PublicKey.isOnCurve(sender.toBytes())) {
    throw new TxError("The sender address is a program account and cannot sign a payment.");
  }
  // Recipients may be off-curve: a multisig vault or other program wallet is a valid payee.
  const recipient = key(i.request.recipient, "recipient");
  const references = i.request.references.map((r) => key(r, "reference"));

  const tx = new Transaction({ feePayer: sender, recentBlockhash: PLACEHOLDER_BLOCKHASH });
  const names: string[] = [];

  let transfer: TransactionInstruction;
  if (i.token === "USDC") {
    const mint = new PublicKey(USDC_MINT);
    const senderAta = getAssociatedTokenAddressSync(mint, sender);
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient, true);
    if (i.createRecipientAta) {
      tx.add(createAssociatedTokenAccountIdempotentInstruction(sender, recipientAta, recipient, mint));
      names.push("Create the recipient's USDC account if missing");
    }
    transfer = createTransferCheckedInstruction(senderAta, mint, recipientAta, sender, i.amountAtomic, TOKENS.USDC.decimals);
  } else {
    transfer = SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports: i.amountAtomic });
  }

  if (i.request.memo !== undefined) {
    tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(i.request.memo, "utf8") }));
    names.push("Attach memo");
  }

  for (const pubkey of references) transfer.keys.push({ pubkey, isSigner: false, isWritable: false });
  tx.add(transfer);
  names.push(i.token === "USDC" ? "Send USDC" : "Send SOL");

  let raw: Buffer;
  try {
    raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  } catch {
    // web3.js refuses to serialize past the packet limit.
    throw new TxError(TOO_BIG);
  }
  if (raw.length > MAX_TX_BYTES) {
    throw new TxError(TOO_BIG);
  }
  const transactionBase64 = raw.toString("base64");
  if (Buffer.from(transactionBase64, "base64").toString("base64") !== transactionBase64) {
    throw new Error("transaction base64 is not canonical");
  }
  return { transactionBase64, bytes: raw.length, instructions: names };
}

function key(value: string, role: "sender" | "recipient" | "reference"): PublicKey {
  try {
    const k = new PublicKey(value);
    if (k.toBase58() === value) return k;
  } catch {
    // fall through to the plain-sentence error
  }
  throw new TxError(`The ${role} is not a valid Solana address.`);
}

// ---------------------------------------------------------------------------------------------
// F1 pay_all: several requests in ONE legacy transaction. Per request, in order: the recipient's USDC account
// (created idempotently, once per recipient, only when missing), then transferChecked (USDC) or SystemProgram.transfer
// (SOL) with that request's references appended as read-only non-signers, exactly as buildTransferTx does for one.
// Then one memo listing every request's "owed:<id>". Each reference rides on its own transfer, so Owed's paid check
// pairs every request with the instruction that carries its reference (web/lib/validate.ts, chain.ts pairedAmount).

export interface BatchTransfer {
  id: string;
  recipient: string;
  token: "USDC" | "SOL";
  amountAtomic: bigint;
  references: string[];
  /** Open the recipient's USDC account first (only the first transfer to a recipient opens it). */
  createRecipientAta: boolean;
}

export const BATCH_MEMO_PREFIX = "owed:";

/** "owed:a owed:b" for the ids in the transaction. */
export function batchMemo(ids: readonly string[]): string {
  return ids.map((id) => `${BATCH_MEMO_PREFIX}${id}`).join(" ");
}

export function buildBatchTx(i: { sender: string; transfers: readonly BatchTransfer[] }): { transactionBase64: string; bytes: number; instructions: string[] } {
  if (i.transfers.length === 0) throw new TxError("There is nothing to pay.");
  const sender = key(i.sender, "sender");
  if (!PublicKey.isOnCurve(sender.toBytes())) throw new TxError("The sender address is a program account and cannot sign a payment.");
  const tx = new Transaction({ feePayer: sender, recentBlockhash: PLACEHOLDER_BLOCKHASH });
  const names: string[] = [];
  const mint = new PublicKey(USDC_MINT);
  const opened = new Set<string>();
  for (const t of i.transfers) {
    if (t.amountAtomic <= 0n) throw new TxError("The amount must be greater than zero.");
    if (t.amountAtomic > U64_MAX) throw new TxError("The amount is too large to send.");
    const recipient = key(t.recipient, "recipient");
    const references = t.references.map((r) => key(r, "reference"));
    let transfer: TransactionInstruction;
    if (t.token === "USDC") {
      const senderAta = getAssociatedTokenAddressSync(mint, sender);
      const recipientAta = getAssociatedTokenAddressSync(mint, recipient, true);
      if (t.createRecipientAta && !opened.has(t.recipient)) {
        tx.add(createAssociatedTokenAccountIdempotentInstruction(sender, recipientAta, recipient, mint));
        names.push("Create the recipient's USDC account if missing");
        opened.add(t.recipient);
      }
      transfer = createTransferCheckedInstruction(senderAta, mint, recipientAta, sender, t.amountAtomic, TOKENS.USDC.decimals);
    } else {
      transfer = SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports: t.amountAtomic });
    }
    for (const pubkey of references) transfer.keys.push({ pubkey, isSigner: false, isWritable: false });
    tx.add(transfer);
    names.push(t.token === "USDC" ? "Send USDC" : "Send SOL");
  }
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(batchMemo(i.transfers.map((t) => t.id)), "utf8") }));
  names.push("Attach memo");
  let raw: Buffer;
  try {
    raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  } catch {
    throw new TxError(BATCH_TOO_BIG);
  }
  if (raw.length > MAX_TX_BYTES) throw new TxError(BATCH_TOO_BIG);
  const transactionBase64 = raw.toString("base64");
  if (Buffer.from(transactionBase64, "base64").toString("base64") !== transactionBase64) throw new Error("transaction base64 is not canonical");
  return { transactionBase64, bytes: raw.length, instructions: names };
}

const BATCH_TOO_BIG = "These payments don't fit in one Solana transaction (limit 1,232 bytes).";

/**
 * The longest prefix of `transfers` that fits in one transaction (≤ 1,232 bytes), built. pay_all proposes it and
 * names the rest for the next call. Throws TxError when not even the first one fits.
 */
export function planBatch(sender: string, transfers: readonly BatchTransfer[]): { built: ReturnType<typeof buildBatchTx>; count: number } {
  let best: { built: ReturnType<typeof buildBatchTx>; count: number } | null = null;
  for (let n = 1; n <= transfers.length; n++) {
    try {
      best = { built: buildBatchTx({ sender, transfers: transfers.slice(0, n) }), count: n };
    } catch (error) {
      if (error instanceof TxError && error.message === BATCH_TOO_BIG && best) break;
      throw error;
    }
  }
  return best!;
}
