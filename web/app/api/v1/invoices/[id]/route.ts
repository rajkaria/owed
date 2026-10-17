import type { InvoiceResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, toErrorResponse } from "@/lib/http";
import { isInvoiceId, loadInvoice, toPublicInvoice } from "@/lib/invoices";

export const runtime = "nodejs";

/** Chain budget for one read, same as GET /requests/:id. */
const CHAIN_BUDGET_MS = 2500;

/** GET /api/v1/invoices/:id — an invoice and its payment status, checked against the chain if still open. */
export async function GET(req: Request, ctx: RouteContext<"/api/v1/invoices/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isInvoiceId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed invoice id");
    const loaded = await loadInvoice(id, { deadline: Date.now() + CHAIN_BUDGET_MS });
    if (!loaded) throw new ApiError("not_found", "no invoice with this id");
    const res: InvoiceResponse = toPublicInvoice(loaded, baseUrl(req));
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
