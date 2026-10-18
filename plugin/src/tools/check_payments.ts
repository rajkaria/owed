import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { tokenSchema, type StatusRawRes, type StatusResult } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { TOKENS, USDC_MINT, type Token } from "../money.js";
import { atomicAmount } from "../paybox.js";
import type { TransferRequest } from "../solana-pay.js";
import { ago, explorerUrl, MATCHED_LABEL, shortAddress } from "../text.js";
import { basescanTx } from "../evm.js"; // W3-B
import { fiatOutput, fiatStatusLine } from "../local-currency.js"; // local-currency asks
import type { RefundSummary } from "../contract.js"; // F8 invoices
// F7 pots start
import type { PotRes } from "../contract.js";
import { POT_TITLE_MAX, potEnded, potTermsProblem } from "../pots.js";
import { clean, quote } from "../text.js";
// F7 pots end

/** Leaves room for process start-up and output inside PayBox's 10 s per-call limit. */
export const CHECK_BUDGET_MS = 8500;

export const inputSchema = z.object({
  requests: z.array(z.string().min(1).max(2048)).min(1).max(20)
    .describe("1 to 20 requests to check: Owed request ids (e.g. \"JArQ6g9JvoWr\"), Owed links, chip-in pot ids or board links (F7), or Solana Pay transfer URLs that carry a reference."),
}).strict();

const resultStatus = z.enum(["open", "paid", "underpaid", "cancelled", "expired", "not_found", "invalid", "unknown"]); // W3-C: + expired

export const resultSchema = z.object({
  input: z.string(),
  id: z.string().optional(),
  status: resultStatus.describe("unknown = could not be checked right now; try again."),
  amount_requested: z.string().nullable(),
  token: tokenSchema.nullable(),
  amount_paid: z.string().optional(),
  payer: z.string().optional(),
  signature: z.string().optional(),
  paid_at: z.string().optional(),
  explorer_url: z.string().optional(),
  waited: z.string().optional().describe('How long an unpaid request has been open, e.g. "2h 14m".'),
  // W3-C
  expires_at: z.string().optional().describe("When the request stops (or stopped) taking payments."),
  cancelled_at: z.string().optional().describe("When the recipient cancelled it."),
  error: z.string().optional(),
  chain: z.literal("base").optional().describe("Set for a request on Base: amounts are USDC on Base and explorer_url is Basescan."), // W3-B
  // 0012
  matched: z.string().optional().describe("Set when the payment (or its rest) carried no reference and the recipient matched it with match_payments. Say so; never present it as paid through the link."),
  rest_request: z.string().optional().describe("Underpaid: the follow-up request already asking for the rest."),
  rest_of: z.string().optional().describe("This request asks for the rest of that underpaid request."),
  fiat: fiatOutput.optional(), // local-currency asks: the quote behind amount_requested (USDC)
  // F8 invoices
  refunded: z.string().optional().describe("Refunds of this payment back to the payer, confirmed on Solana."),
  refunded_in_full: z.boolean().optional(),
  refund_pending: z.string().optional().describe("Refunds proposed but not landed yet."),
  // F7 pots: a pot's board (status open, or expired once its deadline passed); amount_requested is its target, if any.
  pot: z.object({
    title: z.string().describe("Written by whoever started the pot; unverified."),
    raised: z.string(), target: z.string().nullable(), count: z.number().int(), deadline: z.string(), link: z.string(),
    latest: z.array(z.object({ amount: z.string(), payer: z.string(), at: z.string(), explorer_url: z.string() }).strict()),
  }).strict().optional().describe("Set when the input is a chip-in pot: what it raised from how many contributions, and the latest ones."),
}).strict();

export const outputSchema = z.object({
  results: z.array(resultSchema),
  summary: z.string(),
}).strict();

export type CheckInput = z.output<typeof inputSchema>;
export type CheckResult = z.output<typeof resultSchema>;
export type CheckOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Check whether payment requests have been paid, by reading Solana mainnet (and Base, for Owed requests made on Base).", // W3-B
  "Use it when the user asks \"did Priya pay?\", \"who still owes me?\" or wants a status on requests made with ask_for_money.",
  "Pass up to 20 items: Owed request ids, Owed links, or Solana Pay transfer URLs (they must include a reference).",
  "Returns each request's status (open, paid, underpaid, cancelled, expired, not_found, invalid, or unknown if it couldn't be checked) with the payer, amount and transaction link when paid, plus a one-line summary. Show the user the summary and the explorer link for each payment.",
  "A payment the user matched with match_payments (it carried no reference) is marked matched; say so. For an underpaid request, match_payments with action ask_for_rest makes a new request for exactly the rest; if the payer says they paid but it shows open, match_payments looks for a payment that lost its reference.", // 0012
  "A payment that was partly or fully sent back with refund_payment says \"refunded <amount>\" once Solana confirms the refund.", // F8 invoices
  "A chip-in pot (its id or board link, from start_pot) shows what it raised against its target, from how many contributions, the latest ones and its deadline; a pot is never counted as money anyone owes.", // F7 pots
].join(" ");

type Parsed =
  | { kind: "owed"; input: string; id: string }
  | { kind: "transfer"; input: string; request: TransferRequest; token: Token }
  | { kind: "invalid"; input: string; error: string }
  | { kind: "pot"; input: string; id: string }; // F7 pots

const TRANSACTION_REQUEST = "This is a Solana Pay checkout link (transaction request). Owed checks transfer links only.";
const UNREACHABLE = "Owed's server is unreachable right now, so this request couldn't be checked. Try again shortly.";
const RPC_FAILED = "Solana couldn't be reached to check this link. Try again shortly.";

export async function checkPayments(args: CheckInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  const remaining = () => CHECK_BUDGET_MS - (deps.now() - started);
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  const parsed = args.requests.map((raw) => parse(raw, ctx, deps));
  const ids = [...new Set(parsed.flatMap((p) => (p.kind === "owed" ? [p.id] : [])))];

  const owedLookup = ids.length === 0
    ? Promise.resolve(new Map<string, StatusResult>() as Map<string, StatusResult> | string)
    : within(
      ctx.api.status(ids).then(
        (res) => new Map(res.results.map((r) => [r.id, r] as const)) as Map<string, StatusResult> | string,
        (error) => (error instanceof ApiError && error.code !== "upstream_unavailable" ? `Owed couldn't check these: ${error.message}` : UNREACHABLE),
      ),
      remaining(), () => UNREACHABLE,
    );

  // F8 invoices: refunds of these requests, beside the status read (best effort: an older server just has none).
  const refundLookup = ids.length === 0
    ? Promise.resolve(new Map<string, RefundSummary>())
    : within(
      ctx.api.refundsFor(ids).then((res) => new Map(res.requests.map((r) => [r.request_id, r] as const)), () => new Map<string, RefundSummary>()),
      Math.min(remaining(), 4000), () => new Map<string, RefundSummary>(),
    );
  // F7 pots: each pot's board, beside the rest.
  const potLookup = Promise.all(parsed.map((p) => (p.kind === "pot" ? checkPot(p, ctx, deps, remaining) : Promise.resolve(null))));
  const [owed, refunds, pots, ...transfers] = await Promise.all([
    owedLookup,
    refundLookup, // F8 invoices
    potLookup, // F7 pots
    ...parsed.map((p) => (p.kind === "transfer" ? checkTransfer(p, ctx, deps, remaining) : Promise.resolve(null))),
  ]);

  const now = deps.now();
  const results: CheckResult[] = parsed.map((p, i) => {
    if (p.kind === "invalid") return { input: p.input, status: "invalid", amount_requested: null, token: null, error: p.error };
    if (p.kind === "transfer") return transfers[i] as CheckResult;
    if (p.kind === "pot") return (pots as Array<CheckResult | null>)[i]!; // F7 pots
    if (typeof owed === "string") return { input: p.input, id: p.id, status: "unknown", amount_requested: null, token: null, error: owed };
    const r = owed.get(p.id);
    if (!r) return { input: p.input, id: p.id, status: "not_found", amount_requested: null, token: null, error: NOT_FOUND };
    return withRefunds(fromOwed(p.input, r, now), (refunds as Map<string, RefundSummary>).get(p.id)); // F8 invoices
  });

  const summary = summarize(results, deps);
  const lines = [summary, ...results.flatMap((r) => detailLine(r))];
  const output: CheckOutput = { results, summary };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

function parse(raw: string, ctx: CallContext, deps: Deps): Parsed {
  const input = raw.trim();
  // W3-B: a bare Base payment link has no reference to find; Owed checks Base requests by their Owed id or link.
  if (/^ethereum:/i.test(input)) return { kind: "invalid", input, error: "This is a Base payment link (ethereum:...). Owed checks Base requests by their Owed id or link, not the wallet link." };
  let link;
  try {
    link = deps.parseLink(input, ctx.hosts);
  } catch (error) {
    return { kind: "invalid", input, error: errorText(error, "This isn't an Owed link, id or Solana Pay transfer URL.") };
  }
  if (link.kind === "owed") return { kind: "owed", input, id: link.id };
  if (link.kind === "pot") return { kind: "pot", input, id: link.id }; // F7 pots
  if (link.kind === "transaction") return { kind: "invalid", input, error: TRANSACTION_REQUEST };
  const request = link.request;
  if (request.references.length === 0) {
    return { kind: "invalid", input, error: "This Solana Pay link has no reference, so its payment can't be found on-chain." };
  }
  if (request.splToken !== undefined && request.splToken !== USDC_MINT) {
    return { kind: "invalid", input, error: "Owed checks USDC or SOL links only." };
  }
  return { kind: "transfer", input, request, token: request.splToken === USDC_MINT ? "USDC" : "SOL" };
}

const NOT_FOUND = "No Owed request has this id.";

function fromOwed(input: string, r: StatusResult, now: number): CheckResult {
  const out: CheckResult = { input, id: r.id, status: r.status, amount_requested: r.amount_requested ?? null, token: r.token ?? null };
  if (r.status === "not_found") out.error = NOT_FOUND;
  if (r.status === "invalid") out.error = "Owed's server couldn't read this id.";
  if (r.amount_paid !== undefined) out.amount_paid = r.amount_paid;
  if (r.payer !== undefined) out.payer = r.payer;
  if (r.signature !== undefined) {
    out.signature = r.signature;
    out.explorer_url = r.chain === "base" ? basescanTx(r.signature) : explorerUrl(r.signature); // W3-B
  }
  if (r.chain === "base") out.chain = "base"; // W3-B
  // Local-currency asks: only a quote that produces the USDC requested is shown.
  if (r.fiat && fiatStatusLine(r.fiat, r.amount_requested)) {
    out.fiat = { currency: r.fiat.currency, amount: r.fiat.amount, rate: r.fiat.rate, rate_source: r.fiat.rate_source, quoted_at: r.fiat.quoted_at };
  }
  if (r.paid_at !== undefined) out.paid_at = r.paid_at;
  if (r.expires_at !== undefined) out.expires_at = r.expires_at; // W3-C
  if (r.cancelled_at !== undefined) out.cancelled_at = r.cancelled_at;
  // 0012: a matched payment is labelled apart from a referenced one; the rest-of links.
  if (r.matched) out.matched = r.matched.covers === "rest" ? `the rest (${r.matched.amount}${r.token ? ` ${r.token}` : ""}) was ${MATCHED_LABEL}` : MATCHED_LABEL;
  if (r.rest_request) out.rest_request = r.rest_request;
  if (r.rest_of) out.rest_of = r.rest_of;
  if ((r.status === "open" || r.status === "underpaid") && r.created_at) {
    const waited = ago(r.created_at, now);
    if (waited) out.waited = waited;
  }
  return out;
}

// F8 invoices: what was sent back to the payer (only for a paid request, and only the token's own amounts).
function withRefunds(r: CheckResult, s: RefundSummary | undefined): CheckResult {
  if (!s || !r.token || s.token !== r.token || (r.status !== "paid" && r.status !== "underpaid")) return r;
  if (s.refunded !== "0") {
    r.refunded = s.refunded;
    r.refunded_in_full = s.paid !== null && s.refunded === s.paid;
  }
  if (s.pending !== "0") r.refund_pending = s.pending;
  return r;
}

async function checkTransfer(p: Extract<Parsed, { kind: "transfer" }>, ctx: CallContext, deps: Deps, remaining: () => number): Promise<CheckResult> {
  const base: CheckResult = { input: p.input, status: "unknown", amount_requested: p.request.amount ?? null, token: p.token };
  // The API reads the chain with its own RPC (and caches); direct RPC is the fallback when it's down.
  try {
    const url = deps.buildTransferUrl(p.request);
    const res = await within<StatusRawRes | null>(ctx.api.statusRaw(url), Math.min(remaining(), 4000), () => null);
    if (res) return withPayment({ ...base, status: res.status }, res.amount_paid, res.payer, res.signature, res.paid_at);
  } catch (error) {
    if (error instanceof ApiError && error.code !== "upstream_unavailable") return { ...base, status: "invalid", error: error.message };
  }
  try {
    const amountAtomic = p.request.amount === undefined ? 1n : deps.toAtomic(p.request.amount, p.token);
    const check = await within(
      deps.findPayment(deps.rpc(), { reference: p.request.references[0]!, recipient: p.request.recipient, token: p.token, amountAtomic }),
      remaining(), () => null,
    );
    if (!check) return { ...base, error: RPC_FAILED };
    const paid = check.amountPaidAtomic === undefined ? undefined : deps.fromAtomic(check.amountPaidAtomic, p.token);
    // A link without an amount lets the payer choose it: any confirmed credit counts as paid.
    const status = p.request.amount === undefined && check.status === "underpaid" ? "paid" : check.status;
    return withPayment({ ...base, status }, paid, check.payer, check.signature, check.paidAt);
  } catch {
    return { ...base, error: RPC_FAILED };
  }
}

function withPayment(r: CheckResult, amountPaid?: string, payer?: string, signature?: string, paidAt?: string): CheckResult {
  if (amountPaid !== undefined) r.amount_paid = amountPaid;
  if (payer !== undefined) r.payer = payer;
  if (signature !== undefined) {
    r.signature = signature;
    r.explorer_url = explorerUrl(signature);
  }
  if (paidAt !== undefined) r.paid_at = paidAt;
  return r;
}

function atomicOf(amount: string | null | undefined, token: Token): bigint {
  if (!amount) return 0n;
  try {
    return BigInt(atomicAmount(amount, TOKENS[token].decimals));
  } catch {
    return 0n;
  }
}

function totals(map: Map<Token, bigint>, deps: Deps): string {
  return [...map].filter(([, v]) => v > 0n).map(([token, v]) => `${deps.fromAtomic(v, token)} ${token}`).join(" + ");
}

/** One result per request: the same Owed id given twice (as id and as link, or a share twice) counts once (QA-10). */
function distinct(results: CheckResult[]): CheckResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.id ? `id:${r.id}` : `input:${r.input}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarize(all: CheckResult[], deps: Deps): string {
  // F7 pots: a pot is nobody's debt, so it is summed apart from the requests.
  const potParts = distinct(all).filter((r) => r.pot).map((r) => `pot ${quote(r.pot!.title, POT_TITLE_MAX)}: ${potRaisedText(r)}`);
  const results = distinct(all).filter((r) => !r.pot);
  if (results.length === 0 && potParts.length > 0) return potParts.join(" · ");
  const received = new Map<Token, bigint>();
  const outstanding = new Map<Token, bigint>();
  const count = (status: CheckResult["status"]) => results.filter((r) => r.status === status).length;
  // 0012: an underpaid request whose rest request is also being checked owes nothing on its own; the rest request does.
  const checkedIds = new Set(results.flatMap((r) => (r.id ? [r.id] : [])));
  for (const r of results) {
    if (!r.token) continue;
    const paid = atomicOf(r.amount_paid, r.token);
    if (r.status === "paid" || r.status === "underpaid") received.set(r.token, (received.get(r.token) ?? 0n) + paid);
    if (r.status === "underpaid" && r.rest_request && checkedIds.has(r.rest_request)) continue;
    if (r.status === "open" || r.status === "underpaid") {
      const owedNow = atomicOf(r.amount_requested, r.token) - paid;
      if (owedNow > 0n) outstanding.set(r.token, (outstanding.get(r.token) ?? 0n) + owedNow);
    }
  }
  const parts = [`${count("paid")} of ${results.length} paid`];
  const got = totals(received, deps);
  if (got) parts.push(`${got} received`);
  const due = totals(outstanding, deps);
  if (due) parts.push(`${due} outstanding`);
  const extras: Array<[CheckResult["status"], string]> = [
    ["underpaid", "underpaid"], ["cancelled", "cancelled"], ["expired", "expired"], ["not_found", "not found"],
    ["invalid", "invalid"], ["unknown", "couldn't be checked"],
  ];
  for (const [status, label] of extras) if (count(status) > 0) parts.push(`${count(status)} ${label}`);
  return [...parts, ...potParts].join(" · ");
}

function label(r: CheckResult): string {
  return r.id ? `request ${r.id}${r.chain === "base" ? " (Base)" : ""}` : "Solana Pay link"; // W3-B: say which chain
}

function detailLine(r: CheckResult): string[] {
  const lines = statusLine(r);
  // Local-currency asks: the quote under the status line, labelled as one.
  const quoted = lines.length > 0 ? fiatStatusLine(r.fiat, r.amount_requested ?? undefined) : null;
  return quoted ? [...lines, `  Asked as ${quoted}; a quote, not a guarantee.`] : lines;
}

function statusLine(r: CheckResult): string[] {
  if (r.pot) return potStatusLines(r); // F7 pots
  const from = r.payer ? ` from ${shortAddress(r.payer)}` : "";
  const link = r.explorer_url ? `: ${r.explorer_url}` : "";
  const refunded = r.refunded ? `, refunded ${r.refunded} ${r.token ?? ""}${r.refunded_in_full ? " (in full)" : ""}` : ""; // F8 invoices
  const pending = r.refund_pending ? `, a refund of ${r.refund_pending} ${r.token ?? ""} is waiting to land` : "";
  if (r.status === "paid") return [`Paid, ${label(r)}: ${r.amount_paid ?? r.amount_requested ?? "?"} ${r.token ?? ""}${from}${r.matched ? `, ${r.matched}` : ""}${refunded}${pending}${link}`]; // 0012
  if (r.status === "underpaid") {
    // 0012: the follow-up for the rest, or how to ask for it.
    const rest = r.rest_request
      ? ` The rest is asked in request ${r.rest_request}.`
      : r.id ? ` To ask for the rest, call match_payments with action ask_for_rest and this request.` : "";
    return [`Underpaid, ${label(r)}: ${r.amount_paid ?? "?"} of ${r.amount_requested ?? "?"} ${r.token ?? ""}${from}${link}.${rest}`];
  }
  if (r.status === "open" && r.waited) return [`Open, ${label(r)}: ${r.amount_requested ?? "?"} ${r.token ?? ""}, waiting ${r.waited}${r.expires_at ? `, expires ${r.expires_at}` : ""}`];
  // W3-C: ended requests take no payment; say so, so nobody chases or pays them.
  if (r.status === "cancelled") return [`Cancelled, ${label(r)}: ${r.amount_requested ?? "?"} ${r.token ?? ""}${r.cancelled_at ? ` at ${r.cancelled_at}` : ""}; it takes no payment.`];
  if (r.status === "expired") return [`Expired, ${label(r)}: ${r.amount_requested ?? "?"} ${r.token ?? ""}${r.expires_at ? ` at ${r.expires_at}` : ""}; it takes no payment.`];
  if (r.error) return [`${r.status === "unknown" ? "Not checked" : "Skipped"}, ${r.input.length > 60 ? `${r.input.slice(0, 57)}...` : r.input}: ${r.error}`];
  return [];
}

// ---- F7 pots start ----
/** A pot's board as a result: checked against its id (wallet + token), never counted as a debt. */
async function checkPot(p: Extract<Parsed, { kind: "pot" }>, ctx: CallContext, deps: Deps, remaining: () => number): Promise<CheckResult> {
  const unknown = (error: string): CheckResult => ({ input: p.input, id: p.id, status: "unknown", amount_requested: null, token: null, error });
  let pot: PotRes | null;
  try {
    pot = await within(ctx.api.getPot(p.id), Math.min(remaining(), 6000), () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return { input: p.input, id: p.id, status: "not_found", amount_requested: null, token: null, error: "No Owed pot has this id." };
    if (error instanceof ApiError && error.code !== "upstream_unavailable") return { input: p.input, id: p.id, status: "invalid", amount_requested: null, token: null, error: error.message };
    return unknown(UNREACHABLE);
  }
  if (!pot) return unknown(UNREACHABLE);
  const wrong = potTermsProblem(pot, p.id);
  if (wrong) return { input: p.input, id: p.id, status: "invalid", amount_requested: null, token: null, error: wrong };
  const out: CheckResult = {
    input: p.input, id: p.id, status: potEnded(pot, deps.now()) ? "expired" : "open", amount_requested: pot.target, token: pot.token,
    amount_paid: pot.totals.raised, expires_at: pot.deadline,
    pot: {
      title: clean(pot.title, POT_TITLE_MAX), raised: pot.totals.raised, target: pot.target, count: pot.totals.count, deadline: pot.deadline, link: pot.link,
      latest: pot.contributions.slice(0, 5).map((c) => ({ amount: c.amount, payer: c.payer, at: c.at, explorer_url: explorerUrl(c.signature) })),
    },
  };
  if (!pot.chain_checked) out.error = "Solana couldn't be read just now, so the newest contributions may not be counted yet.";
  return out;
}

function potRaisedText(r: CheckResult): string {
  const p = r.pot!;
  const count = `${p.count} ${p.count === 1 ? "contribution" : "contributions"}`;
  return `${p.target === null ? `${p.raised} ${r.token}` : `${p.raised} of ${p.target} ${r.token}`} raised from ${count}${r.status === "expired" ? ", ended" : ""}`;
}

function potStatusLines(r: CheckResult): string[] {
  const p = r.pot!;
  const when = r.status === "expired" ? `ended ${p.deadline}; it takes no new contributions` : `takes contributions until ${p.deadline}`;
  const lines = [`Pot ${r.id} ${quote(p.title, POT_TITLE_MAX)} (written by whoever started it; unverified): ${potRaisedText(r)}, ${when}. Board: ${p.link}`];
  for (const c of p.latest) lines.push(`  ${c.amount} ${r.token ?? ""} from ${shortAddress(c.payer)} at ${c.at}: ${c.explorer_url}`);
  if (r.error) lines.push(`  ${r.error}`);
  return lines;
}
// ---- F7 pots end ----

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("check_payments", {
    title: "Check who has paid",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => checkPayments(args, deps));
}
