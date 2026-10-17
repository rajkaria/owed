import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, decimalSchema, type GetRequestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT, type Token } from "../money.js";
import { proposeSolana, solanaOutputSchema } from "../paybox.js";
import type { TransferRequest } from "../solana-pay.js";
import { brandFlags, cautionLine, quote, shortAddress } from "../text.js";

export const inputSchema = z.object({
  link: z.string().min(1).max(2048).describe("What to pay: an Owed link or request id, a Solana Pay transfer URL (solana:...), or the text of a payment QR code."),
  sender: addressSchema.describe("The user's own PayBox Solana wallet address that pays (from list_credentials). Use the same wallet you pass as use_plugin.wallet_id."),
  max_amount: decimalSchema.optional().describe("Optional ceiling in the link's token; the tool refuses if the request asks for more."),
  amount: decimalSchema.optional().describe("Only for links that don't set an amount: how much to send, in token units."),
}).strict();

export const outputSchema = solanaOutputSchema;
export type PayInput = z.output<typeof inputSchema>;

export const REFUSE_TRANSACTION_REQUEST = "This is a Solana Pay checkout link (transaction request). Owed pays transfer links only; open it in a wallet app instead.";
export const REFUSE_ALREADY_PAID = "This request is already paid.";

const DESCRIPTION = [
  "Pay someone's payment request: an Owed link or id, or any Solana Pay transfer link or QR text (USDC or SOL).",
  "Use it when the user pastes a link and says \"pay this\" or \"pay Raj's request\".",
  "sender is the user's own PayBox Solana wallet address (from list_credentials). The tool checks the request is still open and that the wallet has the funds plus about 0.003 SOL for fees, then returns an unsigned Solana transaction for the user to approve in PayBox.",
  "It refuses checkout links (Solana Pay transaction requests), paid requests and amounts above max_amount.",
  "Show the user the text preview: it quotes the requester's words as unverified and adds a caution if they mention a brand. Nothing is sent until the user approves in PayBox.",
].join(" ");

interface Resolved {
  request: TransferRequest;
  token: Token;
  /** Requester-written text, raw (untrusted); shown only through quote(). */
  name?: string | null;
  notes: Array<string | null | undefined>;
  flags: string[];
}

export async function payLink(args: PayInput, deps: Deps = defaultDeps) {
  if (!deps.isSolanaAddress(args.sender)) return refusal("sender must be a Solana wallet address (the user's own PayBox Solana wallet).");
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  let parsed;
  try {
    parsed = deps.parseLink(args.link.trim(), ctx.hosts);
  } catch (error) {
    return refusal(errorText(error, "This isn't a payment link Owed can read."));
  }
  if (parsed.kind === "transaction") return refusal(REFUSE_TRANSACTION_REQUEST);

  let resolved: Resolved;
  if (parsed.kind === "owed") {
    const result = await resolveOwed(parsed.id, ctx, deps);
    if (typeof result === "string") return refusal(result);
    resolved = result;
  } else {
    const token = tokenOf(parsed.request);
    if (!token) return refusal("Owed pays USDC or SOL links only.");
    const r = parsed.request;
    // An "owed:<id>" memo is Owed's own tag, not requester text.
    const memo = r.memo?.startsWith("owed:") ? undefined : r.memo;
    resolved = { request: r, token, name: r.label, notes: [r.message, memo], flags: [] };
  }
  const { request, token } = resolved;

  if (request.recipient === args.sender) return refusal("This request pays your own wallet, so there is nothing to send.");

  let amountAtomic: bigint;
  try {
    if (request.amount !== undefined) {
      amountAtomic = deps.toAtomic(request.amount, token);
      if (args.amount !== undefined && deps.toAtomic(args.amount, token) !== amountAtomic) {
        return refusal(`This link already sets the amount to ${deps.fromAtomic(amountAtomic, token)} ${token}; it can't be changed.`);
      }
    } else {
      if (args.amount === undefined) return refusal(`This link doesn't set an amount. Ask the user how much ${token} to send and pass it as amount.`);
      amountAtomic = deps.toAtomic(args.amount, token);
    }
  } catch (error) {
    return refusal(`The amount isn't valid: ${errorText(error, "use a positive decimal amount.")}`);
  }
  const amount = deps.fromAtomic(amountAtomic, token);

  if (args.max_amount !== undefined) {
    let max: bigint;
    try {
      max = deps.toAtomic(args.max_amount, token);
    } catch (error) {
      return refusal(`max_amount isn't valid: ${errorText(error, "use a positive decimal amount.")}`);
    }
    if (amountAtomic > max) {
      return refusal(`This request is for ${amount} ${token}, above your limit of ${deps.fromAtomic(max, token)} ${token}. Nothing was sent.`);
    }
  }

  let readiness;
  try {
    readiness = await deps.payerReadiness(deps.rpc(), { sender: args.sender, recipient: request.recipient, token, amountAtomic });
  } catch {
    return refusal("Solana couldn't be reached to check your balance. Nothing was sent; try again in a moment.");
  }
  if (!readiness.ok) return refusal(readiness.reason ?? "Your wallet can't cover this payment and its fees.");

  const createRecipientAta = token === "USDC" && !readiness.recipientAtaExists;
  let structuredContent;
  try {
    const built = deps.buildTransferTx({ sender: args.sender, request, token, amountAtomic, createRecipientAta });
    structuredContent = proposeSolana({ transactionBase64: built.transactionBase64 }).structuredContent;
  } catch (error) {
    return refusal(`Couldn't build the payment: ${errorText(error, "unknown error")}`);
  }

  const caution = cautionLine([...new Set([...resolved.flags, ...brandFlags(resolved.name, ...resolved.notes)])]);
  const notes = resolved.notes.map((n) => quote(n, 140)).filter(Boolean);
  const name = quote(resolved.name, 40);
  const preview = [
    `Pay ${amount} ${token} to ${shortAddress(request.recipient)}.`,
    notes.length > 0 ? `Requester's note, unverified: ${notes.join(", ")}.` : "",
    name ? `Requester's name, unverified: ${name}.` : "",
    createRecipientAta ? "This also opens the recipient's USDC account (about 0.002 SOL, paid by you)." : "",
    "Approve in PayBox to send.",
  ].filter(Boolean).join(" ");
  const text = [caution, preview, `Recipient: ${request.recipient}`].filter(Boolean).join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function tokenOf(r: TransferRequest): Token | null {
  if (r.splToken === undefined) return "SOL";
  return r.splToken === USDC_MINT ? "USDC" : null;
}

async function resolveOwed(id: string, ctx: CallContext, deps: Deps): Promise<Resolved | string> {
  let rq: GetRequestRes;
  try {
    rq = await ctx.api.getRequest(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return `No Owed request has the id ${id}. Check the link with the requester.`;
    if (error instanceof ApiError && error.code === "upstream_unavailable") {
      return "Owed's server is unreachable, so this link can't be resolved right now. Try again shortly, or ask the requester for the Solana Pay link.";
    }
    return `Owed couldn't load this request: ${errorText(error, "unknown error")}`;
  }
  if (rq.status === "paid") return REFUSE_ALREADY_PAID;
  if (rq.status === "cancelled") return "This request was cancelled by the requester.";
  if (rq.status === "underpaid") {
    const paid = rq.paid ? `${rq.paid.amount} of ${rq.amount} ${rq.token}` : `part of ${rq.amount} ${rq.token}`;
    return `This request already received a partial payment (${paid}). Ask the requester for a new link for the rest.`;
  }
  if (rq.status !== "open") return `This request can't be paid (status: ${rq.status}).`;

  let parsed;
  try {
    parsed = deps.parseLink(rq.solana_pay_url, ctx.hosts);
  } catch {
    return "Owed's server returned a payment link it can't read. Nothing was sent.";
  }
  const token = parsed.kind === "transfer" ? tokenOf(parsed.request) : null;
  if (parsed.kind !== "transfer" || token !== rq.token || parsed.request.recipient !== rq.recipient
    || parsed.request.amount === undefined || deps.toAtomic(parsed.request.amount, token) !== deps.toAtomic(rq.amount, token)) {
    return "Owed's server returned a payment link that doesn't match the request. Nothing was sent.";
  }
  return {
    request: parsed.request, token,
    name: rq.requester_name, notes: [rq.for, rq.note], flags: rq.flags,
  };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("pay_link", {
    title: "Pay a payment request",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args) => payLink(args, deps));
}
