import { isCashOutId } from "@/lib/moonpay/cash-out";

export const runtime = "nodejs";

/**
 * GET /cash-out/<id> — where MoonPay's sell widget sends the user back (redirectURL). MoonPay appends the sale id and its
 * deposit details as query parameters (https://dev.moonpay.com/widget/off-ramp/customization/parameters.md); they are
 * ignored on purpose: the deposit address only ever comes from MoonPay's signed webhook and API, through cash_out.
 * Reads nothing, stores nothing: it tells the user what to do next. `?region=1` is MoonPay's unsupported-region return.
 */
export async function GET(req: Request, ctx: RouteContext<"/cash-out/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  const valid = isCashOutId(id);
  const region = new URL(req.url).searchParams.get("region") === "1";
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = !valid
    ? "<p>This isn't a cash-out link.</p>"
    : region
      ? "<p>MoonPay doesn't buy USDC from people where you are, so this cash-out can't go ahead. Nothing was sent. The USDC is still in your wallet.</p>"
      : `<p>Your sale is set up with MoonPay. Nothing has left your wallet yet.</p>
<p>Go back to your agent and ask it to continue your cash-out (<code>cash_out</code> with cash_out_id <code>${esc(id)}</code>). It checks the sale with MoonPay and then asks you to approve one USDC transfer from your wallet to MoonPay with your passkey. MoonPay pays your bank once the transfer lands.</p>
<p>MoonPay needs the USDC within 48 hours of the sale, or it cancels it.</p>`;
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Cash out</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">Cash out</h1>${body}</body>`,
    { status: valid ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" } },
  );
}
