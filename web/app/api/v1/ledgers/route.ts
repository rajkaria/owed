import { PublicKey } from "@solana/web3.js";
import { CreateLedgerBody, type GroupLedgerResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { handleFlags, requirePayer } from "@/lib/inbox-payer";
import { createLedger, LEDGER_CREATE_LIMITS, LEDGER_TEXT_LIMITS, loadLedger, toPublicLedger } from "@/lib/ledgers";
import { clientIp, take } from "@/lib/ratelimit";
import { brandFlags, sanitizeText } from "@/lib/safety";
import { requireNotSanctioned } from "@/lib/sanctions";
import { isSolanaAddress } from "@/lib/solana-pay";

export const runtime = "nodejs";

const HOUR = 3600;

/**
 * POST /api/v1/ledgers — F6, start_ledger: a group ledger with its owner (member 0, the wallet that will receive what
 * it is owed) and 1 to 19 more members, each with an optional F1 payer identity ({handle, wallet} the agent resolved
 * with PayBox resolve_username, {sns} this server resolves on Solana, or {wallet}). Unsigned, like every create:
 * nothing is owed and nothing lands in anyone's inbox until a wallet named in the ledger signs an expense and a settle-up.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateLedgerBody.parse(await readJson(req));
    const owner = body.owner.trim();
    if (!isSolanaAddress(owner) || !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) {
      throw new ApiError("invalid_input", "owner: must be the owner's Solana wallet address, one that can sign (not a token account)");
    }
    requireNotSanctioned(owner);
    const title = sanitizeText(body.title, LEDGER_TEXT_LIMITS.title);
    if (!title) throw new ApiError("invalid_input", "title: needs some readable text, e.g. 'Lisbon trip'");
    const ownerName = sanitizeText(body.owner_name, LEDGER_TEXT_LIMITS.name);
    if (!ownerName) throw new ApiError("invalid_input", "owner_name: needs some readable text");
    const names = body.members.map((m, i) => {
      const name = sanitizeText(m.name, LEDGER_TEXT_LIMITS.name);
      if (!name) throw new ApiError("invalid_input", `members.${i}.name: needs some readable text`);
      return name;
    });
    const seen = new Map<string, string>();
    for (const name of [ownerName, ...names]) {
      const key = name.toLowerCase();
      if (seen.has(key)) throw new ApiError("invalid_input", `members: two members are called '${name}'; give each a different name`);
      seen.set(key, name);
    }
    // F1 payer identities, side by side (an .sns name resolves on Solana). None may be the owner's own wallet.
    const payers = await Promise.all(body.members.map((m, i) => requirePayer(m.payer, owner, { field: `members.${i}.payer` })));
    const wallets = new Set<string>();
    payers.forEach((p, i) => {
      if (!p) return;
      requireNotSanctioned(p.wallet);
      if (wallets.has(p.wallet)) throw new ApiError("invalid_input", `members.${i}.payer: that wallet is already another member's`);
      wallets.add(p.wallet);
    });

    const slot = await take([
      { key: `ledger-create:owner:${owner}`, max: LEDGER_CREATE_LIMITS.perOwnerPerHour, windowSeconds: HOUR, scope: "owner" },
      { key: `ledger-create:ip:${clientIp(req)}`, max: LEDGER_CREATE_LIMITS.perIpPerHour, windowSeconds: HOUR, scope: "ip" },
    ]);
    if (!slot.allowed) {
      throw new ApiError(
        "rate_limited",
        slot.scope === "owner" ? "too many new ledgers for this owner in the last hour, try again later" : "too many new ledgers from this client in the last hour, try again later",
        { "Retry-After": String(slot.retryAfterSeconds ?? 60) },
      );
    }

    // Brand flags read the raw text, so a brand hidden in a stripped link still flags.
    const flags = [...new Set([
      ...brandFlags([body.title, body.owner_name, ...body.members.map((m) => m.name)]),
      ...payers.flatMap((p) => handleFlags(p?.handle)),
    ])];
    const id = await createLedger({
      title, owner, ownerName, members: names.map((name, i) => ({ name, payer: payers[i] ?? null })), flags, source: body.source,
    });
    const loaded = await loadLedger(id);
    if (!loaded) throw new ApiError("upstream_unavailable", "the new ledger couldn't be read back, try again shortly");
    const res: GroupLedgerResponse = toPublicLedger(loaded, baseUrl(req));
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
