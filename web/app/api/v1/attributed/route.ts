import { AttributedBody, type AttributedResponse } from "@/lib/contract";
import { ApiError, json, readJson, toErrorResponse } from "@/lib/http";
import { attributedOf } from "@/lib/match";
import { clientIp, take } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** Lookups per client IP per minute (PayBox's sandboxes share IPs, so this is generous). */
const ATTRIBUTED_LIMITS = { perIp: 60, windowSeconds: 60 } as const;

/**
 * POST /api/v1/attributed — which of these transactions already settle an Owed request (by reference, over x402,
 * or matched by the recipient), and which of these keys are Owed requests' references (0012). match_payments asks
 * before offering a payment without a reference as a candidate. Everything it returns is already public: each
 * request page shows its paying transaction, and a reference is in the request's solana: link.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = AttributedBody.parse(await readJson(req));
    const slot = await take([{ key: `attributed:ip:${clientIp(req)}`, max: ATTRIBUTED_LIMITS.perIp, windowSeconds: ATTRIBUTED_LIMITS.windowSeconds, scope: "ip" }]);
    if (!slot.allowed) {
      throw new ApiError("rate_limited", "too many lookups from this client in the last minute, try again shortly", {
        "Retry-After": String(slot.retryAfterSeconds ?? 60),
      });
    }
    const res: AttributedResponse = await attributedOf([...new Set(body.signatures)], [...new Set(body.keys)]);
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
