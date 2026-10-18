import { confirmEmailSubscription, TOKEN } from "@/lib/alerts/subscribe";
import { AlertTokenBody } from "@/lib/contract";
import { baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

/**
 * GET /api/v1/alerts/confirm?token=… — changes nothing: it sends the browser (303) to /alerts/confirm, where the
 * address owner presses Confirm. Mail scanners that open every link therefore can't turn alerts on for anyone.
 */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const target = new URL("/alerts/confirm", baseUrl(req));
  if (TOKEN.test(token)) target.searchParams.set("token", token);
  return new Response(null, { status: 303, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
}

/** POST /api/v1/alerts/confirm {token} — turns a pending email subscription on (idempotent). */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = AlertTokenBody.parse(await readJson(req));
    return json(await confirmEmailSubscription(body, clientIp(req)));
  } catch (e) {
    return toErrorResponse(e);
  }
}
