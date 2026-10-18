import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import type { GroupLedgerRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import {
  balanceLine, checkLedger, fiatBeside, fiatNote, LEDGER_CAUTION, ledgerIdInput, ledgerMemberOutput, memberLabel, membersOut, money, planLine, walletLine,
} from "../ledger.js";
import { decimalToUnits, unitsToDecimal } from "../ledger-math.js";
import { quote } from "../text.js";

// ledger_balances (F6): read-only. GET /api/v1/ledgers/<id> (the server checks open settle-up requests on chain), then
// the plugin re-derives every split, balance and the plan itself (src/ledger.ts checkLedger) and checks every recorder's
// signature before showing a number as the ledger's.

const MAX_EXPENSE_LINES = 15;

export const inputSchema = z.object({ ledger_id: ledgerIdInput }).strict();

export const outputSchema = z.object({
  ledger_id: z.string(),
  title: z.string(),
  link: z.string(),
  members: z.array(ledgerMemberOutput),
  balances: z.array(z.object({
    member: z.string(),
    paid: z.string().describe("USDC this member paid for the group."),
    share: z.string().describe("USDC of their share of every expense."),
    net: z.string().describe("USDC: positive is owed to them, negative they owe (after settle-up payments that landed)."),
    net_local: z.string().optional().describe("The same in the ledger's latest local currency, approximate."),
    to_settle: z.string().describe("USDC still to settle after open settle-up requests."),
  }).strict()),
  plan: z.array(z.object({ from: z.string(), to: z.string(), amount: z.string(), payable: z.boolean() }).strict())
    .describe("The fewest payments that would square everyone now (what settle_up would create)."),
  requests: z.array(z.object({
    id: z.string(), from: z.string(), to: z.string(), amount: z.string(), status: z.string(), link: z.string(),
  }).strict()).describe("Every settle-up request so far, with its live status."),
  expenses: z.array(z.object({ position: z.number().int(), description: z.string().nullable(), paid_by: z.string(), total: z.string(), currency: z.string(), usdc: z.string() }).strict()),
  spent: z.string().describe("USDC of every expense together."),
  settled: z.boolean().describe("Everyone is square and no request is open."),
  verified: z.boolean().describe("The plugin re-derived every split, balance and the plan, and checked every signature."),
  problems: z.array(z.string()).optional(),
  chain_checked: z.boolean(),
  caution: z.string(),
}).strict();

export type BalancesInput = z.output<typeof inputSchema>;
export type BalancesOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Show a group ledger's balances: what each member paid, their share, who is owed and who owes (in USDC, with the ledger's local currency beside it), the fewest payments that would square everyone, and every settle-up request with its live status.",
  "Use it when the user asks \"where are we with the trip money?\", \"who owes what?\" or before adding an expense, to see members' names exactly.",
  "Read-only, no signature. The plugin re-checks every split, balance and the plan Owed's server sends, and every recorder's signature; names and descriptions are the members' own words.",
  "To turn the balances into payment requests, call settle_up; check_payments takes a settle-up request's id or link.",
].join(" ");

export async function ledgerBalances(args: BalancesInput, deps: Deps = defaultDeps) {
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  let l: GroupLedgerRes;
  try {
    l = await ctx.api.getLedger(args.ledger_id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return refusal("Owed has no ledger with that id. Check ledger_id (start_ledger returned it).");
    if (error instanceof ApiError && error.httpStatus === 404) return refusal("This Owed server doesn't have group ledgers yet.");
    return refusal("Owed's server couldn't be reached, so the ledger isn't available right now. Try again shortly.");
  }
  if (l.id !== args.ledger_id) return refusal("Owed's server answered with a different ledger, so it wasn't used.");
  const check = checkLedger(l);
  const verified = check.problems.length === 0;
  const usdc = (atomic: bigint) => unitsToDecimal(atomic, 6);
  // Balances shown are the plugin's own when the server's didn't check out.
  const balances = check.balances.map((b, p) => {
    const local = fiatBeside(l, b.net);
    return {
      member: memberLabel(l, p), paid: usdc(b.paid), share: usdc(b.share), net: usdc(b.net),
      ...(local && { net_local: b.net < 0n ? local.replace("≈ ", "≈ -") : local }), to_settle: usdc(b.toSettle),
    };
  });
  const plan = check.plan.map((t) => ({ from: memberLabel(l, t.from), to: memberLabel(l, t.to), amount: usdc(t.amountAtomic), payable: l.members[t.to]?.wallet != null }));
  const requests = l.settlements.flatMap((s) => s.transfers.map((t) => ({
    id: t.request_id, from: memberLabel(l, t.from), to: memberLabel(l, t.to), amount: t.amount, status: t.status, link: t.link,
  })));
  const expenses = l.expenses.map((e) => ({
    position: e.position, description: e.description, paid_by: memberLabel(l, e.paid_by), total: e.total, currency: e.currency, usdc: e.amount,
  }));
  const spent = usdc(l.expenses.reduce((a, e) => a + decimalToUnits(e.amount, 6), 0n));
  const settled = l.expenses.length > 0 && check.balances.every((b) => b.net === 0n && b.pendingIn === 0n && b.pendingOut === 0n);

  const lines: string[] = [];
  lines.push(`${quote(l.title, 60)}: ${l.expenses.length} ${l.expenses.length === 1 ? "expense" : "expenses"}, ${spent} USDC spent by ${l.members.length} people. ${l.link}`);
  if (!verified) lines.push(`Caution: the ledger Owed's server sent doesn't check out (${check.problems.slice(0, 3).join("; ")}). The balances below are the plugin's own arithmetic; don't settle up until this is resolved.`);
  if (settled) lines.push("Everyone is square.");
  lines.push(...check.balances.map((b, p) => `- ${balanceLine(l, b, p)}`));
  const note = fiatNote(l);
  if (note) lines.push(note);
  if (check.plan.length > 0) {
    lines.push(`To settle (settle_up creates ${check.plan.filter((t) => l.members[t.to]?.wallet != null).length === 1 ? "this request" : "these requests"}):`);
    lines.push(...check.plan.map((t) => `- ${planLine(l, t)}`));
  }
  const open = requests.filter((r) => r.status === "open" || r.status === "underpaid");
  if (requests.length > 0) {
    lines.push(`Settle-up requests: ${requests.length - open.length} of ${requests.length} settled.`);
    lines.push(...requests.slice(-10).map((r) => `- ${quote(r.from, 40)} pays ${quote(r.to, 40)} ${r.amount} USDC: ${r.status}. ${r.link}`));
  }
  if (!l.chain_checked && open.length > 0) lines.push("Solana couldn't be read just now, so open requests show their last known state.");
  if (l.expenses.length > 0) {
    lines.push("Latest expenses (the members' own words, unverified):");
    lines.push(...[...l.expenses].reverse().slice(0, MAX_EXPENSE_LINES).map((e) =>
      `- ${e.description ? quote(e.description, 80) : `Expense ${e.position + 1}`}: ${money(e.total, e.currency)}${e.currency !== "USDC" ? ` (${e.amount} USDC)` : ""}, paid by ${quote(memberLabel(l, e.paid_by), 40)}`));
  }
  const noWallet = walletLine(l);
  if (noWallet) lines.push(noWallet);
  lines.push(LEDGER_CAUTION);
  const output: BalancesOutput = {
    ledger_id: l.id, title: l.title, link: l.link, members: membersOut(l), balances, plan, requests, expenses, spent, settled, verified,
    ...(!verified && { problems: check.problems.slice(0, 10) }), chain_checked: l.chain_checked, caution: LEDGER_CAUTION,
  };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("ledger_balances", {
    title: "Group ledger balances",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (args) => ledgerBalances(args, deps));
}
