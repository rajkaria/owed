import { createSubscription } from "@/lib/alerts/subscribe";
import { CreateAlertBody } from "@/lib/contract";
import { baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * POST /api/v1/alerts — S1 paid alerts. Links a wallet to a Telegram chat (or, when this deployment has email
 * configured, an address) after the wallet signs "Owed alerts for <wallet> at <ISO time>" (PayBox request_wallet_sign
 * {op:"solanaMessage"} or a browser wallet; at most 5 minutes old, each message once). Answers 201 with a pending
 * subscription: a one-time Telegram /start link (15 minutes), or "check your email" (a confirm link, 24 hours).
 * A channel that isn't configured is refused (503) before the signature is spent.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateAlertBody.parse(await readJson(req));
    return json(await createSubscription(body, clientIp(req), baseUrl(req)), { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
