import { PublicKey } from "@solana/web3.js";
import { CreateRequestBody, type CreateRequestResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { AmountError, toAtomic } from "@/lib/money";
import { domainBrandFlags, requireVerifiedDomain } from "@/lib/payee";
import { requireCreateSlot, requireDnsSlot } from "@/lib/ratelimit";
import { requireSolMinimum } from "@/lib/sol-minimum";
import { createRequest, solanaPayUrl } from "@/lib/requests";
import { brandFlags, sanitizeText, TEXT_LIMITS, withoutOwnBrandFlags } from "@/lib/safety";
import { x402UrlFor } from "@/lib/x402/url";

export const runtime = "nodejs";

/** POST /api/v1/requests — create a payment request. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateRequestBody.parse(await readJson(req));

    // An off-curve recipient is usually a token account pasted by mistake; wallets would
    // derive a second token account from it and the money would be stuck.
    if (!PublicKey.isOnCurve(new PublicKey(body.recipient).toBytes())) {
      throw new ApiError("invalid_input", "recipient must be a wallet address, not a token account or program address");
    }

    let amountAtomic: bigint;
    try {
      amountAtomic = toAtomic(body.amount, body.token);
    } catch (e) {
      if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
      throw e;
    }
    // QA-18: a SOL request to a never-used wallet must reach Solana's minimum, or it could never be paid.
    if (body.token === "SOL") await requireSolMinimum(body.recipient, amountAtomic, "amount");

    const flags = brandFlags([body.payer_name, body.for, body.note, body.requester_name]);

    await requireCreateSlot(req, body.recipient);

    // W2-H verified payee: store a domain only if its DNS publishes this recipient right now.
    // W2-E: DNS lookups are capped per client IP and per domain.
    if (body.from_domain) await requireDnsSlot(req, body.from_domain);
    const fromDomain = body.from_domain ? await requireVerifiedDomain(body.from_domain, body.recipient) : null;
    // A brand word in the verified domain flags the request like one in the text (QA-02): the pay page shows the caution.
    // W2-E: a brand word the verified domain owns ("Owed Support" from getowed.xyz) isn't a caution.
    const allFlags = withoutOwnBrandFlags([...new Set([...flags, ...domainBrandFlags(fromDomain)])], fromDomain);

    const row = await createRequest({
      recipient: body.recipient,
      token: body.token,
      amountAtomic,
      payerName: sanitizeText(body.payer_name, TEXT_LIMITS.payer_name),
      forText: sanitizeText(body.for, TEXT_LIMITS.for),
      note: sanitizeText(body.note, TEXT_LIMITS.note),
      requesterName: sanitizeText(body.requester_name, TEXT_LIMITS.requester_name),
      flags: allFlags,
      source: body.source,
      fromDomain,
      expiresInDays: body.expires_in_days ?? null, // W3-C: the database computes expires_at from its own clock
    });

    const base = baseUrl(req);
    const res: CreateRequestResponse = {
      id: row.id,
      link: `${base}/r/${row.id}`,
      solana_pay_url: solanaPayUrl(row),
      qr_url: `${base}/api/qr/${row.id}.png`,
      reference: row.reference,
      x402_url: x402UrlFor(base, row),
      created_at: row.createdAt,
      flags: row.flags,
      from_domain: row.fromDomain,
      expires_at: row.expiresAt ?? null, // W3-C
    };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
