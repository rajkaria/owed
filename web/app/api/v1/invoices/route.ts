import { PublicKey } from "@solana/web3.js";
import { CreateInvoiceBody, type InvoiceResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { createInvoice, prepareInvoice, toPublicInvoice } from "@/lib/invoices";
import { AmountError } from "@/lib/money";
import { requireVerifiedDomain } from "@/lib/payee";
import { takeCreateSlot } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** POST /api/v1/invoices — an itemized invoice whose total is one payment request (same id). */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateInvoiceBody.parse(await readJson(req));

    // Same rule as single requests: a token account or program address would strand the money.
    if (!PublicKey.isOnCurve(new PublicKey(body.recipient).toBytes())) {
      throw new ApiError("invalid_input", "recipient must be a wallet address, not a token account or program address");
    }

    const input = {
      recipient: body.recipient,
      token: body.token,
      businessName: body.business_name,
      clientName: body.client_name,
      invoiceNumber: body.invoice_number,
      notes: body.notes,
      dueDate: body.due_date,
      items: body.items,
      source: body.source,
    };
    const now = Date.now();
    try {
      prepareInvoice(input, now); // every amount, date and text check, before a rate-limit slot is spent
    } catch (e) {
      if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
      throw e;
    }

    // Verified payee (W2-H): the domain must publish this recipient in DNS now; stored on the invoice and its request.
    const fromDomain = body.from_domain == null ? null : await requireVerifiedDomain(body.from_domain, body.recipient);

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

    const created = await createInvoice({ ...input, fromDomain }, now);
    const res: InvoiceResponse = toPublicInvoice(created, baseUrl(req));
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
