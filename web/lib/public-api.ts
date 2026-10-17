// Owned by sprint W1-D (web-api). Signatures are fixed so W1-E (pages) can build in parallel.
// Shapes match contract/fixtures/get-request.res.json and status.res.json.

export type RequestStatus = "open" | "paid" | "underpaid" | "cancelled";

export interface PublicRequest {
  id: string;
  kind: "single" | "split_share" | "invoice";
  recipient: string;
  amount: string;
  token: "USDC" | "SOL";
  payer_name: string | null;
  for: string | null;
  note: string | null;
  requester_name: string | null;
  status: RequestStatus;
  solana_pay_url: string;
  reference: string;
  x402_url: string | null;
  created_at: string;
  paid: null | { signature: string; payer: string; amount: string; at: string; rail: "solana_pay" | "x402" };
  flags: string[];
}

/** Server-side read used by pages (no HTTP hop). Returns null when the id doesn't exist. */
export async function getPublicRequest(id: string): Promise<PublicRequest | null> {
  void id;
  throw new Error("not implemented: getPublicRequest (W1-D)");
}
