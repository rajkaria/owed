import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { addressSchema, type GroupLedgerRes, type SettleUpRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import {
  balanceLine, checkLedger, isoSeconds, LEDGER_CAUTION, ledgerIdInput, localSignatureCheck, memberLabel, MESSAGE_VALID_MS, planLine, signatureInput,
  signedMessageInput,
} from "../ledger.js";
import { decimalToUnits, ledgerBalances, planSettlement, settlePrefix, transferAmounts, unitsToDecimal, type PlannedTransfer } from "../ledger-math.js";
import { USDC_MINT } from "../money.js";
import { payerOutput } from "../payer.js";
import { idMatchesTerms } from "../request-id.js";
import { clean, quote, rateLimitedText } from "../text.js";

// settle_up (F6): the largest debtor pays the largest creditor until everyone is square (at most n - 1 payments).
// Two calls. The first reads the ledger, re-derives it (src/ledger.ts checkLedger) and returns the plan and
// message_to_sign, which names the ledger's version, how many requests and their USDC total. The second sends the
// signature; Owed's server creates one ordinary request per payment (payable to the creditor, addressed to the
// debtor), and the plugin checks each one: it pays exactly the planned amount to the creditor's wallet, its id hashes
// its terms, and the plan matches what the ledger now shows.

const BUDGET_MS = 9500;
const READ_TIMEOUT_MS = 4000;
const SETTLE_TIMEOUT_MS = 8000;
const SIGNED_RE = /^Owed settle up ledger ([1-9A-HJ-NP-Za-km-z]{12}) v(\d{1,9}): (\d{1,2}) requests?, ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) USDC by ([1-9A-HJ-NP-Za-km-z]{32,44}) at /;

export const inputSchema = z.object({
  ledger_id: ledgerIdInput,
  signer: addressSchema.describe("The user's own PayBox Solana wallet (from list_credentials): the ledger's owner or a member's wallet in it signs the settle-up."),
  signed_message: signedMessageInput.optional(),
  signature: signatureInput.optional(),
}).strict();

const planOut = z.object({ from: z.string(), to: z.string(), amount: z.string().describe("USDC."), payable: z.boolean().describe("false: the person owed has no wallet in the ledger, so no request can pay them.") }).strict();

export const outputSchema = z.object({
  step: z.enum(["sign", "settled", "nothing"]).describe("sign = sign message_to_sign and call again; settled = requests created; nothing = everyone is square or already asked."),
  ledger_id: z.string(),
  link: z.string(),
  plan: z.array(planOut),
  message_to_sign: z.string().optional(),
  expires_at: z.string().optional(),
  requests: z.array(z.object({
    from: z.string(), to: z.string(), amount: z.string(), id: z.string().describe("check_payments takes it."), link: z.string(),
    addressed_to: payerOutput.optional().describe("In this person's own agent inbox (what_do_i_owe)."),
    share_text: z.string().describe("A ready-to-send message for whoever pays it."),
  }).strict()).optional(),
  unpayable: z.array(z.object({ from: z.string(), to: z.string(), amount: z.string(), why: z.string() }).strict()).optional(),
  balances: z.array(z.string()).optional(),
  caution: z.string(),
}).strict();

export type SettleInput = z.output<typeof inputSchema>;
export type SettleOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Settle a group ledger: the largest debtor pays the largest creditor until everyone is square, so n people need at most n - 1 payments.",
  "Each payment becomes one ordinary Owed request in USDC, payable straight to the person owed and addressed to the person who owes it, so it lands in their own agent's inbox (what_do_i_owe) as \"<ledger title> settle-up\", naming the ledger and who recorded the settle-up. Owed never holds the money.",
  "Someone owed money who has no wallet in the ledger can't be paid this way: that payment is listed and skipped.",
  "Two calls. The first shows the plan and message_to_sign; sign it with PayBox request_wallet_sign (credential_id of the signer wallet, intent {op:\"solanaMessage\", address: signer, message: message_to_sign}); the user approves with their passkey and no money moves. Then call settle_up again with signed_message and signature (valid 5 minutes, once).",
  "signer is the user's own PayBox Solana wallet (from list_credentials), the owner's or a member's in this ledger. Afterwards send each person their link (share_text), and use ledger_balances or check_payments to see who has paid.",
].join(" ");

function apiRefusal(error: unknown): string {
  if (!(error instanceof ApiError)) return errorText(error, "Couldn't settle up.");
  if (error.code === "not_found") return "Owed has no ledger with that id. Check ledger_id (start_ledger returned it).";
  if (error.code === "blocked") return `Owed refused: ${error.message}.`;
  if (error.code === "rate_limited") return rateLimitedText(error.message, "Each settle-up payment counts as one request.");
  if (error.code === "invalid_input") return `Owed refused the settle-up: ${error.message}. Nothing was created.`;
  if (error.httpStatus === 404) return "This Owed server doesn't have group ledgers yet. Nothing was created.";
  if (error.detail) return `Owed couldn't settle up: ${clean(error.detail, 300)}. Nothing was created; try again shortly.`;
  return "Owed's server couldn't be reached. Check ledger_balances before trying again: the requests may have been created.";
}

const usdc = (atomic: bigint) => unitsToDecimal(atomic, 6);
const planOutput = (l: GroupLedgerRes, plan: PlannedTransfer[]) =>
  plan.map((t) => ({ from: memberLabel(l, t.from), to: memberLabel(l, t.to), amount: usdc(t.amountAtomic), payable: l.members[t.to]?.wallet != null }));

export async function settleUp(args: SettleInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  if (!deps.isSolanaAddress(args.signer)) return refusal("signer must be a Solana wallet address (the user's own PayBox Solana wallet).");
  if ((args.signed_message === undefined) !== (args.signature === undefined)) {
    return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
  }
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  if (args.signed_message === undefined || args.signature === undefined) {
    let l: GroupLedgerRes;
    try {
      l = await makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: READ_TIMEOUT_MS }).getLedger(args.ledger_id, { chain: false });
    } catch (error) {
      return refusal(apiRefusal(error));
    }
    if (l.id !== args.ledger_id) return refusal("Owed's server answered with a different ledger, so nothing was settled.");
    if (!l.members.some((m) => m.wallet === args.signer)) {
      return refusal(`Only the ledger's owner or a member whose wallet is in it can settle up, and ${args.signer} isn't one of them. Sign with that wallet.`);
    }
    const check = checkLedger(l);
    if (check.problems.length > 0) {
      return refusal(`This ledger doesn't add up (${check.problems.slice(0, 3).join("; ")}), so it can't be settled. Show the user ledger_balances; nothing was created.`);
    }
    const plan = planOutput(l, check.plan);
    const payable = check.plan.filter((t) => l.members[t.to]?.wallet != null);
    const base: SettleOutput = { step: "nothing", ledger_id: l.id, link: l.link, plan, caution: LEDGER_CAUTION };
    if (check.plan.length === 0) {
      const open = l.settlements.flatMap((s) => s.transfers).filter((t) => t.status === "open" || t.status === "underpaid").length;
      const text = open > 0
        ? `Nothing new to settle in ${quote(l.title, 60)}: ${open} settle-up ${open === 1 ? "request is" : "requests are"} still open. ledger_balances shows who has paid.`
        : l.expenses.length === 0 ? `Nothing to settle in ${quote(l.title, 60)} yet: no expenses are recorded.` : `Everyone in ${quote(l.title, 60)} is square.`;
      return { content: [{ type: "text" as const, text }], structuredContent: base };
    }
    if (payable.length === 0) {
      return refusal(`Everyone owed money in ${quote(l.title, 60)} has no wallet in the ledger, so no request can pay them: ${check.plan.map((t) => planLine(l, t)).join("; ")}. Settle those by hand.`);
    }
    const total = payable.reduce((a, t) => a + t.amountAtomic, 0n);
    const message_to_sign = `${settlePrefix(l.id, l.version, payable.length, usdc(total), args.signer)} at ${isoSeconds(started)}`;
    const expires_at = isoSeconds(started + MESSAGE_VALID_MS);
    const output: SettleOutput = { ...base, step: "sign", message_to_sign, expires_at };
    const text = [
      `To settle ${quote(l.title, 60)}, Owed will create ${payable.length} ${payable.length === 1 ? "request" : "requests"} (${usdc(total)} USDC in all), each paid straight to the person owed:`,
      ...check.plan.map((t) => `- ${planLine(l, t)}`),
      "Sign this exact message with PayBox (it moves no money; it approves only these requests, for this version of the ledger):",
      message_to_sign,
      `Call request_wallet_sign with this wallet's credential_id and intent {"op":"solanaMessage","address":"${args.signer}","message":"${message_to_sign}"}.`,
      `After the user approves, call settle_up again with ledger_id, signer, signed_message (the text above) and signature (from the output). Valid until ${expires_at}, once.`,
    ].join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: output };
  }

  // Second call: the signed message itself names the version, count and total it approves.
  const message = args.signed_message;
  const m = SIGNED_RE.exec(message);
  const again = "call settle_up with only ledger_id and signer for a fresh message, sign that, and try again.";
  if (!m || m[1] !== args.ledger_id || m[5] !== args.signer) {
    return refusal(`signed_message must be exactly the message_to_sign settle_up gave for this ledger and signer. ${again}`);
  }
  const lead = message.slice(0, message.lastIndexOf(" at ") + 4);
  const problem = localSignatureCheck(lead, args.signer, message, args.signature.trim(), started, again);
  if (problem) return refusal(problem);
  const version = Number(m[2]);
  const count = Number(m[3]);
  const totalAtomic = decimalToUnits(m[4]!, 6);

  let res: SettleUpRes | null;
  try {
    res = await within(
      makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: SETTLE_TIMEOUT_MS }).settleLedger(args.ledger_id, { signer: args.signer, version, signed_message: message, signature: args.signature.trim() }),
      BUDGET_MS - (deps.now() - started), () => null,
    );
  } catch (error) {
    return refusal(apiRefusal(error));
  }
  if (!res) return refusal("Owed's server didn't answer in time. Check ledger_balances before trying again: the requests may have been created.");

  const bad = (why: string) => refusal(`Owed's server created settle-up requests that don't match the ledger (${why}), so don't send them. Check ledger_balances.`);
  const l = res.ledger;
  if (l.id !== args.ledger_id || res.round !== version) return bad("a different ledger or version");
  const check = checkLedger(l);
  if (check.problems.length > 0) return bad(check.problems[0]!);
  // The plan before this settle-up: the ledger now, without this round's requests.
  const n = l.members.length;
  const before = ledgerBalances(n, l.expenses.map((e) => {
    const shares = Array.from({ length: n }, () => 0n);
    for (const s of e.shares) shares[s.member] = decimalToUnits(s.amount, 6);
    return { paidBy: e.paid_by, amountAtomic: decimalToUnits(e.amount, 6), sharesAtomic: shares };
  }), l.settlements.filter((s) => s.round !== res.round).flatMap((s) => s.transfers.map((t) => {
    const amountAtomic = decimalToUnits(t.amount, 6);
    return { from: t.from, to: t.to, amountAtomic, ...transferAmounts(t.status, amountAtomic, t.paid ? decimalToUnits(t.paid.amount, 6) : null) };
  })));
  const plan = planSettlement(before.map((b) => b.toSettle));
  const payable = plan.filter((t) => l.members[t.to]?.wallet != null);
  const total = payable.reduce((a, t) => a + t.amountAtomic, 0n);
  if (payable.length !== count || total !== totalAtomic || res.created.length !== count) return bad("not the requests that were signed for");
  const forText = `${l.title} settle-up`;
  for (const [i, c] of res.created.entries()) {
    const t = payable[i]!;
    const debtor = l.members[t.from]!;
    const creditor = l.members[t.to]!;
    const r = c.request;
    const amountAtomic = decimalToUnits(c.amount, 6);
    if (c.from !== t.from || c.to !== t.to || amountAtomic !== t.amountAtomic || r.recipient !== creditor.wallet) return bad(`payment ${i + 1} isn't the planned one`);
    if ((r.payer?.wallet ?? null) !== debtor.wallet) return bad(`payment ${i + 1} isn't addressed to ${memberLabel(l, t.from)}`);
    if (!idMatchesTerms(r.id, { recipient: r.recipient, token: "USDC", amountAtomic, reference: r.reference })) return bad(`request ${r.id}'s id doesn't hash its terms`);
    try {
      const link = new URL(r.link);
      const parsed = deps.parseLink(r.solana_pay_url, ctx.hosts);
      if (link.protocol !== "https:" || !link.pathname.endsWith(`/r/${r.id}`) || parsed.kind !== "transfer") return bad(`request ${r.id}'s links`);
      const q = parsed.request;
      if (q.recipient !== r.recipient || q.splToken !== USDC_MINT || !q.references.includes(r.reference) || q.amount === undefined || deps.toAtomic(q.amount, "USDC") !== amountAtomic) {
        return bad(`request ${r.id}'s Solana Pay link pays something else`);
      }
    } catch {
      return bad(`request ${r.id}'s links can't be read`);
    }
    if (r.for !== forText || !r.note?.includes(`ledger ${l.id}`)) return bad(`request ${r.id} doesn't name the ledger`);
  }

  const requests = res.created.map((c) => {
    const debtor = memberLabel(l, c.from);
    const creditor = memberLabel(l, c.to);
    const share_text = `Hi ${debtor}! Settling up ${quote(l.title, 60).replace(/^"|"$/g, "'")}: you owe ${creditor} ${c.amount} USDC. Pay with any Solana wallet, or your own agent in PayBox, here: ${c.request.link}`;
    return {
      from: debtor, to: creditor, amount: c.amount, id: c.request.id, link: c.request.link,
      ...(c.request.payer && { addressed_to: { wallet: c.request.payer.wallet, handle: c.request.payer.handle, sns: c.request.payer.sns } }), share_text,
    };
  });
  const unpayable = res.unpayable.map((u) => ({
    from: memberLabel(l, u.from), to: memberLabel(l, u.to), amount: u.amount, why: `${memberLabel(l, u.to)} has no wallet in this ledger, so no request can pay them; settle it by hand.`,
  }));
  const balances = check.balances.map((b, p) => balanceLine(l, b, p));
  const lines = [
    `Settle-up for ${quote(l.title, 60)}: ${requests.length} ${requests.length === 1 ? "request" : "requests"}, ${usdc(total)} USDC, each paid straight to the person owed. Ledger: ${l.link}`,
    ...requests.map((r) => `- ${quote(r.from, 40)} pays ${quote(r.to, 40)} ${r.amount} USDC: ${r.link}${r.addressed_to ? " (in their own agent's inbox, what_do_i_owe)" : " (no wallet in the ledger: send them this link)"}`),
    ...unpayable.map((u) => `- Not created: ${quote(u.from, 40)} owes ${quote(u.to, 40)} ${u.amount} USDC. ${u.why}`),
    "Each request names the ledger and who recorded this settle-up. Send each person their link (share_text); ledger_balances or check_payments shows who has paid.",
  ];
  const output: SettleOutput = {
    step: "settled", ledger_id: l.id, link: l.link, plan: planOutput(l, plan), requests, ...(unpayable.length > 0 && { unpayable }), balances, caution: LEDGER_CAUTION,
  };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("settle_up", {
    title: "Settle up a group ledger",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    // Each signed message settles one version once; afterwards there is nothing left to settle.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => settleUp(args, deps));
}
