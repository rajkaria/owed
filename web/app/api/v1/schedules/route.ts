import { PublicKey } from "@solana/web3.js";
import { CreateScheduleBody, type ScheduleResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { AmountError, fromAtomic, toAtomic } from "@/lib/money";
import { requireVerifiedDomain } from "@/lib/payee";
import { takeCreateSlot } from "@/lib/ratelimit";
import { solanaPayUrl } from "@/lib/requests";
import { brandFlags, sanitizeText, TEXT_LIMITS } from "@/lib/safety";
import { createSchedule, nextRequestOn } from "@/lib/schedules";
import { x402UrlFor } from "@/lib/x402/url";

export const runtime = "nodejs";

/**
 * POST /api/v1/schedules — ask the same payer for the same amount on the same day of every month (UTC).
 * When that day is today, this month's request is opened right away and returned as first_request;
 * otherwise next_request_on says when the daily cron (/api/cron/schedules) opens the first one.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateScheduleBody.parse(await readJson(req));
    // Local-currency asks lock a rate when each request is made; a schedule would reuse one rate for months.
    if (body.currency != null) {
      throw new ApiError("invalid_input", "currency: monthly requests are in USDC or SOL only, because a rate locked today would be wrong next month; ask for the monthly amount in USDC");
    }

    // Same rule as single requests: a token account or program address would strand the money.
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

    const payerName = sanitizeText(body.payer_name, TEXT_LIMITS.payer_name);
    const forText = sanitizeText(body.for, TEXT_LIMITS.for);
    const requesterName = sanitizeText(body.requester_name, TEXT_LIMITS.requester_name);
    const flags = brandFlags([body.payer_name, body.for, body.requester_name]);

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

    // Verified payee (W2-H): checked now and again before every month's request (lib/schedules.ts).
    const fromDomain = body.from_domain ? await requireVerifiedDomain(body.from_domain, body.recipient) : null;

    const now = Date.now();
    const { schedule, first } = await createSchedule({
      recipient: body.recipient,
      token: body.token,
      amountAtomic,
      payerName,
      forText,
      requesterName,
      flags,
      dayOfMonth: body.day_of_month,
      maxRequests: body.months ?? null,
      source: body.source,
      fromDomain,
    }, { now });

    const base = baseUrl(req);
    const res: ScheduleResponse = {
      id: schedule.id,
      recipient: schedule.recipient,
      amount: fromAtomic(schedule.amountAtomic, schedule.token),
      token: schedule.token,
      payer_name: schedule.payerName,
      for: schedule.forText,
      requester_name: schedule.requesterName,
      day_of_month: schedule.dayOfMonth,
      months: schedule.maxRequests,
      first_period: schedule.firstPeriod,
      status: schedule.status,
      next_request_on: nextRequestOn({ ...schedule, opened: first ? 1 : 0 }, now, first !== null),
      created_at: schedule.createdAt,
      flags: schedule.flags,
      from_domain: schedule.fromDomain,
      from_domain_verified_at: schedule.fromDomainVerifiedAt,
      first_request: first && {
        period: first.period,
        id: first.request.id,
        link: `${base}/r/${first.request.id}`,
        solana_pay_url: solanaPayUrl(first.request),
        qr_url: `${base}/api/qr/${first.request.id}.png`,
        reference: first.request.reference,
        x402_url: x402UrlFor(base, first.request),
        created_at: first.request.createdAt,
        flags: first.request.flags,
        from_domain: first.request.fromDomain ?? null,
      },
    };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
