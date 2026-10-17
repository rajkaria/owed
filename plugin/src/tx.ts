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
import { TOKENS, USDC_MINT } from "./money.js";
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
const U64_MAX = 2n ** 64n - 1n;
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
