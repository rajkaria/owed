import { parseCtaBody, recordCtaEvent } from "@/lib/cta";
import { ApiError, readJson, toErrorResponse } from "@/lib/http";

export const runtime = "nodejs";

/**
 * POST /api/v1/cta — {"event":"prompt_copy","request":"<id>"}: the pay page's copy button for "Pay this: <link>"
 * (SP1). The page sends it without waiting and never blocks the copy on it. 204 when counted; 400 for any
 * other event or a malformed id (clicks on the PayBox link are counted by GET /api/v1/cta/paybox only); 404 for
 * an unknown request; 429 over the per-request or hourly cap. JSON only, so a cross-site form can't post it.
 * Nothing about the visitor is stored (lib/cta.ts).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") throw new ApiError("invalid_input", "content-type must be application/json");
    const { event, request } = parseCtaBody(await readJson(req));
    const outcome = await recordCtaEvent(event, request);
    if (outcome.kind === "unknown_request") throw new ApiError("not_found", "no request with this id");
    if (outcome.kind === "limited") {
      throw new ApiError("rate_limited", "this request's copies were counted enough for this hour, try again later", {
        "Retry-After": String(outcome.retryAfterSeconds),
      });
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
