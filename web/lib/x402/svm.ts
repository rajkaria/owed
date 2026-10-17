import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { fromAtomic } from "../money";
import { USDC_MINT, type Terms } from "./wire";

// A local read of the payer's signed x402 transaction, before any facilitator call.
// The facilitator re-checks all of this, and settlement is only trusted once the chain
// shows the credit (chain.ts). This catches a tampered amount, mint or recipient early.

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TRANSFER_CHECKED = 12;
const USDC_DECIMALS = 6;

export interface InspectedTx {
  /** Account 0: the facilitator, which co-signs and pays the network fee. */
  feePayer: string;
  /** The single top-level transferChecked, or null if it can't be read statically (e.g. lookup tables, smart wallets). */
  transfer: { mint: string; destination: string; authority: string; amountAtomic: bigint; decimals: number } | null;
  transferCount: number;
}

export function inspectTransaction(base64: string): InspectedTx | string {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  } catch {
    return "payment transaction could not be decoded";
  }
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const key = (i: number) => keys[i];
  let transferCount = 0;
  let transfer: InspectedTx["transfer"] = null;
  for (const ix of msg.compiledInstructions) {
    const program = key(ix.programIdIndex);
    if (program !== TOKEN_PROGRAM_ID.toBase58() && program !== TOKEN_2022) continue;
    const data = ix.data;
    if (data.length < 10 || data[0] !== TRANSFER_CHECKED) continue;
    transferCount++;
    const [source, mint, destination, authority] = ix.accountKeyIndexes.map(key);
    if (source === undefined || mint === undefined || destination === undefined || authority === undefined) continue;
    const amountAtomic = Buffer.from(data.subarray(1, 9)).readBigUInt64LE(0);
    transfer = { mint, destination, authority, amountAtomic, decimals: data[9] };
  }
  return { feePayer: keys[0], transfer: transferCount === 1 ? transfer : null, transferCount };
}

export function recipientUsdcAccount(recipient: string): string {
  return getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), new PublicKey(recipient), true).toBase58();
}

/**
 * Why this transaction can't pay these terms, or null if it can (as far as a static read
 * shows). A transaction we can't read statically is left to the facilitator.
 */
export function transactionMismatch(tx: InspectedTx, t: Terms): string | null {
  if (tx.transferCount > 1) return "payment transaction has more than one token transfer";
  const tr = tx.transfer;
  if (!tr) return null;
  if (tr.mint !== USDC_MINT) return "payment transaction does not send USDC";
  if (tr.decimals !== USDC_DECIMALS) return "payment transaction has the wrong USDC decimals";
  if (tr.destination !== recipientUsdcAccount(t.recipient)) return "payment transaction does not pay this request's recipient";
  if (tr.amountAtomic !== t.amountAtomic) {
    return `payment transaction sends ${fromAtomic(tr.amountAtomic, "USDC")} USDC; this request is ${fromAtomic(t.amountAtomic, "USDC")} USDC`;
  }
  if (tr.authority === tx.feePayer) return "payment transaction moves the fee payer's own funds";
  return null;
}
