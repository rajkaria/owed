import { baseUrl } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { cardLimits } from "@/lib/moonpay/client";
import { moonpayConfig } from "@/lib/moonpay/config";
import { cardEligibility } from "@/lib/moonpay/eligibility";
import { store } from "@/lib/moonpay/store";
import { signedWidgetUrl } from "@/lib/moonpay/widget";
import { clientIp, take } from "@/lib/ratelimit";
import { getRequest, settleFromChain } from "@/lib/requests";
import { fromAtomic } from "@/lib/money";

export const runtime = "nodejs";

/** Widget URLs a client may have signed: generous for a person retrying, small for a script. */
const LIMIT = { perIp: 30, perRequest: 60, windowSeconds: 600 } as const;

function page(status: number, message: string, back: string | null): Response {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const link = back ? `<p><a href="${esc(back)}">Back to the request</a></p>` : "";
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pay by card</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">Pay by card</h1><p>${esc(message)}</p>${link}</body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } },
  );
}

/**
 * GET /api/moonpay/:id — sends the payer to MoonPay's buy widget for this request: USDC on Solana, the
 * exact amount owed, delivered to the recipient, carrying the request id as externalTransactionId. The URL
 * is signed here with the secret key (and bound to the payer's IP), so the key never reaches a browser.
 * A plain link on the pay page points here; `?back=i` returns the payer to the invoice page instead.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/moonpay/[id]">): Promise<Response> {
  const config = moonpayConfig();
  if (!config) return page(404, "Paying by card isn't available on this site.", null);
  const { id } = await ctx.params;
  if (!isRequestId(id)) return page(404, "There is no request with this id.", null);
  const origin = baseUrl(req);
  const pagePath = `${new URL(req.url).searchParams.get("back") === "i" ? "i" : "r"}/${encodeURIComponent(id)}`;
  const back = `${origin}/${pagePath}`;
  try {
    const ip = clientIp(req);
    const slot = await take([
      { key: `moonpay:ip:${ip}`, max: LIMIT.perIp, windowSeconds: LIMIT.windowSeconds, scope: "ip" },
      { key: `moonpay:request:${id}`, max: LIMIT.perRequest, windowSeconds: LIMIT.windowSeconds, scope: "request" },
    ]);
    if (!slot.allowed) return page(429, "Too many card checkouts were opened from here. Wait a few minutes and try again.", back);

    let row = await getRequest(id);
    if (!row) return page(404, "There is no request with this id.", null);
    // Settle first, so a request paid a moment ago never opens a second purchase.
    try {
      [row] = await settleFromChain([row], { deadline: Date.now() + 2000 });
    } catch {
      // Chain unreachable: the stored state decides.
    }
    const eligible = cardEligibility(row, await cardLimits(config));
    // The pay page explains why when it shows no card button; just send the payer back to it.
    if (!eligible.ok) return new Response(null, { status: 303, headers: { Location: back, "Cache-Control": "no-store" } });

    await store.startCheckout(row.id);
    const location = signedWidgetUrl(config, {
      recipient: row.recipient,
      amount: fromAtomic(row.amountAtomic, "USDC"),
      requestId: row.id,
      redirectUrl: `${back}?card=return`,
      unsupportedRegionUrl: `${back}?card=region`,
      ip: ip === "unknown" ? null : ip,
    });
    return new Response(null, {
      status: 303,
      headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
    });
  } catch (e) {
    console.error(`moonpay checkout ${id}: ${e instanceof Error ? e.message : String(e)}`);
    return page(503, "Paying by card isn't available right now. Try again shortly, or pay with a wallet.", back);
  }
}
