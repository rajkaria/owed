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
import { screenRecipient, type Screening } from "../screen.js";
import { cautionLine, clean, quote } from "../text.js";

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
  unit_price: decimalSchema.describe('Price of one unit in whole token units as a decimal string, e.g. "40" or "0.25".'),
}).strict();

export const inputSchema = z.object({
  recipient: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials). The invoice is paid to this address."),
  token: tokenSchema.default("USDC").describe('"USDC" (default) or "SOL". Every price on the invoice is in this token.'),
  business_name: z.string().min(1).max(INVOICE_LIMITS.business_name).describe("Who the invoice is from: the user's name or business."),
  client_name: z.string().min(1).max(INVOICE_LIMITS.client_name).describe("Who is being billed."),
  items: z.array(itemSchema).min(1).max(INVOICE_LIMITS.items).describe("1 to 20 line items. The total is their sum; Owed computes it."),
  due_date: isoDateSchema.describe("Payment due date, YYYY-MM-DD (today or later)."),
  invoice_number: z.string().min(1).max(INVOICE_LIMITS.invoice_number).optional().describe("The user's own invoice number, if they have one."),
  notes: z.string().min(1).max(INVOICE_LIMITS.notes).optional().describe("Optional note printed on the invoice, e.g. payment terms or a thank-you."),
  from_domain: z.string().min(1).max(253).optional().describe("A domain the user controls whose _owed TXT record publishes this wallet (verified payee)."),
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
}).strict();

export type InvoiceInput = z.output<typeof inputSchema>;
export type InvoiceOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Create an invoice: a printable invoice page with line items, total, due date and invoice number, payable from any Solana wallet (by QR or link) or by the client's own PayBox agent.",
  "Use it when the user says things like \"invoice Acme for 3 hours of consulting at 40 USDC, due Friday\" or \"bill Sam for the logo and the website\".",
  "recipient is the user's own PayBox Solana wallet address (get it from list_credentials); the client pays it directly, Owed never holds money.",
  "Give each line a description, quantity and unit price; Owed adds them up. Returns invoice_link and a ready-to-send share_text: show both to the user.",
  "Later, check_payments with the id tells whether the invoice has been paid.",
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
}

/** The message the user sends their client. Inputs must already be clean()ed. */
export function invoiceShareText(i: InvoiceShareInput): string {
  const which = i.invoiceNumber ? `invoice ${i.invoiceNumber}` : "an invoice";
  return `Hi ${i.clientName}, here is ${which} from ${i.businessName} for ${i.total} ${i.token}, due ${readableDate(i.dueDate)}. ` +
    `View it and pay with any Solana wallet: ${i.link}`;
}

// ---- the tool ----

export async function createInvoice(
  args: InvoiceInput,
  deps: Deps = defaultDeps,
  screen: (addr: string) => Promise<Screening> = screenRecipient,
  checkDomain: CheckFromDomain | null = checkFromDomain,
) {
  const started = deps.now();
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const token = args.token;
  const dueProblem = dueDateProblem(args.due_date, started);
  if (dueProblem) return refusal(dueProblem);

  let priced: ReturnType<typeof priceItems>;
  try {
    priced = priceItems(args.items, token, deps);
  } catch (error) {
    return refusal(errorText(error, "The line items don't add up to a valid total."));
  }
  const total = deps.fromAtomic(priced.totalAtomic, token);

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
  const [screening, domain] = await Promise.all([
    screen(args.recipient),
    args.from_domain !== undefined && checkDomain ? checkDomain(args.from_domain, args.recipient, deps, domainBudget) : Promise.resolve(null),
  ]);
  if (!screening.ok) return refusal(screening.message);
  if (domain && !domain.ok) return refusal(domain.message);

  const body: CreateInvoiceReq = {
    recipient: args.recipient,
    token,
    business_name: text.businessName,
    client_name: text.clientName,
    items: args.items.map((item, i) => ({
      description: descriptions[i]!,
      quantity: priced.lines[i]!.quantity,
      unit_price: deps.fromAtomic(priced.lines[i]!.unitPriceAtomic, token),
    })),
    due_date: args.due_date,
    ...(text.invoiceNumber && { invoice_number: text.invoiceNumber }),
    ...(text.notes && { notes: text.notes }),
    ...(domain?.ok && { from_domain: domain.from_domain }),
    source: "plugin",
  };

  // The API client gives up after API_TIMEOUT_MS; `within` also keeps a slow screening + DNS step from pushing past 10 s.
  const outcome = await within<{ res: InvoiceRes } | { error: unknown }>(
    ctx.api.createInvoice(body).then((res) => ({ res }), (error: unknown) => ({ error })),
    Math.max(0, Math.min(API_TIMEOUT_MS + 250, budgetLeft())),
    () => ({ error: new ApiError("upstream_unavailable", "Owed's server did not answer in time.") }),
  );
  if ("error" in outcome) {
    const error = outcome.error;
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't create the invoice."));
    return refusal(apiRefusal(error));
  }
  const res = outcome.res;

  const mismatch = checkInvoice(res, body, priced, ctx, deps);
  if (mismatch) return refusal(mismatch);

  const share_text = invoiceShareText({
    clientName: res.client_name ? clean(res.client_name, INVOICE_LIMITS.client_name) : text.clientName,
    businessName: res.business_name ? clean(res.business_name, INVOICE_LIMITS.business_name) : text.businessName,
    invoiceNumber: res.invoice_number ? clean(res.invoice_number, INVOICE_LIMITS.invoice_number) : null,
    total, token, dueDate: res.due_date, link: res.link,
  });
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
  };

  const count = res.items.length;
  const lines = [
    `Invoice ready: ${total} ${token} to ${quote(output.client_name, INVOICE_LIMITS.client_name)}, due ${readableDate(res.due_date)} (${count} ${count === 1 ? "item" : "items"}). Send this link: ${res.link}`,
    `Message to send: ${share_text}`,
  ];
  if (domain?.ok) lines.push(...domain.lines);
  const caution = cautionLine(res.flags);
  if (caution) lines.push(caution.replace("this request", "this invoice"));
  if (screening.screening === "unavailable") lines.push("Recipient screening was unavailable, so this address wasn't screened.");
  lines.push("Use check_payments with the id to see whether it's paid.");
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

/**
 * The server builds what the client pays; refuse to hand out an invoice that pays anyone or anything else
 * than what this call priced. The page link's host isn't pinned (the server's domain can change before
 * the plugin's OWED_BASE_URL does), but it must be https and name this invoice.
 */
function checkInvoice(res: InvoiceRes, body: CreateInvoiceReq, priced: ReturnType<typeof priceItems>, ctx: CallContext, deps: Deps): string | null {
  const bad = "Owed's server returned an invoice that doesn't match what was asked, so it wasn't used. Try again.";
  try {
    const token = body.token;
    const link = new URL(res.link);
    const payLink = new URL(res.request_link);
    if (link.protocol !== "https:" || link.pathname !== `/i/${res.id}`) return bad;
    if (payLink.protocol !== "https:" || payLink.pathname !== `/r/${res.id}`) return bad;
    if (res.recipient !== body.recipient || res.token !== token || res.status !== "open" || res.due_date !== body.due_date) return bad;
    if (deps.toAtomic(res.total, token) !== priced.totalAtomic) return bad;
    if (res.items.length !== priced.lines.length) return bad;
    for (const [i, line] of priced.lines.entries()) {
      const item = res.items[i]!;
      if (parseQuantity(item.quantity) !== parseQuantity(line.quantity)) return bad;
      if (deps.toAtomic(item.unit_price, token) !== line.unitPriceAtomic || deps.toAtomic(item.amount, token) !== line.amountAtomic) return bad;
    }
    if ((body.from_domain ?? null) !== (res.from_domain ?? null)) return bad;
    const parsed = deps.parseLink(res.solana_pay_url, ctx.hosts);
    if (parsed.kind !== "transfer") return bad;
    const r = parsed.request;
    if (r.recipient !== body.recipient || r.splToken !== (token === "USDC" ? USDC_MINT : undefined) || !r.references.includes(res.reference)) return bad;
    if (r.amount === undefined || deps.toAtomic(r.amount, token) !== priced.totalAtomic) return bad;
    // The id must commit to these exact terms, or a payer's pay_link would refuse the invoice.
    if (!idMatchesTerms(res.id, { recipient: body.recipient, token, amountAtomic: priced.totalAtomic, reference: res.reference })) return bad;
    return null;
  } catch {
    return bad;
  }
}

function apiRefusal(error: ApiError): string {
  switch (error.code) {
    case "rate_limited": return "Owed is limiting new requests for this wallet right now. Try again in a few minutes.";
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
