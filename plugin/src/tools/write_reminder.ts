import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { tokenSchema, type GetRequestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { TOKENS, type Token } from "../money.js";
import { atomicAmount } from "../paybox.js";
import { clean, explorerUrl } from "../text.js";
import { checkPayments, type CheckResult } from "./check_payments.js";

// A nudge for someone who hasn't paid yet. It reads the request's status first and never writes a
// reminder for a request that is paid or cancelled, or whose status can't be read right now.

export const REMINDER_BUDGET_MS = 8500;

const toneSchema = z.enum(["friendly", "firm", "formal"]);
const channelSchema = z.enum(["sms", "whatsapp", "email"]);

export const inputSchema = z.object({
  request: z.string().min(1).max(2048).describe("The request to chase: an Owed request id, an Owed link, or a Solana Pay transfer link with a reference."),
  tone: toneSchema.default("friendly").describe('"friendly" (default), "firm" or "formal".'),
  channel: channelSchema.default("sms").describe('"sms" (default), "whatsapp" or "email" (adds a subject line).'),
}).strict();

export const outputSchema = z.object({
  status: z.enum(["open", "underpaid", "paid", "cancelled"]),
  text: z.string().nullable().describe("The reminder to send, or null when there is nothing to chase."),
  subject: z.string().optional().describe("Email only."),
  tone: toneSchema,
  channel: channelSchema,
  id: z.string().optional(),
  link: z.string().optional().describe("The pay link inside the reminder."),
  amount_due: z.string().optional(),
  token: tokenSchema.optional(),
  days_outstanding: z.number().int().nonnegative().optional(),
  explorer_url: z.string().optional().describe("The payment, when it is already paid."),
}).strict();

export type ReminderInput = z.output<typeof inputSchema>;
export type ReminderOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Draft a reminder for someone who hasn't paid an Owed request yet: friendly, firm or formal, for SMS, WhatsApp or email, with the pay link and how many days it has been outstanding.",
  "Use it when the user says \"remind Priya\", \"nudge Sam about the 15 USDC\" or \"write a firm follow-up\".",
  "Pass the request's id or link (from ask_for_money, split_bill or who_owes_me). It checks the payment on Solana first:",
  "if it is already paid it returns text null and says so, so nobody is chased for money they sent. Show the user the text; Owed sends nothing itself.",
].join(" ");

interface Facts {
  status: ReminderOutput["status"];
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
}

export async function writeReminder(args: ReminderInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  const input = args.request.trim();
  let parsed;
  try {
    parsed = deps.parseLink(input, ctx.hosts);
  } catch (error) {
    return refusal(errorText(error, "This isn't an Owed request id, Owed link or Solana Pay link."));
  }
  if (parsed.kind === "transaction") return refusal("This is a Solana Pay checkout link (transaction request), not a payment request Owed can chase.");

  const facts = parsed.kind === "owed"
    ? await owedFacts(parsed.id, ctx, deps, REMINDER_BUDGET_MS - (deps.now() - started))
    : await transferFacts(input, ctx, deps);
  if (typeof facts === "string") return refusal(facts);

  const days = facts.createdAt ? daysBetween(facts.createdAt, deps.now()) : undefined;
  const base: ReminderOutput = {
    status: facts.status, text: null, tone: args.tone, channel: args.channel, token: facts.token,
    ...(facts.id && { id: facts.id }),
    ...(days !== undefined && { days_outstanding: days }),
  };

  if (facts.status === "paid") {
    const when = facts.paidAt ? ` on ${longDate(facts.paidAt)}` : "";
    const tx = facts.signature ? explorerUrl(facts.signature) : undefined;
    const output: ReminderOutput = { ...base, ...(tx && { explorer_url: tx }) };
    const paid = `${facts.amountPaid ?? facts.amount} ${facts.token}${when}`;
    const lead = facts.payerName ? `${facts.payerName} already paid ${paid}` : `This request is already paid (${paid})`;
    return text(`${lead}, so there is nothing to chase.${tx ? ` Payment: ${tx}` : ""}`, output);
  }
  if (facts.status === "cancelled") {
    return text("This request was cancelled, so there is nothing to chase.", base);
  }

  const draft = compose(facts, args.tone, args.channel, days);
  const output: ReminderOutput = {
    ...base, text: draft.body, amount_due: facts.amountDue,
    ...(draft.subject && { subject: draft.subject }),
    ...(draft.link && { link: draft.link }),
  };
  const lines = [
    facts.status === "underpaid"
      ? `Underpaid: ${facts.amountPaid} of ${facts.amount} ${facts.token} arrived, ${facts.amountDue} ${facts.token} still due. A payment link can't take a top-up, so this reminder carries no link: create a new request for ${facts.amountDue} ${facts.token} with ask_for_money and send its link with it.`
      : `Still open${days === undefined ? "" : days === 0 ? " since today" : ` after ${dayCount(days)}`}: ${facts.amount} ${facts.token}. Reminder (${args.tone}, ${args.channel}) for the user to send:`,
    ...(draft.subject ? [`Subject: ${draft.subject}`] : []),
    draft.body,
  ];
  return text(lines.join("\n"), output);
}

function text(t: string, output: ReminderOutput) {
  return { content: [{ type: "text" as const, text: t }], structuredContent: output };
}

async function owedFacts(id: string, ctx: CallContext, deps: Deps, budgetMs: number): Promise<Facts | string> {
  const unreadable = "Owed couldn't read this request's status right now, so no reminder was written (it might already be paid). Try again shortly.";
  let r: GetRequestRes | null;
  try {
    r = await within(ctx.api.getRequest(id), budgetMs, () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return "No Owed request has this id.";
    if (error instanceof ApiError && error.code === "invalid_input") return `Owed couldn't read this request: ${error.message}`;
    return unreadable;
  }
  if (!r) return unreadable;
  if (r.status === "not_found" || r.status === "invalid") return "No Owed request has this id.";
  const paid = r.paid ?? undefined;
  return {
    status: r.status,
    id: r.id,
    link: `${ctx.base}/r/${r.id}`,
    amount: r.amount,
    token: r.token,
    amountPaid: paid?.amount,
    amountDue: remainder(r.amount, r.status === "underpaid" ? paid?.amount : undefined, r.token, deps),
    payerName: clean(r.payer_name, 40) || undefined,
    requesterName: clean(r.requester_name, 40) || undefined,
    forText: clean(r.for, 80) || undefined,
    createdAt: r.created_at,
    signature: paid?.signature,
    paidAt: paid?.at,
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
    link: input.startsWith("https://") ? input : `${ctx.base}/p?u=${encodeURIComponent(solanaUrl)}`,
    amount: request.amount,
    token,
    amountPaid: result.amount_paid,
    amountDue: remainder(request.amount, result.status === "underpaid" ? result.amount_paid : undefined, token, deps),
    requesterName: clean(request.label, 40) || undefined,
    forText: clean(request.message, 80) || undefined,
    signature: result.signature,
    paidAt: result.paid_at,
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

/** Every value that reaches the text has been through clean(); `for` is always shown in quotes. */
export function compose(f: Facts, tone: ReminderInput["tone"], channel: ReminderInput["channel"], days: number | undefined): Draft {
  const underpaid = f.status === "underpaid";
  const link = underpaid ? undefined : f.link;
  const what = f.forText ? ` for "${f.forText.replace(/"/g, "'")}"` : "";
  const money = `${f.amount} ${f.token}`;
  const due = `${f.amountDue} ${f.token}`;
  const hi = { friendly: f.payerName ? `Hi ${f.payerName}` : "Hi", firm: f.payerName ? `Hi ${f.payerName}` : "Hello", formal: f.payerName ? `Dear ${f.payerName}` : "Hello" }[tone];
  const from = f.requesterName;
  const ago = since(days);
  const when = { friendly: ago ? ` from ${ago}` : "", firm: "", formal: f.createdAt ? `, requested on ${longDate(f.createdAt)},` : "" }[tone];
  const outstanding = days !== undefined && days > 0 ? ` It has been outstanding for ${dayCount(days)}.` : "";
  const how = "You can pay from any Solana wallet (Phantom, Solflare, Backpack), or ask your own AI agent to pay it with PayBox.";

  let ask: string;
  if (underpaid) {
    ask = {
      friendly: `thanks for the ${f.amountPaid} ${f.token}${what}! The total was ${money}, so ${due} is still to go. I'll send you a link for the rest.`,
      firm: `I received ${f.amountPaid} of the ${money}${what}. ${due} is still outstanding.${outstanding} I'll send a link for the remainder; please pay it today.`,
      formal: `we have received ${f.amountPaid} ${f.token} of the ${money}${what}. The remaining ${due} is outstanding.${outstanding} A payment link for the remainder will follow.`,
    }[tone];
  } else {
    ask = {
      friendly: `just a friendly reminder about the ${money}${what}${when}.`,
      firm: `the ${money}${what} is still unpaid.${outstanding} Please pay it today.`,
      formal: `this is a reminder that payment of ${money}${what}${when} remains outstanding${days ? ` after ${dayCount(days)}` : ""}.`,
    }[tone];
  }
  const thanks = { friendly: "Thanks!", firm: "Thank you.", formal: "Kind regards," }[tone];

  if (channel === "email") {
    const subject = underpaid
      ? { friendly: `The rest of the ${money}${what}`, firm: `${due} still outstanding${what}`, formal: `Outstanding balance: ${due}${what}` }[tone]
      : {
        friendly: `Quick reminder: ${money}${what}`,
        firm: `Payment overdue: ${money}${what}${days ? ` (${dayCount(days)})` : ""}`,
        formal: `Payment reminder: ${money}${what}${f.createdAt ? `, requested ${longDate(f.createdAt)}` : ""}`,
      }[tone];
    const paragraphs = [`${hi},`, capitalize(ask)];
    if (link) paragraphs.push(`Pay here: ${link}\n${how}`);
    paragraphs.push(from ? `${thanks}\n${from}` : thanks.replace(/,$/, ""));
    return { subject, body: paragraphs.join("\n\n"), link };
  }

  const sign = from ? (tone === "formal" ? ` Regards, ${from}` : ` – ${from}`) : "";
  if (channel === "whatsapp") {
    const lines = [`${hi}, ${ask}`];
    if (link) lines.push(`Pay here: ${link}`, "Any Solana wallet works, or your AI agent can pay it with PayBox.");
    lines.push(from ? (tone === "formal" ? `${thanks} ${from}` : `${thanks} – ${from}`) : thanks.replace(/,$/, ""));
    return { body: lines.join("\n"), link };
  }
  // SMS: one short paragraph.
  const pay = link ? ` Pay here: ${link}` : "";
  return { body: `${hi}, ${ask}${pay}${tone === "formal" ? "" : ` ${thanks}`}${sign}`.trim(), link };
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
