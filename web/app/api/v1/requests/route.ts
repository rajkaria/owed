import { PublicKey } from "@solana/web3.js";
import { CreateRequestBody, type CreateRequestResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { AmountError, toAtomic } from "@/lib/money";
import { takeCreateSlot } from "@/lib/ratelimit";
import { createRequest, solanaPayUrl } from "@/lib/requests";
import { brandFlags, sanitizeText, TEXT_LIMITS } from "@/lib/safety";
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

    const flags = brandFlags([body.payer_name, body.for, body.note, body.requester_name]);

    const slot = await takeCreateSlot(body.recipient);
    if (!slot.allowed) {
      throw new ApiError(
        "rate_limited",
        slot.scope === "recipient"
          ? "too many requests for this recipient in the last hour, try again later"
          : "Owed is handling too many new requests right now, try again later",
        { "Retry-After": String(slot.retryAfterSeconds ?? 60) },
      );
    }

    const row = await createRequest({
      recipient: body.recipient,
      token: body.token,
      amountAtomic,
      payerName: sanitizeText(body.payer_name, TEXT_LIMITS.payer_name),
      forText: sanitizeText(body.for, TEXT_LIMITS.for),
      note: sanitizeText(body.note, TEXT_LIMITS.note),
      requesterName: sanitizeText(body.requester_name, TEXT_LIMITS.requester_name),
      flags,
      source: body.source,
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
    };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
