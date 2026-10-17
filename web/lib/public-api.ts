import "server-only";
import { isRequestId } from "./ids";
import { chainCheckable, getRequest, settleFromChain, toPublic } from "./requests";
import type { FiatQuote } from "./fiat";

// Owned by sprint W1-D (web-api). Signatures are fixed so W1-E (pages) can build in parallel.
// Shapes match contract/fixtures/get-request.res.json and status.res.json.

// W3-C: "expired" is computed on read once expires_at has passed (lib/requests.ts EFFECTIVE_STATUS).
export type RequestStatus = "open" | "paid" | "underpaid" | "cancelled" | "expired";

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
  /** W3-B: null on Base requests (they pay through pay_url, an EIP-681 link). */
  solana_pay_url: string | null;
  reference: string;
  x402_url: string | null;
  created_at: string;
  /** rail "matched": the recipient matched a payment that carried no reference (0012); `matched` has the proof. */
  paid: null | { signature: string; payer: string; amount: string; at: string; rail: "solana_pay" | "x402" | "base_transfer" | "matched" | "moonpay_card" };
  flags: string[];
  // W2-H verified payee: the domain that published the recipient in DNS when the request was created.
  from_domain: string | null;
  from_domain_verified_at: string | null;
  // W3-C: when it stops taking payments (null = never), and the recipient's signed cancellation, if any.
  expires_at: string | null;
  cancelled: null | { at: string; signed_message: string; signature: string };
  // W3-B Base requests: the chain the request is paid on, and the link a wallet opens to pay it
  // (the solana: URL, or ethereum:<USDC>@8453/transfer?address=…&uint256=… on Base).
  // Optional in the type so rows built by hand elsewhere (tests, other sprints) still compile; toPublic always sets both.
  chain?: "solana" | "base";
  pay_url?: string;
  // 0012 matched payments. `matched`: a payment without this request's reference that the recipient's own wallet
  // attributed to it with a signed message (covers "full" = it paid the request, "rest" = it paid what an
  // underpaid request still owed). Never shown like a referenced payment. `rest_of` / `rest_request`: the
  // follow-up request for the rest of an underpaid one, both ways. Optional like chain above.
  matched?: null | {
    signature: string;
    covers: "full" | "rest";
    payer: string;
    amount: string;
    at: string;
    confirmed_by: string;
    confirmed_at: string;
    signed_message: string;
    message_signature: string;
  };
  rest_of?: string | null;
  rest_request?: null | { id: string; status: RequestStatus; link?: string };
  /** Local-currency asks: the quote that locked `amount` (USDC). Display only; absent on USDC/SOL asks. */
  fiat?: FiatQuote;
  // W3-S: the SNS name that pointed to recipient at creation (lib/sns.ts). Optional for rows built by hand.
  sns_name?: string | null;
  sns_source?: "sol_record_v2" | "sol_record_v1" | "owner" | null;
  sns_resolved_at?: string | null;
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
  if (chainCheckable(row.status)) { // W3-C: expired and cancelled requests may still have been paid
    try {
      [row] = await settleFromChain([row], { deadline: Date.now() + PAGE_CHAIN_BUDGET_MS, timeoutMs: PAGE_CHAIN_BUDGET_MS });
    } catch {
      // Render the stored state; the page's status polling settles it.
    }
  }
  return toPublic(row);
}
