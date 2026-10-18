import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { API_TIMEOUT_MS, ApiError } from "../api.js";
import { addressSchema, type GroupLedgerRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import { LEDGER_CAUTION, ledgerMemberOutput, membersOut, walletLine } from "../ledger.js";
import { LEDGER_LIMITS } from "../ledger-math.js";
import { payerInput, payerLabel, resolvePayer, type PayerResolution } from "../payer.js";
import { SNS_BUDGET_MS } from "../sns-payee.js";
import { clean, quote, rateLimitedText } from "../text.js";

// start_ledger (F6): a group ledger, the running tab for a trip or a house. The user is the owner and member 0; the
// others may carry an F1 payer identity, so they can be paid what they're owed and find their settle-up request in
// their own agent's inbox. Nothing is owed and nothing lands anywhere until expenses are recorded and someone settles up.

const CALL_BUDGET_MS = 9500;

export const inputSchema = z.object({
  owner: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials). The user is the ledger's first member and is paid here."),
  owner_name: z.string().min(1).max(LEDGER_LIMITS.name).describe("The user's own first name, as the others will see it in the ledger."),
  title: z.string().min(1).max(LEDGER_LIMITS.title).describe('What the ledger is for, e.g. "Lisbon trip" or "Flat 4B bills". Everyone sees it quoted.'),
  members: z.array(z.object({
    name: z.string().min(1).max(LEDGER_LIMITS.name).describe("First name, as the user calls them. add_expense names members by these names."),
    payer: payerInput.optional(), // F1: {handle, wallet} after resolve_username, {sns} or {wallet}
  }).strict()).min(1).max(LEDGER_LIMITS.members - 1).describe("Everyone else in the ledger (1 to 19 people), not including the user."),
}).strict();

export const outputSchema = z.object({
  ledger_id: z.string().describe("Pass it to add_expense, ledger_balances and settle_up."),
  link: z.string().describe("The ledger's page: members, expenses, balances and settle-up requests, live."),
  title: z.string(),
  owner: z.string(),
  members: z.array(ledgerMemberOutput),
  caution: z.string(),
}).strict();

export type StartLedgerInput = z.output<typeof inputSchema>;
export type StartLedgerOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Start a group ledger for a trip, a house or any shared costs: a running tab of who paid what, split however the group agreed, that settle_up later turns into the fewest Owed payment requests.",
  "Use it when the user says things like \"start a tab for our Lisbon trip with Priya, Sam and Alex\" or \"track the flat's bills\".",
  "owner is the user's own PayBox Solana wallet (from list_credentials) and owner_name the user's own first name: the user is the first member. List everyone else in members.",
  "Give a member a payer so they can be paid what they're owed and find their settle-up request in their own agent's inbox (what_do_i_owe): for an X handle, call PayBox resolve_username first, tell the user which wallet it resolved to, and pass {handle, wallet}; or pass {sns} or {wallet}. A member without a wallet can still owe (they get a plain pay link) but can't be paid through Owed.",
  "Show the user the ledger link. Nothing is owed and nothing is sent until expenses are added (add_expense) and someone settles up (settle_up).",
].join(" ");

export async function startLedger(args: StartLedgerInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  if (!deps.isSolanaAddress(args.owner)) return refusal("owner must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const title = clean(args.title, LEDGER_LIMITS.title);
  if (!title) return refusal('title needs some readable text, e.g. "Lisbon trip".');
  const ownerName = clean(args.owner_name, LEDGER_LIMITS.name);
  if (!ownerName) return refusal("owner_name needs some readable text: the user's own first name.");
  const names = args.members.map((m, i) => clean(m.name, LEDGER_LIMITS.name) || `Person ${i + 2}`);
  const seen = new Set<string>();
  for (const name of [ownerName, ...names]) {
    const key = name.toLowerCase();
    if (seen.has(key)) return refusal(`Two members are called ${quote(name, 40)}. Give each a different name (add an initial), so expenses can name them.`);
    seen.add(key);
  }

  const budget = Math.max(1500, CALL_BUDGET_MS - API_TIMEOUT_MS - (deps.now() - started));
  const [ownerScreen, payerResults] = await Promise.all([
    deps.screenRecipient(args.owner, deps),
    Promise.all(args.members.map((m, i): Promise<PayerResolution | null> =>
      (m.payer ? resolvePayer(m.payer, args.owner, deps, Math.min(SNS_BUDGET_MS, budget), names[i]) : Promise.resolve(null)))),
  ]);
  if (!ownerScreen.ok) return refusal(ownerScreen.message);
  const refused = payerResults.find((r) => r && !r.ok);
  if (refused && !refused.ok) return refusal(refused.message);
  const payers = payerResults.map((r) => (r?.ok ? r : null));
  const wallets = new Set<string>();
  for (const [i, p] of payers.entries()) {
    if (!p) continue;
    if (wallets.has(p.payer.wallet)) return refusal(`${quote(names[i], 40)} has the same wallet as another member. Each member needs their own wallet. Nothing was created.`);
    wallets.add(p.payer.wallet);
  }
  const screens = await Promise.all(payers.map((p) => (p ? deps.screenRecipient(p.payer.wallet, deps) : Promise.resolve(null))));
  const blocked = screens.find((s) => s && !s.ok);
  if (blocked && !blocked.ok) return refusal(blocked.message);

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  let res: GroupLedgerRes;
  try {
    res = await ctx.api.createLedger({
      title, owner: args.owner, owner_name: ownerName,
      members: names.map((name, i) => ({ name, ...(payers[i] && { payer: payers[i]!.body }) })),
      source: "plugin",
    });
  } catch (error) {
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't start the ledger."));
    if (error.code === "rate_limited") return refusal(rateLimitedText(error.message));
    if (error.code === "invalid_input" || error.code === "blocked") return refusal(`Owed refused the ledger: ${error.message}`);
    if (error.httpStatus === 404) return refusal("This Owed server doesn't have group ledgers yet. Nothing was created.");
    return refusal(`Owed couldn't start the ledger: ${error.message} Nothing was created; try again shortly.`);
  }

  // The server must hold exactly these members: the owner first, then each with the wallet resolved here.
  const expected = [{ wallet: args.owner, handle: null, sns: null }, ...payers.map((p) => p?.payer ?? { wallet: null, handle: null, sns: null })];
  const sameMembers = res.members.length === expected.length && res.members.every((m, i) =>
    m.position === i && m.wallet === expected[i]!.wallet && (m.handle ?? null) === expected[i]!.handle && (m.sns ?? null) === expected[i]!.sns);
  let page: URL | null = null;
  try {
    page = new URL(res.link);
  } catch {
    page = null;
  }
  if (!sameMembers || res.owner !== args.owner || res.version !== 0 || res.expenses.length !== 0 || !page || page.protocol !== "https:" || !page.pathname.endsWith(`/l/${res.id}`)) {
    return refusal("Owed's server returned a ledger that doesn't match what was asked, so it wasn't used. Try again.");
  }

  const members = membersOut(res);
  const lines = [
    `Ledger ready: ${quote(title, LEDGER_LIMITS.title)} with ${members.length} people. Page: ${res.link}`,
    ...members.map((m) => `- ${quote(m.name, 40)}${m.position === 0 ? " (the user, owner)" : ""}${m.wallet ? `: ${payerLabel({ wallet: m.wallet, handle: m.handle, sns: m.sns })}` : ": no wallet yet"}`),
  ];
  const noWallet = walletLine(res);
  if (noWallet) lines.push(noWallet);
  if (payers.some((p) => p?.payer.handle)) lines.push("Handles are labels: Owed doesn't verify them; the wallets are what PayBox resolved.");
  lines.push(`Ledger id ${res.id}. Add expenses with add_expense (each needs one signature from the user's wallet, or from a member's own wallet), see balances with ledger_balances, and settle with settle_up.`);
  const output: StartLedgerOutput = { ledger_id: res.id, link: res.link, title, owner: res.owner, members, caution: LEDGER_CAUTION };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("start_ledger", {
    title: "Start a group ledger",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => startLedger(args, deps));
}
