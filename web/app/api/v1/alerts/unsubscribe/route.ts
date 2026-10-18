import { TOKEN, unsubscribeByToken } from "@/lib/alerts/subscribe";
import { AlertTokenBody } from "@/lib/contract";
import { baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { clientIp } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** GET /api/v1/alerts/unsubscribe?token=… — changes nothing: 303 to the /alerts/unsubscribe page and its button. */
export async function GET(req: Request): Promise<Response> {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  const target = new URL("/alerts/unsubscribe", baseUrl(req));
  if (TOKEN.test(token)) target.searchParams.set("token", token);
  return new Response(null, { status: 303, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
}

/**
 * POST /api/v1/alerts/unsubscribe — turns off the subscription an alert email's token belongs to. Takes {token} as
 * JSON (the /alerts/unsubscribe page), or ?token=… in the URL with any body: that is the List-Unsubscribe URL every
 * alert email carries, and mail apps POST "List-Unsubscribe=One-Click" to it (RFC 8058). Idempotent.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const fromUrl = new URL(req.url).searchParams.get("token");
    const body = AlertTokenBody.parse(fromUrl !== null ? { token: fromUrl } : await readJson(req));
    return json(await unsubscribeByToken(body, clientIp(req)));
  } catch (e) {
    return toErrorResponse(e);
  }
}
