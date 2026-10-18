import { errorResponse, json } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { moonpayConfig, moonpaySellConfig, moonpayWebhookKey } from "@/lib/moonpay/config";
import { isSellWebhook, parseSellWebhook } from "@/lib/moonpay/sell"; // F4 cash out
import { parseWebhookBody, verifyWebhookSignature } from "@/lib/moonpay/transaction";
import { defer } from "@/lib/notify/defer";

export const runtime = "nodejs";
// The on-chain check runs after the 2xx (MoonPay wants an answer within 5 s) and may wait for the chain.
export const maxDuration = 60;

const MAX_BODY_BYTES = 200_000;

/**
 * POST /api/hooks/moonpay — a MoonPay webhook delivery: Buy transactions (pay by card) and Sell transactions (F4 cash
 * out). Checks Moonpay-Signature-V2 against MOONPAY_WEBHOOK_KEY over the raw body (https://dev.moonpay.com/
 * api-reference/widget/webhooks/signature.md), answers at once, then:
 * - Buy (card on): stores MoonPay's report and checks the Solana transaction it names on chain. The body never marks
 *   anything paid by itself: only the chain does (lib/moonpay/attribution.ts).
 * - Sell (cash-out on): records the sale's status on the cash-out it names and, when its currency, amount and refund
 *   wallet match, MoonPay's deposit address for it (lib/moonpay/cash-out.ts). A cash-out never touches a request.
 */
export async function POST(req: Request): Promise<Response> {
  const webhookKey = moonpayWebhookKey();
  if (!webhookKey) return errorResponse("upstream_unavailable", "this deployment has no MoonPay webhook key configured");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  if (!verifyWebhookSignature(req.headers.get("moonpay-signature-v2"), text, webhookKey)) {
    return json({ error: { code: "unauthorized", message: "missing or wrong Moonpay-Signature-V2" } }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse("invalid_input", "body must be JSON");
  }
  // F4 cash out start: Sell events go to the cash-out path only, and only while cash-out is on.
  if (isSellWebhook(body)) {
    const sale = parseSellWebhook(body);
    if (!sale || !moonpaySellConfig()) return json({ received: false });
    try {
      const { ingestSellEvent } = await import("@/lib/moonpay/cash-out");
      const { outcome } = await ingestSellEvent(sale);
      return json({ received: outcome !== "ignored" });
    } catch (e) {
      // A storage failure answers 5xx so MoonPay retries the delivery.
      console.error(`moonpay sell webhook: ${e instanceof Error ? e.message : String(e)}`);
      return errorResponse("upstream_unavailable", "couldn't record this sale update; retry");
    }
  }
  // F4 cash out end
  const tx = parseWebhookBody(body);
  const requestId = tx?.externalTransactionId;
  // Other events (KYC, a purchase that didn't start on an Owed page, card off) are acknowledged and dropped.
  if (!tx || !requestId || !isRequestId(requestId) || !moonpayConfig()) return json({ received: false });
  // Loaded after the answer: the settle path (requests, chain) stays off the cold-start path.
  defer("MoonPay delivery", async () => (await import("@/lib/moonpay/webhook")).processWebhook(tx, requestId));
  return json({ received: true });
}
