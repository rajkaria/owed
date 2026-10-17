import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { incomingTransfers, readTransfer, type IncomingScan, type IncomingTransfer } from "../chain.js";
import { addressSchema, signatureSchema, tokenSchema, type AttributedRes, type GetRequestRes, type LedgerEntry, type RestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import type { Token } from "../money.js";
import { idMatchesTerms } from "../request-id.js";
import { clean, explorerUrl, MATCHED_LABEL, quote, shortAddress } from "../text.js";
import { ledgerMessage, signatureMatches } from "./who_owes_me.js";

// 0012: find payments that were made but never counted. A payment counts only when it carries the request's Solana Pay
// reference; exchanges and some wallets drop it, so real money sits in the recipient's wallet while the request shows
// open (or underpaid). Three actions:
//   find          reads the recipient's incoming USDC (and SOL) transfers since each open or underpaid request was made,
//                 skips anything Owed already counts, and returns the transfers of exactly the amount still due, ranked,
//                 each with plain reasons and ambiguity warnings. Nothing is marked: it only proposes.
//                 With `requests` (Owed links or ids) no signature is needed. Without, it reads the recipient's ledger,
//                 which takes the same signed "Owed ledger access" message as who_owes_me (two calls).
//   confirm       counts one candidate, proven by the wallet the request pays: the first call checks the transaction
//                 and returns "Owed match <transaction> to <id> for <recipient> at <ISO time>" to sign with PayBox's
//                 request_wallet_sign; the second sends it. Owed's server re-reads the transaction (exact amount still
//                 due, to this wallet, after the request, no Owed reference, not counted elsewhere), then marks the
//                 request paid as "matched by the recipient (no reference on the payment)", keeping the signed message.
//   ask_for_rest  for an underpaid request: one new linked request for exactly what is still owed.

export const MATCH_BUDGET_MS = 8500;
export const LOOKUP_TIMEOUT_MS = 3500;
/** The ledger route checks open requests on chain before it answers. */
export const LEDGER_TIMEOUT_MS = 4500;
/** The server reads the chain twice before it records a match; a timeout would spend the signature for nothing. */
export const CONFIRM_API_TIMEOUT_MS = 7000;
export const MESSAGE_VALID_MS = 5 * 60_000;
const MAX_SKEW_MS = 60_000;
/** A transfer this long before the request was made is clock skew at most (the server allows the same). */
const CREATED_SKEW_MS = 60_000;
const MAX_REQUESTS = 10;
const MAX_CANDIDATES = 20;
const MAX_LINES = 12;

export const inputSchema = z.object({
  recipient: addressSchema
    .describe("The user's own PayBox Solana wallet address (from list_credentials): the wallet the requests pay."),
  action: z.enum(["find", "confirm", "ask_for_rest"]).optional()
    .describe("find (default): look for uncounted payments. confirm: count one candidate (needs a signature). ask_for_rest: new request for what an underpaid request still owes."),
  requests: z.array(z.string().min(1).max(2048)).min(1).max(MAX_REQUESTS).optional()
    .describe("find: up to 10 Owed request links or ids to look at. Leave out to look at all the wallet's open requests (then it needs a signed ledger message, two calls)."),
  link: z.string().min(1).max(2048).optional()
    .describe("confirm / ask_for_rest: the request (its Owed link or id)."),
  transaction: signatureSchema.optional()
    .describe("confirm: the candidate's transaction signature, from find's output."),
  signed_message: z.string().min(1).max(200).optional()
    .describe("Second call only: the exact message_to_sign from the first call."),
  signature: z.string().min(64).max(200).optional()
    .describe("Second call only: the signature request_wallet_sign returned for that message (hex as PayBox returns it)."),
}).strict();

const candidateSchema = z.object({
  request_id: z.string(),
  request_link: z.string(),
  token: tokenSchema,
  request_amount: z.string(),
  expected: z.string().describe("What the request still needs: its amount, or the remainder of an underpaid one."),
  covers: z.enum(["full", "rest"]).describe("full = would pay the request; rest = would pay the remainder after a partial payment."),
  transaction: z.string(),
  explorer_url: z.string(),
  payer: z.string().describe("The wallet that sent it (for an exchange withdrawal, the exchange's wallet)."),
  amount: z.string(),
  at: z.string(),
  confidence: z.enum(["high", "medium", "low", "ambiguous"]).describe("ambiguous = it fits more than one request, or the request has more than one fitting transfer: ask the user."),
  score: z.number().int(),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  payer_name: z.string().optional().describe("Written by whoever created the request; unverified."),
  for: z.string().optional().describe("Written by whoever created the request; unverified."),
}).strict();

const underpaidSchema = z.object({
  request_id: z.string(),
  request_link: z.string(),
  token: tokenSchema,
  amount: z.string(),
  amount_paid: z.string(),
  remaining: z.string(),
  rest_request: z.string().optional().describe("A follow-up request already asks for the rest."),
}).strict();

const scanSchema = z.object({
  token: tokenSchema,
  account: z.string().describe("The account read: the wallet's USDC account, or the wallet for SOL."),
  since: z.string(),
  transfers_read: z.number().int(),
  unread: z.number().int().describe("Transactions in the window that weren't read (over the cap or out of time)."),
  complete: z.boolean(),
}).strict();

export const outputSchema = z.object({
  action: z.enum(["find", "confirm", "ask_for_rest"]),
  step: z.enum(["sign", "candidates", "matched", "rest_asked"])
    .describe("sign = sign message_to_sign and call again with the same arguments plus signed_message and signature; candidates = find's result; matched = counted; rest_asked = follow-up request made."),
  recipient: z.string(),
  message_to_sign: z.string().optional(),
  sign_by: z.string().optional(),
  // find
  candidates: z.array(candidateSchema).optional(),
  underpaid: z.array(underpaidSchema).optional(),
  scanned: z.array(scanSchema).optional(),
  requests_checked: z.number().int().optional(),
  notes: z.array(z.string()).optional(),
  // confirm
  id: z.string().optional(),
  link: z.string().optional(),
  transaction: z.string().optional(),
  explorer_url: z.string().optional(),
  amount: z.string().optional(),
  token: tokenSchema.optional(),
  covers: z.enum(["full", "rest"]).optional(),
  status: z.string().optional(),
  label: z.string().optional().describe("How the request now reads everywhere: matched by the recipient, not paid through the link."),
  already_matched: z.boolean().optional(),
  // ask_for_rest
  rest_id: z.string().optional(),
  rest_link: z.string().optional(),
  rest_of: z.string().optional(),
  already_asked: z.boolean().optional(),
}).strict();

export type MatchInput = z.output<typeof inputSchema>;
export type MatchOutput = z.output<typeof outputSchema>;
export type Candidate = z.output<typeof candidateSchema>;

const DESCRIPTION = [
  "Find payments the user received but Owed never counted, and count them with the user's say-so. A payment counts only when it carries the request's Solana Pay reference; exchanges (Coinbase, Binance…) and some wallets drop it, so the money arrives but the request stays open or underpaid.",
  "Use it when someone says \"I paid you\" but check_payments shows open, when a request is underpaid, or the user asks \"did anyone pay me without the link?\".",
  "action find (default): pass recipient (the user's PayBox Solana wallet) and requests (Owed links or ids) to look at those, or leave requests out to look at every open request (then it returns a ledger message to sign with request_wallet_sign first, and you call again with signed_message and signature). It returns candidates: transfers into the wallet of exactly the amount still due, made after the request, not counted anywhere, ranked with reasons and warnings. It never marks anything paid.",
  "action confirm: link (the request) and transaction (from a candidate). The first call checks it and returns message_to_sign; sign it with request_wallet_sign (op solanaMessage, the same wallet; signing moves no money), then call again with signed_message and signature. Owed re-checks the chain and marks the request paid, labelled \"matched by the recipient (no reference on the payment)\". Only confirm a payment the user recognises; when a candidate is ambiguous, ask which request it pays.",
  "action ask_for_rest: link of an underpaid request; makes one new request for exactly what is still owed and returns its link to share.",
].join(" ");

// -------------------------------------------------------------------------------------------------------- shared

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function matchMessage(transaction: string, id: string, recipient: string, nowMs: number): string {
  return `Owed match ${transaction} to ${id} for ${recipient} at ${isoSeconds(nowMs)}`;
}

/** null when the message reads `lead<ISO>` and is fresh and signed by `signer`; otherwise what to tell the agent. */
function checkSigned(lead: string, message: string, signature: string, signer: string, now: number, again: string): string | null {
  if (!message.startsWith(lead) || !ISO_RE.test(message.slice(lead.length))) {
    return `signed_message must be exactly the message_to_sign from the first call ("${lead}<time>"). ${again}`;
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

function resolveId(text: string, ctx: CallContext, deps: Deps): string {
  const parsed = deps.parseLink(text.trim(), ctx.hosts);
  if (parsed.kind !== "owed") throw new Error("Only Owed requests (an Owed link or request id) have a status Owed can change; a plain Solana Pay link isn't stored anywhere.");
  return parsed.id;
}

function atomicOf(amount: string, token: Token, deps: Deps): bigint {
  return deps.toAtomic(amount, token);
}

const signHow = (recipient: string, message: string) =>
  `Call request_wallet_sign with this wallet's credential_id and intent {"op":"solanaMessage","address":"${recipient}","message":"${message}"}.`;

// -------------------------------------------------------------------------------------------------------- find

/** One request match_payments looks for a payment to. */
export interface Target {
  id: string;
  link: string;
  token: Token;
  amount: string;
  amountAtomic: bigint;
  status: "open" | "underpaid" | "expired";
  covers: "full" | "rest";
  dueAtomic: bigint;
  createdAt: string;
  paidSignature?: string;
  paidPayer?: string;
  amountPaid?: string;
  payerName?: string;
  forText?: string;
  restRequest?: string;
}

/** A payment Owed already counts: never a candidate; its payer has "paid you before". */
export interface Known {
  id: string;
  signature?: string;
  payer?: string;
}

function targetFromRequest(rq: GetRequestRes, base: string, deps: Deps): Target | null {
  if (rq.status !== "open" && rq.status !== "underpaid" && rq.status !== "expired") return null;
  const amountAtomic = atomicOf(rq.amount, rq.token, deps);
  const paidAtomic = rq.status === "underpaid" && rq.paid ? atomicOf(rq.paid.amount, rq.token, deps) : 0n;
  const t: Target = {
    id: rq.id, link: `${base}/r/${rq.id}`, token: rq.token, amount: rq.amount, amountAtomic, status: rq.status,
    covers: rq.status === "underpaid" ? "rest" : "full", dueAtomic: amountAtomic - paidAtomic, createdAt: rq.created_at,
  };
  if (rq.status === "underpaid" && rq.paid) {
    t.paidSignature = rq.paid.signature;
    t.paidPayer = rq.paid.payer;
    t.amountPaid = rq.paid.amount;
  }
  const payerName = clean(rq.payer_name, 40);
  if (payerName) t.payerName = payerName;
  const forText = clean(rq.for, 80);
  if (forText) t.forText = forText;
  if (rq.rest_request?.id) t.restRequest = rq.rest_request.id;
  return t;
}

function targetFromEntry(e: LedgerEntry, deps: Deps): Target {
  const amountAtomic = atomicOf(e.amount, e.token, deps);
  const due = e.amount_due ? atomicOf(e.amount_due, e.token, deps) : amountAtomic;
  const t: Target = {
    id: e.id, link: e.link, token: e.token, amount: e.amount, amountAtomic, status: e.status === "underpaid" ? "underpaid" : "open",
    covers: e.status === "underpaid" ? "rest" : "full", dueAtomic: due, createdAt: e.created_at,
  };
  if (e.status === "underpaid") {
    if (e.signature) t.paidSignature = e.signature;
    if (e.payer) t.paidPayer = e.payer;
    if (e.amount_paid) t.amountPaid = e.amount_paid;
  }
  const payerName = clean(e.payer_name, 40);
  if (payerName) t.payerName = payerName;
  const forText = clean(e.for, 80);
  if (forText) t.forText = forText;
  if (e.rest_request) t.restRequest = e.rest_request;
  return t;
}

function minutesText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

const OWED_MEMO = /\bowed:([1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?)\b/;

/**
 * Pair every transfer with every request whose remaining amount it equals exactly (and that existed when it landed),
 * score each pair and say why, then flag ambiguity both ways. Pure: tests drive it with recorded mainnet transfers.
 */
export function rankCandidates(targets: readonly Target[], transfers: readonly IncomingTransfer[], known: readonly Known[], deps: Pick<Deps, "fromAtomic">): Candidate[] {
  const paidBefore = new Map<string, string>();
  for (const k of known) if (k.payer && !paidBefore.has(k.payer)) paidBefore.set(k.payer, k.id);
  const pairs: Array<{ t: Target; x: IncomingTransfer }> = [];
  for (const t of targets) {
    if (t.dueAtomic <= 0n) continue;
    for (const x of transfers) {
      if (x.amountAtomic !== t.dueAtomic) continue;
      if (Date.parse(x.at) < Date.parse(t.createdAt) - CREATED_SKEW_MS) continue;
      if (x.signature === t.paidSignature) continue;
      pairs.push({ t, x });
    }
  }
  const perTx = new Map<string, Target[]>();
  const perTarget = new Map<string, IncomingTransfer[]>();
  for (const { t, x } of pairs) {
    perTx.set(x.signature, [...(perTx.get(x.signature) ?? []), t]);
    perTarget.set(t.id, [...(perTarget.get(t.id) ?? []), x]);
  }

  const out: Candidate[] = pairs.map(({ t, x }) => {
    const due = deps.fromAtomic(t.dueAtomic, t.token);
    const reasons: string[] = [];
    const warnings: string[] = [];
    let score = 40;
    reasons.push(t.covers === "rest"
      ? `Exactly the ${due} ${t.token} still owed after the partial payment of ${t.amountPaid ?? "?"} ${t.token}.`
      : `Exactly ${due} ${t.token}, the amount this request asks for.`);
    const after = Date.parse(x.at) - Date.parse(t.createdAt);
    reasons.push(`Arrived ${minutesText(after)} after the request was made.`);
    if (after <= 3_600_000) score += 20;
    else if (after <= 86_400_000) score += 10;
    else if (after <= 7 * 86_400_000) score += 5;
    if (t.covers === "rest" && t.paidPayer && x.payer === t.paidPayer) {
      score += 30;
      reasons.push(`Sent by the same wallet that made the partial payment (${shortAddress(x.payer)}).`);
    } else if (paidBefore.has(x.payer)) {
      score += 15;
      reasons.push(`This wallet (${shortAddress(x.payer)}) has paid you through Owed before (request ${paidBefore.get(x.payer)}).`);
    }
    const memo = x.memo ? OWED_MEMO.exec(x.memo)?.[1] : undefined;
    if (memo === t.id) {
      score += 50;
      reasons.push(`Its memo names this request (owed:${t.id}): the wallet kept Owed's memo but dropped the reference.`);
    } else if (memo) {
      score -= 30;
      warnings.push(`Its memo names a different Owed request (owed:${memo}), so it was probably meant for that one.`);
    } else {
      reasons.push("It carries no Solana Pay reference and no Owed memo, as exchange withdrawals and plain wallet sends often don't.");
    }
    const others = (perTx.get(x.signature) ?? []).filter((o) => o.id !== t.id);
    if (others.length > 0) {
      warnings.push(`It also fits ${others.length === 1 ? "request" : "requests"} ${others.map((o) => o.id).join(", ")} (same amount), so Owed can't tell which one it pays. Ask the user before confirming.`);
    }
    const rivals = (perTarget.get(t.id) ?? []).filter((o) => o.signature !== x.signature);
    if (rivals.length > 0) {
      warnings.push(`${rivals.length + 1} transfers fit this request; only one can pay it. Ask the user which one they recognise.`);
    }
    const ambiguous = others.length > 0 || rivals.length > 0;
    const confidence = ambiguous ? "ambiguous" : score >= 70 ? "high" : score >= 55 ? "medium" : "low";
    const c: Candidate = {
      request_id: t.id, request_link: t.link, token: t.token, request_amount: t.amount, expected: due, covers: t.covers,
      transaction: x.signature, explorer_url: explorerUrl(x.signature), payer: x.payer, amount: deps.fromAtomic(x.amountAtomic, t.token),
      at: x.at, confidence, score, reasons, warnings,
    };
    if (t.payerName) c.payer_name = t.payerName;
    if (t.forText) c.for = t.forText;
    return c;
  });
  const rank = { high: 0, medium: 1, ambiguous: 2, low: 3 } as const;
  return out
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.score - a.score || a.at.localeCompare(b.at) || a.request_id.localeCompare(b.request_id))
    .slice(0, MAX_CANDIDATES);
}

async function find(args: MatchInput, ctx: CallContext, deps: Deps, started: number, remaining: () => number) {
  const notes: string[] = [];
  let targets: Target[] = [];
  const known: Known[] = [];
  let checked = 0;

  if (args.requests) {
    const ids: string[] = [];
    for (const raw of args.requests) {
      try {
        ids.push(resolveId(raw, ctx, deps));
      } catch (error) {
        notes.push(`Skipped ${raw.length > 50 ? `${raw.slice(0, 47)}...` : raw}: ${errorText(error, "not an Owed link or id")}`);
      }
    }
    const api = makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.min(LOOKUP_TIMEOUT_MS, remaining()) });
    const read = await Promise.all([...new Set(ids)].map((id) => within(
      api.getRequest(id).then((rq) => ({ id, rq }), (error: unknown) => ({ id, error })),
      remaining(), () => ({ id, error: new ApiError("upstream_unavailable", "timed out") as unknown }),
    )));
    for (const r of read) {
      if ("error" in r) {
        notes.push(r.error instanceof ApiError && r.error.code === "not_found" ? `No Owed request has the id ${r.id}.` : `Request ${r.id} couldn't be read just now.`);
        continue;
      }
      const rq = r.rq;
      checked++;
      if (rq.id !== r.id) { notes.push(`Owed's server answered about a different request than ${r.id}; skipped.`); continue; }
      if (rq.chain === "base") { notes.push(`Request ${rq.id} is on Base, where payments are found by amount already; nothing to match.`); continue; }
      if (rq.recipient !== args.recipient) { notes.push(`Request ${rq.id} pays ${shortAddress(rq.recipient)}, not this wallet; skipped.`); continue; }
      if (rq.paid?.signature) known.push({ id: rq.id, signature: rq.paid.signature, payer: rq.paid.payer });
      if (rq.matched?.signature) known.push({ id: rq.id, signature: rq.matched.signature, payer: rq.matched.payer });
      const t = targetFromRequest(rq, ctx.base, deps);
      if (!t) {
        notes.push(rq.status === "paid"
          ? `Request ${rq.id} is already paid${rq.matched ? ` (${MATCHED_LABEL})` : ""}.`
          : `Request ${rq.id} is ${rq.status}; it isn't searched.`);
        continue;
      }
      targets.push(t);
    }
  } else {
    if (args.signed_message === undefined && args.signature === undefined) {
      const message_to_sign = ledgerMessage(args.recipient, started);
      const sign_by = isoSeconds(started + MESSAGE_VALID_MS);
      const output: MatchOutput = { action: "find", step: "sign", recipient: args.recipient, message_to_sign, sign_by };
      const text = [
        "To look through every open request of this wallet, Owed needs to read its ledger, which takes a signature (or pass requests: the Owed links to check, and no signature is needed).",
        message_to_sign,
        signHow(args.recipient, message_to_sign),
        `Then call match_payments again with recipient, signed_message (the text above) and signature (from the output). Valid until ${sign_by}, once. Signing moves no money.`,
      ].join("\n");
      return { content: [{ type: "text" as const, text }], structuredContent: output };
    }
    if (args.signed_message === undefined || args.signature === undefined) return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
    const problem = checkSigned(`Owed ledger access for ${args.recipient} at `, args.signed_message, args.signature, args.recipient, started,
      "Call match_payments with only recipient to get a fresh message, sign that, and try again.");
    if (problem) return refusal(problem);
    let ledger;
    try {
      ledger = await within(
        makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.min(LEDGER_TIMEOUT_MS, remaining()) })
          .ledger({ recipient: args.recipient, signed_message: args.signed_message, signature: args.signature.trim() }),
        remaining(), () => null,
      );
    } catch (error) {
      if (error instanceof ApiError && (error.code === "invalid_input" || error.code === "rate_limited")) return refusal(`Owed refused the ledger read: ${error.message}`);
      return refusal("Owed's server couldn't be reached, so the open requests couldn't be read. Try again shortly, or pass requests (the links to check).");
    }
    if (!ledger) return refusal("Owed's server didn't answer in time. Try again, or pass requests (the links to check).");
    if (ledger.recipient !== args.recipient) return refusal("Owed's server answered about a different wallet, so nothing was searched.");
    if (!ledger.chain_checked) notes.push("Solana couldn't be read when the ledger was fetched, so a request listed as open may have been paid since.");
    if (ledger.truncated) notes.push("This wallet has more than 100 open requests; only the newest 100 were searched.");
    for (const e of ledger.paid_recently) if (e.signature) known.push({ id: e.id, signature: e.signature, payer: e.payer });
    for (const e of ledger.open) {
      checked++;
      if (e.status === "underpaid" && e.signature) known.push({ id: e.id, signature: e.signature, payer: e.payer });
      if (e.status === "open" || e.status === "underpaid") targets.push(targetFromEntry(e, deps));
    }
  }

  const underpaid = targets.filter((t) => t.covers === "rest").map((t) => ({
    request_id: t.id, request_link: t.link, token: t.token, amount: t.amount, amount_paid: t.amountPaid ?? deps.fromAtomic(t.amountAtomic - t.dueAtomic, t.token),
    remaining: deps.fromAtomic(t.dueAtomic, t.token), ...(t.restRequest && { rest_request: t.restRequest }),
  }));
  // An underpaid request whose rest is already asked in a follow-up: the follow-up is what gets paid now.
  targets = targets.filter((t) => !(t.covers === "rest" && t.restRequest));

  // Read each token's incoming transfers since its oldest request.
  const scans: Array<{ token: Token; since: string; scan: IncomingScan | null; error?: string }> = [];
  const skip = new Set(known.flatMap((k) => (k.signature ? [k.signature] : [])));
  const tokens = (["USDC", "SOL"] as const).filter((tk) => targets.some((t) => t.token === tk));
  const scanBudget = Math.max(0, Math.min(5000, remaining() - 1800));
  await Promise.all(tokens.map(async (token) => {
    const since = targets.filter((t) => t.token === token).map((t) => Date.parse(t.createdAt)).reduce((a, b) => Math.min(a, b));
    const sinceIso = isoSeconds(since - CREATED_SKEW_MS);
    try {
      const scan = await within(
        incomingTransfers(deps.rpc(), { recipient: args.recipient, token, sinceUnix: Math.floor((since - CREATED_SKEW_MS) / 1000), skip }, scanBudget),
        scanBudget + 200, () => null,
      );
      scans.push({ token, since: sinceIso, scan, ...(scan === null && { error: "Solana didn't answer in time" }) });
    } catch (error) {
      scans.push({ token, since: sinceIso, scan: null, error: errorText(error, "Solana couldn't be read") });
    }
  }));
  scans.sort((a, b) => a.token.localeCompare(b.token));

  let candidates = rankCandidates(targets, scans.flatMap((s) => s.scan?.transfers ?? []), known, deps);

  // Drop anything Owed already counts, or that names a request's reference (that request owns it by Owed's rules).
  if (candidates.length > 0) {
    const sigs = [...new Set(candidates.map((c) => c.transaction))];
    const keySet = new Set<string>();
    for (const s of scans) for (const x of s.scan?.transfers ?? []) if (sigs.includes(x.signature)) for (const k of x.keys) keySet.add(k);
    const keys = [...keySet].slice(0, 256);
    let attributed: AttributedRes | null = null;
    try {
      attributed = await within(
        makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.max(500, Math.min(2500, remaining())) }).attributed({ signatures: sigs.slice(0, 100), keys }),
        Math.max(0, remaining()), () => null,
      );
    } catch {
      attributed = null;
    }
    if (!attributed) {
      notes.push("Owed couldn't check right now whether these transfers already count for another request; confirm checks that again before anything is recorded.");
    } else {
      const counted = new Map(attributed.attributed.map((a) => [a.signature, a.request_id]));
      const refs = new Map(attributed.references.map((r) => [r.key, r.request_id]));
      const keysOf = new Map(scans.flatMap((s) => s.scan?.transfers ?? []).map((x) => [x.signature, x.keys]));
      const dropped = new Set<string>();
      candidates = candidates.filter((c) => {
        const owner = counted.get(c.transaction);
        if (owner) {
          if (!dropped.has(c.transaction)) notes.push(`Transfer ${shortAddress(c.transaction)} already counts for request ${owner}; not offered.`);
          dropped.add(c.transaction);
          return false;
        }
        const named = (keysOf.get(c.transaction) ?? []).map((k) => refs.get(k)).find((id) => id !== undefined);
        if (named) {
          if (!dropped.has(c.transaction)) {
            notes.push(named === c.request_id
              ? `Transfer ${shortAddress(c.transaction)} carries request ${named}'s own reference, so check_payments counts it; check that request instead.`
              : `Transfer ${shortAddress(c.transaction)} carries request ${named}'s reference, so it pays that one; not offered.`);
          }
          dropped.add(c.transaction);
          return false;
        }
        return true;
      });
      // Re-rank without the dropped ones, so ambiguity warnings only name transfers still on offer.
      if (dropped.size > 0) {
        const left = scans.flatMap((s) => s.scan?.transfers ?? []).filter((x) => !dropped.has(x.signature));
        candidates = rankCandidates(targets, left, known, deps);
      }
    }
  }

  const scanned = scans.map((s) => ({
    token: s.token, account: s.scan?.account ?? "", since: s.since,
    transfers_read: s.scan?.read ?? 0, unread: s.scan?.unread ?? 0, complete: s.scan?.complete ?? false,
  }));
  for (const s of scans) {
    if (s.error) notes.push(`${s.token} transfers couldn't be read (${s.error}); try again shortly.`);
    else if (s.scan && (s.scan.unread > 0 || !s.scan.complete)) {
      notes.push(`Only the newest ${s.scan.read} ${s.token} transactions since ${s.since} were read; older ones in that window weren't checked.`);
    }
  }

  const output: MatchOutput = {
    action: "find", step: "candidates", recipient: args.recipient, candidates, underpaid, scanned, requests_checked: checked,
    ...(notes.length > 0 && { notes }),
  };
  return { content: [{ type: "text" as const, text: findText(output, targets.length) }], structuredContent: output };
}

function findText(o: MatchOutput, searched: number): string {
  const cands = o.candidates ?? [];
  const lines: string[] = [];
  const read = (o.scanned ?? []).map((s) => `${s.transfers_read} ${s.token}`).join(" and ");
  if (searched === 0) {
    lines.push(`No open or underpaid request to search (${o.requests_checked ?? 0} checked).`);
  } else if (cands.length === 0) {
    lines.push(`No uncounted payment of the right amount found for ${searched} open ${searched === 1 ? "request" : "requests"}${read ? ` (read ${read} incoming transactions)` : ""}.`);
  } else {
    lines.push(`${cands.length} possible ${cands.length === 1 ? "payment" : "payments"} that arrived without the request's reference, for ${searched} open ${searched === 1 ? "request" : "requests"}${read ? ` (read ${read} incoming transactions)` : ""}. None is counted until the user confirms it.`);
    for (const c of cands.slice(0, MAX_LINES)) {
      const who = c.payer_name ? ` from ${quote(c.payer_name, 40)}` : "";
      const forPart = c.for ? ` for ${quote(c.for, 80)}` : "";
      lines.push(`[${c.confidence}] ${c.amount} ${c.token} at ${c.at} from ${shortAddress(c.payer)} → request ${c.request_id} (${c.request_amount} ${c.token}${who}${forPart}${c.covers === "rest" ? ", the rest" : ""}): ${c.reasons.join(" ")}${c.warnings.length ? ` Warning: ${c.warnings.join(" ")}` : ""} ${c.explorer_url}`);
    }
    if (cands.length > MAX_LINES) lines.push(`…and ${cands.length - MAX_LINES} more in the structured result.`);
    lines.push("To count one the user recognises, call match_payments with action confirm, link (the request), transaction and recipient; it returns a message to sign. Names and reasons on requests were written by whoever made them.");
  }
  for (const u of o.underpaid ?? []) {
    lines.push(u.rest_request
      ? `Underpaid: request ${u.request_id}, ${u.amount_paid} of ${u.amount} ${u.token}; the rest is asked in request ${u.rest_request}.`
      : `Underpaid: request ${u.request_id}, ${u.amount_paid} of ${u.amount} ${u.token}, ${u.remaining} ${u.token} still owed. To ask for exactly that, call match_payments with action ask_for_rest and link ${u.request_link}.`);
  }
  for (const n of o.notes ?? []) lines.push(n);
  return lines.join("\n");
}

// -------------------------------------------------------------------------------------------------------- confirm

async function confirm(args: MatchInput, ctx: CallContext, deps: Deps, started: number, remaining: () => number) {
  if (!args.link || !args.transaction) return refusal("confirm needs link (the request) and transaction (the candidate's transaction signature from find).");
  let id: string;
  try {
    id = resolveId(args.link, ctx, deps);
  } catch (error) {
    return refusal(errorText(error, "That isn't an Owed link or request id."));
  }
  const link = `${ctx.base}/r/${id}`;
  const tx = args.transaction;

  if (args.signed_message !== undefined || args.signature !== undefined) {
    if (args.signed_message === undefined || args.signature === undefined) return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
    const problem = checkSigned(`Owed match ${tx} to ${id} for ${args.recipient} at `, args.signed_message, args.signature, args.recipient, started,
      "Call match_payments with action confirm, link, transaction and recipient (no signature) for a fresh message, sign that, and try again.");
    if (problem) return refusal(problem);
    let res;
    try {
      res = await within(
        makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.min(CONFIRM_API_TIMEOUT_MS, remaining()) })
          .matchPayment(id, { recipient: args.recipient, transaction: tx, signed_message: args.signed_message, signature: args.signature.trim() }),
        remaining(), () => null,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed request has the id ${id}. Nothing was recorded.`);
      if (error instanceof ApiError && (error.code === "invalid_input" || error.code === "rate_limited")) return refusal(`Owed refused the match: ${error.message}. Nothing was recorded.`);
      return refusal("Owed couldn't confirm the match (its server or Solana didn't answer). Check the request with check_payments; if it still shows open, ask for a fresh message and try again.");
    }
    if (!res) return refusal("Owed's server didn't answer in time, so the match isn't confirmed. Check the request with check_payments before trying again.");
    if (res.id !== id || res.recipient !== args.recipient || res.status !== "paid" || res.matched?.signature !== tx) {
      return refusal(`Owed's server answered about a different request or state (${res.status}), so the match isn't confirmed. Check the request with check_payments.`);
    }
    const m = res.matched;
    const output: MatchOutput = {
      action: "confirm", step: "matched", recipient: args.recipient, id, link, transaction: tx, explorer_url: explorerUrl(tx),
      amount: m.amount, token: res.token, covers: m.covers, status: res.status, label: MATCHED_LABEL, already_matched: res.already_matched,
    };
    const text = res.already_matched
      ? `This payment was already matched to request ${id}; nothing changed. ${link}`
      : [
        `Matched: ${m.amount} ${res.token} (${explorerUrl(tx)}) now counts for request ${id}${m.covers === "rest" ? " as the rest after the partial payment" : ""}. The request is paid.`,
        `Its page (${link}), check_payments, who_owes_me and /proof show it as "${MATCHED_LABEL}", not as paid through the link. Your signed message is stored with it as proof that you matched it.`,
      ].join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: output };
  }

  // First call: read the request and the transaction, so the user only signs a match that can be recorded.
  let rq: GetRequestRes | null;
  try {
    rq = await within(makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.min(LOOKUP_TIMEOUT_MS, remaining()) }).getRequest(id), remaining(), () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed request has the id ${id}. Check the link.`);
    return refusal("Owed's server couldn't be reached, so nothing was checked. Try again shortly.");
  }
  if (!rq) return refusal("Owed's server didn't answer in time. Try again shortly.");
  if (rq.id !== id) return refusal("Owed's server answered about a different request, so nothing was checked.");
  if (rq.chain === "base") return refusal("This request is on Base, where payments are found by amount already; there is nothing to match by hand.");
  if (rq.recipient !== args.recipient) {
    return refusal(`This request pays ${shortAddress(rq.recipient)}, not this wallet (${shortAddress(args.recipient)}). Only the wallet a request pays can match a payment to it.`);
  }
  if (rq.matched?.signature === tx) return refusal(`This payment is already matched to request ${id}. Nothing to do.`);
  if (rq.status === "paid") return refusal(`Request ${id} is already paid${rq.matched ? ` (${MATCHED_LABEL})` : ""}, so nothing can be matched to it.`);
  const target = targetFromRequest(rq, ctx.base, deps);
  if (!target && rq.status !== "cancelled") return refusal(`Request ${id} is ${rq.status}; a payment can't be matched to it.`);
  // A cancelled request that money reached anyway can still be matched in full (the server allows it too).
  const t = target ?? targetFromRequest({ ...rq, status: "open" }, ctx.base, deps)!;
  const due = deps.fromAtomic(t.dueAtomic, t.token);

  let check;
  try {
    check = await within(readTransfer(deps.rpc(), { signature: tx, recipient: args.recipient, token: t.token }, Math.max(0, Math.min(4000, remaining() - 500))),
      Math.max(0, remaining() - 300), () => null);
  } catch {
    check = null;
  }
  const lines: string[] = [];
  if (check && !check.ok) {
    const why = {
      not_found: "isn't on Solana mainnet (or isn't confirmed yet)",
      failed: "failed on chain, so it moved no money",
      no_credit: `sends no ${t.token} to this wallet`,
      own: "was signed by this wallet itself, so it isn't a payment from someone else",
    }[check.reason];
    return refusal(`Transaction ${shortAddress(tx)} ${why}. Nothing to sign.`);
  }
  if (check?.ok) {
    const x = check.transfer;
    if (x.amountAtomic !== t.dueAtomic) {
      return refusal(`That transaction credits ${deps.fromAtomic(x.amountAtomic, t.token)} ${t.token}, but request ${id} needs exactly ${due} ${t.token}${t.covers === "rest" ? " (what is still owed)" : ""}. Only an exact match can be confirmed.`);
    }
    if (Date.parse(x.at) < Date.parse(t.createdAt) - CREATED_SKEW_MS) {
      return refusal(`That transaction landed at ${x.at}, before request ${id} was made (${t.createdAt}), so it can't be its payment.`);
    }
    lines.push(`Checked on chain: ${deps.fromAtomic(x.amountAtomic, t.token)} ${t.token} from ${shortAddress(x.payer)} at ${x.at}, exactly what request ${id} still needs.`);
  } else {
    lines.push("Solana couldn't be read just now to pre-check the transaction; Owed's server checks it before recording anything.");
  }
  const message_to_sign = matchMessage(tx, id, args.recipient, started);
  const sign_by = isoSeconds(started + MESSAGE_VALID_MS);
  const output: MatchOutput = {
    action: "confirm", step: "sign", recipient: args.recipient, id, link, transaction: tx, explorer_url: explorerUrl(tx),
    amount: due, token: t.token, covers: t.covers, status: rq.status, message_to_sign, sign_by,
  };
  const who = t.payerName ? ` from ${quote(t.payerName, 40)}` : "";
  const forPart = t.forText ? ` for ${quote(t.forText, 80)}` : "";
  const text = [
    ...lines,
    `To count it for request ${id} (${t.amount} ${t.token}${who}${forPart}${t.covers === "rest" ? `, the remaining ${due} ${t.token}` : ""}), sign this exact message with PayBox. It moves no money; it records that this wallet says the payment is for this request.`,
    message_to_sign,
    signHow(args.recipient, message_to_sign),
    `After the user approves, call match_payments again with action confirm, link, transaction, recipient, signed_message (the text above) and signature. Valid until ${sign_by}, once.`,
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

// -------------------------------------------------------------------------------------------------------- ask_for_rest

function restMatches(res: RestRes, recipient: string, deps: Deps): boolean {
  try {
    const atomic = deps.toAtomic(res.amount, res.token);
    if (res.recipient !== recipient) return false;
    return idMatchesTerms(res.id, { recipient: res.recipient, token: res.token, amountAtomic: atomic, reference: res.reference, ...(res.chain === "base" && { chain: "base" as const }) });
  } catch {
    return false;
  }
}

async function askRest(args: MatchInput, ctx: CallContext, deps: Deps, remaining: () => number) {
  if (!args.link) return refusal("ask_for_rest needs link: the underpaid request's Owed link or id.");
  let id: string;
  try {
    id = resolveId(args.link, ctx, deps);
  } catch (error) {
    return refusal(errorText(error, "That isn't an Owed link or request id."));
  }
  let res: RestRes | null;
  try {
    res = await within(makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.min(LOOKUP_TIMEOUT_MS + 1000, remaining()) }).askForRest(id, { source: "plugin" }), remaining(), () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal(`No Owed request has the id ${id}. Check the link.`);
    if (error instanceof ApiError && (error.code === "invalid_input" || error.code === "rate_limited" || error.code === "blocked")) return refusal(`Owed refused: ${error.message}.`);
    return refusal("Owed's server couldn't be reached, so no follow-up request was made. Try again shortly.");
  }
  if (!res) return refusal("Owed's server didn't answer in time; no follow-up is confirmed. Try again shortly (asking twice returns the same request).");
  if (res.rest_of !== id || !restMatches(res, args.recipient, deps)) {
    return refusal("Owed's server returned a follow-up that doesn't pay this wallet the stated amount (its id doesn't hash its terms), so don't share it.");
  }
  const output: MatchOutput = {
    action: "ask_for_rest", step: "rest_asked", recipient: args.recipient, rest_id: res.id, rest_link: res.link, rest_of: id,
    amount: res.amount, token: res.token, already_asked: res.already_asked,
  };
  const text = [
    res.already_asked
      ? `The rest was already asked for: request ${res.id} for ${res.amount} ${res.token}. Share the same link: ${res.link}`
      : `Asked for the rest: a new request for exactly ${res.amount} ${res.token} (what request ${id} still owes). Share this link with the payer: ${res.link}`,
    `Its page says it is the rest of request ${id}; the first request's page links to it, and who_owes_me counts the remainder once.`,
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

// -------------------------------------------------------------------------------------------------------- entry

export async function matchPayments(args: MatchInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  const remaining = () => MATCH_BUDGET_MS - (deps.now() - started);
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  const action = args.action ?? "find";
  if (action === "confirm") return confirm(args, ctx, deps, started, remaining);
  if (action === "ask_for_rest") return askRest(args, ctx, deps, remaining);
  if (args.link || args.transaction) return refusal("find takes requests (a list of links), not link or transaction; for one candidate use action confirm.");
  return find(args, ctx, deps, started, remaining);
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("match_payments", {
    title: "Find uncounted payments",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => matchPayments(args, deps));
}
