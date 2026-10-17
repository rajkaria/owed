import { RestBody, type RestResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { askForRest } from "@/lib/match";
import { fromAtomic } from "@/lib/money";
import { requireCreateSlot } from "@/lib/ratelimit";
import { getRequest, payUrl, solanaPayUrl } from "@/lib/requests";
import { x402UrlFor } from "@/lib/x402/url";

export const runtime = "nodejs";

/**
 * POST /api/v1/requests/:id/rest — ask for the rest of an underpaid request (0012). Creates one new request for
 * exactly what is still owed (atomic units: amount minus what arrived), linked both ways (rest_of / rest_request),
 * with the same recipient, token, chain and requester text. Asking again returns that same request.
 * Like any request, it needs no proof from the recipient: it can only ever pay them.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/requests/[id]/rest">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isRequestId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed id");
    const body = RestBody.parse(await readJson(req));
    const existing = await getRequest(id);
    if (!existing) throw new ApiError("not_found", "no request with this id");
    if (!existing.restRequest) await requireCreateSlot(req, existing.recipient);
    const { rest, already } = await askForRest(id, body.source);
    const base = baseUrl(req);
    const res: RestResponse = {
      id: rest.id,
      link: `${base}/r/${rest.id}`,
      solana_pay_url: rest.chain === "base" ? null : solanaPayUrl(rest),
      qr_url: `${base}/api/qr/${rest.id}.png`,
      reference: rest.reference,
      x402_url: x402UrlFor(base, rest),
      created_at: rest.createdAt,
      flags: rest.flags,
      from_domain: rest.fromDomain ?? null,
      expires_at: rest.expiresAt ?? null,
      chain: rest.chain ?? "solana",
      pay_url: payUrl(rest),
      recipient: rest.recipient,
      amount: fromAtomic(rest.amountAtomic, rest.token),
      token: rest.token,
      rest_of: id,
      already_asked: already,
    };
    return json(res, { status: already ? 200 : 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
