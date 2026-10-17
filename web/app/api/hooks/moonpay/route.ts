import { errorResponse, json } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { moonpayConfig } from "@/lib/moonpay/config";
import { parseWebhookBody, verifyWebhookSignature } from "@/lib/moonpay/transaction";
import { defer } from "@/lib/notify/defer";

export const runtime = "nodejs";
// The on-chain check runs after the 2xx (MoonPay wants an answer within 5 s) and may wait for the chain.
export const maxDuration = 60;

const MAX_BODY_BYTES = 200_000;

/**
 * POST /api/hooks/moonpay — a MoonPay webhook delivery (Buy transaction created / updated / failed).
 * Checks Moonpay-Signature-V2 against MOONPAY_WEBHOOK_KEY over the raw body, answers at once, then
 * stores MoonPay's report and checks the Solana transaction it names on chain. The body never marks
 * anything paid by itself: only the chain does (lib/moonpay/attribution.ts).
 */
export async function POST(req: Request): Promise<Response> {
  const config = moonpayConfig();
  if (!config?.webhookKey) return errorResponse("upstream_unavailable", "this deployment has no MoonPay webhook key configured");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  if (!verifyWebhookSignature(req.headers.get("moonpay-signature-v2"), text, config.webhookKey)) {
    return json({ error: { code: "unauthorized", message: "missing or wrong Moonpay-Signature-V2" } }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse("invalid_input", "body must be JSON");
  }
  const tx = parseWebhookBody(body);
  const requestId = tx?.externalTransactionId;
  // Other events (sell, KYC, a purchase that didn't start on an Owed page) are acknowledged and dropped.
  if (!tx || !requestId || !isRequestId(requestId)) return json({ received: false });
  // Loaded after the answer: the settle path (requests, chain) stays off the cold-start path.
  defer("MoonPay delivery", async () => (await import("@/lib/moonpay/webhook")).processWebhook(tx, requestId));
  return json({ received: true });
}
