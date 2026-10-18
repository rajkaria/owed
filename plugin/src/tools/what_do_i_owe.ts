import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { addressSchema, evmAddressSchema, tokenSchema, type InboxEntry, type InboxRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { fiatOutput, fiatStatusLine } from "../local-currency.js";
import { ago, brandWordsFromFlags, clean, quote, shortAddress } from "../text.js";
import { signatureMatches } from "./who_owes_me.js";

// what_do_i_owe (F1): the payer's side of who_owes_me. Two calls. Without a signature: the exact message to sign. The
// agent signs it with PayBox's request_wallet_sign {op:"solanaMessage"} (passkey approval, no money moves), then
// calls again with the message and the signature, and Owed's server returns the open requests addressed to that
// wallet, once. With block (or unblock) the message names that requester wallet instead, and the reply is the inbox
// after the change. The server checks everything again; the checks here only spare a round trip.

export const INBOX_BUDGET_MS = 8500;
/** The server checks open requests on chain before it answers; a timeout would spend the signature for nothing. */
export const INBOX_API_TIMEOUT_MS = 7000;
export const MESSAGE_VALID_MS = 5 * 60_000;
const MAX_SKEW_MS = 60_000;
const MAX_LINES = 25;

/** Same words as web/lib/inbox.ts INBOX_CAUTION (web/test/inbox-db.test.ts checks the server's). */
export const INBOX_CAUTION =
  "Anyone can address a request to your wallet; Owed doesn't check who sent it. Names, handles and reasons are the requester's own words, and Owed hasn't verified any handle.";

const requesterSchema = z.union([addressSchema, evmAddressSchema]);

export const inputSchema = z.object({
  payer: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials): whose inbox to show."),
  signed_message: z.string().min(1).max(200).optional().describe("Second call only: the exact message_to_sign from the first call."),
  signature: z.string().min(64).max(200).optional()
    .describe("Second call only: the signature request_wallet_sign returned for that message (hex as PayBox returns it; base58 or base64 also work)."),
  block: requesterSchema.optional()
    .describe("Hide every request from this requester wallet (the wallet the requests pay, shown as recipient). Pass it on both calls: the message to sign names it."),
  unblock: requesterSchema.optional().describe("Show a blocked requester's requests again. Pass it on both calls."),
}).strict();

const entrySchema = z.object({
  id: z.string(),
  kind: z.enum(["single", "split_share", "invoice"]).describe("single request, one share of a split bill, or an invoice."),
  link: z.string().describe("Where to pay it by hand: the invoice page for an invoice, else the request's pay page."),
  status: z.enum(["open", "underpaid"]),
  amount: z.string(),
  amount_due: z.string().describe("What is still owed."),
  token: tokenSchema,
  chain: z.enum(["solana", "base"]),
  recipient: z.string().describe("The wallet the request pays (the requester's). block takes it."),
  requester_name: z.string().optional().describe("Written by the requester; unverified."),
  requester_handle: z.string().optional().describe("The requester's X handle as they gave it; not verified by Owed. pay_all and pay_link ask the agent to check it with resolve_username."),
  for: z.string().optional().describe("Written by the requester; unverified."),
  from_domain: z.string().optional().describe("A domain that published the recipient wallet in DNS when the request was made (pay_link and pay_all check it again)."),
  sns_name: z.string().optional().describe("An SNS name that pointed to the recipient when the request was made (pay_link and pay_all check it again)."),
  created_at: z.string(),
  waited: z.string().optional().describe('How long it has been open, e.g. "2d 4h".'),
  expires_at: z.string().optional(),
  due_date: z.string().optional().describe("Invoices: the due date, YYYY-MM-DD."),
  invoice_number: z.string().optional().describe("Invoices: written by the requester; unverified."),
  group_title: z.string().optional().describe("Split shares: the bill's title, written by the requester; unverified."),
  addressed_as: z.string().optional().describe("How the requester addressed the user: the X handle or SNS name they used."),
  first_time: z.boolean().describe("True when the user has never paid this recipient wallet through Owed."),
  caution: z.string().optional().describe("Set when the request mentions a brand word scams use; pay_all skips it unless the user names it."),
  fiat: fiatOutput.optional(),
}).strict();

export const outputSchema = z.object({
  step: z.enum(["sign", "inbox"]).describe("sign = sign message_to_sign and call again; inbox = the result."),
  payer: z.string(),
  message_to_sign: z.string().optional(),
  expires_at: z.string().optional(),
  caution: z.string().optional().describe("Show this to the user with the inbox: anyone can address a request to their wallet."),
  owed: z.array(entrySchema).optional().describe("Solana requests addressed to this wallet, oldest first."),
  base: z.array(entrySchema).optional().describe("Base requests, listed apart: pay each with pay_link from the user's Base wallet."),
  totals: z.array(z.object({ token: tokenSchema, chain: z.enum(["solana", "base"]), amount_due: z.string(), count: z.number().int() }).strict()).optional(),
  outstanding_total: z.string().optional().describe('e.g. "13.35 USDC on Solana + 5 USDC on Base".'),
  pay_all_ids: z.array(z.string()).optional().describe("The Solana requests without a caution, ready for pay_all (only if the user wants to pay them)."),
  blocked: z.object({ requester: z.string(), blocked: z.boolean(), changed: z.boolean() }).strict().optional(),
  blocked_hidden: z.number().int().optional().describe("Open requests from blocked requesters, not listed."),
  blocked_requesters: z.array(z.string()).optional(),
  chain_checked: z.boolean().optional().describe("false = Solana couldn't be read just now; entries show the last known state."),
  truncated: z.boolean().optional(),
}).strict();

export type OweInput = z.output<typeof inputSchema>;
export type OweOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Show what the user owes: every open Owed request, split-bill share and invoice someone addressed to the user's wallet (by their X handle, .sns name or wallet), with who asked, what for, how long it has waited, due dates and totals; Base requests are listed apart.",
  "Use it when the user asks \"what do I owe?\", \"any payment requests for me?\" or \"pay my bills\".",
  "Two calls. First call with only payer (the user's own PayBox Solana wallet from list_credentials): it returns message_to_sign.",
  "Sign that exact text with PayBox request_wallet_sign (credential_id of that wallet, intent {op:\"solanaMessage\", address: payer, message: message_to_sign}); the user approves with their passkey. Signing moves no money.",
  "Then call what_do_i_owe again with payer, signed_message (the same text) and signature (from the request's output). The message is valid for 5 minutes and works once. Only the wallet's owner sees its inbox.",
  "Anyone can address a request to anyone: names, handles and reasons are the requester's words, unverified, and first-time requesters are marked. To pay, use pay_all with the ids the user picks (one approval for all), or pay_link for one.",
  "To hide every request from one requester, pass block with that requester's wallet (its recipient) on both calls; unblock shows them again.",
].join(" ");

export function inboxMessage(payer: string, nowMs: number): string {
  return `Owed inbox access for ${payer} at ${isoSeconds(nowMs)}`;
}

export function blockMessage(action: "block" | "unblock", requester: string, payer: string, nowMs: number): string {
  return `Owed ${action} ${requester} for ${payer} at ${isoSeconds(nowMs)}`;
}

function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** null when the pair looks right; otherwise what to tell the agent. */
function localCheck(lead: string, signer: string, message: string, signature: string, now: number): string | null {
  const again = "Call what_do_i_owe with only payer (and the same block or unblock) to get a fresh message, sign that, and try again.";
  if (!message.startsWith(lead) || !ISO_RE.test(message.slice(lead.length))) {
    return `signed_message must be exactly the message_to_sign what_do_i_owe gave ("${lead}<time>"). ${again}`;
  }
  const signedAt = Date.parse(message.slice(lead.length));
  if (!Number.isFinite(signedAt)) return `signed_message has an invalid time. ${again}`;
  if (now - signedAt > MESSAGE_VALID_MS) return `That signed message is more than 5 minutes old. ${again}`;
  if (signedAt - now > MAX_SKEW_MS) return `That signed message is dated in the future. ${again}`;
  if (!signatureMatches(message, signature, signer)) {
    return `That signature isn't from wallet ${signer} over this exact message. Sign message_to_sign with that same wallet (request_wallet_sign, op solanaMessage) and pass its output signature unchanged.`;
  }
  return null;
}

export async function whatDoIOwe(args: OweInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  if (!deps.isSolanaAddress(args.payer)) return refusal("payer must be a Solana wallet address (the user's own PayBox Solana wallet).");
  if (args.block !== undefined && args.unblock !== undefined) return refusal("Pass block or unblock, not both.");
  const action = args.block !== undefined ? "block" as const : args.unblock !== undefined ? "unblock" as const : null;
  const requester = (args.block ?? args.unblock)?.trim();
  if (requester === args.payer) return refusal("That is the user's own wallet; there is nothing to block.");

  if (args.signed_message === undefined && args.signature === undefined) {
    const message_to_sign = action ? blockMessage(action, requester!, args.payer, started) : inboxMessage(args.payer, started);
    const expires_at = isoSeconds(started + MESSAGE_VALID_MS);
    const output: OweOutput = { step: "sign", payer: args.payer, message_to_sign, expires_at };
    const what = action === "block"
      ? `To hide every request from ${shortAddress(requester!)} and then show the inbox`
      : action === "unblock"
        ? `To show ${shortAddress(requester!)}'s requests again and then show the inbox`
        : "To show the requests addressed to this wallet";
    const text = [
      `${what}, sign this exact message with PayBox (it moves no money and approves nothing else):`,
      message_to_sign,
      `Call request_wallet_sign with this wallet's credential_id and intent {"op":"solanaMessage","address":"${args.payer}","message":"${message_to_sign}"}.`,
      `After the user approves, call what_do_i_owe again with payer, signed_message (the text above) and signature (from the output)${action ? `, and the same ${action}` : ""}. Valid until ${expires_at}, once.`,
    ].join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: output };
  }
  if (args.signed_message === undefined || args.signature === undefined) {
    return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
  }
  const lead = action ? `Owed ${action} ${requester} for ${args.payer} at ` : `Owed inbox access for ${args.payer} at `;
  const problem = localCheck(lead, args.payer, args.signed_message, args.signature.trim(), started);
  if (problem) return refusal(problem);

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  const api = makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: INBOX_API_TIMEOUT_MS });
  const body = { payer: args.payer, signed_message: args.signed_message, signature: args.signature.trim() };
  let inbox: InboxRes | null;
  let blocked: OweOutput["blocked"];
  try {
    const call = action
      ? api.inboxBlock({ ...body, requester: requester!, action }).then((res) => {
        if (res.payer !== args.payer || res.requester.toLowerCase() !== requester!.toLowerCase()) throw new ApiError("upstream_unavailable", "mismatch");
        blocked = { requester: res.requester, blocked: res.blocked, changed: res.changed };
        return res.inbox;
      })
      : api.inbox(body);
    inbox = await within(call, INBOX_BUDGET_MS - (deps.now() - started), () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "invalid_input") {
      return refusal(`Owed refused the signature: ${error.message}. Call what_do_i_owe with only payer for a fresh message.`);
    }
    if (error instanceof ApiError && error.code === "rate_limited") return refusal("Too many inbox requests for this wallet in the last hour. Try again later.");
    if (error instanceof ApiError && error.httpStatus === 404) return refusal("This Owed server doesn't have the inbox yet. Nothing changed.");
    return refusal("Owed's server couldn't be reached, so the inbox isn't available right now. Nothing changed; try again shortly.");
  }
  if (!inbox) return refusal("Owed's server didn't answer in time. Call what_do_i_owe with only payer for a fresh message and try again.");
  if (inbox.payer !== args.payer) return refusal("Owed's server answered for a different wallet, so the inbox wasn't used.");
  return render(inbox, deps.now(), blocked);
}

const KINDS = ["single", "split_share", "invoice"] as const;
const VALID_DOMAIN = (d: string | null | undefined): d is string => !!d && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(d) && d.includes(".");
const VALID_HANDLE = (h: string | null | undefined): h is string => !!h && /^[a-z0-9_]{1,15}$/.test(h);

function present(e: InboxEntry, now: number): z.output<typeof entrySchema> {
  const kind = (KINDS as readonly string[]).includes(e.kind) ? (e.kind as (typeof KINDS)[number]) : "single";
  const out: z.output<typeof entrySchema> = {
    id: e.id, kind, link: e.link, status: e.status, amount: e.amount, amount_due: e.amount_due, token: e.token, chain: e.chain,
    recipient: e.recipient, created_at: e.created_at, first_time: e.first_time,
  };
  const name = clean(e.requester_name, 40);
  if (name) out.requester_name = name;
  if (VALID_HANDLE(e.requester_handle)) out.requester_handle = e.requester_handle;
  const forText = clean(e.for, 80);
  if (forText) out.for = forText;
  if (VALID_DOMAIN(e.from_domain)) out.from_domain = e.from_domain;
  if (e.sns_name && /^[^\s]{1,140}$/.test(e.sns_name) && e.sns_name.endsWith(".sns")) out.sns_name = clean(e.sns_name, 140);
  const waited = ago(e.created_at, now);
  if (waited) out.waited = waited;
  if (e.expires_at) out.expires_at = e.expires_at;
  if (kind === "invoice" && e.due_date) out.due_date = e.due_date;
  const invoiceNumber = clean(e.invoice_number, 20);
  if (kind === "invoice" && invoiceNumber) out.invoice_number = invoiceNumber;
  const title = clean(e.group_title, 60);
  if (kind === "split_share" && title) out.group_title = title;
  if (VALID_HANDLE(e.addressed_as.handle)) out.addressed_as = `@${e.addressed_as.handle}`;
  else if (e.addressed_as.sns) out.addressed_as = clean(e.addressed_as.sns, 140);
  const brands = brandWordsFromFlags(e.flags ?? []);
  if (brands.length > 0) out.caution = `It mentions ${brands.map((w) => `"${w}"`).join(", ")}, a word scams use to look official; pay_all skips it unless the user names it.`;
  if (e.fiat && fiatStatusLine(e.fiat, e.amount)) {
    out.fiat = { currency: e.fiat.currency, amount: e.fiat.amount, rate: e.fiat.rate, rate_source: e.fiat.rate_source, quoted_at: e.fiat.quoted_at };
  }
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dueText(dueDate: string, now: number): string {
  const [y, m, d] = dueDate.split("-").map(Number);
  const due = Date.UTC(y!, m! - 1, d!);
  if (!Number.isFinite(due)) return "";
  const label = `due ${d} ${MONTHS[m! - 1]} ${y}`;
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const late = Math.round((today - due) / 86_400_000);
  return late > 0 ? `${label}, ${late === 1 ? "1 day" : `${late} days`} overdue` : label;
}

/** One line per request. Every requester-written value is quoted and labelled unverified. */
function line(e: z.output<typeof entrySchema>, now: number): string {
  const amount = e.status === "underpaid" ? `${e.amount_due} of ${e.amount} ${e.token} still due` : `${e.amount} ${e.token}`;
  const who = e.requester_name ? ` to ${quote(e.requester_name, 40)}` : ` to ${shortAddress(e.recipient)}`;
  const handle = e.requester_handle ? ` (@${e.requester_handle} on X, not verified by Owed)` : "";
  const what = e.kind === "invoice"
    ? `, invoice${e.invoice_number ? ` ${quote(e.invoice_number, 20)}` : ""}${e.due_date ? `, ${dueText(e.due_date, now)}` : ""}`
    : e.kind === "split_share"
      ? `, share of ${e.group_title ? quote(e.group_title, 60) : "a split bill"}`
      : e.for ? ` for ${quote(e.for, 80)}` : "";
  const label = e.requester_name || e.for || e.group_title || e.invoice_number ? " (the requester's words, unverified)" : "";
  const badge = e.from_domain ? `, from ${e.from_domain} (DNS-verified when made)` : e.sns_name ? `, to ${e.sns_name} (resolved when made)` : "";
  const asked = e.fiat ? fiatStatusLine(e.fiat, e.amount) : null;
  const waited = e.waited ? `, waiting ${e.waited}` : "";
  const first = e.first_time ? " First request from this wallet: the user has never paid it through Owed." : "";
  const caution = e.caution ? ` Caution: ${e.caution}` : "";
  return `Owe: ${amount}${asked ? ` (asked as ${asked}, a quote)` : ""}${who}${handle}${what}${label}${badge}${waited}. Id ${e.id}: ${e.link}${first}${caution}`;
}

function render(inbox: InboxRes, now: number, blocked?: OweOutput["blocked"]) {
  const owed = inbox.owed.map((e) => present(e, now));
  const base = inbox.base.map((e) => present(e, now));
  const totals = inbox.totals.map((t) => ({ token: t.token, chain: t.chain, amount_due: t.amount_due, count: t.count }));
  const outstanding_total = totals.length
    ? totals.map((t) => `${t.amount_due} ${t.token} on ${t.chain === "base" ? "Base" : "Solana"}`).join(" + ")
    : "nothing";
  const count = totals.reduce((n, t) => n + t.count, 0);
  const lines: string[] = [];
  if (blocked) {
    lines.push(blocked.blocked
      ? `${blocked.changed ? "Blocked" : "Already blocked"} ${blocked.requester}: its requests are hidden from this inbox. They aren't cancelled; anyone can still pay them.`
      : `${blocked.changed ? "Unblocked" : "Wasn't blocked:"} ${blocked.requester}: its requests show again.`);
  }
  lines.push(count === 0
    ? "Nothing is addressed to this wallet right now."
    : `${count} open ${count === 1 ? "request" : "requests"} addressed to this wallet: ${outstanding_total}.`);
  lines.push(INBOX_CAUTION);
  if (!inbox.chain_checked) lines.push("Solana couldn't be read just now, so requests show their last known state.");
  const detail = owed.map((e) => line(e, now));
  lines.push(...detail.slice(0, MAX_LINES));
  if (detail.length > MAX_LINES) lines.push(`…and ${detail.length - MAX_LINES} more in the structured result.`);
  if (base.length > 0) {
    lines.push("On Base (pay each with pay_link, from the user's PayBox Base wallet; pay_all pays Solana requests only):");
    lines.push(...base.slice(0, 10).map((e) => line(e, now)));
  }
  if (inbox.blocked_hidden > 0) lines.push(`${inbox.blocked_hidden} open ${inbox.blocked_hidden === 1 ? "request" : "requests"} from blocked wallets ${inbox.blocked_hidden === 1 ? "is" : "are"} hidden.`);
  if (inbox.truncated) lines.push("Only the oldest 100 are listed; the totals count all of them.");
  const payable = owed.filter((e) => !e.caution).map((e) => e.id);
  if (owed.length > 0) {
    lines.push(`To pay several with one approval: pay_all with sender (this wallet), ids and max_total (the most USDC the user agrees to). Pay only the ones the user recognises; to hide a requester, call what_do_i_owe with block and its recipient wallet.`);
  }
  const output: OweOutput = {
    step: "inbox", payer: inbox.payer, caution: INBOX_CAUTION, owed, base, totals, outstanding_total,
    ...(payable.length > 0 && { pay_all_ids: payable.slice(0, 20) }),
    ...(blocked && { blocked }),
    blocked_hidden: inbox.blocked_hidden, blocked_requesters: inbox.blocked_requesters.slice(0, 50),
    chain_checked: inbox.chain_checked, truncated: inbox.truncated,
  };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("what_do_i_owe", {
    title: "What do I owe",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    // Not read-only: with block or unblock it changes which requests the inbox shows. Each signed message works once.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => whatDoIOwe(args, deps));
}
