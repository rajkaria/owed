import { StatusBody, type StatusResult } from "@/lib/contract";
import { json, readJson, toErrorResponse } from "@/lib/http";
import { isRequestId } from "@/lib/ids";
import { fromAtomic } from "@/lib/money";
import { getRequests, settleFromChain, type RequestRow } from "@/lib/requests";

export const runtime = "nodejs";

/** Leaves headroom under the plugin's 4 s API timeout. */
const CHAIN_BUDGET_MS = 3200;

function result(row: RequestRow): StatusResult {
  const out: StatusResult = {
    id: row.id,
    status: row.status,
    amount_requested: fromAtomic(row.amountAtomic, row.token),
    token: row.token,
    created_at: row.createdAt,
  };
  if ((row.status === "paid" || row.status === "underpaid") && row.paidAmountAtomic != null) {
    out.amount_paid = fromAtomic(row.paidAmountAtomic, row.token);
    out.payer = row.paidPayer ?? undefined;
    out.signature = row.paidSignature ?? undefined;
    out.paid_at = row.paidAt ?? undefined;
  }
  return out;
}

/**
 * POST /api/v1/status — status of up to 20 requests. Open and underpaid ones are checked
 * on chain (at most every 3 s per id); a payment found is written once.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { ids } = StatusBody.parse(await readJson(req));
    const unique = [...new Set(ids)];
    const rows = await getRequests(unique.filter(isRequestId));
    const settled = new Map(
      (await settleFromChain([...rows.values()], { deadline: Date.now() + CHAIN_BUDGET_MS })).map((r) => [r.id, r]),
    );
    const results: StatusResult[] = unique.map((id) => {
      if (!isRequestId(id)) return { id, status: "invalid" };
      const row = settled.get(id);
      return row ? result(row) : { id, status: "not_found" };
    });
    return json({ results });
  } catch (e) {
    return toErrorResponse(e);
  }
}
