import { errorResponse, json } from "@/lib/http";
import { bankRailConfig, parseEnterpriseEvent, verifyEnterpriseSignature } from "@/lib/moonpay/enterprise";
import { defer } from "@/lib/notify/defer";

export const runtime = "nodejs";
// The chain check runs after the 2xx (MoonPay Enterprise wants an answer within 5 s) and may wait for the payout.
export const maxDuration = 60;

const MAX_BODY_BYTES = 100_000;

/**
 * POST /api/hooks/moonpay-enterprise — F3 bank rail: a MoonPay Enterprise webhook. 404 while OWED_BANK_RAIL is off.
 * Verifies webhook-signature ("v1=<hex HMAC-SHA256 of webhook-timestamp + raw body>", keyed with the whsec_ secret,
 * 5-minute window; https://dev.enterprise.moonpay.com/webhooks.md), answers at once, then for `transaction` and
 * `transaction_status` events reads the transaction back from MoonPay and settles at most one open invoice of the
 * recipient's, only after the chain shows MoonPay's USDC payout (lib/moonpay/bank.ts). Every other event is
 * acknowledged and dropped. The body itself never marks anything.
 */
export async function POST(req: Request): Promise<Response> {
  const config = bankRailConfig();
  if (!config) return errorResponse("not_found", "not found");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  const ok = verifyEnterpriseSignature({
    timestamp: req.headers.get("webhook-timestamp"),
    signature: req.headers.get("webhook-signature"),
    rawBody: text,
    secret: config.webhookSecret,
  });
  if (!ok) return json({ error: { code: "unauthorized", message: "missing or wrong webhook-signature" } }, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse("invalid_input", "body must be JSON");
  }
  const event = parseEnterpriseEvent(body);
  if (!event) return json({ received: false });
  defer("MoonPay Enterprise transaction", async () => {
    const { processEnterpriseEvent } = await import("@/lib/moonpay/bank");
    const outcome = await processEnterpriseEvent(event);
    if (outcome.kind === "ignored") console.warn(`moonpay enterprise ${event.transactionId}: ${outcome.reason}`);
  });
  return json({ received: true });
}
