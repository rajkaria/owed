import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { addressSchema, tokenSchema, type CancelRes, type GetRequestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { clean, explorerUrl, quote, shortAddress } from "../text.js";
import { signatureMatches } from "./who_owes_me.js";

// W3-C: cancel a request, proven by the wallet it pays. Two calls, like who_owes_me. Without a signature:
// the request is read (it must pay this wallet and still be unpaid) and the exact message to sign comes back,
// "Owed cancel <id> for <recipient> at <ISO time>". The agent signs it with PayBox's request_wallet_sign
// {op:"solanaMessage"} (passkey approval), then calls again with the message and the signature; Owed's server
// checks it again (ed25519, at most 5 minutes old, usable once, only the recipient), reads the chain so a
// paid request is never cancelled, and marks the request cancelled with the signed message kept as proof.
// The checks here only spare a round trip and give a clear reason.

export const CANCEL_BUDGET_MS = 8500;
/** Reading the request on the first call. */
export const LOOKUP_TIMEOUT_MS = 4000;
/** The server reads the chain before it cancels; a timeout would spend the signature for nothing. */
export const CANCEL_API_TIMEOUT_MS = 7000;
export const MESSAGE_VALID_MS = 5 * 60_000;
const MAX_SKEW_MS = 60_000;

export const inputSchema = z.object({
  link: z.string().min(1).max(2048)
    .describe("The request to cancel: its Owed link (https://…/r/<id>, or an invoice's …/i/<id>) or its request id."),
  recipient: addressSchema
    .describe("The user's own PayBox Solana wallet address (from list_credentials): the wallet the request pays. Only that wallet can cancel it."),
  signed_message: z.string().min(1).max(200).optional()
    .describe("Second call only: the exact message_to_sign from the first call."),
  signature: z.string().min(64).max(200).optional()
    .describe("Second call only: the signature request_wallet_sign returned for that message (hex as PayBox returns it; base58 or base64 also work)."),
}).strict();

export const outputSchema = z.object({
  step: z.enum(["sign", "cancelled"]).describe("sign = sign message_to_sign and call again; cancelled = done."),
  id: z.string().describe("The Owed request id."),
  link: z.string().describe("The request's page, which now shows Cancelled once step is cancelled."),
  recipient: z.string(),
  amount: z.string(),
  token: tokenSchema,
  status: z.enum(["open", "expired", "cancelled"]).describe("The request's status: open or expired before the cancel, cancelled after."),
  payer_name: z.string().optional().describe("Written by the requester; unverified."),
  for: z.string().optional().describe("Written by the requester; unverified."),
  message_to_sign: z.string().optional().describe("step sign: the exact text to sign with request_wallet_sign."),
  sign_by: z.string().optional().describe("step sign: the message must reach Owed before this time (UTC)."),
  cancelled_at: z.string().optional().describe("step cancelled: when the request was cancelled."),
  already_cancelled: z.boolean().optional().describe("step cancelled: true if it had been cancelled before; nothing changed."),
}).strict();

export type CancelInput = z.output<typeof inputSchema>;
export type CancelOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Cancel one of the user's own Owed payment requests (a request, one share of a split bill, or an invoice) so nobody pays it: its page shows Cancelled without pay buttons, pay_link refuses it, and its x402 endpoint stops taking payments.",
  "Use it when the user says \"cancel the request to Sam\", \"Priya paid me in cash, cancel her link\" or \"withdraw that invoice\".",
  "Only the wallet the request pays can cancel it, proven by a signature. Two calls. First call with link (the request's Owed link or id) and recipient (the user's own PayBox Solana wallet from list_credentials): it checks the request and returns message_to_sign.",
  "Sign that exact text with PayBox request_wallet_sign (credential_id of that wallet, intent {op:\"solanaMessage\", address: recipient, message: message_to_sign}); the user approves with their passkey. Signing moves no money.",
  "Then call cancel_request again with link, recipient, signed_message (the same text) and signature (from the request's output). The message is valid for 5 minutes and works once.",
  "A paid or partly paid request can't be cancelled. Cancelling twice changes nothing.",
].join(" ");

export function cancelMessage(id: string, recipient: string, nowMs: number): string {
  return `Owed cancel ${id} for ${recipient} at ${isoSeconds(nowMs)}`;
}

function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** null when the pair looks right; otherwise what to tell the agent. */
function localCheck(id: string, recipient: string, message: string, signature: string, now: number): string | null {
  const lead = `Owed cancel ${id} for ${recipient} at `;
  const again = "Call cancel_request with only link and recipient to get a fresh message, sign that, and try again.";
  if (!message.startsWith(lead) || !ISO_RE.test(message.slice(lead.length))) {
    return `signed_message must be exactly the message_to_sign cancel_request gave for this request and wallet ("${lead}<time>"). ${again}`;
  }
  const signedAt = Date.parse(message.slice(lead.length));
  if (!Number.isFinite(signedAt)) return `signed_message has an invalid time. ${again}`;
  if (now - signedAt > MESSAGE_VALID_MS) return `That signed message is more than 5 minutes old. ${again}`;
  if (signedAt - now > MAX_SKEW_MS) return `That signed message is dated in the future. ${again}`;
  if (!signatureMatches(message, signature, recipient)) {
    return `That signature isn't from wallet ${recipient} over this exact message. Sign message_to_sign with that same wallet (request_wallet_sign, op solanaMessage) and pass its output signature unchanged.`;
  }
  return null;
}

interface Target {
  id: string;
  ctx: CallContext;
}

function resolveTarget(link: string, deps: Deps): Target | string {
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return errorText(error, "Owed is misconfigured.");
  }
  const text = link.trim();
  if (/^(?:https?:\/\/)?[^/\s]+\/g\/[1-9A-HJ-NP-Za-km-z]{12}\/?$/i.test(text)) {
    return "That is a split bill's board. A board can't be cancelled as a whole: cancel each unpaid share with its own link (…/r/<id>), from split_bill's output or the board.";
  }
  let parsed;
  try {
    parsed = deps.parseLink(text, ctx.hosts);
  } catch (error) {
    return errorText(error, "That isn't an Owed link or request id.");
  }
  if (parsed.kind !== "owed") {
    return "Only Owed requests (an Owed link or request id) can be cancelled. A plain Solana Pay link isn't stored anywhere, so there is nothing to cancel: just stop sharing it.";
  }
  return { id: parsed.id, ctx };
}

function describe(rq: Pick<GetRequestRes, "amount" | "token" | "payer_name" | "for">): string {
  const from = rq.payer_name ? ` from ${quote(rq.payer_name, 40)}` : "";
  const forPart = rq.for ? ` for ${quote(rq.for, 80)}` : "";
  return `${rq.amount} ${rq.token}${from}${forPart}`;
}

function base(target: Target, rq: GetRequestRes | CancelRes, recipient: string) {
  const payerName = clean(rq.payer_name, 40);
  const forText = clean(rq.for, 80);
  return {
    id: target.id,
    link: `${target.ctx.base}/r/${target.id}`,
    recipient,
    amount: rq.amount,
    token: rq.token,
    ...(payerName && { payer_name: payerName }),
    ...(forText && { for: forText }),
  };
}

function alreadyCancelled(target: Target, rq: GetRequestRes | CancelRes, recipient: string) {
  const at = rq.cancelled?.at;
  const output: CancelOutput = { ...base(target, rq, recipient), step: "cancelled", status: "cancelled", already_cancelled: true, ...(at && { cancelled_at: at }) };
  const text = `This request (${describe(rq)}) was already cancelled${at ? ` at ${at}` : ""}. Nothing changed. Its page: ${output.link}`;
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

function paidRefusal(rq: GetRequestRes): string {
  const tx = rq.paid?.signature ? ` (${explorerUrl(rq.paid.signature)})` : "";
  if (rq.status === "paid") return `This request is already paid${tx}, so it can't be cancelled. Nothing changed.`;
  const paid = rq.paid ? `${rq.paid.amount} of ${rq.amount} ${rq.token}` : `part of ${rq.amount} ${rq.token}`;
  return `This request already received a partial payment (${paid})${tx}, so it can't be cancelled. Nothing changed.`;
}

export async function cancelRequest(args: CancelInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  const remaining = () => CANCEL_BUDGET_MS - (deps.now() - started);
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const target = resolveTarget(args.link, deps);
  if (typeof target === "string") return refusal(target);

  if (args.signed_message === undefined && args.signature === undefined) return firstCall(target, args.recipient, deps, started, remaining);
  if (args.signed_message === undefined || args.signature === undefined) {
    return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
  }
  const problem = localCheck(target.id, args.recipient, args.signed_message, args.signature, started);
  if (problem) return refusal(problem);

  let res: CancelRes | null;
  try {
    res = await within(
      makeApi({ base: target.ctx.base, fetch: deps.fetch, timeoutMs: Math.min(CANCEL_API_TIMEOUT_MS, remaining()) })
        .cancelRequest(target.id, { recipient: args.recipient, signed_message: args.signed_message, signature: args.signature.trim() }),
      remaining(), () => null,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed request has the id ${target.id}. Nothing was cancelled.`);
    if (error instanceof ApiError && (error.code === "invalid_input" || error.code === "rate_limited")) {
      return refusal(`Owed refused the cancellation: ${error.message}. Nothing changed.`);
    }
    return refusal("Owed couldn't confirm the cancellation (its server or Solana didn't answer). Check the request with check_payments; if it still shows open, call cancel_request with only link and recipient for a fresh message.");
  }
  if (!res) {
    return refusal("Owed's server didn't answer in time, so the cancellation isn't confirmed. Check the request with check_payments; if it still shows open, call cancel_request again for a fresh message.");
  }
  if (res.id !== target.id || res.recipient !== args.recipient || res.status !== "cancelled") {
    return refusal(`Owed's server answered about a different request or state (${res.status}), so the cancellation isn't confirmed. Check the request with check_payments.`);
  }
  if (res.already_cancelled) return alreadyCancelled(target, res, args.recipient);

  const at = res.cancelled?.at;
  const output: CancelOutput = { ...base(target, res, args.recipient), step: "cancelled", status: "cancelled", already_cancelled: false, ...(at && { cancelled_at: at }) };
  const text = [
    `Cancelled: ${describe(res)}, request ${target.id}${at ? `, at ${at}` : ""}.`,
    `Its page (${output.link}) now says Cancelled with no pay buttons, pay_link refuses it and its x402 endpoint takes no payment. Your signed message is stored with it as proof that this wallet cancelled it.`,
    "Someone who kept the raw solana: payment link could still send money to your wallet; if that happens, Owed shows the request as paid.",
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

async function firstCall(target: Target, recipient: string, deps: Deps, started: number, remaining: () => number) {
  let rq: GetRequestRes | null;
  try {
    rq = await within(
      makeApi({ base: target.ctx.base, fetch: deps.fetch, timeoutMs: Math.min(LOOKUP_TIMEOUT_MS, remaining()) }).getRequest(target.id),
      remaining(), () => null,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed request has the id ${target.id}. Check the link.`);
    if (error instanceof ApiError && error.code === "invalid_input") return refusal(`Owed can't read that request: ${error.message}.`);
    return refusal("Owed's server couldn't be reached, so the request couldn't be checked and nothing was cancelled. Try again shortly.");
  }
  if (!rq) return refusal("Owed's server didn't answer in time, so nothing was cancelled. Try again shortly.");
  if (rq.id !== target.id) return refusal("Owed's server answered about a different request, so nothing was cancelled.");
  if (rq.recipient !== recipient) {
    return refusal(`This request pays ${shortAddress(rq.recipient)}, not this wallet (${shortAddress(recipient)}). Only the wallet a request pays can cancel it; if it's one of the user's other wallets, use that one as recipient.`);
  }
  if (rq.status === "cancelled") return alreadyCancelled(target, rq, recipient);
  if (rq.status === "paid" || rq.status === "underpaid") return refusal(paidRefusal(rq));
  if (rq.status !== "open" && rq.status !== "expired") return refusal(`This request can't be cancelled (status: ${rq.status}).`);

  const message_to_sign = cancelMessage(target.id, recipient, started);
  const sign_by = isoSeconds(started + MESSAGE_VALID_MS);
  const output: CancelOutput = { ...base(target, rq, recipient), step: "sign", status: rq.status, message_to_sign, sign_by };
  const expired = rq.status === "expired" ? " It has already expired; cancelling makes that final." : "";
  const text = [
    `To cancel this request (${describe(rq)}, ${output.link}), sign this exact message with PayBox. It moves no money and approves nothing else.${expired}`,
    message_to_sign,
    `Call request_wallet_sign with this wallet's credential_id and intent {"op":"solanaMessage","address":"${recipient}","message":"${message_to_sign}"}.`,
    `After the user approves, call cancel_request again with link, recipient, signed_message (the text above) and signature (from the output). Valid until ${sign_by}, once.`,
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("cancel_request", {
    title: "Cancel a payment request",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, (args) => cancelRequest(args, deps));
}
