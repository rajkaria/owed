import { PublicKey } from "@solana/web3.js";
import { CreatePotBody, type PotResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { handleFlags, parseHandle } from "@/lib/inbox-payer";
import { createPot, potAmount, POT_LIMITS, requirePotCreateSlot, toPublicPot } from "@/lib/pots";
import { brandFlags, sanitizeText, TEXT_LIMITS } from "@/lib/safety";
import { requireNotSanctioned } from "@/lib/sanctions";
import { requireSolMinimum } from "@/lib/sol-minimum";

export const runtime = "nodejs";

const DAY_MS = 86_400_000;

/**
 * POST /api/v1/pots — F7: start a chip-in pot for one Solana wallet. Validated like POST /api/v1/requests: a wallet
 * that can sign (not a token account), off the sanctions list, amounts within the token's limits, requester text
 * sanitized and brand-flagged, rate limited per recipient and per client IP. Every pot ends: deadline (ISO) or
 * deadline_days (1 to 90), default 30 days. 201 with the pot (its id commits to recipient + token via `nonce`).
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreatePotBody.parse(await readJson(req));
    requireNotSanctioned(body.recipient);
    if (!PublicKey.isOnCurve(new PublicKey(body.recipient).toBytes())) {
      throw new ApiError("invalid_input", "recipient must be a wallet address, not a token account or program address");
    }
    const token = body.token;

    const title = sanitizeText(body.title, POT_LIMITS.title);
    if (!title) throw new ApiError("invalid_input", "title: needs some readable text, e.g. 'Team dinner'");
    const requesterHandle = parseHandle(body.requester_handle, "requester_handle");

    const target = body.target == null ? null : potAmount(body.target, token, "target");
    const suggested = body.suggested == null ? null : potAmount(body.suggested, token, "suggested");
    const presets = (body.presets ?? []).map((p, i) => potAmount(p, token, `presets.${i}`));
    if (presets.length > 0 && token !== "USDC") throw new ApiError("invalid_input", "presets: preset amounts are paid over x402, which is USDC only; leave presets out for a SOL pot");
    if (new Set(presets.map(String)).size !== presets.length) throw new ApiError("invalid_input", "presets: each preset amount must be different");
    const anyAmount = body.any_amount ?? true;
    if (!anyAmount && suggested === null && presets.length === 0) {
      throw new ApiError("invalid_input", "any_amount: a pot that takes only fixed amounts needs a suggested amount or presets");
    }
    // QA-18: SOL to a never-used wallet must reach Solana's minimum; check the smallest fixed amount offered.
    if (token === "SOL" && suggested !== null) await requireSolMinimum(body.recipient, suggested, "suggested");

    if (body.deadline != null && body.deadline_days != null) throw new ApiError("invalid_input", "deadline: give deadline or deadline_days, not both");
    let deadline: string | null = null;
    if (body.deadline != null) {
      const at = Date.parse(body.deadline);
      const now = Date.now();
      if (!Number.isFinite(at) || at < now + POT_LIMITS.deadlineMinMinutes * 60_000) {
        throw new ApiError("invalid_input", `deadline: must be at least ${POT_LIMITS.deadlineMinMinutes} minutes from now`);
      }
      // A few minutes of slack under 90 days, so this clock and the database's never disagree at the edge.
      if (at > now + POT_LIMITS.deadlineMaxDays * DAY_MS - 5 * 60_000) throw new ApiError("invalid_input", "deadline: can be at most 90 days from now");
      deadline = new Date(at).toISOString();
    }

    const note = sanitizeText(body.note, POT_LIMITS.note);
    const requesterName = sanitizeText(body.requester_name, TEXT_LIMITS.requester_name);
    // Brand flags read the raw text, so a brand hidden in a stripped link still flags.
    const flags = [...new Set([...brandFlags([body.title, body.note, body.requester_name]), ...handleFlags(requesterHandle)])];

    await requirePotCreateSlot(req, body.recipient);
    const pot = await createPot({
      recipient: body.recipient, token, title, note, requesterName, requesterHandle,
      targetAtomic: target, suggestedAtomic: suggested, anyAmount, presetsAtomic: presets,
      deadline, deadlineDays: deadline === null ? (body.deadline_days ?? POT_LIMITS.deadlineDefaultDays) : null,
      flags, source: body.source,
    });
    const res: PotResponse = toPublicPot(pot, baseUrl(req));
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
