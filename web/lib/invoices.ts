import "server-only";
import { isoUtc, isUniqueViolation, sql, transaction, type Query, type Row } from "./db";
import { newReference, requestIdFor } from "./ids";
import { AmountError, formatUnits, fromAtomic, toAtomic, TOKENS, type Token } from "./money";
import { domainBrandFlags } from "./payee";
import { chainCheckable, getRequest, settleFromChain, solanaPayUrl, toPublic, type RequestRow } from "./requests";
import { brandFlags, sanitizeText, TEXT_LIMITS } from "./safety";
import type { RpcOptions } from "./solana";
import type { PublicRequest, RequestStatus } from "./public-api";
import { watchSoon } from "./notify/helius"; // W3-A

// Invoices. An invoice is one ordinary request row (kind 'invoice') for the total plus an
// `invoices` row with the same id, so its pay page, /status, check_payments and pay_link all
// work unchanged, and the id commits to the recipient, token, total and reference (lib/ids.ts).
// Both rows are written in one transaction: all or nothing. Totals are bigint atomic units.

export const MAX_ITEMS = 20;
export const INVOICE_TEXT_LIMITS = { business_name: 60, client_name: 60, description: 80, invoice_number: 20, notes: 280 } as const;
/** Quantities are decimals with at most 4 places ("1.5" hours), up to a million. */
export const QUANTITY_DECIMALS = 4;
const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_DECIMALS);
const MAX_QUANTITY_SCALED = 1_000_000n * QUANTITY_SCALE;
const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** How far ahead a due date may be. A typo'd year is the usual reason for one further out. */
export const MAX_DUE_YEARS = 3;

const INVOICE_ID = /^[1-9A-HJ-NP-Za-km-z]{12}$/;

export function isInvoiceId(s: unknown): s is string {
  return typeof s === "string" && INVOICE_ID.test(s);
}

// ---- pure: amounts, dates, text ----

/** "1.5" -> 15000n (scaled by 10^4). Throws AmountError (user-facing) for zero, too many places or too much. */
export function parseQuantity(quantity: string): bigint {
  const m = DECIMAL.exec(quantity);
  const frac = m?.[2]?.slice(1) ?? "";
  if (!m || frac.length > QUANTITY_DECIMALS) {
    throw new AmountError(`quantity must be a positive number with at most ${QUANTITY_DECIMALS} decimal places`);
  }
  const scaled = BigInt(m[1]) * QUANTITY_SCALE + BigInt(frac.padEnd(QUANTITY_DECIMALS, "0") || "0");
  if (scaled <= 0n) throw new AmountError("quantity must be more than zero");
  if (scaled > MAX_QUANTITY_SCALED) throw new AmountError("quantity can be at most 1000000");
  return scaled;
}

export function formatQuantity(scaled: bigint): string {
  return formatUnits(scaled, QUANTITY_DECIMALS);
}

export interface ItemInput {
  description: string | null | undefined;
  quantity: string;
  unit_price: string;
}

export interface InvoiceLine {
  /** Requester-written, sanitized. Render quoted. */
  description: string;
  /** Normalized decimal ("1.5", "2"). */
  quantity: string;
  unitPriceAtomic: bigint;
  amountAtomic: bigint;
}

/**
 * Line amounts and the total in atomic units. quantity × unit price must come out to a whole number
 * of atomic units (no rounding: a payer must be able to check every line). Throws AmountError naming the line.
 */
export function priceItems(items: readonly ItemInput[], token: Token): { lines: InvoiceLine[]; totalAtomic: bigint } {
  if (items.length < 1 || items.length > MAX_ITEMS) throw new AmountError(`an invoice needs between 1 and ${MAX_ITEMS} items`);
  const { decimals } = TOKENS[token];
  let totalAtomic = 0n;
  const lines = items.map((item, i): InvoiceLine => {
    const where = `items[${i}]`;
    const description = sanitizeText(item.description, INVOICE_TEXT_LIMITS.description);
    if (description === null) throw new AmountError(`${where}.description is empty once links and control characters are removed`);
    let quantity: bigint;
    let unitPriceAtomic: bigint;
    try {
      quantity = parseQuantity(item.quantity);
      unitPriceAtomic = toAtomic(item.unit_price, token);
    } catch (e) {
      if (e instanceof AmountError) throw new AmountError(`${where}: ${e.message}`);
      throw e;
    }
    const scaled = unitPriceAtomic * quantity;
    if (scaled % QUANTITY_SCALE !== 0n) {
      throw new AmountError(
        `${where}: ${formatQuantity(quantity)} × ${item.unit_price} ${token} isn't a whole number of ${token} units ` +
          `(the smallest is ${formatUnits(1n, decimals)}); change the quantity or the unit price`,
      );
    }
    const amountAtomic = scaled / QUANTITY_SCALE;
    totalAtomic += amountAtomic;
    return { description, quantity: formatQuantity(quantity), unitPriceAtomic, amountAtomic };
  });
  if (totalAtomic > U64_MAX) throw new AmountError("the invoice total is too large");
  return { lines, totalAtomic };
}

function utcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Epoch ms of a real calendar date "YYYY-MM-DD" (UTC midnight), or null. */
export function parseIsoDate(s: string): number | null {
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

/** A due date from yesterday (UTC, for time zones) up to MAX_DUE_YEARS ahead. Throws AmountError (user-facing). */
export function checkDueDate(dueDate: string, now: number = Date.now()): string {
  const ms = parseIsoDate(dueDate);
  if (ms === null) throw new AmountError("due_date must be a real date written YYYY-MM-DD");
  const today = utcDay(now);
  if (ms < today - 86_400_000) throw new AmountError(`due_date ${dueDate} is in the past`);
  const limit = new Date(today);
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_DUE_YEARS);
  if (ms > limit.getTime()) throw new AmountError(`due_date ${dueDate} is more than ${MAX_DUE_YEARS} years away`);
  return dueDate;
}

/** Sanitize, then shorten for a column with a tighter cap, ending in "…" so a cut is visible. */
export function fit(text: string | null, max: number): string | null {
  if (text === null) return null;
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** What the payer's wallet shows next to the amount (the request's `for`). */
export function invoiceForText(invoiceNumber: string | null, dueDate: string): string {
  return invoiceNumber ? `Invoice ${invoiceNumber}` : `Invoice due ${dueDate}`;
}

// ---- storage ----

export interface InvoiceRow {
  id: string;
  recipient: string;
  token: Token;
  totalAtomic: bigint;
  businessName: string;
  clientName: string;
  invoiceNumber: string | null;
  notes: string | null;
  /** YYYY-MM-DD */
  dueDate: string;
  items: InvoiceLine[];
  flags: string[];
  source: "plugin" | "web";
  /** Verified payee domain (display only), with when the server confirmed it. */
  fromDomain: string | null;
  fromDomainVerifiedAt: string | null;
  createdAt: string;
}

const INVOICE_COLUMNS = `id, recipient, token, total_atomic::text as total_atomic, business_name, client_name, invoice_number, notes,
  to_char(due_date, 'YYYY-MM-DD') as due_date, items::text as items, array_to_json(flags)::text as flags, source,
  from_domain, ${isoUtc("from_domain_verified_at")} as from_domain_verified_at, ${isoUtc("created_at")} as created_at`;

interface StoredLine {
  description: string;
  quantity: string;
  unit_price_atomic: string;
  amount_atomic: string;
}

const storeLines = (lines: readonly InvoiceLine[]): StoredLine[] =>
  lines.map((l) => ({
    description: l.description,
    quantity: l.quantity,
    unit_price_atomic: l.unitPriceAtomic.toString(),
    amount_atomic: l.amountAtomic.toString(),
  }));

function readLines(json: string): InvoiceLine[] {
  const raw = JSON.parse(json) as StoredLine[];
  return raw.map((l) => ({
    description: String(l.description),
    quantity: String(l.quantity),
    unitPriceAtomic: BigInt(l.unit_price_atomic),
    amountAtomic: BigInt(l.amount_atomic),
  }));
}

function invoiceFromRow(r: Row): InvoiceRow {
  return {
    id: r.id!,
    recipient: r.recipient!,
    token: r.token as Token,
    totalAtomic: BigInt(r.total_atomic!),
    businessName: r.business_name!,
    clientName: r.client_name!,
    invoiceNumber: r.invoice_number,
    notes: r.notes,
    dueDate: r.due_date!,
    items: readLines(r.items ?? "[]"),
    flags: JSON.parse(r.flags ?? "[]") as string[],
    source: r.source as InvoiceRow["source"],
    fromDomain: r.from_domain,
    fromDomainVerifiedAt: r.from_domain_verified_at,
    createdAt: r.created_at!,
  };
}

export interface CreateInvoiceInput {
  recipient: string;
  token: Token;
  /** Raw requester text; sanitized here. */
  businessName: string;
  clientName: string;
  invoiceNumber: string | null | undefined;
  notes: string | null | undefined;
  dueDate: string;
  items: readonly ItemInput[];
  source: "plugin" | "web";
  /** A domain already verified by web/lib/payee.ts `requireVerifiedDomain` (W2-H), or null. */
  fromDomain?: string | null;
  /** W3-C: whole days (1-90, checked by the route); the request gets expires_at = now() + this. Must reach the due date. */
  expiresInDays?: number | null;
}

/** W3-C: an invoice that stops taking payments before it is due is a mistake; say how many days it needs. */
export function checkExpiryReachesDue(dueDate: string, expiresInDays: number | null | undefined, now: number = Date.now()): void {
  if (!expiresInDays) return;
  const due = parseIsoDate(dueDate);
  if (due === null) return;
  if (utcDay(now + expiresInDays * 86_400_000) < due) {
    const needed = Math.round((due - utcDay(now)) / 86_400_000);
    throw new AmountError(`expires_in_days ${expiresInDays} ends before the due date ${dueDate}; use at least ${needed}, or leave it out`);
  }
}

/** The sanitized, priced invoice, before anything is written. Throws AmountError (user-facing). */
export function prepareInvoice(input: CreateInvoiceInput, now: number = Date.now()) {
  const businessName = sanitizeText(input.businessName, INVOICE_TEXT_LIMITS.business_name);
  const clientName = sanitizeText(input.clientName, INVOICE_TEXT_LIMITS.client_name);
  if (businessName === null) throw new AmountError("business_name is empty once links and control characters are removed");
  if (clientName === null) throw new AmountError("client_name is empty once links and control characters are removed");
  const dueDate = checkDueDate(input.dueDate, now);
  checkExpiryReachesDue(dueDate, input.expiresInDays, now); // W3-C
  const { lines, totalAtomic } = priceItems(input.items, input.token);
  // Brand flags read the raw text, so a brand hidden in a stripped link still flags.
  const flags = [...new Set([
    ...brandFlags([input.businessName, input.clientName, input.invoiceNumber, input.notes, ...input.items.map((i) => i.description)]),
    ...domainBrandFlags(input.fromDomain), // W2-H (QA-02): a brand word in the verified domain flags the invoice too
  ])];
  return {
    businessName,
    clientName,
    invoiceNumber: sanitizeText(input.invoiceNumber, INVOICE_TEXT_LIMITS.invoice_number),
    notes: sanitizeText(input.notes, INVOICE_TEXT_LIMITS.notes),
    dueDate,
    lines,
    totalAtomic,
    flags,
  };
}

export interface InvoiceWithRequest {
  invoice: InvoiceRow;
  request: RequestRow;
}

/** Inserts the request and the invoice in one transaction. The shared id is derived from the terms (lib/ids.ts). */
export async function createInvoice(input: CreateInvoiceInput, now: number = Date.now()): Promise<InvoiceWithRequest> {
  const p = prepareInvoice(input, now);
  const { mint, decimals } = TOKENS[input.token];
  const fromDomain = input.fromDomain ?? null;
  // The request carries the domain too, so pay_link on the invoice checks it (requests.from_domain is W2-H's 0009).
  const requestDomain = fromDomain === null ? ["", ""] : [", from_domain, from_domain_verified_at", ", $13::text, now()"];
  // The request row keeps the request caps (TEXT_LIMITS), so every existing reader of /requests/:id accepts it.
  const requesterName = fit(p.businessName, TEXT_LIMITS.requester_name);
  const payerName = fit(p.clientName, TEXT_LIMITS.payer_name);
  const forText = invoiceForText(p.invoiceNumber, p.dueDate);
  for (let attempt = 0; ; attempt++) {
    const reference = newReference();
    const id = requestIdFor({ recipient: input.recipient, token: input.token, amountAtomic: p.totalAtomic, reference });
    const queries: Query[] = [
      {
        text: `insert into requests (id, kind, invoice_id, recipient, token, mint, decimals, amount_atomic, reference,
                 payer_name, for_text, requester_name, flags, source${requestDomain[0]})
               values ($1, 'invoice', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12${requestDomain[1]})
               returning ${isoUtc("created_at")} as created_at`,
        params: [
          id, input.recipient, input.token, mint, decimals, p.totalAtomic, reference,
          payerName, forText, requesterName, p.flags, input.source,
          ...(fromDomain === null ? [] : [fromDomain]),
        ],
      },
      {
        // created_at is copied from the request so the invoice and its payment share one timestamp.
        text: `insert into invoices (id, recipient, token, total_atomic, business_name, client_name, invoice_number, notes,
                 due_date, items, flags, source, from_domain, from_domain_verified_at, created_at)
               select $1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::jsonb, $11::text[], $12, $13::text,
                      case when $13::text is null then null else now() end, r.created_at
                 from requests r where r.id = $1
               returning ${INVOICE_COLUMNS}`,
        params: [
          id, input.recipient, input.token, p.totalAtomic, p.businessName, p.clientName, p.invoiceNumber, p.notes,
          p.dueDate, JSON.stringify(storeLines(p.lines)), p.flags, input.source, fromDomain,
        ],
      },
      // W3-C: expires_at at the transaction's now() + N days (the same instant as created_at).
      ...(input.expiresInDays
        ? [{
            text: `update requests set expires_at = now() + make_interval(days => $2::int) where id = $1
                   returning ${isoUtc("expires_at")} as expires_at`,
            params: [id, input.expiresInDays],
          }]
        : []),
    ];
    try {
      const results = await transaction(queries);
      watchSoon(); // W3-A: Helius watches the invoice's reference key
      const invoice = invoiceFromRow(results[1][0]);
      // Exactly the request row just written (same columns lib/requests.ts reads back).
      const request: RequestRow = {
        id,
        kind: "invoice",
        recipient: input.recipient,
        token: input.token,
        mint,
        decimals,
        amountAtomic: p.totalAtomic,
        reference,
        payerName,
        forText,
        note: null,
        requesterName,
        flags: p.flags,
        status: "open",
        paidSignature: null,
        paidPayer: null,
        paidAmountAtomic: null,
        paidAt: null,
        paidRail: null,
        source: input.source,
        createdAt: results[0][0].created_at!,
        fromDomain,
        fromDomainVerifiedAt: invoice.fromDomainVerifiedAt,
        expiresAt: input.expiresInDays ? (results[2]?.[0]?.expires_at ?? null) : null, // W3-C
      };
      return { invoice, request };
    } catch (e) {
      // A collision needs two equal 256-bit references (or a 70-bit id clash); retry with a fresh reference.
      const collision = isUniqueViolation(e, "requests_pkey") || isUniqueViolation(e, "requests_reference_key");
      if (attempt < 2 && collision) continue;
      throw e;
    }
  }
}

export async function getInvoice(id: string): Promise<InvoiceRow | null> {
  const rows = await sql(`select ${INVOICE_COLUMNS} from invoices where id = $1`, [id]);
  return rows.length ? invoiceFromRow(rows[0]) : null;
}

/**
 * An invoice and its payment request. With `rpc`, an open or underpaid request is checked on
 * chain first; if the chain can't be read in time the stored state is used. Null when either
 * row is missing or they disagree on the terms (never shown as payable).
 */
export async function loadInvoice(id: string, rpc: RpcOptions | null = null): Promise<InvoiceWithRequest | null> {
  if (!isInvoiceId(id)) return null;
  const [invoice, stored] = await Promise.all([getInvoice(id), getRequest(id)]);
  if (!invoice || !stored) return null;
  if (
    stored.kind !== "invoice" ||
    stored.recipient !== invoice.recipient ||
    stored.token !== invoice.token ||
    stored.amountAtomic !== invoice.totalAtomic
  ) {
    console.error(`invoice ${id}: invoice and request rows disagree on the payment terms`);
    return null;
  }
  let request = stored;
  if (rpc && chainCheckable(request.status)) { // W3-C: an expired or cancelled invoice may still have been paid
    try {
      [request] = await settleFromChain([request], rpc);
    } catch {
      // Serve the stored state; the page's status polling settles it.
    }
  }
  return { invoice, request };
}

// ---- public shape (contract: invoices.*.json) ----

export interface PublicInvoiceItem {
  /** Requester-written, sanitized. Render quoted. */
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
}

export interface PublicInvoice {
  id: string;
  /** The printable invoice page. */
  link: string;
  /** The plain pay page for the same request. */
  request_link: string;
  solana_pay_url: string;
  qr_url: string;
  reference: string;
  x402_url: string | null;
  recipient: string;
  token: Token;
  /** Requester-written, sanitized. Render quoted. */
  business_name: string;
  client_name: string;
  invoice_number: string | null;
  notes: string | null;
  /** UTC date the invoice was made, YYYY-MM-DD. */
  issue_date: string;
  due_date: string;
  items: PublicInvoiceItem[];
  total: string;
  status: RequestStatus;
  paid: PublicRequest["paid"];
  created_at: string;
  flags: string[];
  /** Verified payee domain (display only; W2-H's badge shows it), or null. */
  from_domain: string | null;
  from_domain_verified_at: string | null;
  // W3-C: when the invoice stops taking payments, and when it was cancelled; each absent when not set.
  expires_at?: string;
  cancelled_at?: string;
}

export function toPublicInvoice({ invoice, request }: InvoiceWithRequest, base: string): PublicInvoice {
  const pub = toPublic(request);
  return {
    id: invoice.id,
    link: `${base}/i/${invoice.id}`,
    request_link: `${base}/r/${invoice.id}`,
    solana_pay_url: solanaPayUrl(request),
    qr_url: `${base}/api/qr/${invoice.id}.png`,
    reference: request.reference,
    x402_url: pub.x402_url,
    recipient: invoice.recipient,
    token: invoice.token,
    business_name: invoice.businessName,
    client_name: invoice.clientName,
    invoice_number: invoice.invoiceNumber,
    notes: invoice.notes,
    issue_date: invoice.createdAt.slice(0, 10),
    due_date: invoice.dueDate,
    items: invoice.items.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_price: fromAtomic(l.unitPriceAtomic, invoice.token),
      amount: fromAtomic(l.amountAtomic, invoice.token),
    })),
    total: fromAtomic(invoice.totalAtomic, invoice.token),
    status: request.status,
    paid: pub.paid,
    created_at: invoice.createdAt,
    flags: invoice.flags,
    from_domain: invoice.fromDomain,
    from_domain_verified_at: invoice.fromDomainVerifiedAt,
    ...(request.expiresAt && { expires_at: request.expiresAt }), // W3-C
    ...(request.cancelledAt && { cancelled_at: request.cancelledAt }),
  };
}

/** Chain check budget for a page render, same as getPublicRequest: client polling takes over. */
const PAGE_CHAIN_BUDGET_MS = 1200;

/** Server-side read for /i/[id] (no HTTP hop). Null when the id doesn't exist. */
export async function getPublicInvoice(id: string, base: string): Promise<PublicInvoice | null> {
  const loaded = await loadInvoice(id, { deadline: Date.now() + PAGE_CHAIN_BUDGET_MS, timeoutMs: PAGE_CHAIN_BUDGET_MS });
  return loaded ? toPublicInvoice(loaded, base) : null;
}
