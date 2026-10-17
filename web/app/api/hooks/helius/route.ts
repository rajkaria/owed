import { errorResponse, json } from "@/lib/http";
import { webhookSecret } from "@/lib/notify/config";
import { defer } from "@/lib/notify/defer";
import { authorized, processDelivery, reportedTransactions } from "@/lib/notify/webhook";

export const runtime = "nodejs";
// The re-checks run after the 200 (Helius wants an answer within 1 s) and may wait for the chain.
export const maxDuration = 60;

const MAX_BODY_BYTES = 1_000_000;

/**
 * POST /api/hooks/helius — a Helius webhook delivery (W3-A). Checks the Authorization header against
 * HELIUS_WEBHOOK_SECRET, answers at once, then re-checks on chain every Owed request whose reference
 * key the reported transactions carry, through the normal settle path. The body never marks anything paid.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = webhookSecret();
  if (!secret) return errorResponse("upstream_unavailable", "this deployment has no webhook secret configured");
  if (!authorized(req.headers.get("authorization"), secret)) {
    return json({ error: { code: "unauthorized", message: "missing or wrong Authorization header" } }, { status: 401 });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse("invalid_input", "body must be JSON");
  }
  const txs = reportedTransactions(body);
  if (txs.length) defer("Helius delivery", () => processDelivery(txs));
  return json({ received: txs.length });
}
