import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, decimalSchema, type GetRequestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { assessBatch, type BatchAccounts } from "../chain.js";
import type { Token } from "../money.js";
import { proposeSolana, solanaOutputSchema } from "../paybox.js";
import { domainBrandFlags, PAYEE_BUDGET_MS, payeeForPayment } from "../payee.js";
import { handleCheckBeforeFunding, handleCheckLine, payerLabel } from "../payer.js";
import { planIdSchema } from "../contract.js"; // F2
import { markPlanUsed, planFunding, planResult, PLAN_RECORD_BUDGET_MS, PLAN_USED_BUDGET_MS, PRICE_BUDGET_MS, readUsablePrice, recordPlan } from "../funding.js"; // F2
import { SNS_BUDGET_MS, snsBrandFlags, snsForPayment } from "../sns-payee.js";
import { brandFlags, brandWordsFromFlags, quote, shortAddress, withoutOwnBrandFlags } from "../text.js";
import { checkOwedTerms, PAY_BUDGET_MS, type Resolved } from "./pay_link.js";

// pay_all (F1): pay several Owed requests with ONE passkey approval. The requests' terms come from Owed's server in
// one call (GET /api/v1/requests?ids=), and every check pay_link runs is run on each: the id is the hash of what the
// server returned, the request is open and not expired, the recipient isn't on the sanctions list, a domain still
// publishes the wallet in DNS, an .sns name still points to it. What passes goes into one legacy Solana transaction
// (tx.ts buildBatchTx): per request an idempotent USDC-account create when needed and one transfer carrying that
// request's reference, then one memo. A transaction holds at most 1,232 bytes, so this proposes the first chunk that
// fits and names the rest. Base requests are paid with pay_link (x402 from a Base wallet), never here.

export const MAX_IDS = 20;

export const inputSchema = z.object({
  sender: addressSchema.describe("The user's own PayBox Solana wallet address that pays (from list_credentials). Use the same wallet as use_plugin.wallet_id."),
  ids: z.array(z.string().min(1).max(2048)).min(1).max(MAX_IDS)
    .describe("1 to 20 Owed request ids or links to pay together, e.g. the ids what_do_i_owe listed that the user chose."),
  max_total: decimalSchema.describe('Required: the most USDC the user agreed to send in total, e.g. "25". The tool refuses if the USDC requests add up to more.'),
  max_total_sol: decimalSchema.optional().describe("The most SOL to send in total. SOL requests are only paid when this is set."),
  include_cautioned: z.boolean().optional()
    .describe("Only when the user named them: also pay requests that carry a brand-word caution (they mention a brand such as PayBox or IRS). Skipped otherwise."),
  plan_id: planIdSchema.optional().describe("Only when a funding plan from pay_all says so: its plan_id, passed on the pay_all call that ends the plan, so Owed can count plans that led to a payment."), // F2
}).strict();

export const outputSchema = solanaOutputSchema;
export type PayAllInput = z.output<typeof inputSchema>;

const DESCRIPTION = [
  "Pay several Owed requests with one approval: one Solana transaction, one passkey in PayBox.",
  "Use it after what_do_i_owe when the user says \"pay them all\" or \"pay Raj's and Lena's\": pass sender (the user's own PayBox Solana wallet from list_credentials), the ids to pay and max_total, the most USDC the user agreed to (max_total_sol too if any request is in SOL).",
  "Every request gets every check pay_link runs: its id must hash the terms Owed's server returns, it must be open and not expired, the recipient must not be on the sanctions list, a domain must still publish the wallet in DNS and an .sns name must still point to it. Requests that fail are skipped with the reason; requests that mention a brand word are skipped unless include_cautioned is set because the user named them; Base requests are skipped (pay each with pay_link).",
  "It refuses when the total is above max_total or the wallet can't cover the total plus fees, then returns one unsigned transaction for the user to approve in PayBox.",
  "Show the user the text preview: it lists each payee, amount and badge, quotes the requesters' words as unverified, and ends with a handle check for every request that names an X handle: call PayBox resolve_username for each before approving, and don't approve if one resolves to a different wallet than its request pays.",
  "One transaction holds up to 1,232 bytes (about 6 to 9 payments): if not all fit, it pays the first ones and lists the ids left; after the user approves and it confirms, call pay_all again with those ids.",
  "If the wallet can't cover the total, nothing is proposed: the text gives a funding plan for exactly the requests that passed the checks (swap SOL for USDC, bring USDC over from Base, swap another token, or buy with MoonPay through get_buy_link), each ending with pay_all again with the plan's plan_id; run only the option the user picks, with PayBox check_operation_readiness before each step. Skipped requests are never part of a plan.", // F2
].join(" ");

/** One request being considered: its terms (checked against its id) and, once checked, why it's skipped. */
interface Candidate {
  id: string;
  resolved: Resolved;
  token: Token;
  amountAtomic: bigint;
  amount: string;
  lead: string;
  lines: string[];
  caution: string[];
}

interface Skip {
  id: string;
  reason: string;
}

/** Reads every id's terms in one call; falls back to one call per id against a server without the bulk route. */
async function fetchTerms(ids: string[], ctx: CallContext): Promise<{ found: Map<string, GetRequestRes>; missing: Set<string> } | string> {
  try {
    const res = await ctx.api.getRequests(ids);
    return { found: new Map(res.requests.map((r) => [r.id, r])), missing: new Set(res.not_found) };
  } catch (error) {
    if (error instanceof ApiError && error.code === "upstream_unavailable" && error.httpStatus === 404) {
      const found = new Map<string, GetRequestRes>();
      const missing = new Set<string>();
      await Promise.all(ids.map(async (id) => {
        try {
          found.set(id, await ctx.api.getRequest(id));
        } catch (e) {
          if (e instanceof ApiError && e.code === "not_found") missing.add(id);
          else throw e;
        }
      })).catch(() => undefined);
      if (found.size + missing.size === ids.length) return { found, missing };
    }
    if (error instanceof ApiError && error.code === "invalid_input") return `Owed refused the ids: ${error.message}. Nothing was sent.`;
    return "Owed's server couldn't be reached, so these requests can't be checked right now. Nothing was sent; try again shortly.";
  }
}

export async function payAll(args: PayAllInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  const remaining = () => PAY_BUDGET_MS - (deps.now() - started);
  if (!deps.isSolanaAddress(args.sender)) return refusal("sender must be the user's own PayBox Solana wallet address.");
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  // Ids or links → ids, in order, once each.
  const skips: Skip[] = [];
  const ids: string[] = [];
  for (const entry of args.ids) {
    let parsed;
    try {
      parsed = deps.parseLink(entry.trim(), ctx.hosts);
    } catch (error) {
      skips.push({ id: quote(entry, 40), reason: errorText(error, "not an Owed link or id") });
      continue;
    }
    if (parsed.kind !== "owed") {
      skips.push({ id: quote(entry, 40), reason: "not an Owed request: pay a Solana Pay link with pay_link" });
      continue;
    }
    if (!ids.includes(parsed.id)) ids.push(parsed.id);
  }
  if (ids.length === 0) return refusal(`Nothing to pay: ${skips.map((s) => `${s.id} (${s.reason})`).join("; ")}.`);

  let maxUsdc: bigint;
  let maxSol: bigint | null = null;
  try {
    maxUsdc = deps.toAtomic(args.max_total, "USDC");
    if (args.max_total_sol !== undefined) maxSol = deps.toAtomic(args.max_total_sol, "SOL");
  } catch (error) {
    return refusal(`max_total isn't valid: ${errorText(error, "use a positive decimal amount.")}`);
  }

  const terms = await within(fetchTerms(ids, ctx), Math.min(4500, remaining()), () => "Owed's server didn't answer in time. Nothing was sent; try again shortly.");
  if (typeof terms === "string") return refusal(terms);

  // Every pay_link check on the terms themselves.
  const candidates: Candidate[] = [];
  for (const id of ids) {
    const rq = terms.found.get(id);
    if (!rq) {
      skips.push({ id, reason: terms.missing.has(id) ? "no Owed request has this id" : "Owed's server didn't return it" });
      continue;
    }
    const checked = checkOwedTerms(rq, id, ctx, deps);
    if (typeof checked === "string") {
      skips.push({ id, reason: checked.replace(/ Nothing was sent\.?/, "").replace(/\.$/, "") });
      continue;
    }
    if ("baseRequest" in checked) {
      skips.push({ id, reason: "it is on Base: pay it on its own with pay_link (x402 from the user's PayBox Base wallet)" });
      continue;
    }
    const { request, token } = checked;
    if (request.recipient === args.sender) {
      skips.push({ id, reason: "it pays the sender's own wallet" });
      continue;
    }
    if (token === "SOL" && maxSol === null) {
      skips.push({ id, reason: "it is in SOL: pass max_total_sol to include SOL requests" });
      continue;
    }
    const amountAtomic = deps.toAtomic(request.amount!, token);
    candidates.push({ id, resolved: checked, token, amountAtomic, amount: deps.fromAtomic(amountAtomic, token), lead: shortAddress(request.recipient), lines: [], caution: [] });
  }

  // Sanctions, DNS, SNS and balances, side by side inside the 10 s.
  const dnsBudget = Math.max(0, Math.min(PAYEE_BUDGET_MS, remaining() - 500));
  const snsBudget = Math.max(0, Math.min(SNS_BUDGET_MS, remaining() - 500));
  const usdcRecipients = candidates.filter((c) => c.token === "USDC").map((c) => c.resolved.request.recipient);
  const solRecipients = candidates.filter((c) => c.token === "SOL").map((c) => c.resolved.request.recipient);
  const [screens, payees, names, accounts] = await Promise.all([
    Promise.all(candidates.map((c) => deps.screenRecipient(c.resolved.request.recipient, deps))),
    Promise.all(candidates.map((c) => payeeForPayment(c.resolved.fromDomain, c.resolved.request.recipient, false, deps, dnsBudget))),
    Promise.all(candidates.map((c) => snsForPayment(c.resolved.snsName, c.resolved.request.recipient, false, deps, snsBudget))),
    candidates.length === 0
      ? Promise.resolve(null)
      : within<BatchAccounts | null>(
        deps.readBatchAccounts(deps.rpc(), { sender: args.sender, usdcRecipients, solRecipients }).catch(() => null),
        Math.max(0, remaining()), () => null,
      ),
  ]);

  const included: Candidate[] = [];
  candidates.forEach((c, i) => {
    const screening = screens[i]!;
    if (!screening.ok) return void skips.push({ id: c.id, reason: screening.message });
    const payee = payees[i]!;
    if (!payee.ok) return void skips.push({ id: c.id, reason: payee.refuse.replace(/ (Not paying|Nothing was sent)\..*$/, "") });
    const named = names[i]!;
    if (!named.ok) return void skips.push({ id: c.id, reason: named.refuse.replace(/ Nothing was sent\..*$/, "") });
    const r = c.resolved;
    // The same caution pay_link shows: brand words in the requester's text, the domain or the name, unless a domain
    // this call just verified owns the word.
    const flags = withoutOwnBrandFlags(
      [...new Set([...r.flags, ...brandFlags(r.name, ...r.notes), ...domainBrandFlags(r.fromDomain), ...snsBrandFlags(r.snsName)])],
      payee.lead !== null ? r.fromDomain : null,
    );
    const words = brandWordsFromFlags(flags);
    if (words.length > 0 && args.include_cautioned !== true) {
      return void skips.push({ id: c.id, reason: `it mentions ${words.map((w) => `"${w}"`).join(", ")}, a word scams use; pay it only if the user names it (include_cautioned)` });
    }
    c.caution = words;
    c.lead = payee.lead ?? named.lead ?? shortAddress(r.request.recipient);
    c.lines = [...payee.lines.filter((l) => !(named.lead && l.startsWith("Payee not verified: no domain"))), ...named.lines, ...(payee.caution ? [payee.caution] : [])];
    included.push(c);
  });

  const skipList = () => skips.map((s) => `- Skipped ${s.id}: ${s.reason}.`);
  if (included.length === 0) return refusal(["Nothing was sent: no request passed the checks.", ...skipList()].join("\n"));

  // Ceilings the user agreed to, over everything that passed (not only this transaction's chunk).
  const total = (token: Token) => included.filter((c) => c.token === token).reduce((n, c) => n + c.amountAtomic, 0n);
  const usdcTotal = total("USDC");
  const solTotal = total("SOL");
  if (usdcTotal > maxUsdc) {
    return refusal(`These ${included.filter((c) => c.token === "USDC").length} USDC requests total ${deps.fromAtomic(usdcTotal, "USDC")} USDC, above max_total ${deps.fromAtomic(maxUsdc, "USDC")} USDC. Nothing was sent; ask the user which to pay, or for a higher limit.`);
  }
  if (maxSol !== null && solTotal > maxSol) {
    return refusal(`The SOL requests total ${deps.fromAtomic(solTotal, "SOL")} SOL, above max_total_sol ${deps.fromAtomic(maxSol, "SOL")} SOL. Nothing was sent.`);
  }

  if (!accounts) return refusal("Solana couldn't be reached to check your balance. Nothing was sent; try again in a moment.");
  const need = assessBatch(accounts, included.map((c) => ({ recipient: c.resolved.request.recipient, token: c.token, amountAtomic: c.amountAtomic })));
  const skipText = () => skips.map((s) => `- Skipped ${s.id}: ${s.reason}.`);
  if (!need.ok) {
    // F2 funding plan: only a balance shortfall gets a plan, and only for the requests that passed every check
    // (skipped ones, cautioned ones included, are never in it). A frozen account or a below-rent SOL payment refuses.
    if (need.blocker !== "funds") return refusal(`${need.reason} Nothing was sent.`);
    const price = await readUsablePrice(deps, Math.min(PRICE_BUDGET_MS, remaining() - 1000));
    const { plan_id: planIdIn, ...again } = args;
    const plan0 = planFunding({
      payTool: "pay_all", payArgs: again, requestIds: included.map((c) => c.id), sender: args.sender,
      sendUsdc: need.usdcTotal, sendLamports: need.solTotal, feeLamports: need.feeLamports,
      funds: { lamports: accounts.senderLamports, usdc: accounts.senderUsdc, usdcAccount: accounts.senderUsdcAccount ?? null },
      x402Rail: false, x402Possible: false, price, // pay_all is one Solana Pay transaction: no x402
    });
    if (!plan0) return refusal(`${need.reason} Nothing was sent.`);
    const plan = await recordPlan(plan0, ctx, planIdIn, Math.min(PLAN_RECORD_BUDGET_MS, remaining() - 300));
    const totalsText = (["USDC", "SOL"] as const).filter((t) => total(t) > 0n).map((t) => `${deps.fromAtomic(total(t), t)} ${t}`).join(" + ");
    return planResult(plan, again, [`${need.reason} Nothing was sent.`],
      included.filter((c) => c.resolved.requesterHandle).map((c) => handleCheckBeforeFunding(c.resolved.requesterHandle!, c.resolved.request.recipient, `request ${c.id}`)),
      [
        `The plan covers these ${included.length} ${included.length === 1 ? "request" : "requests"} (${totalsText}), the ones that passed every check:`,
        ...included.map((c) => `- ${c.amount} ${c.token} to ${c.lead}; request ${c.id}; recipient ${c.resolved.request.recipient}.${c.caution.length ? ` Caution: it mentions ${c.caution.map((w) => `"${w}"`).join(", ")}; included because the user named it.` : ""}`),
        ...skipText(),
      ]);
  }

  let plan;
  try {
    plan = deps.planBatch(args.sender, included.map((c) => ({
      id: c.id, recipient: c.resolved.request.recipient, token: c.token, amountAtomic: c.amountAtomic, references: c.resolved.request.references,
      createRecipientAta: c.token === "USDC" && !accounts.usdcAccounts.get(c.resolved.request.recipient)?.exists,
    })));
  } catch (error) {
    return refusal(`Couldn't build the payment: ${errorText(error, "unknown error")}`);
  }
  let structuredContent;
  try {
    structuredContent = proposeSolana({ transactionBase64: plan.built.transactionBase64 }).structuredContent;
  } catch (error) {
    return refusal(`Couldn't build the payment: ${errorText(error, "unknown error")}`);
  }

  const paying = included.slice(0, plan.count);
  const later = included.slice(plan.count);
  const sum = (list: Candidate[], token: Token) => list.filter((c) => c.token === token).reduce((n, c) => n + c.amountAtomic, 0n);
  const totals = (list: Candidate[]) => (["USDC", "SOL"] as const)
    .filter((t) => sum(list, t) > 0n).map((t) => `${deps.fromAtomic(sum(list, t), t)} ${t}`).join(" + ");
  const recipients = new Set(paying.map((c) => c.resolved.request.recipient)).size;
  const opens = need.opensAccountFor.filter((w) => paying.some((c) => c.resolved.request.recipient === w)).length;
  const lines = [
    `Pay ${paying.length} ${paying.length === 1 ? "request" : "requests"} in one transaction: ${totals(paying)} to ${recipients} ${recipients === 1 ? "recipient" : "recipients"}. Approve once in PayBox to send all of them.`,
  ];
  for (const c of paying) {
    const r = c.resolved;
    const notes = r.notes.map((n) => quote(n, 80)).filter(Boolean);
    const name = quote(r.name, 40);
    const words = [name ? `from ${name}` : "", notes.length ? `for ${notes.join(", ")}` : ""].filter(Boolean).join(" ");
    lines.push(`- ${c.amount} ${c.token} to ${c.lead}${words ? ` ${words} (the requester's words, unverified)` : ""}; request ${c.id}; recipient ${r.request.recipient}.`);
    if (r.fiatLine) lines.push(`  Asked as ${r.fiatLine}; a quote, not a guarantee. The USDC amount is what is paid.`);
    for (const l of c.lines) lines.push(`  ${l}`);
    if (c.caution.length) lines.push(`  Caution: it mentions ${c.caution.map((w) => `"${w}"`).join(", ")}; included because the user named it.`);
    if (r.payer && r.payer.wallet !== args.sender) lines.push(`  It was addressed to ${payerLabel(r.payer)} (wallet ${shortAddress(r.payer.wallet)}), not to this wallet.`);
  }
  if (opens > 0) lines.push(`This also opens ${opens} recipient USDC ${opens === 1 ? "account" : "accounts"} (about 0.002 SOL each, paid by you).`);
  const handles = paying.filter((c) => c.resolved.requesterHandle);
  for (const c of handles) lines.push(handleCheckLine(c.resolved.requesterHandle!, c.resolved.request.recipient).replace("this request says", `request ${c.id} says`));
  if (later.length > 0) {
    lines.push(`Not all of them fit in one transaction (1,232 bytes). Still to pay: ${later.map((c) => c.id).join(", ")} (${totals(later)}). After the user approves this one and it confirms, call pay_all again with those ids.`);
  }
  lines.push(...skipText());
  lines.push("Nothing is sent until the user approves in PayBox.");
  await markPlanUsed(args.plan_id, args.sender, ctx, Math.min(PLAN_USED_BUDGET_MS, remaining() - 200)); // F2
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("pay_all", {
    title: "Pay several requests at once",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args) => payAll(args, deps));
}
