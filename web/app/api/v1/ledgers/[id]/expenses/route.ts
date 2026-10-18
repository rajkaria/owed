import { AddExpenseBody, type AddExpenseResponse } from "@/lib/contract";
import { fromMinor, usdcAtomicFor } from "@/lib/fiat";
import { lockRate } from "@/lib/fx";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import {
  insertExpense, isLedgerId, LEDGER_EXPENSE_PURPOSE, LEDGER_EXPENSES_PER_HOUR, loadLedger, toPublicLedger,
} from "@/lib/ledgers";
import { prepareExpense, signingMember } from "@/lib/ledgers-write";
import { brandFlags } from "@/lib/safety";
import { checkSignedMessage, spendOnce } from "@/lib/verify-signature";

export const runtime = "nodejs";

/**
 * POST /api/v1/ledgers/:id/expenses — F6, add_expense: who paid, the amount and currency, and how it is split
 * (even among some or all members, by shares, exact amounts, or a receipt's items with tax and tip spread over each
 * member's item subtotal). Needs, from the owner's or a member's wallet in this ledger, a signature over
 *   "Owed add expense <digest> (<total> <currency>) to ledger <id> by <signer> at <ISO time>"
 * (at most 5 minutes old, once), where the digest covers exactly what is stored (lib/ledgers-math.ts expenseDigest).
 * A local-currency expense is locked to USDC here, at one live rate under lib/fx.ts's two-source 2% rule, each
 * member's share rounded up; the payer is credited the shares' sum.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/v1/ledgers/[id]/expenses">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isLedgerId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed ledger id");
    const body = AddExpenseBody.parse(await readJson(req));
    const loaded = await loadLedger(id);
    if (!loaded) throw new ApiError("not_found", "no ledger with this id");
    const signer = body.signer.trim();
    const recorder = signingMember(loaded, signer);
    if (!recorder) {
      throw new ApiError("blocked", "only the ledger's owner or a member whose wallet is in it can add expenses; sign with that wallet");
    }
    if (loaded.ledger.expenseCount >= 100) {
      throw new ApiError("invalid_input", "this ledger already has 100 expenses, the most one holds; settle up and start a new ledger");
    }
    const prepared = prepareExpense(id, loaded.ledger.memberCount, body, signer);
    const verified = checkSignedMessage({ message: body.signed_message, signature: body.signature, signer, prefix: prepared.prefix });

    // Each member's share in USDC: as is for a USDC expense; at one locked rate, rounded up, for a local currency.
    const units = prepared.split.units;
    let amounts = units;
    let fiat: { rate: string; rateSource: string; quotedAt: string } | null = null;
    if (prepared.currency) {
      const code = prepared.currency;
      const locked = await lockRate(code);
      amounts = units.map((u) => (u === 0n ? 0n : usdcAtomicFor(fromMinor(u, code), code, locked.rate)));
      fiat = { rate: locked.rate, rateSource: locked.rate_source, quotedAt: locked.quoted_at };
    }
    const amountAtomic = amounts.reduce((a, b) => a + b, 0n);
    await spendOnce(LEDGER_EXPENSE_PURPOSE, verified, LEDGER_EXPENSES_PER_HOUR);

    const position = await insertExpense({
      ledgerId: id,
      description: prepared.description,
      paidBy: body.paid_by,
      split: body.split,
      currency: prepared.currency,
      totalUnits: prepared.totalUnits,
      amountAtomic,
      taxUnits: prepared.taxUnits,
      tipUnits: prepared.tipUnits,
      fiat,
      // Brand flags read the raw text, so a brand hidden in a stripped link still flags.
      flags: brandFlags([body.description, ...(body.items ?? []).map((i) => i.description)]),
      recordedBy: signer,
      signedMessage: body.signed_message,
      signature: body.signature.trim(),
      items: prepared.items,
      shares: prepared.split.participants.map((member) => ({
        member, weight: prepared.weights.get(member) ?? null, units: units[member]!, amountAtomic: amounts[member]!,
      })),
    });
    if (position === null) throw new ApiError("invalid_input", "this ledger already has 100 expenses, the most one holds; settle up and start a new ledger");
    const after = await loadLedger(id);
    if (!after) throw new ApiError("upstream_unavailable", "the ledger couldn't be read back, try again shortly");
    const res: AddExpenseResponse = { added: position, ledger: toPublicLedger(after, baseUrl(req)) };
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
