import { PublicKey } from "@solana/web3.js";
import { requireNotSanctioned } from "@/lib/sanctions";
import { type InvoiceResponse } from "@/lib/contract";
import { ApiError, baseUrl, json, readJson, toErrorResponse } from "@/lib/http";
import { prepareInvoice, priceItems, toPublicInvoice } from "@/lib/invoices";
import { AmountError } from "@/lib/money";
import { requireVerifiedDomain } from "@/lib/payee";
import { requireCreateSlot, requireDnsSlot } from "@/lib/ratelimit";
import { requireSolMinimum } from "@/lib/sol-minimum";
import { fiatCurrency, FiatError, type FiatCode } from "@/lib/fiat"; // local-currency invoices
import { lockRate } from "@/lib/fx";
import { parseHandle, requirePayer, requirePayerAskSlot } from "@/lib/inbox-payer"; // F1
// F8 invoices start
import { CreateInvoiceTermsBody, type InvoiceTermsResponse } from "@/lib/contract";
import { createInvoiceWithTerms, getPublicInvoiceWithTerms, hasTerms, planTerms, plannedAmounts, type TermsBody } from "@/lib/invoice-terms";
import { isoDay } from "@/lib/invoice-terms-core";
import { payAtomicFor } from "@/lib/invoices";
// F8 invoices end

export const runtime = "nodejs";

/**
 * POST /api/v1/invoices — an itemized invoice whose total is one payment request (same id).
 * F8: optional terms. installments (2-12, monthly or every N days) make the invoice's own request installment 1 and
 * open the rest on the daily cron; early_discount makes it the early price, with the full price opening after the
 * date; late_fee is printed now and opened once after the due date only if it wasn't paid on time; chase sets the
 * reminder days (default 3/7/14 after the due date) or turns them off.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = CreateInvoiceTermsBody.parse(await readJson(req)); // F8: CreateInvoiceBody plus optional terms

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
    // F8 invoices: the terms, checked with every amount, date and text check, before a rate-limit slot is spent.
    const terms: TermsBody = { installments: body.installments, early_discount: body.early_discount, late_fee: body.late_fee, chase: body.chase };
    let totalAtomic: bigint;
    let smallestUnits: bigint;
    try {
      totalAtomic = prepareInvoice(input, now).totalAtomic; // every amount, date and text check, before a rate-limit slot is spent
      smallestUnits = totalAtomic;
      if (hasTerms(terms)) {
        const units = priceItems(input.items, input.token, currency).totalAtomic;
        const planned = planTerms(terms, { totalUnits: units, token: input.token, currency, issueDate: isoDay(now), dueDate: input.dueDate, expiresInDays: input.expiresInDays });
        smallestUnits = [units, ...plannedAmounts(planned, units)].reduce((a, b) => (b < a ? b : a));
      }
    } catch (e) {
      if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
      throw e;
    }
    // QA-18: a SOL invoice to a never-used wallet must reach Solana's minimum, or it could never be paid.
    // F8: so must every request a plan opens (installments, the early price, the late fee).
    if (body.token === "SOL") await requireSolMinimum(body.recipient, smallestUnits, hasTerms(terms) ? "the smallest amount this invoice asks for" : "the invoice total");
    const rate = currency ? await lockRate(currency) : null; // before a rate-limit slot is spent, like the checks above
    if (rate && currency && hasTerms(terms)) {
      try {
        payAtomicFor(smallestUnits, { code: currency, locked: rate }); // F8: the USDC each part locks must be in range
      } catch (e) {
        if (e instanceof AmountError) throw new ApiError("invalid_input", e.message);
        throw e;
      }
    }

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
      created = await createInvoiceWithTerms({ ...input, fromDomain, rate, payer }, terms, now);
    } catch (e) {
      if (e instanceof AmountError) throw new ApiError("invalid_input", e.message); // the USDC total out of range
      throw e;
    }
    const base = baseUrl(req);
    if (!created.planned) {
      const res: InvoiceResponse = toPublicInvoice(created.created, base);
      return json(res, { status: 201 });
    }
    // F8 invoices: the invoice as GET /invoices/:id shows it, plan included (stored state, no chain read).
    const withTerms = await getPublicInvoiceWithTerms(created.created.invoice.id, base, null);
    if (!withTerms) throw new ApiError("upstream_unavailable", "the invoice was created but couldn't be read back; get it with GET /api/v1/invoices/<id>");
    const res: InvoiceTermsResponse = withTerms;
    return json(res, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}
