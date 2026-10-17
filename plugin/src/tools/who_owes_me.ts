import type { McpServer } from "@modelcontextprotocol/server";
import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { addressSchema, tokenSchema, type LedgerEntry, type LedgerRes, type ScheduleSummary } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { ago, brandWordsFromFlags, clean, explorerUrl, quote, shortAddress } from "../text.js";
import { fiatOutput, fiatStatusLine } from "../local-currency.js"; // local-currency asks

// Two calls. Without a signature: the exact message to sign. The agent signs it with PayBox's
// request_wallet_sign {op:"solanaMessage"} (passkey approval), then calls again with the message and the
// signature, and Owed's server returns the ledger for that wallet once. The server checks everything again;
// the checks here only spare a round trip and give a clear reason.

export const LEDGER_BUDGET_MS = 8500;

/**
 * QA-20. Creating a request needs no proof from the recipient, so a wallet's ledger can hold rows a
 * stranger made. Same words as web/lib/ledger.ts LEDGER_CAUTION / LEDGER_TOTALS_NOTE (web/test/ledger.test.ts
 * checks they match); write_reminder uses them too.
 */
export const LEDGER_CAUTION =
  "Anyone can create a request that pays your wallet; Owed can't tell which ones you made. Check names and amounts before chasing anyone.";
export const LEDGER_TOTALS_NOTE = "Totals include requests anyone could have made.";
/** The server checks open requests on chain before it answers; a timeout would spend the signature for nothing. */
export const LEDGER_API_TIMEOUT_MS = 7000;
export const MESSAGE_VALID_MS = 5 * 60_000;
const MAX_SKEW_MS = 60_000;
const MAX_LINES = 25;

export const inputSchema = z.object({
  recipient: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials): whose ledger to show."),
  signed_message: z.string().min(1).max(200).optional()
    .describe("Second call only: the exact message_to_sign from the first call."),
  signature: z.string().min(64).max(200).optional()
    .describe("Second call only: the signature request_wallet_sign returned for that message (hex as PayBox returns it; base58 or base64 also work)."),
  // W3-D
  csv: z.boolean().optional()
    .describe("Second call only: also return a link to download every open and paid request as a CSV file (for accounting). The link works for 10 minutes."),
}).strict();

const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(["single", "split_share", "invoice"]).describe("single request, one share of a split bill, or an invoice."),
  link: z.string().describe("Where the payer pays: the invoice page for an invoice, else the request's pay page."),
  status: z.enum(["open", "underpaid", "paid"]),
  amount: z.string(),
  token: tokenSchema,
  amount_due: z.string().optional().describe("What is still owed (open and underpaid only)."),
  amount_paid: z.string().optional(),
  payer_name: z.string().optional().describe("Written by whoever created the request (anyone can); unverified."),
  for: z.string().optional().describe("Written by whoever created the request (anyone can); unverified."),
  created_at: z.string(),
  waited: z.string().optional().describe('How long an unpaid request has been open, e.g. "2d 4h".'),
  payer: z.string().optional(),
  paid_at: z.string().optional(),
  explorer_url: z.string().optional(),
  group_id: z.string().optional().describe("Split shares: the bill's group id."),
  group_title: z.string().optional().describe("Split shares: the bill's title. Written by whoever created it; unverified."),
  group_link: z.string().optional().describe("Split shares: the bill's board, showing who has paid."),
  invoice_number: z.string().optional().describe("Invoices: the invoice number. Written by whoever created it; unverified."),
  due_date: z.string().optional().describe("Invoices: the due date, YYYY-MM-DD."),
  from_domain: z.string().optional().describe("The payee domain the request was created with (DNS-verified then)."),
  caution: z.string().optional().describe("Set when the request mentions a brand word scams use (e.g. IRS, PayBox, refund); write_reminder won't chase it."),
  // W3-D
  schedule_id: z.string().optional().describe("Monthly requests: the ask_every_month schedule that opened this one."),
  period: z.string().optional().describe('Monthly requests: the month this one is for, "YYYY-MM".'),
  fiat: fiatOutput.optional(), // local-currency asks: the quote behind amount (USDC)
}).strict();

// W3-D: monthly schedules (ask_every_month) as the ledger lists them.
const scheduleSchema = z.object({
  id: z.string(),
  status: z.string().describe("active, ended (its months ran out) or stopped."),
  amount: z.string(),
  token: tokenSchema,
  payer_name: z.string().optional().describe("Written by whoever set the schedule up; unverified."),
  for: z.string().optional().describe("Written by whoever set the schedule up; unverified."),
  day_of_month: z.number().int(),
  months: z.number().int().nullable().describe("Total monthly requests; null = no end date."),
  requests_opened: z.number().int(),
  next_request_on: z.string().nullable().describe('"YYYY-MM-DD" (UTC); null once ended.'),
  from_domain: z.string().optional(),
  last_error: z.string().optional().describe("Why the last due month's request couldn't be opened (it is retried daily)."),
  requests: z.array(z.object({ period: z.string(), id: z.string(), link: z.string(), status: z.string() }).strict())
    .describe("Recent months' requests, newest first."),
}).strict();

export const outputSchema = z.object({
  step: z.enum(["sign", "ledger"]).describe("sign = sign message_to_sign and call again; ledger = the result."),
  recipient: z.string(),
  caution: z.string().optional().describe("Show this to the user with the ledger: anyone can create a request that pays their wallet."),
  message_to_sign: z.string().optional(),
  expires_at: z.string().optional(),
  open: z.array(entrySchema).optional(),
  paid_recently: z.array(entrySchema).optional().describe("Paid in the last 30 days, newest first."),
  outstanding_total: z.string().optional().describe('e.g. "15 USDC + 0.5 SOL", or "0 USDC". Includes requests anyone could have made.'),
  received_30d: z.string().optional(),
  chain_checked: z.boolean().optional().describe("false = Solana couldn't be read just now; open items show the last known state."),
  truncated: z.boolean().optional(),
  // W3-D
  schedules: z.array(scheduleSchema).optional().describe("Monthly requests (ask_every_month) paid to this wallet."),
  csv_url: z.string().optional().describe("With csv: a download link for every open and paid request as CSV, valid 10 minutes."),
  csv_expires_at: z.string().optional(),
}).strict();

export type WhoInput = z.output<typeof inputSchema>;
export type WhoOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Show who still owes the user money: every open Owed request, split-bill share and invoice paid to their wallet, plus what was paid in the last 30 days, with totals.",
  "Use it when the user asks \"who owes me?\", \"what's outstanding?\" or \"what came in this month?\".",
  "Two calls. First call with only recipient (the user's own PayBox Solana wallet from list_credentials): it returns message_to_sign.",
  "Sign that exact text with PayBox request_wallet_sign (credential_id of that wallet, intent {op:\"solanaMessage\", address: recipient, message: message_to_sign}); the user approves with their passkey. Signing moves no money.",
  "Then call who_owes_me again with recipient, signed_message (the same text) and signature (from the request's output). The message is valid for 5 minutes and works once.",
  "For a few specific requests, check_payments needs no signature.",
  // W3-D
  "It also lists monthly requests set up with ask_every_month and each month's request. Pass csv: true on the second call for a 10-minute CSV download link of every open and paid request.",
].join(" ");

export function ledgerMessage(recipient: string, nowMs: number): string {
  return `Owed ledger access for ${recipient} at ${isoSeconds(nowMs)}`;
}

function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 key bytes follow.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** Every 64-byte value the signature text could be: hex (PayBox), base58 or base64 (wallet adapters). */
function signatureBytes(text: string): Buffer[] {
  const s = text.trim();
  const out: Buffer[] = [];
  const hex = s.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) out.push(Buffer.from(hex, "hex"));
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) {
    try {
      const b = bs58.decode(s);
      if (b.length === 64) out.push(Buffer.from(b));
    } catch {
      // not base58
    }
  }
  if (/^[A-Za-z0-9+/_-]{86}(?:==)?$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 64) out.push(b);
  }
  return out;
}

/** ed25519 over the message's UTF-8 bytes, as request_wallet_sign {op:"solanaMessage"} signs it. */
export function signatureMatches(message: string, signature: string, signer: string): boolean {
  let key;
  try {
    const pub = bs58.decode(signer);
    if (pub.length !== 32) return false;
    key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(pub)]), format: "der", type: "spki" });
  } catch {
    return false;
  }
  const data = Buffer.from(message, "utf8");
  return signatureBytes(signature).some((sig) => {
    try {
      return verify(null, data, key, sig);
    } catch {
      return false;
    }
  });
}

/** null when the pair looks right; otherwise what to tell the agent. */
function localCheck(recipient: string, message: string, signature: string, now: number): string | null {
  const lead = `Owed ledger access for ${recipient} at `;
  const again = "Call who_owes_me with only recipient to get a fresh message, sign that, and try again.";
  if (!message.startsWith(lead) || !ISO_RE.test(message.slice(lead.length))) {
    return `signed_message must be exactly the message_to_sign who_owes_me gave for this wallet ("${lead}<time>"). ${again}`;
  }
  const signedAt = Date.parse(message.slice(lead.length));
  if (!Number.isFinite(signedAt)) return `signed_message has an invalid time. ${again}`;
  if (now - signedAt > MESSAGE_VALID_MS) return `That signed message is more than 5 minutes old. ${again}`;
  if (signedAt - now > MAX_SKEW_MS) return `That signed message is dated in the future. ${again}`;
  if (signatureBytes(signature).length === 0) {
    return "signature must be the 64-byte signature from request_wallet_sign's output (hex), or base58/base64.";
  }
  if (!signatureMatches(message, signature, recipient)) {
    return `That signature isn't from wallet ${recipient} over this exact message. Sign message_to_sign with that same wallet (request_wallet_sign, op solanaMessage) and pass its output signature unchanged.`;
  }
  return null;
}

export async function whoOwesMe(args: WhoInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");

  if (args.signed_message === undefined && args.signature === undefined) {
    const message_to_sign = ledgerMessage(args.recipient, started);
    const expires_at = isoSeconds(started + MESSAGE_VALID_MS);
    const output: WhoOutput = { step: "sign", recipient: args.recipient, message_to_sign, expires_at };
    const text = [
      "To show this wallet's ledger, sign this exact message with PayBox (it moves no money and approves nothing else):",
      message_to_sign,
      `Call request_wallet_sign with this wallet's credential_id and intent {"op":"solanaMessage","address":"${args.recipient}","message":"${message_to_sign}"}.`,
      `After the user approves, call who_owes_me again with recipient, signed_message (the text above) and signature (from the output). Valid until ${expires_at}, once.`,
    ].join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: output };
  }
  if (args.signed_message === undefined || args.signature === undefined) {
    return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
  }

  const problem = localCheck(args.recipient, args.signed_message, args.signature, started);
  if (problem) return refusal(problem);

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  let ledger: LedgerRes | null;
  try {
    ledger = await within(
      makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: LEDGER_API_TIMEOUT_MS }).ledger({
        recipient: args.recipient, signed_message: args.signed_message, signature: args.signature.trim(),
        ...(args.csv === true && { csv: true as const }), // W3-D
      }),
      LEDGER_BUDGET_MS - (deps.now() - started), () => null,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_input") {
      return refusal(`Owed refused the signature: ${error.message}. Call who_owes_me with only recipient for a fresh message.`);
    }
    if (error instanceof ApiError && error.code === "rate_limited") return refusal("Too many ledger requests for this wallet in the last hour. Try again later.");
    return refusal("Owed's server couldn't be reached, so the ledger isn't available right now. check_payments still works for specific requests.");
  }
  if (!ledger) return refusal("Owed's server didn't answer in time. Call who_owes_me with only recipient for a fresh message and try again.");
  if (ledger.recipient !== args.recipient) return refusal("Owed's server answered for a different wallet, so the ledger wasn't used.");

  return render(ledger, deps.now(), args.csv === true);
}

const KINDS = ["single", "split_share", "invoice"] as const;

function present(e: LedgerEntry, now: number): z.output<typeof entrySchema> {
  const kind = (KINDS as readonly string[]).includes(e.kind) ? (e.kind as (typeof KINDS)[number]) : "single";
  const out: z.output<typeof entrySchema> = { id: e.id, kind, link: e.link, status: e.status, amount: e.amount, token: e.token, created_at: e.created_at };
  // Local-currency asks: only a quote that produces the entry's USDC amount is passed on.
  if (e.fiat && fiatStatusLine(e.fiat, e.amount)) {
    out.fiat = { currency: e.fiat.currency, amount: e.fiat.amount, rate: e.fiat.rate, rate_source: e.fiat.rate_source, quoted_at: e.fiat.quoted_at };
  }
  if (e.amount_due !== undefined) out.amount_due = e.amount_due;
  if (e.amount_paid !== undefined) out.amount_paid = e.amount_paid;
  const payerName = clean(e.payer_name, 40);
  if (payerName) out.payer_name = payerName;
  const forText = clean(e.for, 80);
  if (forText) out.for = forText;
  if (e.status !== "paid") {
    const waited = ago(e.created_at, now);
    if (waited) out.waited = waited;
  }
  if (e.payer !== undefined) out.payer = e.payer;
  if (e.paid_at !== undefined) out.paid_at = e.paid_at;
  if (e.signature !== undefined) out.explorer_url = explorerUrl(e.signature);
  if (e.group_id) out.group_id = e.group_id;
  const groupTitle = clean(e.group_title, 60);
  if (kind === "split_share" && groupTitle) out.group_title = groupTitle;
  if (kind === "split_share" && e.group_link) out.group_link = e.group_link;
  const invoiceNumber = clean(e.invoice_number, 20);
  if (kind === "invoice" && invoiceNumber) out.invoice_number = invoiceNumber;
  if (kind === "invoice" && e.due_date) out.due_date = e.due_date;
  // Lower-case ASCII (punycode for IDN), as W2-H stores it; anything else is dropped, never shown.
  if (e.from_domain && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(e.from_domain) && e.from_domain.includes(".")) out.from_domain = e.from_domain;
  const brands = brandWordsFromFlags(e.flags ?? []);
  if (brands.length > 0) out.caution = `This request mentions ${brands.map((w) => `"${w}"`).join(", ")}, a word scams use to look official; write_reminder won't chase it.`;
  // W3-D
  if (e.schedule_id) out.schedule_id = e.schedule_id;
  if (e.period) out.period = e.period;
  return out;
}

// W3-D start: monthly schedules
const VALID_DOMAIN = (d: string | null | undefined): d is string => !!d && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) && d.includes(".");

function presentSchedule(s: ScheduleSummary): z.output<typeof scheduleSchema> {
  const out: z.output<typeof scheduleSchema> = {
    id: s.id, status: s.status, amount: s.amount, token: s.token, day_of_month: s.day_of_month, months: s.months,
    requests_opened: s.requests_opened, next_request_on: s.next_request_on,
    requests: s.requests.map((r) => ({ period: r.period, id: r.id, link: r.link, status: r.status })),
  };
  const payerName = clean(s.payer_name, 40);
  if (payerName) out.payer_name = payerName;
  const forText = clean(s.for, 80);
  if (forText) out.for = forText;
  if (VALID_DOMAIN(s.from_domain)) out.from_domain = s.from_domain;
  // Server-written (the DNS refusal naming the stored domain), so domains stay; controls and invisibles go.
  const lastError = (s.last_error ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").slice(0, 200).trim();
  if (lastError) out.last_error = lastError;
  return out;
}

function ordinal(day: number): string {
  const tens = day % 100;
  return `${day}${tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th")}`;
}

function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return `${MONTHS[m! - 1] ?? period} ${y}`;
}

function scheduleLine(s: z.output<typeof scheduleSchema>): string {
  const name = s.payer_name ? ` from ${quote(s.payer_name, 40)}` : "";
  const forPart = s.for ? ` for ${quote(s.for, 80)}` : "";
  const domain = s.from_domain ? `, as ${s.from_domain}` : "";
  const label = name || forPart ? " (unverified)" : "";
  const parts = [`Monthly: ${s.amount} ${s.token}${name}${forPart}${label} on the ${ordinal(s.day_of_month)} (UTC)${domain}`];
  const latest = s.requests[0];
  if (latest) parts.push(`${monthLabel(latest.period)}'s request ${latest.status}: ${latest.link}`);
  if (s.status === "active" && s.next_request_on) parts.push(`next opens ${s.next_request_on}`);
  else if (s.status === "ended") parts.push(`ended after ${s.requests_opened} ${s.requests_opened === 1 ? "request" : "requests"}`);
  else if (s.status !== "active") parts.push(s.status);
  if (s.last_error) parts.push(`couldn't open this month's request yet (retried daily): ${s.last_error}`);
  return parts.join("; ");
}
// W3-D end

function sumText(parts: Array<[string, string]>): string {
  const nonZero = parts.filter(([amount]) => !/^0(\.0+)?$/.test(amount));
  return nonZero.length ? nonZero.map(([amount, token]) => `${amount} ${token}`).join(" + ") : `0 ${parts[0]?.[1] ?? "USDC"}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "due 30 Oct 2026, 3 days overdue" for an unpaid invoice; "due 30 Oct 2026" otherwise. */
function dueText(dueDate: string, unpaid: boolean, now: number): string {
  const [y, m, d] = dueDate.split("-").map(Number);
  const due = Date.UTC(y!, m! - 1, d!);
  if (!Number.isFinite(due)) return "";
  const label = `due ${d} ${MONTHS[m! - 1]} ${y}`;
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const late = Math.round((today - due) / 86_400_000);
  if (!unpaid || late <= 0) return label;
  return `${label}, ${late === 1 ? "1 day" : `${late} days`} overdue`;
}

/** Who and what, by kind. Every requester-written value is quoted and labelled unverified (QA-20). */
function who(e: z.output<typeof entrySchema>, now: number): string {
  const domain = e.from_domain ? `, as ${e.from_domain} (DNS-verified at creation)` : "";
  if (e.kind === "invoice") {
    const number = e.invoice_number ? ` ${quote(e.invoice_number, 20)}` : "";
    const client = e.payer_name ? ` to ${quote(e.payer_name, 40)}` : "";
    const label = number || client ? " (unverified)" : "";
    const due = e.due_date ? `, ${dueText(e.due_date, e.status !== "paid", now)}` : "";
    return `, invoice${number}${client}${label}${due}${domain}`;
  }
  const name = e.payer_name ? ` from ${quote(e.payer_name, 40)}` : "";
  if (e.kind === "split_share") {
    const title = e.group_title ?? e.for;
    const bill = title ? `, share of ${quote(title, 60)}` : ", share of a split bill";
    const label = name || title ? " (unverified)" : "";
    const board = e.group_link && e.status !== "paid" ? `, board: ${e.group_link}` : "";
    return `${name}${bill}${label}${board}${domain}`;
  }
  const forPart = e.for ? ` for ${quote(e.for, 80)}` : "";
  const label = name || forPart ? " (unverified)" : "";
  const monthly = e.period ? `, monthly request for ${monthLabel(e.period)}` : ""; // W3-D
  return `${name}${forPart}${label}${monthly}${domain}`;
}

function render(ledger: LedgerRes, now: number, csvAsked = false) {
  const open = ledger.open.map((e) => present(e, now));
  const paid = ledger.paid_recently.map((e) => present(e, now));
  const schedules = (ledger.schedules ?? []).map(presentSchedule); // W3-D
  const outstanding_total = sumText(ledger.totals.map((t) => [t.outstanding, t.token]));
  const received_30d = sumText(ledger.totals.map((t) => [t.received_30d, t.token]));
  const openCount = ledger.totals.reduce((n, t) => n + t.open_count, 0);
  const paidCount = ledger.totals.reduce((n, t) => n + t.paid_count, 0);

  const lines = [
    `${openCount} open ${openCount === 1 ? "request" : "requests"} · ${outstanding_total} outstanding · ${received_30d} received in the last 30 days (${paidCount} paid). ${LEDGER_TOTALS_NOTE}`,
    LEDGER_CAUTION,
  ];
  if (!ledger.chain_checked) lines.push("Solana couldn't be read just now, so open requests show their last known state.");
  const detail: string[] = [];
  for (const e of open) {
    const due = e.status === "underpaid" ? `${e.amount_due} of ${e.amount} ${e.token} still due (${e.amount_paid} arrived)` : `${e.amount} ${e.token}`;
    const asked = fiatStatusLine(e.fiat, e.amount); // local-currency asks: "₹1,200 · 12.6 USDC (rate locked …)"
    detail.push(`Owed: ${due}${asked ? ` (asked as ${asked}, a quote)` : ""}${who(e, now)}${e.waited ? `, waiting ${e.waited}` : ""}: ${e.link}${e.caution ? ` Caution: ${e.caution}` : ""}`);
  }
  for (const e of paid) {
    const by = e.payer ? ` by ${shortAddress(e.payer)}` : "";
    const asked = fiatStatusLine(e.fiat, e.amount); // local-currency asks
    detail.push(`Paid: ${e.amount_paid ?? e.amount} ${e.token}${asked ? ` (asked as ${asked}, a quote)` : ""}${who(e, now)}${by}${e.explorer_url ? `: ${e.explorer_url}` : ""}${e.caution ? ` Caution: ${e.caution}` : ""}`);
  }
  lines.push(...detail.slice(0, MAX_LINES));
  if (detail.length > MAX_LINES) lines.push(`…and ${detail.length - MAX_LINES} more in the structured result.`);
  if (ledger.truncated) lines.push("Only the newest 100 open and 100 paid requests are listed; the totals count all of them.");
  // W3-D start
  lines.push(...schedules.map(scheduleLine));
  const csv = csvAsked && ledger.csv ? ledger.csv : null;
  if (csv) {
    lines.push(`CSV of every open and paid request (for accounting): ${csv.url} (works until ${csv.expires_at}, 10 minutes). ` +
      "Its first row repeats the caution above; columns marked (unverified) are as each request's creator wrote them.");
  }
  else if (csvAsked) lines.push("CSV export isn't set up on this Owed server, so there is no download link.");
  // W3-D end
  if (open.length > 0) lines.push("Names, reasons and amounts were written by whoever made each request. write_reminder drafts a nudge for an open one the user recognises.");

  const output: WhoOutput = {
    step: "ledger", recipient: ledger.recipient, caution: LEDGER_CAUTION, open, paid_recently: paid, outstanding_total, received_30d,
    chain_checked: ledger.chain_checked, truncated: ledger.truncated,
    ...(ledger.schedules !== undefined && { schedules }), // W3-D
    ...(csv && { csv_url: csv.url, csv_expires_at: csv.expires_at }), // W3-D
  };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("who_owes_me", {
    title: "Who owes me",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => whoOwesMe(args, deps));
}
