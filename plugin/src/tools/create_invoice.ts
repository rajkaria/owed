import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { API_TIMEOUT_MS, ApiError } from "../api.js";
import {
  addressSchema, decimalSchema, INVOICE_LIMITS, isoDateSchema, quantitySchema, requestIdSchema, tokenSchema,
  type CreateInvoiceReq, type InvoiceRes,
} from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT, type Token } from "../money.js";
import { checkFromDomain } from "../payee.js";
import { idMatchesTerms } from "../request-id.js";
import type { Screening } from "../screen.js";
import { cautionLine, clean, quote, rateLimitedText, shortAddress } from "../text.js";
import { DAY_MS as EXPIRY_DAY_MS, expiresInDaysInput, expiryLine, expiryProblem } from "../expiry.js"; // W3-C
import { belowNewWalletMinimum, newWalletMinimum } from "../sol-minimum.js";
// Local-currency invoices start
import { fromMinor, toMinor, type FiatCode } from "../fiat.js";
import {
  checkQuote, currencyInput, fiatAmountText, fiatApiRefusal, fiatHeadline, fiatOutput, fiatRateLine, parseFiatAsk,
} from "../local-currency.js";
import type { FiatQuoteRes } from "../contract.js";
// Local-currency invoices end
// F1 payer inbox start
import {
  ADDRESSED_LINE, normalizeHandle, payerInput, payerOutput, REFUSE_PAYER_NOT_STORED, requesterHandleInput, resolvePayer, samePayer, type PayerResolution,
} from "../payer.js";
import { SNS_BUDGET_MS } from "../sns-payee.js";
// F1 payer inbox end
// F8 invoices start
import { invoiceTermsSchema, type CreateInvoiceTermsReq, type InvoiceTermsRes } from "../contract.js";
import { isoDay } from "../invoice-terms-core.js";
import {
  chaseInput, checkTerms, earlyDiscountInput, hasTermsArgs, installmentsInput, lateFeeInput, payAtomicOf, planLocal, termsLines, termsSentence, type LocalPlan,
} from "../invoice-terms.js";
// F8 invoices end
import { checkDepositUrl, depositLines, depositUrlInput, REFUSE_DEPOSIT_NOT_STORED } from "../deposit-link.js"; // F3 deposit link

/** PayBox gives a call 10 s; screening, the DNS check and the API call share it. */
const CALL_BUDGET_MS = 9500;
/** Quantities are decimals with at most 4 places ("1.5" hours), up to a million. */
const QUANTITY_DECIMALS = 4;
const QUANTITY_SCALE = 10n ** BigInt(QUANTITY_DECIMALS);
const MAX_QUANTITY_SCALED = 1_000_000n * QUANTITY_SCALE;
const U64_MAX = (1n << 64n) - 1n;
const MAX_DUE_YEARS = 3;
const DAY_MS = 86_400_000;

/**
 * W2-H's `checkFromDomain` (plugin/src/payee.ts): verifies over DNS that `fromDomain` publishes `recipient`.
 * Injected until verified payee merges; with none, a claimed domain is refused rather than ignored.
 */
export type CheckFromDomain = (fromDomain: string, recipient: string, deps: Deps, budgetMs?: number) => Promise<
  { ok: true; from_domain: string; lines: string[] } | { ok: false; message: string }
>;

const itemSchema = z.object({
  description: z.string().min(1).max(INVOICE_LIMITS.description).describe('What this line is for, e.g. "Logo design, 2 rounds of changes".'),
  quantity: z.union([z.number().int().min(1).max(1_000_000), quantitySchema]).default(1)
    .describe('How many: a whole number, or a decimal string with up to 4 places such as "1.5" for hours. Default 1.'),
  unit_price: decimalSchema.describe('Price of one unit in whole token units as a decimal string, e.g. "40" or "0.25". With currency, in that currency, e.g. "4000" for ₹4,000.'),
}).strict();

export const inputSchema = z.object({
  recipient: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials). The invoice is paid to this address."),
  token: tokenSchema.default("USDC").describe('"USDC" (default) or "SOL". Every price on the invoice is in this token.'),
  business_name: z.string().min(1).max(INVOICE_LIMITS.business_name).describe("Who the invoice is from: the user's name or business."),
  client_name: z.string().min(1).max(INVOICE_LIMITS.client_name).describe("Who is being billed."),
  items: z.array(itemSchema).min(1).max(INVOICE_LIMITS.items).describe("1 to 20 line items. The total is their sum; Owed computes it."),
  due_date: isoDateSchema.describe("Payment due date, YYYY-MM-DD (today or later). With installments, the first installment's due date."),
  invoice_number: z.string().min(1).max(INVOICE_LIMITS.invoice_number).optional().describe("The user's own invoice number, if they have one."),
  notes: z.string().min(1).max(INVOICE_LIMITS.notes).optional().describe("Optional note printed on the invoice, e.g. payment terms or a thank-you."),
  from_domain: z.string().min(1).max(253).optional().describe("A domain the user controls whose _owed TXT record publishes this wallet (verified payee)."),
  expires_in_days: expiresInDaysInput.optional().describe("Optional: the invoice stops taking payments after this many days (1 to 90, reaching at least the due date). Owed's server sets the exact time."), // W3-C
  currency: currencyInput.optional(), // local-currency invoice: every unit_price is in this currency
  payer: payerInput.optional().describe("Optional: the client as a payer, so the invoice shows up in their own agent's inbox (what_do_i_owe). For an X handle, call PayBox resolve_username first, tell the user which wallet it resolved to, and pass {handle, wallet}; or pass {sns} or {wallet}. A handle is a label: Owed doesn't verify it."), // F1
  requester_handle: requesterHandleInput.optional(), // F1
  // F8 invoices start
  installments: installmentsInput.optional(),
  early_discount: earlyDiscountInput.optional(),
  late_fee: lateFeeInput.optional(),
  chase: chaseInput.optional(),
  // F8 invoices end
  deposit_url: depositUrlInput.optional(), // F3 deposit link (plain USDC invoices only)
}).strict();

const itemOutput = z.object({
  description: z.string(),
  quantity: z.string(),
  unit_price: z.string(),
  amount: z.string(),
}).strict();

export const outputSchema = z.object({
  id: requestIdSchema.describe("Owed id of the invoice; check_payments and pay_link take it."),
  invoice_link: z.string().describe("The printable invoice page to send to the client."),
  pay_link: z.string().describe("The plain pay page for the same payment."),
  solana_pay_url: z.string(),
  qr_url: z.string(),
  reference: z.string().describe("Solana Pay reference key that identifies the payment on-chain."),
  recipient: z.string(),
  token: tokenSchema,
  business_name: z.string(),
  client_name: z.string(),
  invoice_number: z.string().nullable(),
  items: z.array(itemOutput).min(1).max(INVOICE_LIMITS.items),
  total: z.string(),
  due_date: z.string(),
  from_domain: z.string().nullable(),
  share_text: z.string().describe("A ready-to-send message for the client."),
  status: z.literal("open"),
  expires_at: z.string().optional().describe("When the invoice stops taking payments (set by Owed's server)."), // W3-C
  fiat: fiatOutput.optional(), // local-currency invoice: items are in fiat.currency, total is the USDC locked
  payer: payerOutput.optional().describe("The client the invoice is addressed to: it is in their what_do_i_owe inbox."), // F1
  requester_handle: z.string().optional().describe("The user's own X handle as the client sees it (not verified by Owed)."), // F1
  // F8 invoices: the invoice as a whole. With installments or an early price, `id`'s own request asks for installment 1 or
  // the early price (pay_now); `total` is still the whole invoice.
  terms: invoiceTermsSchema.optional().describe("Installments, the early and full price, the late fee and the chase days, as Owed stored them."),
  deposit_url: z.string().optional().describe("The PayBox Open Deposit link stored with the invoice. A payment through it counts only after match_payments."), // F3 deposit link
}).strict();

export type InvoiceInput = z.output<typeof inputSchema>;
export type InvoiceOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Create an invoice: a printable invoice page with line items, total, due date and invoice number, payable from any Solana wallet (by QR or link) or by the client's own PayBox agent.",
  "Use it when the user says things like \"invoice Acme for 3 hours of consulting at 40 USDC, due Friday\" or \"bill Sam for the logo and the website\".",
  "recipient is the user's own PayBox Solana wallet address (get it from list_credentials); the client pays it directly, Owed never holds money.",
  "Give each line a description, quantity and unit price; Owed adds them up. Returns invoice_link and a ready-to-send share_text: show both to the user.",
  "Later, check_payments with the id tells whether the invoice has been paid.",
  "If the user prices the work in their own currency (\"invoice Acme ₹40,000 for the logo\"), pass currency (\"INR\") with unit prices in it: the invoice lists the items in that currency and the total is locked to USDC at a live rate.", // local-currency invoices
  // F8 invoices start
  "Merchant terms, all optional: installments {count 2-12, interval \"monthly\" or days} splits the total into that many requests (the first due on due_date and payable now, each later one opening 7 days before its own due date; the invoice shows Paid only when all are); early_discount {amount or percent, until} asks a lower price until a date and the full price after (paying one cancels the other); late_fee {amount or percent} is printed now and opened once as its own request the day after the due date, only if it wasn't paid on time; chase sets the days after the due date when who_owes_me says a polite, firm or formal reminder is due (default 3, 7, 14; false for none). Every amount-changing term is a new request, so no link ever changes its amount.",
  // F8 invoices end
  "If the user wants clients without a wallet to pay through PayBox Deposit, call PayBox get_deposit_link with amount_usd = the invoice total and pass its deposit_url (a plain USDC invoice: no installments, early price or local currency). Owed can't check where that link pays, so such a payment counts only after match_payments.", // F3 deposit link
].join(" ");

// ---- pure: amounts and dates (bigint only) ----

export class InvoiceError extends Error {}

/** "1.5" or 2 -> scaled by 10^4. Throws InvoiceError (user-facing). */
export function parseQuantity(quantity: number | string): bigint {
  const text = typeof quantity === "number" ? String(quantity) : quantity;
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  const frac = m?.[2] ?? "";
  if (!m || frac.length > QUANTITY_DECIMALS) throw new InvoiceError(`quantity ${text} must be a positive number with at most ${QUANTITY_DECIMALS} decimal places`);
  const scaled = BigInt(m[1]!) * QUANTITY_SCALE + BigInt(frac.padEnd(QUANTITY_DECIMALS, "0") || "0");
  if (scaled <= 0n) throw new InvoiceError("quantity must be more than zero");
  if (scaled > MAX_QUANTITY_SCALED) throw new InvoiceError("quantity can be at most 1000000");
  return scaled;
}

export function formatQuantity(scaled: bigint): string {
  const whole = scaled / QUANTITY_SCALE;
  const frac = (scaled % QUANTITY_SCALE).toString().padStart(QUANTITY_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export interface PricedLine {
  quantity: string;
  unitPriceAtomic: bigint;
  amountAtomic: bigint;
}

/** Each line's amount and the total, in atomic units. No rounding: quantity × unit price must be exact. */
export function priceItems(items: InvoiceInput["items"], token: Token, deps: Pick<Deps, "toAtomic" | "fromAtomic">) {
  let totalAtomic = 0n;
  const lines = items.map((item, i): PricedLine => {
    const where = `Line ${i + 1}`;
    let quantity: bigint;
    let unitPriceAtomic: bigint;
    try {
      quantity = parseQuantity(item.quantity);
      unitPriceAtomic = deps.toAtomic(item.unit_price, token);
    } catch (error) {
      throw new InvoiceError(`${where}: ${errorText(error, "invalid quantity or unit price")}`);
    }
    const scaled = unitPriceAtomic * quantity;
    if (scaled % QUANTITY_SCALE !== 0n) {
      throw new InvoiceError(
        `${where}: ${formatQuantity(quantity)} × ${item.unit_price} ${token} doesn't come to a whole number of ${token} units ` +
          `(the smallest is ${deps.fromAtomic(1n, token)} ${token}). Change the quantity or the unit price.`,
      );
    }
    const amountAtomic = scaled / QUANTITY_SCALE;
    totalAtomic += amountAtomic;
    return { quantity: formatQuantity(quantity), unitPriceAtomic, amountAtomic };
  });
  if (totalAtomic > U64_MAX) throw new InvoiceError("The invoice total is too large.");
  return { lines, totalAtomic };
}

/** A real date from yesterday (UTC, for time zones) to MAX_DUE_YEARS ahead. Returns a message, or null when fine. */
export function dueDateProblem(dueDate: string, now: number): string | null {
  const ms = Date.parse(`${dueDate}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== dueDate) return `due_date ${dueDate} isn't a real date. Use YYYY-MM-DD.`;
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (ms < today - DAY_MS) return `due_date ${dueDate} is in the past. Use today's date or later.`;
  const limit = new Date(today);
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_DUE_YEARS);
  if (ms > limit.getTime()) return `due_date ${dueDate} is more than ${MAX_DUE_YEARS} years away. Check the year.`;
  return null;
}

/** W3-C: an invoice that stops taking payments before it is due is a mistake (the server refuses it too). */
export function expiryBeforeDue(dueDate: string, days: number | undefined, now: number): string | null {
  if (days === undefined) return null;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const d = new Date(now + days * EXPIRY_DAY_MS);
  const expiresDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (!Number.isFinite(due) || expiresDay >= due) return null;
  const t = new Date(now);
  const needed = Math.round((due - Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())) / EXPIRY_DAY_MS);
  return `expires_in_days ${days} would end the invoice before its due date ${dueDate}. Use at least ${needed}, or leave it out.`;
}

/** "2026-10-31" -> "Oct 31, 2026". */
export function readableDate(isoDate: string): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(ms)
    ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(ms)
    : isoDate;
}

export interface InvoiceShareInput {
  clientName: string;
  businessName: string;
  invoiceNumber: string | null;
  total: string;
  token: string;
  dueDate: string;
  link: string;
  /** Local-currency invoice: the total in its currency ("₹40,000"); `total` is then the USDC locked. */
  fiat?: string;
}

/** The message the user sends their client. Inputs must already be clean()ed. */
export function invoiceShareText(i: InvoiceShareInput): string {
  const which = i.invoiceNumber ? `invoice ${i.invoiceNumber}` : "an invoice";
  const amount = i.fiat ? `${i.fiat} (${i.total} ${i.token})` : `${i.total} ${i.token}`;
  return `Hi ${i.clientName}, here is ${which} from ${i.businessName} for ${amount}, due ${readableDate(i.dueDate)}. ` +
    `View it and pay with any Solana wallet: ${i.link}`;
}

// ---- the tool ----

export async function createInvoice(
  args: InvoiceInput,
  deps: Deps = defaultDeps,
  // W2-E sanctions screen start
  screen: (addr: string) => Promise<Screening> = (addr) => deps.screenRecipient(addr, deps),
  // W2-E sanctions screen end
  checkDomain: CheckFromDomain | null = checkFromDomain,
) {
  const started = deps.now();
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const token = args.token;
  const dueProblem = dueDateProblem(args.due_date, started);
  if (dueProblem) return refusal(dueProblem);
  const expiryEarly = expiryBeforeDue(args.due_date, args.expires_in_days, started); // W3-C
  if (expiryEarly) return refusal(expiryEarly);
  // F3 deposit link start: a plain USDC invoice only (the link's amount is the total), checked before anything is created.
  let depositUrl: string | undefined;
  if (args.deposit_url !== undefined) {
    const checked = checkDepositUrl(args.deposit_url, { token, ...(args.currency !== undefined && { currency: args.currency }), what: "invoice" });
    if (!checked.ok) return refusal(checked.message);
    if (args.installments !== undefined || args.early_discount !== undefined) {
      return refusal("An invoice with installments or an early-pay price asks a different amount first, so it can't carry a PayBox Deposit link. Add the link to a plain invoice, or leave deposit_url out. Nothing was created.");
    }
    depositUrl = checked.url;
  }
  // F3 deposit link end

  // Local-currency invoice: items are priced in the currency's minor units; the server locks the USDC total.
  let code: FiatCode | undefined;
  if (args.currency !== undefined) {
    const parsed = parseFiatAsk(args.currency, "1", token);
    if (!parsed.ok) return refusal(parsed.message);
    code = parsed.ask.code;
  }
  const unit: Token = code ? (code as unknown as Token) : token;
  const units: Pick<Deps, "toAtomic" | "fromAtomic"> = code
    ? { toAtomic: (amount: string) => toMinor(amount, code), fromAtomic: (atomic: bigint) => fromMinor(atomic, code) }
    : deps;

  let priced: ReturnType<typeof priceItems>;
  try {
    priced = priceItems(args.items, unit, units);
  } catch (error) {
    return refusal(errorText(error, "The line items don't add up to a valid total."));
  }
  let total = units.fromAtomic(priced.totalAtomic, unit);
  const fiatTotal = code ? total : undefined;
  let fiat: FiatQuoteRes | undefined;
  // F8 invoices: every term worked out here first, so the server's reply can be checked against it.
  const termArgs = { installments: args.installments, early_discount: args.early_discount, late_fee: args.late_fee, chase: args.chase };
  let plan: LocalPlan | null = null;
  if (hasTermsArgs(termArgs)) {
    const planned = planLocal(termArgs, {
      totalUnits: priced.totalAtomic, issueDate: isoDay(started), dueDate: args.due_date, currency: code ?? null, expiresInDays: args.expires_in_days,
      units: (amount) => units.toAtomic(amount, unit),
    });
    if (!planned.ok) return refusal(planned.message);
    plan = planned.plan;
  }

  const text = {
    businessName: clean(args.business_name, INVOICE_LIMITS.business_name),
    clientName: clean(args.client_name, INVOICE_LIMITS.client_name),
    invoiceNumber: clean(args.invoice_number, INVOICE_LIMITS.invoice_number) || null,
    notes: clean(args.notes, INVOICE_LIMITS.notes) || null,
  };
  if (!text.businessName || !text.clientName) return refusal("business_name and client_name need some text once links are removed.");
  const descriptions = args.items.map((item) => clean(item.description, INVOICE_LIMITS.description));
  const empty = descriptions.findIndex((d) => d === "");
  if (empty !== -1) return refusal(`Line ${empty + 1} needs a description once links are removed.`);

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  // Screening and the DNS check run side by side: together with the API call they must fit 10 s.
  const budgetLeft = () => CALL_BUDGET_MS - (deps.now() - started);
  if (args.from_domain !== undefined && !checkDomain) {
    return refusal("This Owed build can't verify from_domain yet, so it wasn't used. Create the invoice without from_domain.");
  }
  const domainBudget = Math.max(0, budgetLeft() - API_TIMEOUT_MS - 500);
  const requesterHandle = args.requester_handle === undefined ? null : normalizeHandle(args.requester_handle); // F1
  const [screening, domain, minimum, payerResult] = await Promise.all([
    screen(args.recipient),
    args.from_domain !== undefined && checkDomain ? checkDomain(args.from_domain, args.recipient, deps, domainBudget) : Promise.resolve(null),
    // QA-18: a SOL invoice to a never-used wallet must reach Solana's minimum.
    token === "SOL" ? newWalletMinimum(deps.rpc(), args.recipient) : Promise.resolve(null),
    // F1: the client as a payer (an .sns name resolves on Solana).
    args.payer ? resolvePayer(args.payer, args.recipient, deps, Math.min(SNS_BUDGET_MS, Math.max(500, domainBudget)), "the client") : Promise.resolve(null as PayerResolution | null),
  ]);
  if (!screening.ok) return refusal(screening.message);
  if (payerResult && !payerResult.ok) return refusal(payerResult.message); // F1
  const payer = payerResult?.ok ? payerResult : null;
  if (domain && !domain.ok) return refusal(domain.message);
  if (minimum !== null && priced.totalAtomic < minimum) {
    return refusal(belowNewWalletMinimum(shortAddress(args.recipient), deps.fromAtomic(minimum, "SOL"), `a ${total} SOL invoice`));
  }
  // F8 invoices: every request a plan opens must reach the minimum too (installments, the early price, the late fee).
  if (minimum !== null && plan) {
    const parts = [...(plan.installments ?? []).map((i) => i.units), ...(plan.discount ? [plan.discount.earlyUnits] : []), ...(plan.lateFee ? [plan.lateFee.feeUnits] : [])];
    const smallest = parts.reduce((a, b) => (b < a ? b : a), priced.totalAtomic);
    if (smallest < minimum) return refusal(belowNewWalletMinimum(shortAddress(args.recipient), deps.fromAtomic(minimum, "SOL"), `a ${deps.fromAtomic(smallest, "SOL")} SOL part of this invoice`));
  }

  const body: CreateInvoiceReq = {
    recipient: args.recipient,
    token,
    business_name: text.businessName,
    client_name: text.clientName,
    items: args.items.map((item, i) => ({
      description: descriptions[i]!,
      quantity: priced.lines[i]!.quantity,
      unit_price: units.fromAtomic(priced.lines[i]!.unitPriceAtomic, unit),
    })),
    due_date: args.due_date,
    ...(text.invoiceNumber && { invoice_number: text.invoiceNumber }),
    ...(text.notes && { notes: text.notes }),
    ...(domain?.ok && { from_domain: domain.from_domain }),
    source: "plugin",
    ...(args.expires_in_days !== undefined && { expires_in_days: args.expires_in_days }), // W3-C
    ...(code && { currency: code }), // local-currency invoice
    ...(payer && { payer: payer.body }), // F1
    ...(requesterHandle && { requester_handle: requesterHandle }),
    ...(depositUrl && { deposit_url: depositUrl }), // F3 deposit link
  };
  // F8 invoices: the terms ride along; a plain invoice is created exactly as before.
  const termsBody: CreateInvoiceTermsReq | null = plan
    ? {
        ...body,
        ...(args.installments && { installments: { count: args.installments.count, interval: args.installments.interval, ...(args.installments.first_due && { first_due: args.installments.first_due }) } }),
        ...(args.early_discount && { early_discount: args.early_discount }),
        ...(args.late_fee && { late_fee: args.late_fee }),
        ...(args.chase !== undefined && { chase: args.chase }),
      }
    : null;

  // The API client gives up after API_TIMEOUT_MS; `within` also keeps a slow screening + DNS step from pushing past 10 s.
  const outcome = await within<{ res: InvoiceRes | InvoiceTermsRes } | { error: unknown }>(
    (termsBody ? ctx.api.createInvoiceTerms(termsBody) : ctx.api.createInvoice(body)).then((res) => ({ res }), (error: unknown) => ({ error })),
    Math.max(0, Math.min(API_TIMEOUT_MS + 250, budgetLeft())),
    () => ({ error: new ApiError("upstream_unavailable", "Owed's server did not answer in time.") }),
  );
  if ("error" in outcome) {
    const error = outcome.error;
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't create the invoice."));
    if (code) { const why = fiatApiRefusal(error, "invoice"); if (why) return refusal(why); } // local-currency invoice
    return refusal(apiRefusal(error));
  }
  const res = outcome.res;

  // Local-currency invoice: the quote must be these items' total in `code`, and must give the USDC total.
  let payAtomic = priced.totalAtomic;
  if (code && fiatTotal !== undefined) {
    const quoted = checkQuote(res.fiat, res.total, { code, amount: fiatTotal });
    if (!quoted.ok) return refusal("Owed's server returned a quote that doesn't match this invoice, so it wasn't used. Try again.");
    fiat = quoted.fiat;
    payAtomic = quoted.atomic;
    total = quoted.amount;
  }
  // F8 invoices: with installments or an early price, the invoice's own request asks installment 1 or the early price.
  let ownAtomic = payAtomic;
  const terms = (res as InvoiceTermsRes).terms;
  if (plan) {
    let pay: (units: bigint) => bigint;
    try {
      const rate = code ? (res.fiat?.rate ?? null) : null;
      pay = (u: bigint) => payAtomicOf(u, code ?? null, rate);
      ownAtomic = pay(plan.ownUnits);
    } catch {
      return refusal("Owed's server returned an invoice that doesn't match what was asked, so it wasn't used. Try again.");
    }
    const termsProblem = checkTerms(terms, plan, { id: res.id, token, toAtomic: deps.toAtomic, pay });
    if (termsProblem) return refusal(termsProblem);
  }
  const mismatch = checkInvoice(res, body, priced, ctx, deps, code ? { code, payAtomic } : undefined, ownAtomic);
  if (mismatch) return refusal(mismatch);
  if (payer && !samePayer(res.payer, payer.payer)) return refusal(REFUSE_PAYER_NOT_STORED(payer.payer).replace("the request", "the invoice")); // F1
  if (depositUrl && res.deposit_url !== depositUrl) return refusal(REFUSE_DEPOSIT_NOT_STORED.replace("the request", "the invoice")); // F3 deposit link
  const expiry = expiryProblem(args.expires_in_days, res.expires_at, deps.now()); // W3-C
  if (expiry) return refusal(expiry);

  const share_text = invoiceShareText({
    clientName: res.client_name ? clean(res.client_name, INVOICE_LIMITS.client_name) : text.clientName,
    businessName: res.business_name ? clean(res.business_name, INVOICE_LIMITS.business_name) : text.businessName,
    invoiceNumber: res.invoice_number ? clean(res.invoice_number, INVOICE_LIMITS.invoice_number) : null,
    total, token, dueDate: res.due_date, link: res.link,
    ...(fiat && { fiat: fiatAmountText(fiat) }), // local-currency invoice
  }) + (plan && terms ? ` ${termsSentence(terms, token)}`.trimEnd() : ""); // F8 invoices
  const output: InvoiceOutput = {
    id: res.id,
    invoice_link: res.link,
    pay_link: res.request_link,
    solana_pay_url: res.solana_pay_url,
    qr_url: res.qr_url,
    reference: res.reference,
    recipient: args.recipient,
    token,
    business_name: clean(res.business_name, INVOICE_LIMITS.business_name),
    client_name: clean(res.client_name, INVOICE_LIMITS.client_name),
    invoice_number: res.invoice_number === null ? null : clean(res.invoice_number, INVOICE_LIMITS.invoice_number),
    items: res.items.map((item) => ({
      description: clean(item.description, INVOICE_LIMITS.description),
      quantity: item.quantity,
      unit_price: item.unit_price,
      amount: item.amount,
    })),
    total,
    due_date: res.due_date,
    from_domain: res.from_domain ?? null,
    share_text,
    status: "open",
    ...(args.expires_in_days !== undefined && res.expires_at && { expires_at: res.expires_at }), // W3-C
    ...(fiat && { fiat: { currency: fiat.currency, amount: fiat.amount, rate: fiat.rate, rate_source: fiat.rate_source, quoted_at: fiat.quoted_at } }),
    ...(payer && { payer: payer.payer }), // F1
    ...(requesterHandle && { requester_handle: requesterHandle }),
    ...(plan && terms && { terms: invoiceTermsSchema.parse(terms) }), // F8 invoices
    ...(depositUrl && { deposit_url: depositUrl }), // F3 deposit link
  };

  const count = res.items.length;
  const lines = [
    `Invoice ready: ${fiat ? fiatHeadline(fiat, total) : `${total} ${token}`} to ${quote(output.client_name, INVOICE_LIMITS.client_name)}, due ${readableDate(res.due_date)} (${count} ${count === 1 ? "item" : "items"}). Send this link: ${res.link}`,
    `Message to send: ${share_text}`,
  ];
  if (fiat) lines.push(fiatRateLine(fiat, total).replace("The payer pays", "The client pays")); // local-currency invoice
  if (domain?.ok) lines.push(...domain.lines);
  if (payer) lines.push(...payer.lines, ADDRESSED_LINE(payer.payer)); // F1
  if (output.expires_at && args.expires_in_days !== undefined) lines.push(expiryLine(output.expires_at, args.expires_in_days, "the invoice")); // W3-C
  const caution = cautionLine(res.flags);
  if (caution) lines.push(caution.replace("this request", "this invoice"));
  if (screening.screening === "unavailable") lines.push("Recipient screening was unavailable, so this address wasn't screened.");
  if (plan && terms) lines.push(...termsLines(terms)); // F8 invoices
  if (depositUrl) lines.push(...depositLines("invoice")); // F3 deposit link
  lines.push("Use check_payments with the id to see whether it's paid.");
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

/**
 * The server builds what the client pays; refuse to hand out an invoice that pays anyone or anything else
 * than what this call priced. The page link's host isn't pinned (the server's domain can change before
 * the plugin's OWED_BASE_URL does), but it must be https and name this invoice.
 */
function checkInvoice(
  res: InvoiceRes, body: CreateInvoiceReq, priced: ReturnType<typeof priceItems>, ctx: CallContext, deps: Deps,
  // Local-currency invoice: items are in `code` minor units, and the payment is `payAtomic` USDC (checked by checkQuote).
  local?: { code: FiatCode; payAtomic: bigint },
  // F8 invoices: what the invoice's own request asks when terms make it installment 1 or the early price.
  ownAtomic?: bigint,
): string | null {
  const bad = "Owed's server returned an invoice that doesn't match what was asked, so it wasn't used. Try again.";
  try {
    const token = body.token;
    const totalAtomic = local ? local.payAtomic : priced.totalAtomic;
    const payAtomic = ownAtomic ?? totalAtomic;
    const itemUnits = (amount: string) => (local ? toMinor(amount, local.code) : deps.toAtomic(amount, token));
    const link = new URL(res.link);
    const payLink = new URL(res.request_link);
    if (link.protocol !== "https:" || link.pathname !== `/i/${res.id}`) return bad;
    if (payLink.protocol !== "https:" || payLink.pathname !== `/r/${res.id}`) return bad;
    if (res.recipient !== body.recipient || res.token !== token || res.status !== "open" || res.due_date !== body.due_date) return bad;
    if (deps.toAtomic(res.total, token) !== totalAtomic) return bad;
    if (res.items.length !== priced.lines.length) return bad;
    for (const [i, line] of priced.lines.entries()) {
      const item = res.items[i]!;
      if (parseQuantity(item.quantity) !== parseQuantity(line.quantity)) return bad;
      if (itemUnits(item.unit_price) !== line.unitPriceAtomic || itemUnits(item.amount) !== line.amountAtomic) return bad;
    }
    if ((body.from_domain ?? null) !== (res.from_domain ?? null)) return bad;
    const parsed = deps.parseLink(res.solana_pay_url, ctx.hosts);
    if (parsed.kind !== "transfer") return bad;
    const r = parsed.request;
    if (r.recipient !== body.recipient || r.splToken !== (token === "USDC" ? USDC_MINT : undefined) || !r.references.includes(res.reference)) return bad;
    if (r.amount === undefined || deps.toAtomic(r.amount, token) !== payAtomic) return bad;
    // The id must commit to these exact terms, or a payer's pay_link would refuse the invoice.
    if (!idMatchesTerms(res.id, { recipient: body.recipient, token, amountAtomic: payAtomic, reference: res.reference })) return bad;
    return null;
  } catch {
    return bad;
  }
}

function apiRefusal(error: ApiError): string {
  switch (error.code) {
    case "rate_limited": return rateLimitedText(error.message); // W2-E (QA-07)
    case "blocked": return `Owed can't create an invoice for this recipient. ${error.message}`;
    case "invalid_input": return `Owed rejected the invoice: ${error.message}`;
    case "upstream_unavailable":
      return "Owed's server couldn't be reached, so the invoice wasn't created (an invoice page needs it). Try again in a minute, or use ask_for_money for a plain payment link, which works offline.";
    default: return `Owed couldn't create the invoice: ${error.message}`;
  }
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("create_invoice", {
    title: "Create an invoice",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => createInvoice(args, deps));
}
