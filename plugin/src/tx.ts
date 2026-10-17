// Owned by sprint W1-B (tx + chain). Signatures are fixed; bodies are filled by the sprint.
import type { TransferRequest } from "./solana-pay.js";

export interface BuildInput {
  sender: string;
  request: TransferRequest;
  token: "USDC" | "SOL";
  amountAtomic: bigint;
  createRecipientAta: boolean;
}

export function buildTransferTx(i: BuildInput): { transactionBase64: string; bytes: number; instructions: string[] } {
  void i;
  throw new Error("not implemented: buildTransferTx");
}
