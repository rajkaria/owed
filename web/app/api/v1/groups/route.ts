import { PublicKey } from "@solana/web3.js";
import { CreateGroupBody, type GroupResponse } from "@/lib/contract";
import { createGroup, GROUP_TEXT_LIMITS, planShares, toPublicGroup } from "@/lib/groups";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { AmountError, toAtomic } from "@/lib/money";
import { requireVerifiedDomain } from "@/lib/payee";
import { takeCreateSlot } from "@/lib/ratelimit";
import { brandFlags, sanitizeText } from "@/lib/safety";

export const runtime = "nodejs";

/** POST /api/v1/groups — split a bill: one group, one payment request per person. */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateGroupBody.parse(await readJson(req));

    // Same rule as single requests: a token account or program address would strand the money.
    if (!PublicKey.isOnCurve(new PublicKey(body.recipient).toBytes())) {
      throw new ApiError("invalid_input", "recipient must be a wallet address, not a token account or program address");
    }

    let amounts: bigint[];
    try {
      const total = toAtomic(body.total, body.token);
      amounts = planShares(
        total,
        body.people.map((p) => (p.amount == null ? null : toAtomic(p.amount, body.token))),
      );
    } catch (e) {
      if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
      throw e;
    }

    const title = sanitizeText(body.title, GROUP_TEXT_LIMITS.title);
    const requesterName = sanitizeText(body.requester_name, GROUP_TEXT_LIMITS.requester_name);
    // Brand flags read the raw text, so a brand hidden in a stripped link still flags.
    const shares = body.people.map((p, i) => ({
      name: sanitizeText(p.name, GROUP_TEXT_LIMITS.name),
      amountAtomic: amounts[i],
      flags: brandFlags([p.name, body.title, body.requester_name]),
    }));
    const flags = brandFlags([body.title, body.requester_name, ...body.people.map((p) => p.name)]);

    // W2-H verified payee: store a domain only if its DNS publishes this recipient right now.
    // createGroup stores it on the group and on every share.
    const fromDomain = body.from_domain == null ? null : await requireVerifiedDomain(body.from_domain, body.recipient);

    // Every share is a request, so every share counts against the recipient's hourly limit.
    for (let i = 0; i < shares.length; i++) {
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
    }

    const created = await createGroup({
      recipient: body.recipient,
      token: body.token,
      title,
      requesterName,
      flags,
      shares,
      source: body.source,
      fromDomain,
    });
    const res: GroupResponse = toPublicGroup(created, baseUrl(req));
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
