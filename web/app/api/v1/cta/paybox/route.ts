import { isRequestId } from "@/lib/ids";
import { PAYBOX_APP_URL, recordCtaLater } from "@/lib/cta";

export const runtime = "nodejs";

// The pay page's "Create a PayBox account at app.paybox.sh" link (SP1). It always answers 302 to
// app.paybox.sh, at once: the count is written after the response (lib/cta.ts recordCtaLater), so a slow or
// sleeping database never delays the way to PayBox, and a database outage only loses the count.
// No CDN may answer for it (each click must reach the server), and nothing about the visitor is stored.

function toPayBox(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: PAYBOX_APP_URL,
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      // The request id stays on Owed: PayBox sees no referrer from this hop.
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * GET /api/v1/cta/paybox?r=<request id> — counts one paybox_click for a well-formed id of a request that exists
 * (capped per request and per hour), then (always) 302 to app.paybox.sh. A missing, malformed or unknown id counts nothing.
 */
export async function GET(req: Request): Promise<Response> {
  const id = new URL(req.url).searchParams.get("r");
  if (isRequestId(id)) recordCtaLater("paybox_click", id);
  return toPayBox();
}

/** HEAD (link checkers, chat previews): the same redirect, never counted. */
export async function HEAD(): Promise<Response> {
  return toPayBox();
}
