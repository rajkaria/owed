import { SettleUpBody, type SettleUpResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { handleFlags, requirePayerAskSlot } from "@/lib/inbox-payer";
import {
  insertSettlement, isLedgerId, LEDGER_SETTLE_PURPOSE, LEDGER_TEXT_LIMITS, loadLedger, MAX_SETTLEMENTS, settleForText, settleNote, toPublicLedger,
  type NewTransfer,
} from "@/lib/ledgers";
import { unitsToDecimal } from "@/lib/ledgers-math";
import { prepareSettlement, signingMember } from "@/lib/ledgers-write";
import { requireCreateSlot } from "@/lib/ratelimit";
import { solanaPayUrl } from "@/lib/requests";
import { brandFlags, sanitizeText, TEXT_LIMITS } from "@/lib/safety";
import { requireNotSanctioned } from "@/lib/sanctions";
import { checkSignedMessage, spendOnce } from "@/lib/verify-signature";

export const runtime = "nodejs";

/** Chain budget for the read before settling, same as GET /ledgers/:id. */
const CHAIN_BUDGET_MS = 2500;

/**
 * POST /api/v1/ledgers/:id/settle — F6, settle_up: the largest debtor pays the largest creditor until every balance is
 * squared (at most n - 1 transfers, lib/ledgers-math.ts planSettlement). Each transfer becomes one ordinary Owed USDC
 * request payable to the creditor's wallet, addressed to the debtor's wallet when the ledger has it (it lands in their
 * what_do_i_owe inbox), for "<title> settle-up", with a note naming the ledger and who recorded the settle-up. A
 * creditor without a wallet can't be paid through Owed: that transfer is listed as unpayable and nothing is created
 * for it. Needs, from the owner's or a member's wallet, a signature over
 *   "Owed settle up ledger <id> v<version>: <n> requests, <total> USDC by <signer> at <ISO time>"
 * (at most 5 minutes old, once); version pins the state it settles, so a stale signature can't settle a changed ledger.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/ledgers/[id]/settle">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isLedgerId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed ledger id");
    const body = SettleUpBody.parse(await readJson(req));
    const loaded = await loadLedger(id, { deadline: Date.now() + CHAIN_BUDGET_MS });
    if (!loaded) throw new ApiError("not_found", "no ledger with this id");
    const signer = body.signer.trim();
    const recorder = signingMember(loaded, signer);
    if (!recorder) {
      throw new ApiError("blocked", "only the ledger's owner or a member whose wallet is in it can settle up; sign with that wallet");
    }
    // A cancelled or expired settle-up request may still have been paid late; its debt is asked again only once the
    // chain says it wasn't.
    if (!loaded.chainChecked && [...loaded.requests.values()].some((r) => r.status === "cancelled" || r.status === "expired")) {
      throw new ApiError("upstream_unavailable", "Solana couldn't be read to check this ledger's cancelled settle-up requests, try again shortly");
    }
    if (body.version !== loaded.ledger.version) {
      throw new ApiError("invalid_input", `the ledger changed since this was signed (it is at version ${loaded.ledger.version} now); call settle_up again for a fresh message`);
    }
    if (loaded.settlements.length >= MAX_SETTLEMENTS) {
      throw new ApiError("invalid_input", `this ledger has been settled up ${MAX_SETTLEMENTS} times, the most one holds; start a new ledger`);
    }
    const prepared = prepareSettlement(loaded, signer);
    const verified = checkSignedMessage({ message: body.signed_message, signature: body.signature, signer, prefix: prepared.prefix });

    const member = (p: number) => loaded.members[p]!;
    const transfers: NewTransfer[] = prepared.payable.map((t) => {
      const debtor = member(t.from);
      const creditor = member(t.to);
      return {
        from: t.from, to: t.to, amountAtomic: t.amountAtomic, recipient: creditor.wallet!,
        payer: debtor.wallet ? { wallet: debtor.wallet, handle: debtor.handle, sns: debtor.sns } : null,
        payerName: sanitizeText(debtor.name, TEXT_LIMITS.payer_name),
        requesterName: sanitizeText(creditor.name, TEXT_LIMITS.requester_name),
        requesterHandle: creditor.handle,
        flags: [...new Set([...loaded.ledger.flags, ...brandFlags([debtor.name, creditor.name, recorder.name]), ...handleFlags(creditor.handle)])],
      };
    });
    // Every request counts against its creditor's create limit, and an addressed one against the payer-ask limits too.
    for (const t of transfers) {
      requireNotSanctioned(t.recipient);
      await requireCreateSlot(req, t.recipient);
      if (t.payer) await requirePayerAskSlot(req, t.recipient, t.payer.wallet);
    }
    await spendOnce(LEDGER_SETTLE_PURPOSE, verified);

    const done = await insertSettlement({
      ledgerId: id,
      version: body.version,
      recordedBy: signer,
      signedMessage: body.signed_message,
      signature: body.signature.trim(),
      forText: sanitizeText(settleForText(loaded.ledger.title), TEXT_LIMITS.for),
      note: sanitizeText(settleNote(id, sanitizeText(recorder.name, LEDGER_TEXT_LIMITS.name) ?? "a member"), TEXT_LIMITS.note),
      source: loaded.ledger.source,
      transfers,
    });
    if (!done) throw new ApiError("invalid_input", "the ledger changed while settling; call settle_up again for a fresh message");
    const after = await loadLedger(id);
    if (!after) throw new ApiError("upstream_unavailable", "the ledger couldn't be read back, try again shortly");
    const base = baseUrl(req);
    const res: SettleUpResponse = {
      round: done.round,
      created: done.transfers.map((t) => {
        const row = after.requests.get(t.id);
        if (!row) throw new ApiError("upstream_unavailable", "a settle-up request couldn't be read back, try again shortly");
        return {
          position: t.position, from: t.from, to: t.to, amount: unitsToDecimal(t.amountAtomic, 6),
          request: {
            id: row.id, link: `${base}/r/${row.id}`, solana_pay_url: solanaPayUrl(row), reference: row.reference, recipient: row.recipient,
            payer: row.payer ?? null, payer_name: row.payerName, for: row.forText, note: row.note, requester_name: row.requesterName,
            requester_handle: row.requesterHandle ?? null, created_at: row.createdAt,
          },
        };
      }),
      unpayable: prepared.unpayable.map((t) => ({ from: t.from, to: t.to, amount: unitsToDecimal(t.amountAtomic, 6), reason: "no_wallet" as const })),
      ledger: toPublicLedger(after, base),
    };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
