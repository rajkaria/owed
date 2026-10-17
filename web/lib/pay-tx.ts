import "server-only";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TOKENS, USDC_MINT } from "./money";
import type { RequestRow } from "./requests";

// Solana Pay transaction requests (https://docs.solanapay.com/spec#specification-transaction-request).
// Phantom's QR scanner and solana: deep links turn a *transfer* request into a plain Send and drop
// its `reference` and `memo`, so Owed could never match the payment (W2-C, 2026-10-17: tx 5LPHMN…).
// With a transaction request the wallet asks this server for the transaction and only signs it, so
// the reference is in the transaction by construction. Same layout as the plugin's tx.ts (W1-B), the
// one PayBox's Validate passed: ATA create (idempotent) + memo + transfer with the reference appended
// as a read-only non-signer.

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const MAX_TX_BYTES = 1232;

/** solana:<https url> for a request id. The URL has no query, so it needs no encoding (spec). */
export function transactionRequestUrl(origin: string, id: string): string {
  return `solana:${origin}/api/v1/pay/${encodeURIComponent(id)}`;
}

/** Message is shown to the payer as-is. */
export class PayTxError extends Error {}

export function payerKey(account: unknown): PublicKey {
  if (typeof account !== "string" || account.length < 32 || account.length > 44) throw new PayTxError("account must be a Solana address");
  let key: PublicKey;
  try {
    key = new PublicKey(account);
  } catch {
    throw new PayTxError("account must be a Solana address");
  }
  if (key.toBase58() !== account) throw new PayTxError("account must be a Solana address");
  // A fee payer signs, and only on-curve keys have a private key.
  if (!PublicKey.isOnCurve(key.toBytes())) throw new PayTxError("This account can't sign a payment.");
  return key;
}

/** The unsigned transaction paying exactly this request, base64, fee payer = the payer. */
export function buildRequestTx(row: RequestRow, payer: PublicKey, recentBlockhash: string): string {
  const recipient = new PublicKey(row.recipient);
  if (payer.equals(recipient)) throw new PayTxError("This wallet is the one being paid. Pay from a different wallet.");
  const reference = new PublicKey(row.reference);
  const tx = new Transaction({ feePayer: payer, recentBlockhash });

  let transfer: TransactionInstruction;
  if (row.token === "USDC") {
    const mint = new PublicKey(USDC_MINT);
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient, true);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, recipientAta, recipient, mint));
    transfer = createTransferCheckedInstruction(
      getAssociatedTokenAddressSync(mint, payer),
      mint,
      recipientAta,
      payer,
      row.amountAtomic,
      TOKENS.USDC.decimals,
    );
  } else {
    transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: row.amountAtomic });
  }
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [], data: Buffer.from(`owed:${row.id}`, "utf8") }));
  transfer.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  tx.add(transfer);

  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (raw.length > MAX_TX_BYTES) throw new PayTxError("This payment doesn't fit in one Solana transaction.");
  return raw.toString("base64");
}
