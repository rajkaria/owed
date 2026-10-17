import { StatusRawBody, type StatusRawResponse } from "@/lib/contract";
import { ApiError, json, readJson, toErrorResponse } from "@/lib/http";
import { AmountError, fromAtomic, toAtomic, USDC_MINT, type Token } from "@/lib/money";
import { parseTransferUrl, SolanaPayError } from "@/lib/solana-pay";
import { findPayments } from "@/lib/validate";

export const runtime = "nodejs";

const CHAIN_BUDGET_MS = 3200;

/** POST /api/v1/status-raw — check any Solana Pay transfer link on chain. Nothing is stored. */
export async function POST(req: Request): Promise<Response> {
  try {
    const { solana_pay_url } = StatusRawBody.parse(await readJson(req));

    let link;
    try {
      link = parseTransferUrl(solana_pay_url);
    } catch (e) {
      if (e instanceof SolanaPayError) throw new ApiError("invalid_input", e.message);
      throw e;
    }

    let token: Token;
    if (!link.splToken) token = "SOL";
    else if (link.splToken === USDC_MINT) token = "USDC";
    else throw new ApiError("invalid_input", "only USDC and SOL transfer links are supported");

    if (link.references.length === 0) {
      throw new ApiError("invalid_input", "link has no reference key, so its payment can't be found on chain");
    }

    let amountAtomic: bigint | null = null;
    if (link.amount !== undefined) {
      try {
        amountAtomic = toAtomic(link.amount, token);
      } catch (e) {
        if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
        throw e;
      }
    }

    const [check] = await findPayments(
      [{ reference: link.references[0], recipient: link.recipient, token, amountAtomic }],
      { deadline: Date.now() + CHAIN_BUDGET_MS },
    );

    const res: StatusRawResponse = { status: check.status, token };
    if (link.amount !== undefined) res.amount_requested = link.amount;
    if (check.payment) {
      res.amount_paid = fromAtomic(check.payment.amountAtomic, token);
      res.payer = check.payment.payer;
      res.signature = check.payment.signature;
      res.paid_at = check.payment.at;
    }
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
