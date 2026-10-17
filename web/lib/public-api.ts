import "server-only";
import { isRequestId } from "./ids";
import { getRequest, settleFromChain, toPublic } from "./requests";

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
  // W2-H verified payee: the domain that published the recipient in DNS when the request was created.
  from_domain: string | null;
  from_domain_verified_at: string | null;
}

/** Chain check budget for a page render: a slow RPC never holds the page; client polling takes over. */
const PAGE_CHAIN_BUDGET_MS = 1200;

/**
 * Server-side read used by pages (no HTTP hop). Returns null when the id doesn't exist.
 * An open request is checked against the chain first, so a paid link never renders as payable.
 */
export async function getPublicRequest(id: string): Promise<PublicRequest | null> {
  if (!isRequestId(id)) return null;
  let row = await getRequest(id);
  if (!row) return null;
  if (row.status === "open" || row.status === "underpaid") {
    try {
      [row] = await settleFromChain([row], { deadline: Date.now() + PAGE_CHAIN_BUDGET_MS, timeoutMs: PAGE_CHAIN_BUDGET_MS });
    } catch {
      // Render the stored state; the page's status polling settles it.
    }
  }
  return toPublic(row);
}
