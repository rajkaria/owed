// Owned by sprint W1-B (tx + chain). Signatures are fixed; bodies are filled by the sprint.
export interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** JSON-RPC over fetch; tries urls in order; 3 s timeout per url by default. */
export function makeRpc(urls: string[], timeoutMs = 3000): Rpc {
  void urls; void timeoutMs;
  throw new Error("not implemented: makeRpc");
}

export interface PaymentCheck {
  status: "open" | "paid" | "underpaid";
  signature?: string;
  payer?: string;
  amountPaidAtomic?: bigint;
  paidAt?: string;
}

export async function findPayment(
  rpc: Rpc,
  q: { reference: string; recipient: string; token: "USDC" | "SOL"; amountAtomic: bigint },
): Promise<PaymentCheck> {
  void rpc; void q;
  throw new Error("not implemented: findPayment");
}

export async function payerReadiness(
  rpc: Rpc,
  q: { sender: string; recipient: string; token: "USDC" | "SOL"; amountAtomic: bigint },
): Promise<{ ok: boolean; reason?: string; recipientAtaExists: boolean }> {
  void rpc; void q;
  throw new Error("not implemented: payerReadiness");
}

export const DEFAULT_RPC_URLS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];
