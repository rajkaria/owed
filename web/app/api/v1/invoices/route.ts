import { PublicKey } from "@solana/web3.js";
import { requireNotSanctioned } from "@/lib/sanctions";
import { CreateInvoiceBody, type InvoiceResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { createInvoice, prepareInvoice, toPublicInvoice } from "@/lib/invoices";
import { AmountError } from "@/lib/money";
import { requireVerifiedDomain } from "@/lib/payee";
import { requireCreateSlot, requireDnsSlot } from "@/lib/ratelimit";
import { requireSolMinimum } from "@/lib/sol-minimum";
import { fiatCurrency, FiatError, type FiatCode } from "@/lib/fiat"; // local-currency invoices
import { lockRate } from "@/lib/fx";
import { parseHandle, requirePayer, requirePayerAskSlot } from "@/lib/inbox-payer"; // F1

export const runtime = "nodejs";

/** POST /api/v1/invoices — an itemized invoice whose total is one payment request (same id). */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateInvoiceBody.parse(await readJson(req));

    // Same rule as single requests: a token account or program address would strand the money.
    requireNotSanctioned(body.recipient); // W2-E: OFAC SDN list, 403 blocked

    if (!PublicKey.isOnCurve(new PublicKey(body.recipient).toBytes())) {
      throw new ApiError("invalid_input", "recipient must be a wallet address, not a token account or program address");
    }

    // Local-currency invoice: unit prices are in `currency`; the total locks a USDC amount at a live rate.
    let currency: FiatCode | null = null;
    if (body.currency != null) {
      if (body.token !== "USDC") throw new ApiError("invalid_input", "token: a local-currency invoice is paid in USDC; leave token out or set it to USDC");
      try {
        currency = fiatCurrency(body.currency);
      } catch (e) {
        if (e instanceof FiatError) throw new ApiError("invalid_input", `currency: ${e.message}`);
        throw e;
      }
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
      expiresInDays: body.expires_in_days ?? null, // W3-C
      currency,
      requesterHandle: parseHandle(body.requester_handle, "requester_handle"), // F1: a label, format checked
    };
    const now = Date.now();
    let totalAtomic: bigint;
    try {
      totalAtomic = prepareInvoice(input, now).totalAtomic; // every amount, date and text check, before a rate-limit slot is spent
    } catch (e) {
      if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
      throw e;
    }
    // QA-18: a SOL invoice to a never-used wallet must reach Solana's minimum, or it could never be paid.
    if (body.token === "SOL") await requireSolMinimum(body.recipient, totalAtomic, "the invoice total");
    const rate = currency ? await lockRate(currency) : null; // before a rate-limit slot is spent, like the checks above

    // Verified payee (W2-H): the domain must publish this recipient in DNS now; stored on the invoice and its request.
    // W2-E: DNS lookups are capped per client IP and per domain.
    if (body.from_domain != null) await requireDnsSlot(req, body.from_domain);
    // F1: the client as a payer (an .sns name is resolved beside the DNS check).
    const [fromDomain, payer] = await Promise.all([
      body.from_domain == null ? null : requireVerifiedDomain(body.from_domain, body.recipient),
      requirePayer(body.payer, body.recipient),
    ]);

    await requireCreateSlot(req, body.recipient);
    if (payer) await requirePayerAskSlot(req, body.recipient, payer.wallet);

    let created;
    try {
      created = await createInvoice({ ...input, fromDomain, rate, payer }, now);
    } catch (e) {
      if (e instanceof AmountError) throw new ApiError("invalid_input", e.message); // the USDC total out of range
      throw e;
    }
    const res: InvoiceResponse = toPublicInvoice(created, baseUrl(req));
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
