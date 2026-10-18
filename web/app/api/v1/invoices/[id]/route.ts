import type { InvoiceTermsResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, toErrorResponse } from "@/lib/http";
import { isInvoiceId } from "@/lib/invoices";
import { getPublicInvoiceWithTerms } from "@/lib/invoice-terms"; // F8 invoices

export const runtime = "nodejs";

/** Chain budget for one read, same as GET /requests/:id. */
const CHAIN_BUDGET_MS = 2500;

/**
 * GET /api/v1/invoices/:id — an invoice and its payment status, checked against the chain if still open.
 * F8: an invoice with terms also carries `terms` (the plan or the two prices, the late fee, the chase days, what is
 * paid so far, what to pay now), and its status is the invoice's as a whole (paid only when every installment is).
 * An invoice a plan opened carries `term_of`; any invoice with refunds carries `refunds` and `refunded`.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/v1/invoices/[id]">): Promise<Response> {
  try {
    const { id } = await ctx.params;
    if (!isInvoiceId(id)) throw new ApiError("invalid_input", "id must be a 12-character Owed invoice id");
    const res: InvoiceTermsResponse | null = await getPublicInvoiceWithTerms(id, baseUrl(req), { deadline: Date.now() + CHAIN_BUDGET_MS });
    if (!res) throw new ApiError("not_found", "no invoice with this id");
    return json(res);
  } catch (e) {
    return toErrorResponse(e);
  }
}
