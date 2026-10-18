import { PublicKey } from "@solana/web3.js";
import { requireNotSanctioned } from "@/lib/sanctions";
import { CreateRequestBody, type CreateRequestResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { AmountError, fromAtomic, toAtomic } from "@/lib/money";
import { domainBrandFlags, requireVerifiedDomain } from "@/lib/payee";
import { requireCreateSlot, requireDnsSlot } from "@/lib/ratelimit";
import { requireSolMinimum } from "@/lib/sol-minimum";
import { chainCheckable, createRequest, getRequests, payUrl, settleFromChain, solanaPayUrl, toPublic, type RequestRow } from "@/lib/requests";
import { isRequestId } from "@/lib/ids";
import { handleFlags, parseHandle, requirePayer, requirePayerAskSlot } from "@/lib/inbox-payer"; // F1
import { parseEvmAddress } from "@/lib/evm/address"; // W3-B
import { brandFlags, sanitizeText, TEXT_LIMITS, withoutOwnBrandFlags } from "@/lib/safety";
import { x402UrlFor } from "@/lib/x402/url";
import { fiatAsk, lockRate, quoteAt } from "@/lib/fx"; // local-currency asks
import type { FiatQuote } from "@/lib/fiat";
import { requireSnsName } from "@/lib/sns"; // W3-S
import type { BulkRequestsResponse } from "@/lib/contract";
import { parseDepositUrl, storeDepositUrl } from "@/lib/deposit-link"; // F3 deposit link

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

    requireNotSanctioned(body.recipient); // W2-E: OFAC SDN list (Solana and EVM), 403 blocked
    // F3 deposit link: checked before any network call or rate-limit slot; stored beside the request, never in its id.
    const depositUrl = parseDepositUrl(body.deposit_url, { token: body.token, chain: body.chain, currency: body.currency });

    // An off-curve recipient is usually a token account pasted by mistake; wallets would
    // derive a second token account from it and the money would be stuck.
    if (body.chain === "solana" && !PublicKey.isOnCurve(new PublicKey(body.recipient).toBytes())) {
      throw new ApiError("invalid_input", "recipient must be a wallet address, not a token account or program address");
    }

    let amountAtomic: bigint;
    // Local-currency ask: `amount` is in `currency`; a live rate locks the USDC amount (lib/fx.ts), which the id
    // then commits to like any other. The quote is stored beside it for display only.
    let fiat: FiatQuote | null = null;
    if (body.currency != null) {
      if (body.chain !== "solana") throw new ApiError("invalid_input", "currency: local-currency asks are Solana USDC only for now; ask in USDC on Base");
      if (body.token !== "USDC") throw new ApiError("invalid_input", "token: a local-currency ask is paid in USDC; leave token out or set it to USDC");
      const ask = fiatAsk(body.currency, body.amount);
      const quote = quoteAt(ask.code, ask.amount, await lockRate(ask.code));
      fiat = quote.fiat;
      amountAtomic = quote.usdcAtomic;
    } else {
      try {
        amountAtomic = toAtomic(body.amount, body.token);
      } catch (e) {
        if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
        throw e;
      }
    }
    // QA-18: a SOL request to a never-used wallet must reach Solana's minimum, or it could never be paid.
    if (body.token === "SOL") await requireSolMinimum(body.recipient, amountAtomic, "amount");

    // F1: the requester's own X handle is a label like requester_name: its format is checked, and a brand word in it flags.
    const requesterHandle = parseHandle(body.requester_handle, "requester_handle");
    const flags = [...brandFlags([body.payer_name, body.for, body.note, body.requester_name]), ...handleFlags(requesterHandle)];

    await requireCreateSlot(req, body.recipient);

    // W2-H verified payee: store a domain only if its DNS publishes this recipient right now.
    // W2-E: DNS lookups are capped per client IP and per domain.
    if (body.from_domain) await requireDnsSlot(req, body.from_domain);
    // W3-S: an SNS name is stored only if it resolves on Solana to this recipient right now, read beside the DNS check.
    if (body.sns_name && body.chain !== "solana") throw new ApiError("invalid_input", "sns_name: SNS names point to Solana wallets; a Base request can't carry one");
    const [fromDomain, sns, payer] = await Promise.all([
      body.from_domain ? requireVerifiedDomain(body.from_domain, body.recipient) : null,
      body.sns_name ? requireSnsName(body.sns_name, body.recipient) : null,
      requirePayer(body.payer, body.recipient), // F1: who it is addressed to (an .sns name is resolved beside the others)
    ]);
    // F1: addressed requests land in someone's inbox, so they are limited per requester wallet and per payer too.
    if (payer) await requirePayerAskSlot(req, body.recipient, payer.wallet);
    // A brand word in the verified domain flags the request like one in the text (QA-02): the pay page shows the caution.
    // W2-E: a brand word the verified domain owns ("Owed Support" from getowed.xyz) isn't a caution.
    // W3-S: so does one in the SNS name ("phantom.sns" is anyone's).
    const nameFlags = sns ? [...brandFlags([sns.name]), ...domainBrandFlags(sns.name.replace(/_/g, "-").replace(/\.sns$/, ".example"))] : [];
    const allFlags = withoutOwnBrandFlags([...new Set([...flags, ...domainBrandFlags(fromDomain), ...nameFlags])], fromDomain);

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
      chain: body.chain, // W3-B
      fiat,
      sns, // W3-S
      payer, // F1
      requesterHandle,
    });
    const deposited = depositUrl ? await storeDepositUrl(row.id, depositUrl) : null; // F3 deposit link

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
      expires_at: row.expiresAt ?? null, // W3-C
      // W3-B Base requests: the chain, and the link a wallet opens (the solana: URL, or EIP-681 on Base).
      chain: row.chain ?? "solana",
      pay_url: payUrl(row),
      // Local-currency asks: the caller named an amount in another currency, so it learns the USDC here.
      ...(row.fiat && { amount: fromAtomic(row.amountAtomic, row.token), fiat: row.fiat }),
      sns_name: row.snsName ?? null, // W3-S
      sns_source: row.snsSource ?? null,
      // F1: only when set, so an unaddressed request's reply is exactly as before.
      ...(row.payer && { payer: row.payer }),
      ...(row.requesterHandle && { requester_handle: row.requesterHandle }),
      ...(deposited?.depositUrl && { deposit_url: deposited.depositUrl }), // F3 deposit link: only when asked for
    };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** F1: pay_all reads every request's terms in one call; same chain budget as GET /api/v1/requests/:id. */
const BULK_CHAIN_BUDGET_MS = 2500;
const BULK_MAX_IDS = 20;

/**
 * GET /api/v1/requests?ids=a,b,c — F1, for pay_all: 1 to 20 requests, each in exactly the shape
 * GET /api/v1/requests/:id returns (checked against the chain first while still payable), in the order asked.
 * Unknown ids are listed in not_found; repeated ids count once.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const raw = new URL(req.url).searchParams.get("ids") ?? "";
    const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > BULK_MAX_IDS) throw new ApiError("invalid_input", `ids: give 1 to ${BULK_MAX_IDS} Owed ids, comma-separated`);
    const badIndex = ids.findIndex((id) => !isRequestId(id));
    if (badIndex !== -1) throw new ApiError("invalid_input", `ids: ${JSON.stringify(String(ids[badIndex]).slice(0, 20))} is not an Owed id (12 characters)`);
    const byId = await getRequests(ids);
    let rows = ids.map((id) => byId.get(id)).filter((r): r is RequestRow => r !== undefined);
    const due = rows.filter((r) => chainCheckable(r.status)); // W3-C: expired and cancelled requests may still have been paid
    if (due.length > 0) {
      try {
        const settled = new Map((await settleFromChain(due, { deadline: Date.now() + BULK_CHAIN_BUDGET_MS })).map((r) => [r.id, r]));
        rows = rows.map((r) => settled.get(r.id) ?? r);
      } catch {
        // Serve the stored state, as GET /api/v1/requests/:id does; pay_all re-checks every term itself.
      }
    }
    const base = baseUrl(req);
    const res: BulkRequestsResponse = {
      requests: rows.map((r) => toPublic(r, base)) as BulkRequestsResponse["requests"],
      not_found: ids.filter((id) => !byId.has(id)),
    };
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
