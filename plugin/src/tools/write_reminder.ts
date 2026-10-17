import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { tokenSchema, type GetRequestRes, type GroupRes, type InvoiceRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { TOKENS, type Token } from "../money.js";
import { atomicAmount } from "../paybox.js";
import { domainLabel, PAYEE_BUDGET_MS, recordHowTo, verifyPayee, type PayeeResult } from "../payee.js";
import { brandFlags, brandWordsFromFlags, clean, explorerUrl } from "../text.js";
import { basescanTx } from "../evm.js"; // W3-B
import { checkPayments, type CheckResult } from "./check_payments.js";

// A nudge for someone who hasn't paid yet. It reads the request's status first and never writes a
// reminder for a request that is paid or cancelled, or whose status can't be read right now.
// Works on a request (/r), one share of a split bill (/r), a whole split bill (/g: one message for the
// group chat naming who still owes) and an invoice (/i: number and due date). When the request names a
// payee domain, the plugin checks DNS itself (W2-H) before the reminder says "verified".

export const REMINDER_BUDGET_MS = 8500;

/** QA-20: Owed can't tell who created a request that pays the user's wallet; said with every draft. */
export const REMINDER_CAUTION =
  "Before sending: anyone can create a request that pays your wallet, and Owed can't tell whether you made this one. Check the name and amount.";

/** W2-H's verifyPayee (plugin/src/payee.ts), injected so tests can replay recorded DNS answers. */
export type VerifyPayee = (domain: string, address: string, budgetMs: number, deps: Deps) => Promise<PayeeResult>;
const defaultVerify: VerifyPayee = (domain, address, budgetMs, deps) => verifyPayee(domain, address, budgetMs, deps);

const toneSchema = z.enum(["friendly", "firm", "formal"]);
const channelSchema = z.enum(["sms", "whatsapp", "email"]);

export const inputSchema = z.object({
  request: z.string().min(1).max(2048).describe(
    "What to chase: an Owed request id or link (/r/…), one split-bill share's link, a split bill's board link (/g/…, one message for the group naming who still owes), an invoice link (/i/…), or a Solana Pay transfer link with a reference.",
  ),
  tone: toneSchema.default("friendly").describe('"friendly" (default), "firm" or "formal".'),
  channel: channelSchema.default("sms").describe('"sms" (default), "whatsapp" or "email" (adds a subject line).'),
}).strict();

const unpaidShareSchema = z.object({
  name: z.string().describe("Written by the requester; unverified."),
  amount_due: z.string(),
  link: z.string().describe("This share's own pay link, for a one-to-one reminder."),
}).strict();

export const outputSchema = z.object({
  status: z.enum(["open", "underpaid", "paid", "cancelled"]),
  kind: z.enum(["single", "split_share", "invoice", "group"]).optional()
    .describe("group = a whole split bill (its board link); split_share = one person's share."),
  text: z.string().nullable().describe("The reminder to send, or null when there is nothing to chase."),
  subject: z.string().optional().describe("Email only."),
  tone: toneSchema,
  channel: channelSchema,
  id: z.string().optional(),
  link: z.string().optional().describe("The pay link inside the reminder."),
  amount_due: z.string().optional(),
  token: tokenSchema.optional(),
  days_outstanding: z.number().int().nonnegative().optional(),
  due_date: z.string().optional().describe("Invoices: the due date, YYYY-MM-DD."),
  days_overdue: z.number().int().nonnegative().optional().describe("Invoices past their due date."),
  from_domain: z.string().optional().describe("The payee domain the reminder names: checked over DNS by the plugin just now."),
  paid_count: z.number().int().nonnegative().optional().describe("Split bills: shares paid."),
  share_count: z.number().int().nonnegative().optional().describe("Split bills: shares in the bill."),
  unpaid: z.array(unpaidShareSchema).optional().describe("Split bills: who still owes, each with their own link."),
  caution: z.string().optional().describe("Show the user before they send: Owed can't tell whether they made this request."),
  explorer_url: z.string().optional().describe("The payment, when it is already paid."),
}).strict();

export type ReminderInput = z.output<typeof inputSchema>;
export type ReminderOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Draft a reminder for someone who hasn't paid an Owed request yet: friendly, firm or formal, for SMS, WhatsApp or email, with the pay link and how many days it has been outstanding.",
  "Use it when the user says \"remind Priya\", \"nudge Sam about the 15 USDC\", \"chase the invoice\" or \"write a firm follow-up\".",
  "Pass the id or link from ask_for_money, split_bill, create_invoice or who_owes_me. A split bill's board link (/g/…) gives one message for the group chat naming who still owes; one person's share link gives a reminder for them.",
  "Invoice reminders (/i/…) name the invoice number and due date. It checks the payment on Solana first:",
  "if it is already paid it returns text null and says so, so nobody is chased for money they sent. Show the user the text; Owed sends nothing itself.",
].join(" ");

interface Facts {
  status: ReminderOutput["status"];
  kind: NonNullable<ReminderOutput["kind"]>;
  id?: string;
  link: string;
  amount: string;
  token: Token;
  amountPaid?: string;
  amountDue: string;
  payerName?: string;
  requesterName?: string;
  forText?: string;
  createdAt?: string;
  signature?: string;
  paidAt?: string;
  /** For the DNS check; set for Owed requests. */
  recipient?: string;
  /** The payee domain the request claims (server's display copy); checked over DNS before it is named. */
  claimedDomain?: string;
  /** Verified just now, so the reminder names it. */
  verifiedDomain?: string;
  /** Split shares and bills: the bill's title. */
  groupTitle?: string;
  /** Invoices. */
  invoiceNumber?: string;
  dueDate?: string;
  /** Whole split bills. */
  shares?: { paid: number; total: number; unpaid: Array<{ name: string; amountDue: string; link: string }> };
  /** Safety flags (`brand_word:<w>`), from the server and from the text read here. */
  flags: string[];
  /** W3-B: a request on Base (USDC on chain 8453): paid from Base wallets, receipts on Basescan. */
  base?: boolean;
}

export async function writeReminder(args: ReminderInput, deps: Deps = defaultDeps, verify: VerifyPayee = defaultVerify) {
  const started = deps.now();
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  const input = args.request.trim();
  const budget = () => REMINDER_BUDGET_MS - (deps.now() - started);
  let facts: Facts | string;
  const groupId = owedPathId(input, ctx.hosts, "g");
  if (groupId) {
    facts = await groupFacts(groupId, ctx, deps, budget());
  } else {
    let parsed;
    try {
      parsed = deps.parseLink(input, ctx.hosts);
    } catch (error) {
      return refusal(errorText(error, "This isn't an Owed request id, Owed link or Solana Pay link."));
    }
    if (parsed.kind === "transaction") return refusal("This is a Solana Pay checkout link (transaction request), not a payment request Owed can chase.");
    facts = parsed.kind === "owed"
      ? await owedFacts(parsed.id, owedPathId(input, ctx.hosts, "i") !== null, ctx, deps, budget)
      : await transferFacts(input, ctx, deps);
  }
  if (typeof facts === "string") return refusal(facts);

  const now = deps.now();
  const days = facts.createdAt ? daysBetween(facts.createdAt, now) : undefined;
  const overdue = facts.dueDate ? daysPastDue(facts.dueDate, now) : undefined;
  const base: ReminderOutput = {
    status: facts.status, kind: facts.kind, text: null, tone: args.tone, channel: args.channel, token: facts.token,
    ...(facts.id && { id: facts.id }),
    ...(days !== undefined && { days_outstanding: days }),
    ...(facts.dueDate && { due_date: facts.dueDate }),
    ...(overdue !== undefined && overdue > 0 && { days_overdue: overdue }),
    ...(facts.shares && { paid_count: facts.shares.paid, share_count: facts.shares.total }),
  };

  if (facts.status === "paid") {
    if (facts.shares) {
      return text(`Everyone has paid: ${facts.shares.paid} of ${facts.shares.total} shares${facts.groupTitle ? ` of "${facts.groupTitle}"` : ""}, ${facts.amount} ${facts.token} in total, so there is nothing to chase.`, base);
    }
    const when = facts.paidAt ? ` on ${longDate(facts.paidAt)}` : "";
    const tx = facts.signature ? (facts.base ? basescanTx(facts.signature) : explorerUrl(facts.signature)) : undefined; // W3-B
    const output: ReminderOutput = { ...base, ...(tx && { explorer_url: tx }) };
    const paid = `${facts.amountPaid ?? facts.amount} ${facts.token}${when}`;
    const what = facts.kind === "invoice" ? `This invoice is already paid (${paid})` : `This request is already paid (${paid})`;
    const lead = facts.payerName ? `${facts.payerName} already paid ${paid}` : what;
    return text(`${lead}, so there is nothing to chase.${tx ? ` Payment: ${tx}` : ""}`, output);
  }
  if (facts.status === "cancelled") {
    return text("This request was cancelled, so there is nothing to chase.", base);
  }

  // QA-20: anyone can create a request that pays the user's wallet. One that name-drops a brand scams use
  // ("IRS penalty", "PayBox refund") is not chased on Owed's word.
  const brands = brandWordsFromFlags([
    ...facts.flags,
    ...brandFlags(facts.payerName, facts.forText, facts.groupTitle, facts.invoiceNumber, facts.requesterName, ...(facts.shares?.unpaid.map((u) => u.name) ?? [])),
  ]);
  if (brands.length > 0) {
    const list = brands.map((w) => `"${w}"`).join(", ");
    return refusal(
      `No reminder drafted: this ${facts.kind === "group" ? "split bill" : facts.kind === "invoice" ? "invoice" : "request"} mentions ${list}, a word scams use to look official, `
      + "and anyone can create a request that pays your wallet, so Owed can't tell whether you made it. If you did, write to the person yourself.",
    );
  }

  // Only now, with something to chase: the payee domain is named only if DNS still publishes the wallet.
  const domainNote: string[] = [];
  if (facts.claimedDomain && facts.recipient) {
    const payee = await within(
      verify(facts.claimedDomain, facts.recipient, Math.min(PAYEE_BUDGET_MS, budget() - 300), deps),
      Math.max(0, budget() - 200),
      () => ({ status: "dns_unavailable", domain: facts.claimedDomain!, display_domain: facts.claimedDomain!, dnssec: false, records: 0, warnings: [] }) as PayeeResult,
    );
    const label = domainLabel(payee) || clean(facts.claimedDomain, 60);
    if (payee.status === "verified") {
      facts.verifiedDomain = label;
      domainNote.push(`${payee.domain} still publishes this wallet (checked over DNS just now), so the reminder names it.`, ...payee.warnings);
    } else if (payee.status === "unverified") {
      return refusal(
        `This request claims to be from ${label}, but ${label} no longer publishes this wallet, so a payer's agent would refuse to pay it. No reminder was written. `
        + `To fix it, ${recordHowTo(payee.domain, facts.recipient)}, then try again; or create a new request without from_domain.`,
      );
    } else {
      domainNote.push(`DNS couldn't be checked just now, so the reminder doesn't name ${label}. A payer's agent checks it again before paying.`);
    }
  }

  const draft = facts.shares ? composeGroup(facts, args.tone, args.channel, days) : compose(facts, args.tone, args.channel, days, overdue);
  const output: ReminderOutput = {
    ...base, text: draft.body, amount_due: facts.amountDue,
    ...(draft.subject && { subject: draft.subject }),
    ...(draft.link && { link: draft.link }),
    ...(facts.verifiedDomain && { from_domain: facts.verifiedDomain }),
    ...(facts.shares && { unpaid: facts.shares.unpaid.map((u) => ({ name: u.name, amount_due: u.amountDue, link: u.link })) }),
    caution: REMINDER_CAUTION,
  };
  const waited = days === undefined ? "" : days === 0 ? " since today" : ` after ${dayCount(days)}`;
  const lead = facts.shares
    ? `${facts.shares.paid} of ${facts.shares.total} paid${waited}; ${facts.amountDue} ${facts.token} still due. Group reminder (${args.tone}, ${args.channel}) for the user to send:`
    : facts.status === "underpaid"
      ? `Underpaid: ${facts.amountPaid} of ${facts.amount} ${facts.token} arrived, ${facts.amountDue} ${facts.token} still due. A payment link can't take a top-up, so this reminder carries no link: create a new request for ${facts.amountDue} ${facts.token} with ask_for_money and send its link with it.`
      : facts.kind === "invoice" && facts.dueDate
        ? `Invoice ${overdue !== undefined && overdue > 0 ? `${dayCount(overdue)} overdue` : `due ${longDate(facts.dueDate)}`}: ${facts.amount} ${facts.token}. Reminder (${args.tone}, ${args.channel}) for the user to send:`
        : `Still open${waited}: ${facts.amount} ${facts.token}. Reminder (${args.tone}, ${args.channel}) for the user to send:`;
  const lines = [
    lead,
    REMINDER_CAUTION,
    ...domainNote,
    ...(draft.subject ? [`Subject: ${draft.subject}`] : []),
    draft.body,
  ];
  return text(lines.join("\n"), output);
}

function text(t: string, output: ReminderOutput) {
  return { content: [{ type: "text" as const, text: t }], structuredContent: output };
}

const OWED_ID = /^[1-9A-HJ-NP-Za-km-z]{12}$/;

/** The id in an https Owed link whose path is /<page>/<id>, or null. */
export function owedPathId(input: string, hosts: string[], page: "g" | "i"): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !hosts.includes(url.host.toLowerCase())) return null;
  const match = /^\/([gi])\/([^/]+)\/?$/.exec(url.pathname);
  return match && match[1] === page && OWED_ID.test(match[2]!) ? match[2]! : null;
}

const UNREADABLE = "Owed couldn't read this request's status right now, so no reminder was written (it might already be paid). Try again shortly.";

const GROUP_UNREADABLE = "Owed couldn't read this split bill right now, so no reminder was written (some shares might already be paid). Try again shortly.";

function apiProblem(error: unknown, what: "request" | "invoice" | "split bill"): string {
  if (error instanceof ApiError && error.code === "not_found") return `No Owed ${what} has this id.`;
  if (error instanceof ApiError && error.code === "invalid_input") return `Owed couldn't read this ${what}: ${error.message}`;
  return what === "split bill" ? GROUP_UNREADABLE : UNREADABLE;
}

async function owedFacts(id: string, invoiceLink: boolean, ctx: CallContext, deps: Deps, budget: () => number): Promise<Facts | string> {
  // An /i/ link is an invoice: its own endpoint has the status too, so one read is enough.
  if (invoiceLink) return invoiceFacts(id, ctx, deps, budget());
  let r: GetRequestRes | null;
  try {
    r = await within(ctx.api.getRequest(id), budget(), () => null);
  } catch (error) {
    return apiProblem(error, "request");
  }
  if (!r) return UNREADABLE;
  if (r.status === "not_found" || r.status === "invalid") return "No Owed request has this id.";
  if (r.kind === "invoice" && (r.status === "open" || r.status === "underpaid")) {
    const invoice = await invoiceFacts(id, ctx, deps, budget());
    if (typeof invoice !== "string") return invoice;
    // The request alone still makes a reminder; only the number and due date are missing.
  }
  const paid = r.paid ?? undefined;
  const share = r.kind === "split_share";
  const forText = clean(r.for, 80) || undefined;
  return {
    status: r.status,
    kind: share ? "split_share" : r.kind === "invoice" ? "invoice" : "single",
    id: r.id,
    link: `${ctx.base}/${r.kind === "invoice" ? "i" : "r"}/${r.id}`,
    amount: r.amount,
    token: r.token,
    amountPaid: paid?.amount,
    amountDue: remainder(r.amount, r.status === "underpaid" ? paid?.amount : undefined, r.token, deps),
    payerName: clean(r.payer_name, 40) || undefined,
    requesterName: clean(r.requester_name, 40) || undefined,
    // A share's `for` is its bill's title.
    forText: share ? undefined : forText,
    groupTitle: share ? clean(r.for, 60) || undefined : undefined,
    createdAt: r.created_at,
    signature: paid?.signature,
    paidAt: paid?.at,
    recipient: r.recipient,
    claimedDomain: r.from_domain || undefined,
    flags: r.flags,
    ...(r.chain === "base" && { base: true }), // W3-B
  };
}

async function invoiceFacts(id: string, ctx: CallContext, deps: Deps, budgetMs: number): Promise<Facts | string> {
  let inv: InvoiceRes | null;
  try {
    inv = await within(ctx.api.getInvoice(id), budgetMs, () => null);
  } catch (error) {
    return apiProblem(error, "invoice");
  }
  if (!inv) return UNREADABLE;
  if (inv.status === "not_found" || inv.status === "invalid") return "No Owed invoice has this id.";
  const paid = inv.paid ?? undefined;
  return {
    status: inv.status,
    kind: "invoice",
    id: inv.id,
    link: `${ctx.base}/i/${inv.id}`,
    amount: inv.total,
    token: inv.token,
    amountPaid: paid?.amount,
    amountDue: remainder(inv.total, inv.status === "underpaid" ? paid?.amount : undefined, inv.token, deps),
    payerName: clean(inv.client_name, 60) || undefined,
    requesterName: clean(inv.business_name, 60) || undefined,
    // The invoice page shows its id when it has no number.
    invoiceNumber: clean(inv.invoice_number, 20) || inv.id,
    dueDate: inv.due_date,
    createdAt: inv.created_at,
    signature: paid?.signature,
    paidAt: paid?.at,
    recipient: inv.recipient,
    claimedDomain: inv.from_domain || undefined,
    flags: inv.flags,
  };
}

/** A whole split bill: who still owes, from its board. */
async function groupFacts(id: string, ctx: CallContext, deps: Deps, budgetMs: number): Promise<Facts | string> {
  let g: GroupRes | null;
  try {
    g = await within(ctx.api.getGroup(id), budgetMs, () => null);
  } catch (error) {
    return apiProblem(error, "split bill");
  }
  if (!g) return GROUP_UNREADABLE;
  const decimals = TOKENS[g.token].decimals;
  let due = 0n;
  let paid = 0;
  const unpaid: Array<{ name: string; amountDue: string; link: string }> = [];
  g.shares.forEach((share, index) => {
    if (share.status === "paid") return void (paid += 1);
    if (share.status !== "open" && share.status !== "underpaid") return;
    const left = remainder(share.amount, share.status === "underpaid" ? share.paid?.amount : undefined, g!.token, deps);
    try {
      due += BigInt(atomicAmount(left, decimals));
    } catch {
      // an amount the contract already checked; never reached
    }
    unpaid.push({ name: clean(share.name, 40) || `Share ${index + 1}`, amountDue: left, link: `${ctx.base}/r/${share.id}` });
  });
  return {
    status: unpaid.length === 0 ? "paid" : "open",
    kind: "group",
    id: g.id,
    link: `${ctx.base}/g/${g.id}`,
    amount: g.total,
    token: g.token,
    amountDue: deps.fromAtomic(due, g.token),
    requesterName: clean(g.requester_name, 40) || undefined,
    groupTitle: clean(g.title, 60) || undefined,
    createdAt: g.created_at,
    recipient: g.recipient,
    claimedDomain: g.from_domain || undefined,
    shares: { paid, total: g.shares.length, unpaid },
    flags: g.flags,
  };
}

/** A raw Solana Pay link (or an offline /p?u= link): status through check_payments, wording from the link. */
async function transferFacts(input: string, ctx: CallContext, deps: Deps): Promise<Facts | string> {
  const parsed = deps.parseLink(input, ctx.hosts);
  if (parsed.kind !== "transfer") return "This isn't a payment link Owed can chase.";
  const request = parsed.request;
  if (request.amount === undefined) return "This link doesn't set an amount, so there is no amount to remind anyone about.";
  const checked = await checkPayments({ requests: [input] }, deps);
  if ("isError" in checked) return textOf(checked);
  const result: CheckResult | undefined = checked.structuredContent.results[0];
  if (!result || !result.token) return "This link couldn't be read as a payment request.";
  if (result.status === "unknown") return "Solana couldn't be read right now, so no reminder was written (it might already be paid). Try again shortly.";
  if (result.status !== "open" && result.status !== "paid" && result.status !== "underpaid") return result.error ?? "This link isn't a payment request Owed can chase.";
  const token = result.token;
  const solanaUrl = input.startsWith("solana:") ? input : deps.buildTransferUrl(request);
  return {
    status: result.status,
    kind: "single",
    link: input.startsWith("https://") ? input : `${ctx.base}/p?u=${encodeURIComponent(solanaUrl)}`,
    amount: request.amount,
    token,
    amountPaid: result.amount_paid,
    amountDue: remainder(request.amount, result.status === "underpaid" ? result.amount_paid : undefined, token, deps),
    requesterName: clean(request.label, 40) || undefined,
    forText: clean(request.message, 80) || undefined,
    signature: result.signature,
    paidAt: result.paid_at,
    flags: brandFlags(request.label, request.message, request.memo),
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join(" ").trim() || "This link couldn't be checked.";
}

function remainder(amount: string, paid: string | undefined, token: Token, deps: Deps): string {
  if (!paid) return amount;
  try {
    const decimals = TOKENS[token].decimals;
    const due = BigInt(atomicAmount(amount, decimals)) - BigInt(atomicAmount(paid, decimals));
    return due > 0n ? deps.fromAtomic(due, token) : "0";
  } catch {
    return amount;
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "17 October 2026" (UTC). */
export function longDate(iso: string): string {
  const d = new Date(Date.parse(iso));
  return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : iso;
}

/** Whole UTC days a YYYY-MM-DD due date is behind `now`'s date: 0 on the day, negative before it. */
export function daysPastDue(dueDate: string, now: number): number | undefined {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  if (!Number.isFinite(due)) return undefined;
  const d = new Date(now);
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - due) / 86_400_000);
}

/** Whole days from `iso` to `now`; 0 for the same day or a time in the future. */
export function daysBetween(iso: string, now: number): number | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

function dayCount(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/** "today", "yesterday", "3 days ago". */
function since(days: number | undefined): string {
  if (days === undefined) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

interface Draft {
  body: string;
  subject?: string;
  link?: string;
}

const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** An invoice number made of plain characters reads bare ("invoice 2026-114"); anything else is quoted. */
function invoiceRef(f: Facts): string {
  const n = f.invoiceNumber ?? f.id ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9./#_-]{0,19}$/.test(n) ? `invoice ${n}` : `invoice ${q(n)}`;
}

/** The payer's agent shows the same words before it pays (pay_link). */
function verifiedLine(f: Facts): string | undefined {
  return f.verifiedDomain ? `The link pays ${f.verifiedDomain} (verified by DNS).` : undefined;
}

/** Every value that reaches the text has been through clean(); `for`, titles and odd invoice numbers are quoted. */
export function compose(f: Facts, tone: ReminderInput["tone"], channel: ReminderInput["channel"], days: number | undefined, overdue?: number): Draft {
  const underpaid = f.status === "underpaid";
  const link = underpaid ? undefined : f.link;
  const invoice = f.kind === "invoice";
  const what = invoice
    ? ` for ${invoiceRef(f)}`
    : f.kind === "split_share" && f.groupTitle
      ? ` for your share of ${q(f.groupTitle)}`
      : f.forText ? ` for ${q(f.forText)}` : "";
  const money = `${f.amount} ${f.token}`;
  const due = `${f.amountDue} ${f.token}`;
  const hi = { friendly: f.payerName ? `Hi ${f.payerName}` : "Hi", firm: f.payerName ? `Hi ${f.payerName}` : "Hello", formal: f.payerName ? `Dear ${f.payerName}` : "Hello" }[tone];
  const from = f.requesterName;
  const ago = since(days);
  const when = { friendly: ago ? ` from ${ago}` : "", firm: "", formal: f.createdAt ? `, requested on ${longDate(f.createdAt)},` : "" }[tone];
  const outstanding = days !== undefined && days > 0 ? ` It has been outstanding for ${dayCount(days)}.` : "";
  const how = f.base // W3-B
    ? "You can pay from any Base wallet (MetaMask, Coinbase Wallet, Phantom), or ask your own AI agent to pay it with PayBox."
    : "You can pay from any Solana wallet (Phantom, Solflare, Backpack), or ask your own AI agent to pay it with PayBox.";

  let ask: string;
  if (underpaid) {
    ask = {
      friendly: `thanks for the ${f.amountPaid} ${f.token}${what}! The total was ${money}, so ${due} is still to go. I'll send you a link for the rest.`,
      firm: `I received ${f.amountPaid} of the ${money}${what}. ${due} is still outstanding.${outstanding} I'll send a link for the remainder; please pay it today.`,
      formal: `we have received ${f.amountPaid} ${f.token} of the ${money}${what}. The remaining ${due} is outstanding.${outstanding} A payment link for the remainder will follow.`,
    }[tone];
  } else if (invoice && f.dueDate) {
    const dueOn = longDate(f.dueDate);
    const late = overdue !== undefined && overdue > 0;
    const issued = f.createdAt ? `, issued on ${longDate(f.createdAt)},` : "";
    ask = late
      ? {
        friendly: `just a friendly reminder about the ${money}${what}, which was due on ${dueOn}.`,
        firm: `the ${money}${what} was due on ${dueOn} and is now ${dayCount(overdue)} overdue. Please pay it today.`,
        formal: `this is a reminder that payment of ${money}${what}${issued} was due on ${dueOn} and remains outstanding (${dayCount(overdue)} overdue).`,
      }[tone]
      : {
        friendly: `just a friendly reminder about the ${money}${what}, due on ${dueOn}.`,
        firm: `the ${money}${what} is due on ${dueOn}. Please pay it by then.`,
        formal: `this is a reminder that payment of ${money}${what}${issued} is due on ${dueOn}.`,
      }[tone];
  } else {
    ask = {
      friendly: `just a friendly reminder about the ${money}${what}${when}.`,
      firm: `the ${money}${what} is still unpaid.${outstanding} Please pay it today.`,
      formal: `this is a reminder that payment of ${money}${what}${when} remains outstanding${days ? ` after ${dayCount(days)}` : ""}.`,
    }[tone];
  }
  const verified = link ? verifiedLine(f) : undefined;
  const thanks = { friendly: "Thanks!", firm: "Thank you.", formal: "Kind regards," }[tone];

  if (channel === "email") {
    const late = overdue !== undefined && overdue > 0;
    const subject = underpaid
      ? { friendly: `The rest of the ${money}${what}`, firm: `${due} still outstanding${what}`, formal: `Outstanding balance: ${due}${what}` }[tone]
      : invoice && f.dueDate
        ? {
          friendly: `${capitalize(invoiceRef(f))}: ${money} due ${longDate(f.dueDate)}`,
          firm: late ? `Overdue: ${invoiceRef(f)}, ${money} (${dayCount(overdue)})` : `${capitalize(invoiceRef(f))}: ${money} due ${longDate(f.dueDate)}`,
          formal: `Payment reminder: ${invoiceRef(f)}, ${money}, due ${longDate(f.dueDate)}`,
        }[tone]
        : {
          friendly: `Quick reminder: ${money}${what}`,
          firm: `Payment overdue: ${money}${what}${days ? ` (${dayCount(days)})` : ""}`,
          formal: `Payment reminder: ${money}${what}${f.createdAt ? `, requested ${longDate(f.createdAt)}` : ""}`,
        }[tone];
    const paragraphs = [`${hi},`, capitalize(ask)];
    if (link) paragraphs.push([`Pay here: ${link}`, ...(verified ? [verified] : []), how].join("\n"));
    paragraphs.push(from ? `${thanks}\n${from}` : thanks.replace(/,$/, ""));
    return { subject, body: paragraphs.join("\n\n"), link };
  }

  const sign = from ? (tone === "formal" ? ` Regards, ${from}` : ` – ${from}`) : "";
  if (channel === "whatsapp") {
    const lines = [`${hi}, ${ask}`];
    if (link) lines.push(`Pay here: ${link}`, ...(verified ? [verified] : []), `Any ${f.base ? "Base" : "Solana"} wallet works, or your AI agent can pay it with PayBox.`); // W3-B
    lines.push(from ? (tone === "formal" ? `${thanks} ${from}` : `${thanks} – ${from}`) : thanks.replace(/,$/, ""));
    return { body: lines.join("\n"), link };
  }
  // SMS: one short paragraph.
  const pay = link ? ` Pay here: ${link}${verified ? ` ${verified}` : ""}` : "";
  return { body: `${hi}, ${ask}${pay}${tone === "formal" ? "" : ` ${thanks}`}${sign}`.trim(), link };
}

/** One message for a split bill's group chat: who has paid, who still owes, and the board to pay from. */
export function composeGroup(f: Facts, tone: ReminderInput["tone"], channel: ReminderInput["channel"], days: number | undefined): Draft {
  const { paid, total, unpaid } = f.shares!;
  const title = f.groupTitle ? q(f.groupTitle) : "the split bill";
  const list = unpaid.map((u) => `${u.name} (${u.amountDue} ${f.token})`).join(", ");
  const n = unpaid.length;
  const havePaid = `${paid} of ${total} ${paid === 1 ? "has" : "have"} paid`;
  const ago = since(days);
  const hi = tone === "formal" ? "Hello all" : "Hi all";
  const ask = {
    friendly: `a friendly reminder about ${title}${ago ? ` from ${ago}` : ""}: ${havePaid}. Still to pay: ${list}.`,
    firm: `${title} still isn't settled: ${havePaid}. Still to pay: ${list}. Please pay your share today.`,
    formal: `this is a reminder that ${n} of ${total} shares of ${title}${f.createdAt ? `, requested on ${longDate(f.createdAt)},` : ""} ${n === 1 ? "remains" : "remain"} outstanding: ${list}.`,
  }[tone];
  const verified = verifiedLine(f);
  const pay = `Pay your share here: ${f.link}`;
  const from = f.requesterName;
  const thanks = { friendly: "Thanks!", firm: "Thank you.", formal: "Kind regards," }[tone];

  if (channel === "email") {
    const subject = {
      friendly: `Reminder: ${title}, ${n} still to pay`,
      firm: `${capitalize(title)}: ${n} of ${total} shares unpaid`,
      formal: `Payment reminder: ${title}, ${n} of ${total} shares outstanding`,
    }[tone];
    const how = "Tap your name on the board to pay from any Solana wallet (Phantom, Solflare, Backpack), or ask your own AI agent to pay it with PayBox.";
    const paragraphs = [`${hi},`, capitalize(ask), [pay, ...(verified ? [verified] : []), how].join("\n"), from ? `${thanks}\n${from}` : thanks.replace(/,$/, "")];
    return { subject, body: paragraphs.join("\n\n"), link: f.link };
  }
  if (channel === "whatsapp") {
    const lines = [`${hi}, ${ask}`, pay, ...(verified ? [verified] : []), "Any Solana wallet works, or your AI agent can pay it with PayBox."];
    lines.push(from ? (tone === "formal" ? `${thanks} ${from}` : `${thanks} – ${from}`) : thanks.replace(/,$/, ""));
    return { body: lines.join("\n"), link: f.link };
  }
  const sign = from ? (tone === "formal" ? ` Regards, ${from}` : ` – ${from}`) : "";
  return { body: `${hi}, ${ask} ${pay}${verified ? ` ${verified}` : ""}${tone === "formal" ? "" : ` ${thanks}`}${sign}`, link: f.link };
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("write_reminder", {
    title: "Write a payment reminder",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => writeReminder(args, deps));
}
