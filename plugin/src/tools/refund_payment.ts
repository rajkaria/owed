import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { readTransfer } from "../chain.js";
import { addressSchema, decimalSchema, refundIdSchema, type CreateRefundRes, type GetRequestRes, type RefundRes, type RefundSummary } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT, type Token } from "../money.js";
import { proposeSolana, solanaOutputSchema } from "../paybox.js";
import { freshness, isoSeconds, parseRefundMessage, REFUND_MESSAGE_VALID_MS, refundIdFor, refundLead, refundMemo, refundMessage } from "../refund.js";
import { explorerUrl, shortAddress } from "../text.js";
import { signatureMatches } from "./who_owes_me.js";

// F8 invoices: refund all or part of a PAID request to the wallet that paid it. Two calls, like cancel_request. First call
// (link, recipient, optional amount): the request is read (it must pay this wallet and be paid), its refunds so far
// (GET /api/v1/refunds?requests=) say how much is still refundable, the payment is re-read on Solana to confirm who paid,
// and the exact message to sign comes back: "Owed refund <amount> <token> of <id> to <payer> for <recipient> at <ISO>".
// The agent signs it with PayBox request_wallet_sign {op:"solanaMessage"}; the second call sends it to Owed's server
// (POST /api/v1/refunds, which checks it again and stores a pending refund with a fresh reference) and returns ONE
// unsigned transfer from the user's wallet to the payer carrying that reference, for PayBox to approve with a passkey.
// The refund counts ("refunded" on pages, check_payments, who_owes_me) only once Solana shows that transfer.
//
// The output schema is PayBox's strict proposal envelope, so the first call's answer (a message to sign, nothing to
// approve yet) travels as text with a ```json block, refusal-shaped like a funding plan (plugin/src/funding.ts).

export const REFUND_BUDGET_MS = 8500;
export const LOOKUP_TIMEOUT_MS = 3000;
/** The server re-reads the request before it stores the refund; a timeout would spend the signature for nothing. */
export const REFUND_API_TIMEOUT_MS = 5000;
const CHAIN_CHECK_MS = 2500;
const READINESS_MS = 2500;

export const inputSchema = z.object({
  link: z.string().min(1).max(2048)
    .describe("The paid request to refund: its Owed link (https://…/r/<id>, or an invoice's …/i/<id>) or its request id."),
  recipient: addressSchema
    .describe("The user's own PayBox Solana wallet address (from list_credentials): the wallet the request paid. The refund is sent from it."),
  amount: decimalSchema.optional()
    .describe("How much to send back, in the request's token (USDC or SOL). Leave it out to refund everything still refundable."),
  signed_message: z.string().min(1).max(200).optional()
    .describe("Second call only: the exact message_to_sign from the first call."),
  signature: z.string().min(64).max(200).optional()
    .describe("Second call only: the signature request_wallet_sign returned for that message (hex as PayBox returns it; base58 or base64 also work)."),
  refund_id: refundIdSchema.optional()
    .describe("Only to propose the transfer again for a refund that is still pending (the user didn't approve it in time): its refund id from the earlier answer. No new signature is needed."),
}).strict();

export const outputSchema = solanaOutputSchema;
export type RefundInput = z.output<typeof inputSchema>;

const DESCRIPTION = [
  "Refund all or part of a payment the user received through Owed: one Solana transfer from the user's wallet back to the wallet that paid the request (USDC or SOL), for the user to approve in PayBox. Owed never holds money.",
  "Use it when the user says \"refund Priya\", \"send back the 5 USDC they overpaid\", \"they paid twice, refund one\" or \"refund half of that invoice\".",
  "Two calls. First call with link (the paid request's Owed link or id), recipient (the user's own PayBox Solana wallet from list_credentials) and optionally amount (leave it out to refund everything still refundable): it checks the request is paid to this wallet, how much can still be refunded and who paid, and returns message_to_sign. Nothing moves yet.",
  "Sign that exact text with PayBox request_wallet_sign (credential_id of that wallet, intent {op:\"solanaMessage\", address: recipient, message: message_to_sign}); signing moves no money. Then call refund_payment again with link, recipient, amount, signed_message and signature (valid 5 minutes, once): it returns an unsigned transfer to the payer that the user approves with their passkey.",
  "Refunds can never add up to more than was paid. Card (MoonPay) payments and payments the user matched by hand can't be refunded here, because they didn't come from the payer's own wallet. The refund shows as refunded on the request and invoice pages, check_payments and who_owes_me once Solana confirms it.",
].join(" ");

const signHow = (recipient: string, message: string) =>
  `Call request_wallet_sign with this wallet's credential_id and intent {"op":"solanaMessage","address":"${recipient}","message":"${message}"}.`;

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
  let parsed;
  try {
    parsed = deps.parseLink(link.trim(), ctx.hosts);
  } catch (error) {
    return errorText(error, "That isn't an Owed link or request id.");
  }
  if (parsed.kind !== "owed") return "Only Owed requests (an Owed link or request id) can be refunded here: a plain Solana Pay link doesn't say who paid.";
  return { id: parsed.id, ctx };
}

/** Why this request's payment can't go back to the paying wallet (the server's rule, web/lib/refunds.ts), or null. */
export function refundProblem(rq: GetRequestRes, recipient: string): string | null {
  if (rq.recipient !== recipient) {
    return `This request pays ${shortAddress(rq.recipient)}, not this wallet (${shortAddress(recipient)}). Only the wallet a request paid can refund it.`;
  }
  if (rq.chain === "base") return "This request was paid on Base; Owed refunds Solana payments only.";
  if (rq.status !== "paid" && rq.status !== "underpaid") return `This request isn't paid (it is ${rq.status}), so there is nothing to refund.`;
  if (!rq.paid) return "This request has no recorded payment to refund.";
  if (rq.paid.rail === "moonpay_card") return "This request was paid by card through MoonPay, which delivered the USDC from its own wallet. Refund the card payment through MoonPay, or ask the payer for a wallet and send it yourself.";
  if (rq.paid.rail === "matched" || rq.matched?.covers === "full") {
    return "You matched this payment by hand (it carried no reference), so it may have come from an exchange's wallet that wouldn't credit the payer. Ask the payer for their own wallet and send it yourself.";
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rq.paid.payer)) return "The paying wallet isn't a Solana wallet.";
  if (rq.paid.payer === recipient) return "This request was paid from its own wallet; there is nobody to refund.";
  return null;
}

function amounts(s: RefundSummary, token: Token): string {
  return `${s.refunded} ${token} refunded so far${s.pending !== "0" ? `, ${s.pending} ${token} waiting to land` : ""}`;
}

export async function refundPayment(args: RefundInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  const remaining = () => REFUND_BUDGET_MS - (deps.now() - started);
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const target = resolveTarget(args.link, deps);
  if (typeof target === "string") return refusal(target);
  if (args.refund_id !== undefined) {
    if (args.signed_message !== undefined || args.signature !== undefined) return refusal("Pass refund_id alone (to propose a pending refund again) or signed_message and signature, not both.");
    return again(args.refund_id, target, args.recipient, deps, remaining);
  }
  if (args.signed_message === undefined && args.signature === undefined) return firstCall(args, target, deps, started, remaining);
  if (args.signed_message === undefined || args.signature === undefined) return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
  return secondCall(args, target, deps, started, remaining);
}

// ---------------------------------------------------------------- first call: check, then the message to sign

async function firstCall(args: RefundInput, target: Target, deps: Deps, started: number, remaining: () => number) {
  const api = makeApi({ base: target.ctx.base, fetch: deps.fetch, timeoutMs: Math.min(LOOKUP_TIMEOUT_MS, remaining()) });
  let rq: GetRequestRes | null;
  let lookup: RefundSummary | null | "unsupported";
  try {
    [rq, lookup] = await within<[GetRequestRes | null, RefundSummary | null | "unsupported"]>(
      Promise.all([
        api.getRequest(target.id),
        api.refundsFor([target.id]).then(
          (res) => res.requests.find((r) => r.request_id === target.id) ?? null,
          (error: unknown) => (error instanceof ApiError && error.code === "upstream_unavailable" && error.httpStatus === 404 ? "unsupported" as const : Promise.reject(error)),
        ),
      ]),
      remaining(), () => [null, null] as [null, null],
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed request has the id ${target.id}. Check the link.`);
    if (error instanceof ApiError && error.code === "invalid_input") return refusal(`Owed can't read that request: ${error.message}.`);
    return refusal("Owed's server couldn't be reached, so the request couldn't be checked and nothing was refunded. Try again shortly.");
  }
  if (lookup === "unsupported") return refusal("This Owed server doesn't take refunds yet, so nothing was refunded.");
  if (!rq || lookup === null) return refusal("Owed's server didn't answer in time, so nothing was refunded. Try again shortly.");
  if (rq.id !== target.id) return refusal("Owed's server answered about a different request, so nothing was refunded.");
  const problem = refundProblem(rq, args.recipient);
  if (problem) return refusal(`${problem} Nothing was refunded.`);
  const token = rq.token;
  const paid = rq.paid!;
  if (lookup.paid === null) return refusal("Owed's server says this request's payment can't be refunded here. Nothing was refunded.");
  let refundable: bigint;
  let amountAtomic: bigint;
  try {
    refundable = lookup.refundable === "0" ? 0n : deps.toAtomic(lookup.refundable, token);
    amountAtomic = args.amount === undefined ? refundable : deps.toAtomic(args.amount, token);
  } catch (error) {
    return refusal(`The amount isn't valid: ${errorText(error, "use a positive decimal amount.")}`);
  }
  if (refundable <= 0n) return refusal(`Nothing is left to refund on request ${target.id}: it was paid ${lookup.paid} ${token}, ${amounts(lookup, token)}.`);
  if (amountAtomic > refundable) {
    return refusal(`At most ${lookup.refundable} ${token} can be refunded on request ${target.id} (paid ${lookup.paid} ${token}, ${amounts(lookup, token)}). Nothing was refunded.`);
  }
  const amount = deps.fromAtomic(amountAtomic, token);

  // Who paid, from Solana itself: the refund goes to the wallet that sent the payment, not to whatever the server says.
  const notes: string[] = [];
  let check;
  try {
    check = await within(readTransfer(deps.rpc(), { signature: paid.signature, recipient: args.recipient, token }, Math.max(0, Math.min(CHAIN_CHECK_MS, remaining() - 500))),
      Math.max(0, Math.min(CHAIN_CHECK_MS + 200, remaining() - 300)), () => null);
  } catch {
    check = null;
  }
  if (check && !check.ok) {
    const why = { not_found: "isn't on Solana mainnet", failed: "failed on chain", no_credit: `sent no ${token} to this wallet`, own: "was signed by this wallet itself" }[check.reason];
    return refusal(`The payment Owed recorded for this request (${explorerUrl(paid.signature)}) ${why}, so it can't be refunded from here. Nothing was refunded.`);
  }
  if (check?.ok && check.transfer.payer !== paid.payer) {
    return refusal(`On Solana, the payment for this request came from ${check.transfer.payer}, not ${paid.payer} as Owed recorded. Nothing was refunded; check the transaction (${explorerUrl(paid.signature)}).`);
  }
  if (!check) notes.push("Solana couldn't be read just now to double-check who paid; Owed's server checks the request again before recording the refund.");

  const message_to_sign = refundMessage(amount, token, target.id, paid.payer, args.recipient, started);
  const sign_by = isoSeconds(started + REFUND_MESSAGE_VALID_MS);
  const full = amountAtomic === refundable && lookup.refunded === "0" && lookup.pending === "0";
  const plan = {
    step: "sign", request_id: target.id, amount, token, payer: paid.payer, recipient: args.recipient, message_to_sign, sign_by,
    refundable: lookup.refundable, paid: lookup.paid,
    then: { tool: "refund_payment", args: { link: target.id, recipient: args.recipient, amount, signed_message: message_to_sign, signature: "<from request_wallet_sign>" } },
  };
  const text = [
    "Refund ready to sign (step 1 of 2). Nothing has moved yet.",
    `Refund ${amount} ${token}${full ? " (everything that was paid)" : ""} of request ${target.id} to ${paid.payer}, the wallet that paid ${paid.amount} ${token} on ${paid.at.slice(0, 10)} (${explorerUrl(paid.signature)}). Refundable now: ${lookup.refundable} ${token} (${amounts(lookup, token)}).`,
    ...notes,
    "Sign this exact message with PayBox; it moves no money:",
    message_to_sign,
    signHow(args.recipient, message_to_sign),
    `Then call refund_payment again with link, recipient, amount "${amount}", signed_message (the text above) and signature (from the output). Valid until ${sign_by}, once. That call returns one ${token} transfer from this wallet to the payer for the user to approve with their passkey.`,
    "```json",
    JSON.stringify(plan, null, 2),
    "```",
  ].join("\n");
  return refusal(text);
}

// ---------------------------------------------------------------- second call: record it, then the transfer

async function secondCall(args: RefundInput, target: Target, deps: Deps, started: number, remaining: () => number) {
  const message = args.signed_message!;
  const signature = args.signature!.trim();
  const again = "Call refund_payment with only link, recipient and amount to get a fresh message, sign that, and try again.";
  const signed = parseRefundMessage(message);
  if (!signed || signed.requestId !== target.id || signed.recipient !== args.recipient) {
    return refusal(`signed_message must be exactly the message_to_sign refund_payment gave for this request and wallet ("Owed refund <amount> <token> of ${target.id} to <payer> for ${args.recipient} at <time>"). ${again}`);
  }
  const token = signed.token;
  let amountAtomic: bigint;
  try {
    amountAtomic = deps.toAtomic(signed.amount, token);
  } catch (error) {
    return refusal(`The signed amount isn't valid: ${errorText(error, "use a positive decimal amount.")} ${again}`);
  }
  if (deps.fromAtomic(amountAtomic, token) !== signed.amount) return refusal(`signed_message must name the amount as refund_payment wrote it. ${again}`);
  if (args.amount !== undefined) {
    let asked: bigint | null = null;
    try {
      asked = deps.toAtomic(args.amount, token);
    } catch {
      asked = null;
    }
    if (asked !== amountAtomic) return refusal(`amount ${args.amount} differs from the ${signed.amount} ${token} in signed_message. ${again}`);
  }
  if (signed.payer === args.recipient) return refusal("A refund can't go to the wallet that sends it.");
  const stale = freshness(signed.at, started);
  if (stale) return refusal(`${stale} ${again}`);
  if (!signatureMatches(message, signature, args.recipient)) {
    return refusal(`That signature isn't from wallet ${args.recipient} over this exact message. Sign message_to_sign with that same wallet (request_wallet_sign, op solanaMessage) and pass its output signature unchanged.`);
  }
  if (message !== `${refundLead(signed.amount, token, target.id, signed.payer, args.recipient)} at ${isoSeconds(signed.at)}`) {
    return refusal(`signed_message must end with a whole-second UTC time, exactly as refund_payment wrote it. ${again}`);
  }

  // The balance first: the server spends the signature, so nothing is recorded unless the transfer can be sent.
  const ready = await readiness(deps, args.recipient, signed.payer, token, amountAtomic, remaining);
  if (typeof ready === "string") return refusal(`${ready} Nothing was recorded: once that's fixed, call refund_payment again with the same signed_message and signature (valid until ${isoSeconds(signed.at + REFUND_MESSAGE_VALID_MS)}).`);

  let res: CreateRefundRes | null;
  try {
    res = await within(
      makeApi({ base: target.ctx.base, fetch: deps.fetch, timeoutMs: Math.max(500, Math.min(REFUND_API_TIMEOUT_MS, remaining() - 400)) })
        .createRefund({ request: target.id, recipient: args.recipient, amount: signed.amount, signed_message: message, signature }),
      Math.max(0, remaining() - 300), () => null,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed request has the id ${target.id}. Nothing was refunded.`);
    if (error instanceof ApiError && (error.code === "invalid_input" || error.code === "rate_limited")) return refusal(`Owed refused the refund: ${error.message}. Nothing was refunded.`);
    if (error instanceof ApiError && error.httpStatus === 404) return refusal("This Owed server doesn't take refunds yet, so nothing was refunded.");
    return refusal("Owed couldn't record the refund (its server or Solana didn't answer). Nothing was sent. Check the request with check_payments, then ask refund_payment for a fresh message.");
  }
  if (!res) return refusal("Owed's server didn't answer in time, so the refund isn't confirmed and nothing was sent. Check the request with check_payments before trying again.");
  const mismatch = checkRefund(res, { id: target.id, recipient: args.recipient, payer: signed.payer, token, amountAtomic }, deps);
  if (mismatch) return refusal(mismatch);
  return propose(res, ready, deps, [
    `Refund ${signed.amount} ${token} to ${signed.payer} for request ${target.id}. Approve in PayBox to send it.`,
    `It carries refund ${res.id}'s reference and the memo ${res.memo}. Owed shows it as refunded (request and invoice pages, check_payments, who_owes_me) once Solana confirms it; if the user doesn't approve it within 30 minutes, the ${signed.amount} ${token} is refundable again. Paid ${res.paid} ${token}; refunded ${res.refunded}, waiting ${res.pending}, still refundable ${res.refundable}.`,
  ]);
}

// ---------------------------------------------------------------- refund_id: the transfer again for a pending refund

async function again(refundId: string, target: Target, recipient: string, deps: Deps, remaining: () => number) {
  let res: RefundRes | null;
  try {
    res = await within(makeApi({ base: target.ctx.base, fetch: deps.fetch, timeoutMs: Math.min(LOOKUP_TIMEOUT_MS, remaining()) }).getRefund(refundId), remaining(), () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed refund has the id ${refundId}.`);
    return refusal("Owed's server couldn't be reached, so the refund couldn't be read. Try again shortly.");
  }
  if (!res) return refusal("Owed's server didn't answer in time. Try again shortly.");
  if (res.request_id !== target.id) return refusal(`Refund ${refundId} is for request ${res.request_id}, not ${target.id}.`);
  if (res.recipient !== recipient) return refusal(`Refund ${refundId} is sent by ${shortAddress(res.recipient)}, not this wallet.`);
  if (res.status === "confirmed") return refusal(`Refund ${refundId} already landed (${res.confirmed ? explorerUrl(res.confirmed.signature) : "confirmed"}). Nothing more to send.`);
  if (res.status === "lapsed") return refusal(`Refund ${refundId} wasn't sent within 30 minutes, so its amount is refundable again. Call refund_payment with link, recipient and amount for a fresh one.`);
  // The signed message pins the payer and the amount; the server's copy must agree with it.
  const signed = parseRefundMessage(res.signed_message);
  let amountAtomic: bigint;
  try {
    amountAtomic = deps.toAtomic(res.amount, res.token);
  } catch {
    return refusal("Owed's server returned a refund it can't read, so nothing was proposed.");
  }
  if (!signed || signed.payer !== res.payer || signed.amount !== res.amount || signed.token !== res.token || signed.requestId !== target.id || signed.recipient !== recipient
    || !signatureMatches(res.signed_message, res.signature, recipient)) {
    return refusal("Owed's server returned a refund whose signed message doesn't match it, so nothing was proposed.");
  }
  const mismatch = checkRefund(res, { id: target.id, recipient, payer: signed.payer, token: res.token, amountAtomic }, deps);
  if (mismatch) return refusal(mismatch);
  const ready = await readiness(deps, recipient, res.payer, res.token, amountAtomic, remaining);
  if (typeof ready === "string") return refusal(`${ready} The refund is still pending; call refund_payment with refund_id again once that's fixed.`);
  return propose(res, ready, deps, [
    `Refund ${res.amount} ${res.token} to ${res.payer} for request ${target.id} (refund ${res.id}, still pending). Approve in PayBox to send it.`,
    "It shows as refunded once Solana confirms it.",
  ]);
}

// ---------------------------------------------------------------- shared

async function readiness(deps: Deps, sender: string, payer: string, token: Token, amountAtomic: bigint, remaining: () => number): Promise<{ recipientAtaExists: boolean } | string> {
  let r;
  try {
    r = await within(deps.payerReadiness(deps.rpc(), { sender, recipient: payer, token, amountAtomic }, Math.max(0, Math.min(READINESS_MS, remaining() - 4000))),
      Math.max(0, Math.min(READINESS_MS + 200, remaining() - 3800)), () => null);
  } catch {
    r = null;
  }
  if (!r) return "Solana couldn't be reached to check your balance.";
  if (!r.ok) return `This wallet can't send the refund right now: ${(r.reason ?? "it can't cover the refund and its fees.").replace("this request is", "the refund is")}`;
  return { recipientAtaExists: r.recipientAtaExists };
}

/** The server's refund must be exactly what was signed: this request, this wallet, this payer, this amount, its own id. */
function checkRefund(res: RefundRes, want: { id: string; recipient: string; payer: string; token: Token; amountAtomic: bigint }, deps: Deps): string | null {
  const bad = "Owed's server returned a refund that doesn't match what was signed, so nothing was proposed. Check the request with check_payments.";
  try {
    if (res.request_id !== want.id || res.recipient !== want.recipient || res.payer !== want.payer || res.token !== want.token) return bad;
    if (deps.toAtomic(res.amount, res.token) !== want.amountAtomic) return bad;
    if (res.memo !== refundMemo(res.id)) return bad;
    if (refundIdFor({ requestId: want.id, payer: want.payer, token: want.token, amountAtomic: want.amountAtomic, reference: res.reference }) !== res.id) return bad;
    if (res.status !== "pending") return `Refund ${res.id} is ${res.status}, so nothing was proposed.`;
    return null;
  } catch {
    return bad;
  }
}

function propose(res: RefundRes, ready: { recipientAtaExists: boolean }, deps: Deps, lines: string[]) {
  const token = res.token;
  let structuredContent;
  try {
    const built = deps.buildTransferTx({
      sender: res.recipient,
      request: { recipient: res.payer, amount: res.amount, ...(token === "USDC" && { splToken: USDC_MINT }), references: [res.reference], memo: refundMemo(res.id) },
      token,
      amountAtomic: deps.toAtomic(res.amount, token),
      createRecipientAta: token === "USDC" && !ready.recipientAtaExists,
    });
    structuredContent = proposeSolana({ transactionBase64: built.transactionBase64 }).structuredContent;
  } catch (error) {
    return refusal(`Couldn't build the refund transfer: ${errorText(error, "unknown error")}. The refund ${res.id} stays pending for 30 minutes; call refund_payment with refund_id to try again.`);
  }
  const extra = token === "USDC" && !ready.recipientAtaExists ? ["This also opens the payer's USDC account (about 0.002 SOL, paid by this wallet)."] : [];
  return { content: [{ type: "text" as const, text: [...lines, ...extra].join("\n") }], structuredContent };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("refund_payment", {
    title: "Refund a payment",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args) => refundPayment(args, deps));
}
