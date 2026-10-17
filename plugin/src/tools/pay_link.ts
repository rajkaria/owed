import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, decimalSchema, type GetRequestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT, type Token } from "../money.js";
import { proposeSolana, proposeX402, solanaOutputSchema, x402OutputSchema } from "../paybox.js";
import type { TransferRequest } from "../solana-pay.js";
import { idMatchesTerms, VERIFIED_ID_LENGTH } from "../request-id.js";
// W2-H verified payee start
import { PAYEE_BUDGET_MS, payeeForPayment } from "../payee.js";
// W2-H verified payee end
import { brandFlags, cautionLine, quote, shortAddress } from "../text.js";
// W3-B Base requests start
import { evmAddressSchema } from "../contract.js";
import { payBaseRequest } from "../base-request.js";
// W3-B Base requests end

export const inputSchema = z.object({
  link: z.string().min(1).max(2048).describe("What to pay: an Owed link or request id, a Solana Pay transfer URL (solana:...), or the text of a payment QR code."),
  sender: z.union([addressSchema, evmAddressSchema]).describe("The user's own PayBox Solana wallet address that pays (from list_credentials). Use the same wallet you pass as use_plugin.wallet_id. For a request on Base, the user's Base (0x) wallet address."), // W3-B: 0x for Base
  max_amount: decimalSchema.optional().describe("Optional ceiling in the link's token; the tool refuses if the request asks for more."),
  amount: decimalSchema.optional().describe("Only for links that don't set an amount: how much to send, in token units."),
  rail: z.enum(["solana_pay", "x402"]).optional().describe("How to pay. solana_pay (default): an unsigned Solana transaction from the user's wallet. x402: pay an Owed USDC request at its x402 URL; PayBox pays it over x402 and the facilitator covers the network fee, so no SOL is needed."),
  // W2-H verified payee start
  allow_unverified: z.boolean().optional().describe("Only when the user explicitly accepts it: pay a request that names a domain even though DNS can't be checked right now. Never pays a domain that doesn't publish the wallet."),
  // W2-H verified payee end
}).strict();

const PROPOSAL_KEY = "io.paybox/transactionProposal";
/** A Solana transaction proposal (rail solana_pay) or an x402 payment proposal (rail x402). */
export const outputSchema = z.object({
  [PROPOSAL_KEY]: z.union([solanaOutputSchema.shape[PROPOSAL_KEY], x402OutputSchema.shape[PROPOSAL_KEY]]),
}).strict();
export type PayInput = z.output<typeof inputSchema>;

/** Leaves room for process start-up and output inside PayBox's 10 s per-call limit. */
export const PAY_BUDGET_MS = 8500;

export const REFUSE_TRANSACTION_REQUEST = "This is a Solana Pay checkout link (transaction request). Owed pays transfer links only; open it in a wallet app instead.";
export const REFUSE_ALREADY_PAID = "This request is already paid.";

const DESCRIPTION = [
  "Pay someone's payment request: an Owed link or id, or any Solana Pay transfer link or QR text (USDC or SOL).",
  "Use it when the user pastes a link and says \"pay this\" or \"pay Raj's request\".",
  "sender is the user's own PayBox Solana wallet address (from list_credentials). The tool checks the request is still open and that the wallet has the funds plus about 0.003 SOL for fees, then returns an unsigned Solana transaction for the user to approve in PayBox.",
  "It refuses checkout links (Solana Pay transaction requests), paid requests and amounts above max_amount.",
  "With rail \"x402\" (Owed USDC requests only) it checks the request's live x402 challenge pays exactly the same recipient and amount, then returns an x402 payment proposal instead; use it when the user asks to pay over x402 or has no SOL for fees.",
  "Show the user the text preview: it quotes the requester's words as unverified and adds a caution if they mention a brand. Nothing is sent until the user approves in PayBox.",
  // W2-H verified payee start
  "If the request names a domain (from_domain), the tool checks that domain's DNS itself and refuses unless the domain publishes the recipient wallet; a verified domain leads the preview.",
  // W2-H verified payee end
  "A request on Base (USDC on chain 8453) is paid over x402 from the user's PayBox Base wallet (the facilitator pays the gas); if that can't be offered the tool says how to pay it from a Base wallet. It never builds a Solana transaction for a Base request.", // W3-B
].join(" ");

interface Resolved {
  /** The Owed request id, when the link is an Owed link (checked against its terms). */
  id?: string;
  request: TransferRequest;
  token: Token;
  /** Requester-written text, raw (untrusted); shown only through quote(). */
  name?: string | null;
  notes: Array<string | null | undefined>;
  flags: string[];
  // W2-H verified payee start
  /** The domain the request claims to come from (server-supplied, untrusted until DNS says so). */
  fromDomain?: string | null;
  // W2-H verified payee end
}

export async function payLink(args: PayInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  // W3-B: a 0x sender is checked once the request turns out to be on Base.
  if (!deps.isSolanaAddress(args.sender) && !args.sender.startsWith("0x")) return refusal("sender must be a Solana wallet address (the user's own PayBox Solana wallet).");
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
  const x402 = args.rail === "x402";
  if (x402 && parsed.kind !== "owed") return refusal(REFUSE_X402_NOT_OWED);

  let resolved: Resolved;
  if (parsed.kind === "owed") {
    const result = await resolveOwed(parsed.id, ctx, deps);
    if (typeof result === "string") return refusal(result);
    // W3-B Base requests start
    if ("baseRequest" in result) return payBaseRequest(result.baseRequest, parsed.id, args, ctx, deps, PAY_BUDGET_MS - (deps.now() - started));
    // W3-B Base requests end
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
  if (x402 && token !== "USDC") return refusal(REFUSE_X402_NOT_USDC);
  // W3-B: from here on the request is on Solana, so the sender must be a Solana wallet.
  if (!deps.isSolanaAddress(args.sender)) return refusal("This request is on Solana: sender must be the user's own PayBox Solana wallet address, not a 0x address.");

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

  const remaining = () => PAY_BUDGET_MS - (deps.now() - started);
  // The x402 rail reads the live challenge while the balance check runs.
  const x402Url = x402 && resolved.id ? x402UrlFor(ctx.base, resolved.id) : null;
  const challengeCheck = x402Url
    ? checkX402Challenge(x402Url, { recipient: request.recipient, amountAtomic }, deps, Math.min(X402_CHALLENGE_TIMEOUT_MS, remaining()))
    : null;
  // W2-H verified payee start
  const payeeCheck = payeeForPayment(resolved.fromDomain, request.recipient, args.allow_unverified === true, deps,
    Math.min(PAYEE_BUDGET_MS, PAY_BUDGET_MS - (deps.now() - started)));
  // W2-H verified payee end
  let readiness;
  try {
    readiness = await within(
      deps.payerReadiness(deps.rpc(), { sender: args.sender, recipient: request.recipient, token, amountAtomic }),
      remaining(), () => null,
    );
  } catch {
    readiness = null;
  }
  // W2-H verified payee start
  const payee = await payeeCheck;
  if (!payee.ok) return refusal(payee.refuse);
  // W2-H verified payee end
  if (!readiness) return refusal("Solana couldn't be reached to check your balance. Nothing was sent; try again in a moment.");
  // Over x402 the facilitator pays the network fee, so a wallet without SOL can still pay.
  const feeOnly = x402 && readiness.reason !== undefined && FEE_SHORTFALL.test(readiness.reason);
  if (!readiness.ok && !feeOnly) return refusal(readiness.reason ?? "Your wallet can't cover this payment and its fees.");

  const createRecipientAta = token === "USDC" && !readiness.recipientAtaExists;
  let structuredContent;
  if (x402) {
    // An x402 payment can't open the recipient's USDC account the way the Solana Pay transaction does.
    if (createRecipientAta) return refusal(REFUSE_X402_NO_ACCOUNT);
    const challenge = await challengeCheck!;
    if (challenge !== true) return refusal(challenge);
    try {
      structuredContent = proposeX402({ chain: "solana:mainnet", url: x402Url!, maxAmount: amountAtomic.toString() }).structuredContent;
    } catch (error) {
      return refusal(`Couldn't build the x402 payment: ${errorText(error, "unknown error")}`);
    }
  } else {
    try {
      const built = deps.buildTransferTx({ sender: args.sender, request, token, amountAtomic, createRecipientAta });
      structuredContent = proposeSolana({ transactionBase64: built.transactionBase64 }).structuredContent;
    } catch (error) {
      return refusal(`Couldn't build the payment: ${errorText(error, "unknown error")}`);
    }
  }

  const caution = cautionLine([...new Set([...resolved.flags, ...brandFlags(resolved.name, ...resolved.notes)])]);
  const notes = resolved.notes.map((n) => quote(n, 140)).filter(Boolean);
  const name = quote(resolved.name, 40);
  const preview = [
    // W2-H verified payee start
    `Pay ${amount} ${token} to ${payee.lead ?? shortAddress(request.recipient)}${x402 ? " over x402" : ""}.`,
    // W2-H verified payee end
    notes.length > 0 ? `Requester's note, unverified: ${notes.join(", ")}.` : "",
    name ? `Requester's name, unverified: ${name}.` : "",
    createRecipientAta ? "This also opens the recipient's USDC account (about 0.002 SOL, paid by you)." : "",
    x402 ? "The x402 facilitator pays the network fee." : "",
    "Approve in PayBox to send.",
  ].filter(Boolean).join(" ");
  // W2-H verified payee start
  const text = [caution, preview, `Recipient: ${request.recipient}`, ...payee.lines].filter(Boolean).join("\n");
  // W2-H verified payee end
  return { content: [{ type: "text" as const, text }], structuredContent };
}

export const REFUSE_UNVERIFIABLE = "This is an older Owed link whose payment details can't be checked against its id, so Owed won't pay it. Ask the requester for a new link.";
export const REFUSE_TAMPERED = "This link's payment details don't match its id: the recipient or amount may have been changed after the link was made. Nothing was sent; ask the requester for a new link.";

function tokenOf(r: TransferRequest): Token | null {
  if (r.splToken === undefined) return "SOL";
  return r.splToken === USDC_MINT ? "USDC" : null;
}

async function resolveOwed(id: string, ctx: CallContext, deps: Deps): Promise<Resolved | { baseRequest: GetRequestRes } | string> {
  if (id.length !== VERIFIED_ID_LENGTH) return REFUSE_UNVERIFIABLE;
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
  // W3-B Base requests: checked and paid in base-request.ts (x402 on eip155:8453, never a Solana transaction).
  if (rq.chain === "base") return { baseRequest: rq };
  if (rq.solana_pay_url === null) return "Owed's server returned a payment link it can't read. Nothing was sent."; // W3-B

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
  // The id is a hash of the payment terms, so the server can't swap the recipient or amount
  // behind a link someone already shared: different terms would need a different id.
  if (rq.id !== id || !parsed.request.references.includes(rq.reference)
    || !idMatchesTerms(id, { recipient: rq.recipient, token, amountAtomic: deps.toAtomic(rq.amount, token), reference: rq.reference })) {
    return REFUSE_TAMPERED;
  }
  return {
    id, request: parsed.request, token,
    name: rq.requester_name, notes: [rq.for, rq.note], flags: rq.flags,
    // W2-H verified payee start
    fromDomain: rq.from_domain,
    // W2-H verified payee end
  };
}

// ---- x402 rail (SPEC §5.2 T2.2) ----

export const REFUSE_X402_NOT_OWED = "x402 pays Owed requests only (an Owed link or id). Pay this link with rail solana_pay.";
export const REFUSE_X402_NOT_USDC = "x402 pays USDC requests only. Pay this request with rail solana_pay.";
export const REFUSE_X402_NO_ACCOUNT = "The recipient has no USDC account yet, and an x402 payment can't open one. Pay with rail solana_pay, which opens it (about 0.002 SOL).";
export const REFUSE_X402_MISMATCH = "This request's x402 endpoint asks for a different payment than the request itself (recipient, amount or asset). Nothing was sent.";
export const X402_CHALLENGE_TIMEOUT_MS = 3000;
const FEE_SHORTFALL = /needs about [0-9.]+ SOL for fees/;
const X402_NETWORK_V2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const X402_NETWORK_V1 = "solana";

export function x402UrlFor(base: string, id: string): string {
  return `${base}/x/${encodeURIComponent(id)}`;
}

function decodeBase64Json(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function entries(doc: unknown): Array<Record<string, unknown>> | null {
  const accepts = (doc as { accepts?: unknown } | null | undefined)?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  return accepts.every((a) => typeof a === "object" && a !== null) ? accepts as Array<Record<string, unknown>> : null;
}

/**
 * PayBox fetches the challenge again when it pays, so this can't pin what it pays; it does
 * refuse before proposing if the server's challenge disagrees with the id-checked request.
 * Every option in both x402 generations must pay exactly the request's recipient and amount.
 */
export async function checkX402Challenge(
  url: string,
  expect: { recipient: string; amountAtomic: bigint },
  deps: Pick<Deps, "fetch">,
  timeoutMs: number,
): Promise<true | string> {
  let res: Response;
  try {
    res = await deps.fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)), redirect: "error" });
  } catch {
    return "Owed's x402 endpoint couldn't be reached. Nothing was sent; try again, or pay with rail solana_pay.";
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 200 && (body as { paid?: unknown } | undefined)?.paid === true) return REFUSE_ALREADY_PAID;
  if (res.status !== 402) {
    const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
    return `Owed's x402 endpoint can't take this payment (HTTP ${res.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}). Nothing was sent.`;
  }
  const amount = expect.amountAtomic.toString();
  const v2 = entries(decodeBase64Json(res.headers.get("payment-required")));
  const v1 = entries(body);
  if (!v2 && !v1) return "Owed's x402 endpoint returned a challenge Owed can't read. Nothing was sent.";
  const ok =
    (v2 ?? []).every((a) => a.scheme === "exact" && a.network === X402_NETWORK_V2 && a.asset === USDC_MINT && a.payTo === expect.recipient && a.amount === amount)
    && (v1 ?? []).every((a) => a.scheme === "exact" && a.network === X402_NETWORK_V1 && a.asset === USDC_MINT && a.payTo === expect.recipient && a.maxAmountRequired === amount);
  return ok ? true : REFUSE_X402_MISMATCH;
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
