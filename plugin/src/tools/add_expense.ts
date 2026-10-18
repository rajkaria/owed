import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { addressSchema, decimalSchema, type AddExpenseRes, type GroupLedgerRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { FIAT_CODES, lockedAt } from "../fiat.js";
import {
  balanceLine, buildExpense, checkLedger, currencyDecimals, expenseLead, isoSeconds, LEDGER_CAUTION, ledgerIdInput, localSignatureCheck, memberLabel,
  MESSAGE_VALID_MS, money, signatureInput, signedMessageInput, type BuiltExpense,
} from "../ledger.js";
import { LedgerError, LEDGER_LIMITS, SPLIT_MODES, unitsToDecimal } from "../ledger-math.js";
import { clean, quote, rateLimitedText } from "../text.js";

// add_expense (F6): record who paid what and how it splits. Two calls, like who_owes_me: the first reads the ledger,
// works out the split here (the same arithmetic as the server) and returns message_to_sign, which covers exactly this
// expense (a digest of every amount, member and cleaned description); the user signs it with PayBox
// request_wallet_sign; the second call sends it. Only a wallet named in the ledger can sign. A local-currency expense
// is locked to USDC by Owed's server when it is recorded (two sources, 2% rule), and the plugin checks the quote.

const BUDGET_MS = 9500;
const READ_TIMEOUT_MS = 3000;
const WRITE_TIMEOUT_MS = 5500;
const memberName = z.string().min(1).max(LEDGER_LIMITS.name);

export const inputSchema = z.object({
  ledger_id: ledgerIdInput,
  signer: addressSchema.describe("The user's own PayBox Solana wallet (from list_credentials). It must be the ledger's owner or a member's wallet in it: that wallet signs the expense."),
  paid_by: memberName.describe("Who paid, by name as the ledger lists it."),
  amount: decimalSchema.describe('The total paid, in currency, as a decimal string, e.g. "84.60". For split "items" it must be the receipt total: items + tax + tip.'),
  currency: z.string().min(3).max(4).optional().describe(`"USDC" (default) or the currency the expense was paid in, as an ISO 4217 code: one of ${FIAT_CODES.join(", ")}. Each share of a local-currency expense is locked to USDC at one live rate when it is recorded.`),
  description: z.string().min(1).max(LEDGER_LIMITS.description).optional().describe('What it was, e.g. "Dinner at Taberna". Everyone sees it quoted.'),
  split: z.enum(SPLIT_MODES).default("even").describe('"even" (default): equal shares, among everyone or the members in among; "shares": by each member\'s number of shares; "exact": a set amount per member; "items": a receipt, line by line.'),
  among: z.array(memberName).min(1).max(LEDGER_LIMITS.members).optional().describe('split "even" only: who shares it, if not everyone.'),
  shares: z.array(z.object({ member: memberName, shares: decimalSchema.describe('e.g. "2" for a couple, "1" for one person.') }).strict()).min(1).max(LEDGER_LIMITS.members).optional()
    .describe('split "shares": each member who shares it, with their number of shares.'),
  amounts: z.array(z.object({ member: memberName, amount: decimalSchema }).strict()).min(1).max(LEDGER_LIMITS.members).optional()
    .describe('split "exact": what each member owes, in currency; together exactly amount.'),
  items: z.array(z.object({
    description: z.string().min(1).max(LEDGER_LIMITS.itemDescription).optional(),
    amount: decimalSchema.describe("The line's price, in currency."),
    members: z.array(memberName).min(1).max(LEDGER_LIMITS.members).describe("Who had it: it splits evenly among them."),
  }).strict()).min(1).max(LEDGER_LIMITS.items).optional()
    .describe('split "items": every line of the receipt (read the photo yourself). Tax and tip are spread over each person\'s items.'),
  tax: decimalSchema.optional().describe('split "items" only: the receipt\'s tax, in currency.'),
  tip: decimalSchema.optional().describe('split "items" only: the tip or service charge, in currency.'),
  signed_message: signedMessageInput.optional(),
  signature: signatureInput.optional(),
}).strict();

const shareOut = z.object({
  member: z.string(),
  share: z.string().describe("What this member owes for it, in currency."),
  usdc: z.string().optional().describe("Once recorded: the USDC it was locked at (local currency) or the same amount (USDC)."),
}).strict();

export const outputSchema = z.object({
  step: z.enum(["sign", "added"]).describe("sign = sign message_to_sign and call again with the same arguments; added = recorded."),
  ledger_id: z.string(),
  message_to_sign: z.string().optional(),
  expires_at: z.string().optional(),
  currency: z.string(),
  total: z.string().describe("In currency."),
  paid_by: z.string(),
  shares: z.array(shareOut),
  usdc_total: z.string().optional().describe("Once recorded: what the payer is credited in USDC (the shares' sum)."),
  rate: z.string().optional().describe("Local currency, once recorded: units per 1 USDC locked for this expense."),
  position: z.number().int().optional().describe("The expense's number in the ledger (0 = first)."),
  link: z.string().optional(),
  balances: z.array(z.string()).optional().describe("Each member's balance after this expense."),
  caution: z.string(),
}).strict();

export type AddExpenseInput = z.output<typeof inputSchema>;
export type AddExpenseOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Record a shared expense in a group ledger (start_ledger): who paid, the amount, the currency, and how it splits: even (everyone, or the members in among), shares (e.g. 2 shares for a couple), exact amounts per member, or items from a receipt, where each line is split among the members who had it and tax and tip are spread over each person's items.",
  "For a receipt photo, read it yourself and pass every line as items, with tax and tip; amount is the receipt's total. currency is USDC unless the expense was paid in another currency (EUR, INR, …): each member's share is then locked to USDC at one live rate when it is recorded.",
  "Name members exactly as the ledger lists them (ledger_balances shows them).",
  "Two calls. The first returns who owes what and message_to_sign; sign it with PayBox request_wallet_sign (credential_id of the signer wallet, intent {op:\"solanaMessage\", address: signer, message: message_to_sign}); the user approves with their passkey and no money moves. Then call add_expense again with the same arguments plus signed_message and signature (valid 5 minutes, once).",
  "signer is the user's own PayBox Solana wallet (from list_credentials): only the ledger's owner or a member whose wallet is in it can add expenses.",
].join(" ");

function apiRefusal(error: unknown, what: string): string {
  if (!(error instanceof ApiError)) return errorText(error, `Couldn't ${what}.`);
  if (error.code === "not_found") return "Owed has no ledger with that id. Check ledger_id (start_ledger returned it).";
  if (error.code === "blocked") return `Owed refused: ${error.message}.`;
  if (error.code === "rate_limited") return rateLimitedText(error.message);
  if (error.code === "invalid_input") return `Owed refused the expense: ${error.message}. Nothing was recorded.`;
  if (error.httpStatus === 404) return "This Owed server doesn't have group ledgers yet. Nothing was recorded.";
  if (error.detail) return `Owed couldn't record the expense: ${clean(error.detail, 300)}. Nothing was recorded; try again in a minute.`;
  return `Owed's server couldn't be reached, so nothing was recorded. Try again shortly.`;
}

function preview(l: GroupLedgerRes, built: BuiltExpense) {
  return built.participants.map((p) => ({ member: memberLabel(l, p), share: unitsToDecimal(built.units[p]!, built.decimals) }));
}

export async function addExpense(args: AddExpenseInput, deps: Deps = defaultDeps) {
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
  const reader = makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: READ_TIMEOUT_MS });
  let ledger: GroupLedgerRes;
  try {
    ledger = await reader.getLedger(args.ledger_id, { chain: false });
  } catch (error) {
    return refusal(apiRefusal(error, "read the ledger"));
  }
  if (ledger.id !== args.ledger_id) return refusal("Owed's server answered with a different ledger, so nothing was recorded.");
  const signerMember = ledger.members.find((m) => m.wallet === args.signer);
  if (!signerMember) {
    return refusal(`Only the ledger's owner or a member whose wallet is in it can add expenses, and ${args.signer} isn't one of them. Sign with that wallet, or ask the owner to add it.`);
  }
  if (ledger.expenses.length >= LEDGER_LIMITS.expenses) return refusal(`This ledger already has ${LEDGER_LIMITS.expenses} expenses, the most one holds. Settle up and start a new ledger.`);
  let built: BuiltExpense;
  try {
    built = buildExpense(ledger, args);
  } catch (error) {
    if (error instanceof LedgerError) return refusal(`Can't record this expense: ${error.message} Nothing was recorded.`);
    throw error;
  }
  const lead = expenseLead(ledger.id, built, args.signer);
  const total = unitsToDecimal(built.canonical.totalUnits, built.decimals);
  const payer = memberLabel(ledger, built.canonical.paidBy);
  const shares = preview(ledger, built);
  const shareLines = shares.map((s) => `- ${quote(s.member, 40)}: ${money(s.share, built.currency)}`);
  const what = built.canonical.description ? ` for ${quote(built.canonical.description, 80)}` : "";

  if (args.signed_message === undefined || args.signature === undefined) {
    const message_to_sign = `${lead}${isoSeconds(started)}`;
    const expires_at = isoSeconds(started + MESSAGE_VALID_MS);
    const output: AddExpenseOutput = {
      step: "sign", ledger_id: ledger.id, message_to_sign, expires_at, currency: built.currency, total, paid_by: payer, shares, caution: LEDGER_CAUTION,
    };
    const text = [
      `To record ${money(total, built.currency)}${what}, paid by ${quote(payer, 40)}, split ${args.split}:`,
      ...shareLines,
      ...(built.currency !== "USDC" ? [`Owed locks each share to USDC at one live rate when it is recorded; the USDC amounts are what is owed.`] : []),
      "Sign this exact message with PayBox (it moves no money and approves only this expense):",
      message_to_sign,
      `Call request_wallet_sign with this wallet's credential_id and intent {"op":"solanaMessage","address":"${args.signer}","message":"${message_to_sign}"}.`,
      `After the user approves, call add_expense again with the same arguments plus signed_message (the text above) and signature (from the output). Valid until ${expires_at}, once.`,
    ].join("\n");
    return { content: [{ type: "text" as const, text }], structuredContent: output };
  }

  const again = "call add_expense with the same arguments and no signature for a fresh message, sign that, and try again.";
  const problem = localSignatureCheck(lead, args.signer, args.signed_message, args.signature.trim(), started, again);
  if (problem) return refusal(problem);
  const writer = makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: WRITE_TIMEOUT_MS });
  let res: AddExpenseRes | null;
  try {
    res = await within(
      writer.addExpense(ledger.id, { signer: args.signer, ...built.body, signed_message: args.signed_message, signature: args.signature.trim() }),
      BUDGET_MS - (deps.now() - started), () => null,
    );
  } catch (error) {
    return refusal(apiRefusal(error, "record the expense"));
  }
  if (!res) return refusal("Owed's server didn't answer in time. Check ledger_balances before trying again: the expense may have been recorded.");

  // The stored expense must be exactly what was signed, and the whole ledger must still add up.
  const after = res.ledger;
  const stored = after.expenses[res.added];
  const check = checkLedger(after);
  const d = currencyDecimals(built.currency);
  const sameShares = !!stored && stored.shares.length === built.participants.length
    && stored.shares.every((s, i) => s.member === built.participants[i] && s.share === unitsToDecimal(built.units[s.member]!, d));
  if (after.id !== ledger.id || !stored || stored.signed_message !== args.signed_message || stored.recorded_by !== args.signer || stored.total !== total
    || stored.currency !== built.currency || stored.paid_by !== built.canonical.paidBy || !sameShares || check.problems.length > 0) {
    return refusal(`Owed's server stored something other than what was signed${check.problems.length ? ` (${check.problems[0]})` : ""}. Check ledger_balances; don't settle up until it adds up.`);
  }
  const recorded = stored.shares.map((s) => ({ member: memberLabel(after, s.member), share: s.share, usdc: s.amount }));
  const balances = check.balances.map((b, p) => balanceLine(after, b, p));
  const output: AddExpenseOutput = {
    step: "added", ledger_id: after.id, currency: built.currency, total, paid_by: payer, shares: recorded, usdc_total: stored.amount,
    ...(stored.fiat && { rate: stored.fiat.rate }), position: res.added, link: after.link, balances, caution: LEDGER_CAUTION,
  };
  const lines = [
    `Recorded in ${quote(after.title, 60)}: ${money(total, built.currency)}${what}, paid by ${quote(payer, 40)}${built.currency !== "USDC" ? ` = ${stored.amount} USDC` : ""}.`,
    ...recorded.map((s) => `- ${quote(s.member, 40)}: ${money(s.share, built.currency)}${built.currency !== "USDC" ? ` = ${s.usdc} USDC` : ""}`),
    ...(stored.fiat ? [`Rate locked ${lockedAt(stored.fiat.quoted_at)}: ${stored.fiat.rate} ${built.currency} per USDC (${stored.fiat.rate_source}), each share rounded up to 0.000001 USDC.`] : []),
    "Balances now:",
    ...balances.map((b) => `- ${b}`),
    `Ledger: ${after.link}. When the group is ready, settle_up turns the balances into payment requests.`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("add_expense", {
    title: "Add an expense to a group ledger",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    // Each signed message records one expense once.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => addExpense(args, deps));
}
