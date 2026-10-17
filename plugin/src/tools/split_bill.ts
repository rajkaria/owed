import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import bs58 from "bs58";
import * as z from "zod/v4";
import { API_TIMEOUT_MS, ApiError } from "../api.js";
import {
  addressSchema, decimalSchema, groupIdSchema, requestIdSchema, tokenSchema, type CreateGroupReq, type GroupRes,
} from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import { MAX_SPLIT, splitEvenly, USDC_MINT, type Token } from "../money.js";
import { idMatchesTerms } from "../request-id.js";
import { screenRecipient, type Screening } from "../screen.js";
import type { TransferRequest } from "../solana-pay.js";
import { checkFromDomain } from "../payee.js";
import { clean, quote, shareText } from "../text.js";
import { expiresInDaysInput, expiryLine, expiryProblem, OFFLINE_NO_EXPIRY } from "../expiry.js"; // W3-C

const MIN_PEOPLE = 2;
const LIMITS = { title: 60, name: 40, requester_name: 40 } as const;
/** PayBox gives a call 10 s; screening, the DNS check and the API call share it. */
const CALL_BUDGET_MS = 9500;

/**
 * W2-H's `checkFromDomain` (plugin/src/payee.ts): verifies over DNS that `fromDomain` publishes `recipient`.
 * Injected until verified payee merges; with none, a claimed domain is refused rather than ignored.
 */
export type CheckFromDomain = (fromDomain: string, recipient: string, deps: Deps, budgetMs?: number) => Promise<
  { ok: true; from_domain: string; lines: string[] } | { ok: false; message: string }
>;

export const inputSchema = z.object({
  recipient: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials). Every share is paid to this address."),
  total: decimalSchema.describe('What to collect from these people, in whole token units as a decimal string, e.g. "45" or "12.5". Leave out the user\'s own share.'),
  token: tokenSchema.default("USDC").describe('"USDC" (default) or "SOL".'),
  title: z.string().min(1).max(LIMITS.title).describe('What the bill is for, e.g. "Pizza night". Everyone sees it quoted.'),
  people: z.array(z.object({
    name: z.string().min(1).max(LIMITS.name).describe("First name of a person who owes a share."),
    amount: decimalSchema.optional().describe("Only if this person owes a set amount; everyone without one splits the rest evenly."),
  }).strict()).min(MIN_PEOPLE).max(MAX_SPLIT).describe("2 to 20 people who owe money, not including the user."),
  requester_name: z.string().min(1).max(LIMITS.requester_name).optional().describe("The user's own first name, so people know who is asking."),
  from_domain: z.string().min(1).max(253).optional().describe("A domain the user controls that publishes this wallet (verified payee)."),
  expires_in_days: expiresInDaysInput.optional(), // W3-C: every share expires together
}).strict();

const shareOutput = z.object({
  name: z.string(),
  amount: z.string(),
  id: requestIdSchema.nullable().describe("Owed request id of this share; null when the links were built offline. check_payments takes it."),
  link: z.string().describe("This person's own pay link."),
  solana_pay_url: z.string(),
  reference: z.string(),
  share_text: z.string().describe("A ready-to-send message for this person."),
}).strict();

export const outputSchema = z.object({
  group_id: groupIdSchema.nullable().describe("Owed group id; null when the links were built offline."),
  group_link: z.string().nullable().describe("The live board showing who has paid; null offline."),
  mode: z.enum(["hosted", "offline"]),
  title: z.string(),
  recipient: z.string(),
  total: z.string(),
  token: tokenSchema,
  shares: z.array(shareOutput).min(MIN_PEOPLE).max(MAX_SPLIT),
  remainder_note: z.string().optional().describe("Set when the total doesn't divide evenly: who pays the extra smallest unit."),
  from_domain: z.string().optional().describe("The verified payee domain every share carries (checked over DNS by the plugin)."),
  expires_at: z.string().optional().describe("When every share stops taking payments (set by Owed's server)."), // W3-C
}).strict();

export type SplitInput = z.output<typeof inputSchema>;
export type SplitOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Split a bill: creates one Owed payment request per person plus a live group board that shows who has paid. Each person gets their own link, payable from any Solana wallet or their own PayBox agent.",
  "Use it when the user says things like \"split 45 USDC for pizza between Priya, Sam and Alex\".",
  "total is what to collect from the listed people: leave the user out of people, and if the user also ate, leave their own share out of total. Give a person an amount only if they owe a set sum; the rest split evenly.",
  "recipient is the user's own PayBox Solana wallet address (from list_credentials); funds go straight from each payer to it, Owed never holds money.",
  "Show the user the board link and each person's link with its share_text so they can send them; later call check_payments with the share ids to see who has paid.",
].join(" ");

/** Group id = last 12 base58 chars of sha256 over its share ids in board order (web/lib/groups.ts computes the same). */
export function groupIdFor(terms: { recipient: string; token: Token; totalAtomic: bigint; shareIds: readonly string[] }): string {
  const asset = terms.token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256")
    .update(`owed-group:v1\n${terms.recipient}\n${asset}\n${terms.totalAtomic}\n${terms.shareIds.join("\n")}`, "utf8")
    .digest();
  return bs58.encode(digest).slice(-12);
}

export interface Plan {
  amounts: bigint[];
  /** Indexes of the people who split the rest evenly. */
  even: number[];
  /** How many of them (from the first) carry one extra atomic unit. */
  extra: number;
}

/**
 * People with a set amount keep it; everyone else splits the rest evenly with money.ts `splitEvenly`,
 * so the leftover atomic units go to the first of them. Throws an Error whose message is user-facing.
 */
export function planShares(totalAtomic: bigint, set: ReadonlyArray<bigint | undefined>, token: Token, fromAtomic: Deps["fromAtomic"]): Plan {
  const fixed = set.reduce<bigint>((sum, a) => sum + (a ?? 0n), 0n);
  const even = set.flatMap((a, i) => (a === undefined ? [i] : []));
  const rest = totalAtomic - fixed;
  const show = (atomic: bigint) => `${fromAtomic(atomic, token)} ${token}`;
  if (even.length === 0) {
    if (rest !== 0n) throw new Error(`The amounts add up to ${show(fixed)}, but the total is ${show(totalAtomic)}.`);
    return { amounts: set as bigint[], even, extra: 0 };
  }
  if (rest <= 0n) {
    throw new Error(`The set amounts already add up to ${show(fixed)} of the ${show(totalAtomic)} total, so nothing is left for the others.`);
  }
  const split = splitEvenly(rest, even.length);
  const amounts = set.map((a) => a ?? 0n);
  even.forEach((index, k) => { amounts[index] = split[k]!; });
  return { amounts, even, extra: Number(rest % BigInt(even.length)) };
}

function remainderNote(plan: Plan, names: string[], token: Token, fromAtomic: Deps["fromAtomic"]): string | undefined {
  if (plan.extra === 0) return undefined;
  const rest = plan.even.reduce((sum, i) => sum + plan.amounts[i]!, 0n);
  const who = plan.even.slice(0, plan.extra).map((i) => names[i]!);
  const list = who.length === 1 ? who[0]! : `${who.slice(0, -1).join(", ")} and ${who.at(-1)!}`;
  return `${fromAtomic(rest, token)} ${token} doesn't split evenly ${plan.even.length} ways, so ${list} ${who.length === 1 ? "pays" : "each pay"} ${fromAtomic(1n, token)} ${token} more.`;
}

export async function splitBill(
  args: SplitInput,
  deps: Deps = defaultDeps,
  screen: (addr: string) => Promise<Screening> = screenRecipient,
  checkDomain: CheckFromDomain | null = checkFromDomain,
) {
  const started = deps.now();
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const token = args.token;

  let totalAtomic: bigint;
  const set: Array<bigint | undefined> = [];
  try {
    totalAtomic = deps.toAtomic(args.total, token);
  } catch (error) {
    return refusal(`${args.total} ${token} isn't a valid total: ${errorText(error, "use a positive decimal amount.")}`);
  }
  for (const person of args.people) {
    if (person.amount === undefined) {
      set.push(undefined);
      continue;
    }
    try {
      set.push(deps.toAtomic(person.amount, token));
    } catch (error) {
      return refusal(`${person.amount} ${token} isn't a valid amount for ${clean(person.name, LIMITS.name) || "a person"}: ${errorText(error, "use a positive decimal amount.")}`);
    }
  }

  const title = clean(args.title, LIMITS.title);
  if (!title) return refusal("title needs some readable text, e.g. \"Pizza night\".");
  const names = args.people.map((p, i) => clean(p.name, LIMITS.name) || `Person ${i + 1}`);
  const requesterName = clean(args.requester_name, LIMITS.requester_name) || undefined;

  let plan: Plan;
  try {
    plan = planShares(totalAtomic, set, token, deps.fromAtomic);
  } catch (error) {
    return refusal(`Can't split ${deps.fromAtomic(totalAtomic, token)} ${token} this way: ${errorText(error, "check the amounts.")}`);
  }
  const total = deps.fromAtomic(totalAtomic, token);
  const amounts = plan.amounts.map((a) => deps.fromAtomic(a, token));

  const screening = await screen(args.recipient);
  if (!screening.ok) return refusal(screening.message);

  let fromDomain: string | undefined;
  let domainLines: string[] = [];
  if (args.from_domain !== undefined) {
    if (!checkDomain) return refusal("This Owed build can't verify from_domain yet, so it wasn't used. Split the bill without from_domain.");
    const budget = Math.max(1500, CALL_BUDGET_MS - API_TIMEOUT_MS - (deps.now() - started));
    const check = await checkDomain(args.from_domain, args.recipient, deps, budget);
    if (!check.ok) return refusal(check.message);
    fromDomain = check.from_domain;
    domainLines = check.lines;
  }

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  const body: CreateGroupReq = {
    recipient: args.recipient, total, token, title,
    people: names.map((name, i) => ({ name, amount: amounts[i]! })),
    ...(requesterName && { requester_name: requesterName }),
    source: "plugin",
    ...(fromDomain && { from_domain: fromDomain }),
    ...(args.expires_in_days !== undefined && { expires_in_days: args.expires_in_days }), // W3-C
  };

  let expiresAt: string | undefined; // W3-C
  let created: { groupId: string | null; groupLink: string | null; mode: "hosted" | "offline"; shares: Array<{ id: string | null; link: string; solana_pay_url: string; reference: string }> };
  try {
    const res = await ctx.api.createGroup(body);
    const mismatch = checkHosted(res, args.recipient, token, totalAtomic, plan.amounts, ctx, deps);
    if (mismatch) return refusal(mismatch);
    // Payers' agents only see the domain if the server stored it on the board and on every share they pay.
    if (fromDomain && (res.from_domain !== fromDomain || res.shares.some((s) => s.from_domain !== fromDomain))) {
      return refusal(`Owed's server didn't attach ${fromDomain} to every share, so the links weren't used. Try again, or split without from_domain.`);
    }
    const expiry = expiryProblem(args.expires_in_days, res.expires_at, deps.now()); // W3-C
    if (expiry) return refusal(expiry);
    if (args.expires_in_days !== undefined) expiresAt = res.expires_at;
    created = {
      groupId: res.id, groupLink: res.link, mode: "hosted",
      shares: res.shares.map((s) => ({ id: s.id, link: s.link, solana_pay_url: s.solana_pay_url, reference: s.reference })),
    };
  } catch (error) {
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't create the split."));
    if (error.code !== "upstream_unavailable") return refusal(apiRefusal(error));
    try {
      created = { groupId: null, groupLink: null, mode: "offline", shares: amounts.map((amount) => buildOffline(args.recipient, amount, token, title, requesterName, ctx, deps)) };
    } catch (offlineError) {
      return refusal(`Owed's server is unreachable and the offline links couldn't be built: ${errorText(offlineError, "unknown error")}`);
    }
  }

  const shares = created.shares.map((s, i) => ({
    name: names[i]!, amount: amounts[i]!, ...s,
    share_text: shareText({ payerName: names[i], requesterName, forText: title, amount: amounts[i]!, token, link: s.link }),
  }));
  const note = remainderNote(plan, names, token, deps.fromAtomic);
  const output: SplitOutput = {
    group_id: created.groupId, group_link: created.groupLink, mode: created.mode,
    title, recipient: args.recipient, total, token, shares,
    ...(note && { remainder_note: note }),
    ...(fromDomain && created.mode === "hosted" && { from_domain: fromDomain }),
    ...(expiresAt && { expires_at: expiresAt }), // W3-C
  };

  const lines = [
    created.groupLink
      ? `Split ready: ${quote(title, LIMITS.title)}, ${total} ${token} from ${shares.length} people. Live board: ${created.groupLink}`
      : `Split ready: ${quote(title, LIMITS.title)}, ${total} ${token} from ${shares.length} people.`,
    ...shares.map((s) => `- ${s.name}: ${s.amount} ${token} ${s.link}`),
  ];
  if (note) lines.push(note);
  if (created.mode === "hosted") lines.push(...domainLines);
  if (expiresAt && args.expires_in_days !== undefined) lines.push(expiryLine(expiresAt, args.expires_in_days, "every share")); // W3-C
  if (created.mode === "offline" && args.expires_in_days !== undefined) lines.push(OFFLINE_NO_EXPIRY.replace("this one stays", "these stay"));
  lines.push("Send each person their own link (each share has a ready share_text). check_payments takes the share ids or links to see who has paid.");
  if (created.mode === "offline") {
    lines.push("Owed's server didn't answer, so these are self-contained links with no short ids and no board. Each works with any Solana wallet, and check_payments can verify them with the same links.");
    if (fromDomain) lines.push(`These offline links can't carry the verified domain ${fromDomain}, so a payer's agent will see them as unverified.`);
  }
  if (screening.screening === "unavailable") lines.push("Recipient screening was unavailable, so this address wasn't screened.");
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

/**
 * The server builds what each person pays; refuse to hand out a split whose links pay anyone or anything else.
 * Every share id must hash its terms (so a payer's pay_link accepts it) and the group id must hash the share ids.
 */
function checkHosted(
  res: GroupRes, recipient: string, token: Token, totalAtomic: bigint, amounts: bigint[], ctx: CallContext, deps: Deps,
): string | null {
  const bad = "Owed's server returned a split that doesn't match this bill, so it wasn't used. Nothing was sent; try again.";
  try {
    const page = new URL(res.link);
    if (page.protocol !== "https:" || !page.pathname.endsWith(`/g/${res.id}`)) return bad;
    if (res.recipient !== recipient || res.token !== token || deps.toAtomic(res.total, token) !== totalAtomic) return bad;
    if (res.shares.length !== amounts.length) return bad;
    const expectedMint = token === "USDC" ? USDC_MINT : undefined;
    for (const [i, share] of res.shares.entries()) {
      const link = new URL(share.link);
      if (link.protocol !== "https:" || !link.pathname.endsWith(`/r/${share.id}`)) return bad;
      const parsed = deps.parseLink(share.solana_pay_url, ctx.hosts);
      if (parsed.kind !== "transfer") return bad;
      const r = parsed.request;
      if (r.recipient !== recipient || r.splToken !== expectedMint || !r.references.includes(share.reference)) return bad;
      if (r.amount === undefined || deps.toAtomic(r.amount, token) !== amounts[i] || deps.toAtomic(share.amount, token) !== amounts[i]) return bad;
      if (!idMatchesTerms(share.id, { recipient, token, amountAtomic: amounts[i]!, reference: share.reference })) return bad;
    }
    if (groupIdFor({ recipient, token, totalAtomic, shareIds: res.shares.map((s) => s.id) }) !== res.id) return bad;
    return null;
  } catch {
    return bad;
  }
}

function buildOffline(recipient: string, amount: string, token: Token, title: string, requesterName: string | undefined, ctx: CallContext, deps: Deps) {
  const reference = deps.newReference();
  const request: TransferRequest = {
    recipient, amount, references: [reference], message: title,
    ...(token === "USDC" && { splToken: USDC_MINT }),
    ...(requesterName && { label: requesterName }),
  };
  const solana_pay_url = deps.buildTransferUrl(request);
  return { id: null, link: `${ctx.base}/p?u=${encodeURIComponent(solana_pay_url)}`, solana_pay_url, reference };
}

function apiRefusal(error: ApiError): string {
  switch (error.code) {
    case "rate_limited": return "Owed is limiting new requests for this wallet right now (every share counts as one). Try again in a few minutes.";
    case "blocked": return `Owed can't create requests for this recipient. ${error.message}`;
    case "invalid_input": return `Owed rejected the split: ${error.message}`;
    default: return `Owed couldn't create the split: ${error.message}`;
  }
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("split_bill", {
    title: "Split a bill",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => splitBill(args, deps));
}
