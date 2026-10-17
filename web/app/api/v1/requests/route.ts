import { PublicKey } from "@solana/web3.js";
import { CreateRequestBody, type CreateRequestResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { AmountError, toAtomic } from "@/lib/money";
import { domainBrandFlags, requireVerifiedDomain } from "@/lib/payee";
import { takeCreateSlot } from "@/lib/ratelimit";
import { createRequest, payUrl, solanaPayUrl } from "@/lib/requests";
import { parseEvmAddress } from "@/lib/evm/address"; // W3-B
import { brandFlags, sanitizeText, TEXT_LIMITS } from "@/lib/safety";
import { x402UrlFor } from "@/lib/x402/url";

export const runtime = "nodejs";

/** POST /api/v1/requests — create a payment request. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateRequestBody.parse(await readJson(req));

    // W3-B Base requests start: USDC on Base, to the EIP-55 form of a 0x address.
    if (body.chain === "base") {
      const checksummed = parseEvmAddress(body.recipient);
      if (!checksummed) throw new ApiError("invalid_input", "recipient: the 0x address has a wrong EIP-55 checksum (mixed case); check it, or send it all lower-case");
      if (body.token !== "USDC") throw new ApiError("invalid_input", "token: Base requests are USDC only");
      body.recipient = checksummed;
    }
    // W3-B Base requests end

    // An off-curve recipient is usually a token account pasted by mistake; wallets would
    // derive a second token account from it and the money would be stuck.
    if (body.chain === "solana" && !PublicKey.isOnCurve(new PublicKey(body.recipient).toBytes())) {
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

    // W2-H verified payee: store a domain only if its DNS publishes this recipient right now.
    const fromDomain = body.from_domain ? await requireVerifiedDomain(body.from_domain, body.recipient) : null;
    // A brand word in the verified domain flags the request like one in the text (QA-02): the pay page shows the caution.
    const allFlags = [...new Set([...flags, ...domainBrandFlags(fromDomain)])];

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
      chain: body.chain, // W3-B
    });

    const base = baseUrl(req);
    const res: CreateRequestResponse = {
      id: row.id,
      link: `${base}/r/${row.id}`,
      solana_pay_url: row.chain === "base" ? null : solanaPayUrl(row), // W3-B
      qr_url: `${base}/api/qr/${row.id}.png`,
      reference: row.reference,
      x402_url: x402UrlFor(base, row),
      created_at: row.createdAt,
      flags: row.flags,
      from_domain: row.fromDomain,
      // W3-B Base requests: the chain, and the link a wallet opens (the solana: URL, or EIP-681 on Base).
      chain: row.chain ?? "solana",
      pay_url: payUrl(row),
    };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
