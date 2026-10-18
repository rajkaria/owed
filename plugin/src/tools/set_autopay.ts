import type { McpServer } from "@modelcontextprotocol/server";
import { PublicKey } from "@solana/web3.js";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { addressSchema, autopayRuleIdSchema, decimalSchema, isoDateSchema, type AutopayRule } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import {
  autopayMessage, autopayPrefix, AUTOPAY_MESSAGE_VALID_MS, endsAfterMonths, endsProblem, freshSignatureProblem, isoSecond, limitProblem,
  revokeMessage, signedAtOf, type RuleTerms,
} from "../autopay.js";
import { handleInput, normalizeHandle } from "../payer.js";
import { looksLikeSnsName } from "../sns.js";
import { resolveName, SNS_BUDGET_MS } from "../sns-payee.js";
import { rateLimitedText, shortAddress } from "../text.js";

// set_autopay (F5): the payer's standing rule, "pay @landlord's monthly request up to 1,500 USDC". Two calls, like
// who_owes_me and what_do_i_owe. Without a signature: the exact message to sign, and the request_wallet_sign call. The
// agent signs it with PayBox request_wallet_sign {op:"solanaMessage"} (the user approves; no money moves), then calls
// again with the message and the signature, and Owed's server stores the rule (once, within 5 minutes). revoke ends a
// rule the same way.
//
// The rule is data. Owed never pays anything: what_do_i_owe marks the open requests it covers as eligible and hands the
// agent the exact PayBox pay_x402 call, which PayBox runs inside the user's own grant and limits; if PayBox asks for
// approval, that is one tap a month. A rule matches the requester's WALLET only: an X handle comes with the wallet PayBox
// resolve_username returned for it, an .sns name is resolved on Solana here (and again by the server), and both are
// stored as labels.

export const AUTOPAY_BUDGET_MS = 8500;
const API_TIMEOUT_MS = 6000;

export const ONE_TAP_COPY =
  "Owed never pays anything itself. When the user's agent reads the inbox (what_do_i_owe), each open request from this wallet within the rule is marked eligible, with the exact PayBox pay_x402 call. The agent may pay it only inside the user's PayBox limits; if PayBox asks for approval, it's one tap a month. Requests above the rule are never paid automatically.";

export const inputSchema = z.object({
  payer: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials): the wallet that pays and signs the rule."),
  requester: z.object({
    wallet: addressSchema.optional().describe("The requester's Solana wallet: the wallet their requests pay (an inbox line's recipient, or what resolve_username returned for their handle)."),
    handle: handleInput.optional().describe('Their X handle, e.g. "@landlord". Only with wallet: the Solana address PayBox resolve_username returned for it.'),
    sns: z.string().min(1).max(140).optional().describe('Their SNS name, e.g. "landlord.sns": Owed resolves it on Solana.'),
  }).strict().optional().describe("Whose requests the rule pays. If the user names an X handle, call PayBox resolve_username first, tell the user which wallet it resolved to, and pass {handle, wallet}; or pass {sns} or {wallet}. The rule matches that wallet only."),
  max_per_request: decimalSchema.optional().describe('The most one request may ask, in USDC, e.g. "1500".'),
  max_per_month: decimalSchema.optional().describe("The most all of this requester's requests may add up to per calendar month (UTC), in USDC. Default: max_per_request."),
  ends: isoDateSchema.optional().describe("The rule's last day, YYYY-MM-DD, at most a year away. Or pass months."),
  months: z.number().int().min(1).max(12).optional().describe("How many months the rule lasts from today (1 to 12), instead of ends."),
  revoke: autopayRuleIdSchema.optional().describe("End this rule (its id from set_autopay or what_do_i_owe's autopay_rules) instead of making one. Pass it on both calls."),
  signed_message: z.string().min(1).max(300).optional().describe("Second call only: the exact message_to_sign from the first call."),
  signature: z.string().min(64).max(200).optional()
    .describe("Second call only: the signature request_wallet_sign returned for that message (hex as PayBox returns it; base58 or base64 also work)."),
}).strict();

const requesterOutput = z.object({
  wallet: z.string(),
  handle: z.string().nullable().describe("A label: the X handle PayBox resolved to the wallet; Owed doesn't verify handles."),
  sns: z.string().nullable().describe("A label: the SNS name that pointed to the wallet when the rule was made."),
}).strict();

const ruleOutput = z.object({
  id: z.string(),
  requester: requesterOutput,
  token: z.literal("USDC"),
  max_per_request: z.string(),
  max_per_month: z.string(),
  ends: z.string().describe("The rule's last day (UTC)."),
  status: z.enum(["active", "ended", "revoked"]),
  month: z.string().describe("The UTC month used_this_month counts, YYYY-MM."),
  used_this_month: z.string().describe("Paid to this requester this month since the rule was made, in USDC."),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
}).strict();

export const outputSchema = z.object({
  step: z.enum(["sign", "saved", "revoked"]).describe("sign = sign message_to_sign and call again; saved / revoked = done."),
  mode: z.enum(["create", "revoke"]),
  payer: z.string(),
  message_to_sign: z.string().optional(),
  expires_at: z.string().optional(),
  sign_call: z.object({
    tool: z.literal("request_wallet_sign"),
    credential_of: z.string().describe("Use the credential_id of this wallet (from list_credentials)."),
    args: z.object({ intent: z.object({ op: z.literal("solanaMessage"), address: z.string(), message: z.string() }).strict() }).strict(),
  }).strict().optional().describe("The exact PayBox call that signs message_to_sign."),
  draft: z.object({ requester: requesterOutput, max_per_request: z.string(), max_per_month: z.string(), ends: z.string() }).strict().optional()
    .describe("First call: the rule the message describes, to show the user before they sign."),
  rule: ruleOutput.optional(),
  replaced: z.string().nullable().optional().describe("The rule for the same requester this one replaced, if any."),
  already_revoked: z.boolean().optional(),
}).strict();

export type AutopayInput = z.output<typeof inputSchema>;
export type AutopayOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Set a payer's autopay rule: \"pay @landlord's monthly request up to 1,500 USDC\". Owed never pays anything itself: the rule is data. When the user's agent then reads the inbox with what_do_i_owe, open USDC requests from that wallet within the rule are marked eligible with the exact PayBox pay_x402 call, which the agent may run only inside the user's PayBox limits (if PayBox asks for approval, it's one tap a month); requests above the rule are marked over_limit and never paid automatically.",
  "Pass payer (the user's own PayBox Solana wallet from list_credentials), requester, max_per_request (USDC), optionally max_per_month (default the same), and ends (YYYY-MM-DD) or months (1-12): a rule lasts at most a year. USDC only.",
  "requester: for an X handle, call PayBox resolve_username first, tell the user which wallet it resolved to, and pass {handle, wallet}; {sns} is resolved on Solana; or {wallet}. The rule matches that wallet only.",
  "Two calls. The first returns message_to_sign: sign it with PayBox request_wallet_sign (credential_id of the payer wallet, intent {op:\"solanaMessage\", address: payer, message: message_to_sign}); the user approves with their passkey and no money moves. Then call set_autopay again with the same arguments plus signed_message and signature (valid 5 minutes, once). A new rule for the same requester replaces the old one.",
  "To end a rule, pass payer and revoke (the rule id) on both calls the same way.",
].join(" ");

type Requester = { wallet: string; handle: string | null; sns: string | null };

/** The requester as the rule stores it, or why not. An .sns name is resolved on Solana. */
async function resolveRequester(input: NonNullable<AutopayInput["requester"]>, payer: string, deps: Pick<Deps, "rpc">, budgetMs: number): Promise<{ ok: true; requester: Requester } | { ok: false; message: string }> {
  const handle = input.handle === undefined ? null : normalizeHandle(input.handle);
  if (input.handle !== undefined && handle === null) return { ok: false, message: `${input.handle.slice(0, 20)} isn't an X handle (1 to 15 letters, digits or _). Nothing was saved.` };
  let wallet = input.wallet ?? null;
  let sns: string | null = null;
  if (input.sns !== undefined) {
    if (!looksLikeSnsName(input.sns)) return { ok: false, message: `${input.sns.slice(0, 60)} isn't an SNS name (name.sns). Nothing was saved.` };
    const named = await resolveName(input.sns, deps, budgetMs);
    if (!named.ok) return { ok: false, message: `${named.message} Nothing was saved.` };
    if (wallet !== null && named.wallet !== wallet) {
      return { ok: false, message: `${named.name} points to ${shortAddress(named.wallet)}, not to the wallet given (${shortAddress(wallet)}). Nothing was saved; check with the user which is right.` };
    }
    wallet = named.wallet;
    sns = named.name;
  }
  if (wallet === null) {
    if (handle !== null) return { ok: false, message: `To set a rule for @${handle}, first call PayBox resolve_username with "@${handle}", show the user which wallet it resolved to, then pass requester {handle, wallet}. Nothing was saved.` };
    return { ok: false, message: "requester needs a wallet, an SNS name, or an X handle with the wallet PayBox resolve_username returned for it. Nothing was saved." };
  }
  let onCurve = false;
  try {
    const key = new PublicKey(wallet);
    onCurve = key.toBase58() === wallet && PublicKey.isOnCurve(key.toBytes());
  } catch {
    onCurve = false;
  }
  if (!onCurve) return { ok: false, message: "The requester's wallet isn't a wallet requests can pay (it may be a token account). Nothing was saved." };
  if (wallet === payer) return { ok: false, message: "That is the user's own wallet; a rule pays someone else's requests. Nothing was saved." };
  return { ok: true, requester: { wallet, handle, sns } };
}

function label(r: Requester): string {
  if (r.handle) return `@${r.handle} (wallet ${shortAddress(r.wallet)}, as PayBox resolved it; Owed doesn't verify handles)`;
  if (r.sns) return `${r.sns} (wallet ${shortAddress(r.wallet)}, resolved on Solana)`;
  return `wallet ${r.wallet}`;
}

function signStep(mode: "create" | "revoke", payer: string, message: string, started: number, lead: string, draft?: AutopayOutput["draft"]) {
  const expires_at = isoSecond(started + AUTOPAY_MESSAGE_VALID_MS);
  const output: AutopayOutput = {
    step: "sign", mode, payer, message_to_sign: message, expires_at,
    sign_call: { tool: "request_wallet_sign", credential_of: payer, args: { intent: { op: "solanaMessage", address: payer, message } } },
    ...(draft && { draft }),
  };
  const text = [
    `${lead} Sign this exact message with PayBox (it moves no money and approves no payment):`,
    message,
    `Call request_wallet_sign with this wallet's credential_id and intent ${JSON.stringify(output.sign_call!.args.intent)}.`,
    `After the user approves, call set_autopay again with the same arguments plus signed_message (the text above) and signature (from the output). Valid until ${expires_at}, once.`,
    ...(mode === "create" ? [ONE_TAP_COPY] : []),
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

function presentRule(r: AutopayRule): z.output<typeof ruleOutput> {
  return {
    id: r.id, requester: { wallet: r.requester.wallet, handle: r.requester.handle, sns: r.requester.sns }, token: "USDC",
    max_per_request: r.max_per_request, max_per_month: r.max_per_month, ends: r.ends, status: r.status, month: r.month,
    used_this_month: r.used_this_month, created_at: r.created_at, revoked_at: r.revoked_at,
  };
}

function apiRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "invalid_input") return `Owed refused it: ${error.message}. Call set_autopay with the same arguments and no signature for a fresh message.`;
    if (error.code === "not_found") return "Owed has no autopay rule with that id for this wallet. Nothing changed.";
    if (error.code === "rate_limited") return rateLimitedText(error.message);
    if (error.httpStatus === 404) return "This Owed server doesn't take autopay rules yet. Nothing was saved.";
  }
  return "Owed's server couldn't be reached, so nothing was saved. Try again shortly with a fresh message.";
}

export async function setAutopay(args: AutopayInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  const remaining = () => AUTOPAY_BUDGET_MS - (deps.now() - started);
  if (!deps.isSolanaAddress(args.payer)) return refusal("payer must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const second = args.signed_message !== undefined || args.signature !== undefined;
  if (second && (args.signed_message === undefined || args.signature === undefined)) {
    return refusal("Pass both signed_message and signature, or neither to get a message to sign.");
  }

  // ---- revoke
  if (args.revoke !== undefined) {
    if (args.requester || args.max_per_request || args.max_per_month || args.ends || args.months !== undefined) {
      return refusal("To end a rule pass only payer and revoke (and, on the second call, signed_message and signature).");
    }
    if (!second) {
      return signStep("revoke", args.payer, revokeMessage(args.revoke, args.payer, started), started, `To end autopay rule ${args.revoke},`);
    }
    const lead = `Owed autopay revoke ${args.revoke} for ${args.payer} at `;
    const message = args.signed_message!;
    const signedAt = message.startsWith(lead) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(message.slice(lead.length)) ? Date.parse(message.slice(lead.length)) : null;
    if (signedAt === null) return refusal(`signed_message must be exactly the message_to_sign set_autopay gave ("${lead}<time>"). Call set_autopay with payer and revoke for a fresh one.`);
    const problem = freshSignatureProblem(message, signedAt, args.signature!.trim(), args.payer, started);
    if (problem) return refusal(`That signed message can't be used: ${problem}. Call set_autopay with payer and revoke for a fresh message, sign it with this wallet, and try again.`);
    let ctx: CallContext;
    try {
      ctx = callContext(deps);
    } catch (error) {
      return refusal(errorText(error, "Owed is misconfigured."));
    }
    const api = makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.min(API_TIMEOUT_MS, Math.max(500, remaining() - 300)) });
    let res;
    try {
      res = await within(api.revokeAutopay({ payer: args.payer, rule_id: args.revoke, signed_message: message, signature: args.signature!.trim() }), remaining(), () => null);
    } catch (error) {
      return refusal(apiRefusal(error));
    }
    if (!res) return refusal("Owed's server didn't answer in time. Call set_autopay with payer and revoke for a fresh message and try again.");
    if (res.rule.id !== args.revoke || res.rule.payer !== args.payer || res.rule.status !== "revoked") return refusal("Owed's server answered for a different rule, so it can't be trusted. Try again.");
    const output: AutopayOutput = { step: "revoked", mode: "revoke", payer: args.payer, rule: presentRule(res.rule), already_revoked: res.already_revoked };
    const text = res.already_revoked
      ? `Autopay rule ${res.rule.id} was already ended (${res.rule.revoked_at}). Nothing changed.`
      : `Ended autopay rule ${res.rule.id} for ${label(res.rule.requester)}. Its requests stay payable by hand; what_do_i_owe no longer marks them eligible.`;
    return { content: [{ type: "text" as const, text }], structuredContent: output };
  }

  // ---- create: every field checked before anything is signed
  if (!args.requester) return refusal("Whose requests should the rule pay? Pass requester ({handle, wallet} after resolve_username, {sns} or {wallet}).");
  if (args.max_per_request === undefined) return refusal("Ask the user the most one request may be (max_per_request, in USDC) and pass it.");
  if ((args.ends === undefined) === (args.months === undefined)) {
    return refusal("Ask the user how long the rule should last and pass ends (its last day, YYYY-MM-DD) or months (1 to 12), not both. A rule lasts at most a year.");
  }
  let maxPerRequestAtomic: bigint;
  let maxPerMonthAtomic: bigint;
  try {
    maxPerRequestAtomic = deps.toAtomic(args.max_per_request, "USDC");
    maxPerMonthAtomic = deps.toAtomic(args.max_per_month ?? args.max_per_request, "USDC");
  } catch (error) {
    return refusal(`The amounts aren't valid USDC amounts: ${errorText(error, "use positive decimals.")}`);
  }
  const limits = limitProblem(maxPerRequestAtomic, maxPerMonthAtomic);
  if (limits) return refusal(`${limits} Nothing was saved.`);
  // months counts from the day the message was signed, so a second call just after midnight UTC still matches it.
  const signedAt = second ? signedAtOf(args.signed_message!) : started;
  if (second && signedAt === null) return refusal("signed_message must be exactly the message_to_sign set_autopay gave, ending \"(at <time>)\". Call set_autopay without a signature for a fresh one.");
  const ends = args.ends ?? endsAfterMonths(args.months!, signedAt!);
  const endsWrong = endsProblem(ends, signedAt!);
  if (endsWrong) return refusal(`${endsWrong} Nothing was saved.`);
  const who = await resolveRequester(args.requester, args.payer, deps, Math.min(SNS_BUDGET_MS, Math.max(500, remaining() - 4000)));
  if (!who.ok) return refusal(who.message);
  const requester = who.requester;
  const terms: RuleTerms = { payer: args.payer, requester: requester.wallet, maxPerRequestAtomic, maxPerMonthAtomic, ends };
  const draft = {
    requester, max_per_request: deps.fromAtomic(maxPerRequestAtomic, "USDC"), max_per_month: deps.fromAtomic(maxPerMonthAtomic, "USDC"), ends,
  };
  if (!second) {
    return signStep("create", args.payer, autopayMessage(terms, started), started,
      `To let the agent pay ${label(requester)}'s requests up to ${draft.max_per_request} USDC each and ${draft.max_per_month} USDC a month (UTC) until ${ends},`, draft);
  }

  const message = args.signed_message!;
  const prefix = autopayPrefix(terms);
  // The whole text: exactly these terms, then " (at <time>)".
  if (!message.startsWith(prefix) || !/^ \(at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\)$/.test(message.slice(prefix.length))) {
    return refusal(`signed_message doesn't match these arguments: it must read "${prefix} (at <time>)". Call set_autopay with the same arguments and no signature for a fresh message.`);
  }
  const problem = freshSignatureProblem(message, signedAt, args.signature!.trim(), args.payer, started);
  if (problem) return refusal(`That signed message can't be used: ${problem}. Call set_autopay with the same arguments and no signature for a fresh message, sign it with this wallet, and try again.`);

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  const api = makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: Math.min(API_TIMEOUT_MS, Math.max(500, remaining() - 300)) });
  const body = {
    payer: args.payer,
    requester: { wallet: requester.wallet, ...(requester.handle && { handle: requester.handle }), ...(requester.sns && { sns: requester.sns }) },
    token: "USDC" as const, max_per_request: draft.max_per_request, max_per_month: draft.max_per_month, ends,
    signed_message: message, signature: args.signature!.trim(),
  };
  let res;
  try {
    res = await within(api.createAutopay(body), remaining(), () => null);
  } catch (error) {
    return refusal(apiRefusal(error));
  }
  if (!res) return refusal("Owed's server didn't answer in time. Call set_autopay with the same arguments and no signature for a fresh message and try again.");
  const r = res.rule;
  if (r.payer !== args.payer || r.requester.wallet !== requester.wallet || r.max_per_request !== draft.max_per_request || r.max_per_month !== draft.max_per_month
    || r.ends !== ends || r.signed_message !== message || r.status !== "active") {
    return refusal("Owed's server answered with a different rule than the one signed, so it can't be trusted. Check the user's rules with what_do_i_owe.");
  }
  const output: AutopayOutput = { step: "saved", mode: "create", payer: args.payer, rule: presentRule(r), replaced: res.replaced };
  const text = [
    `Saved autopay rule ${r.id}: ${label(requester)}, up to ${r.max_per_request} USDC per request and ${r.max_per_month} USDC per month (UTC) until ${r.ends}.${res.replaced ? ` It replaces rule ${res.replaced}.` : ""}`,
    `One-tap monthly pay within your rule: ${ONE_TAP_COPY}`,
    `To end it, call set_autopay with payer and revoke: "${r.id}".`,
  ].join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent: output };
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("set_autopay", {
    title: "Set an autopay rule",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    // Writes a rule (or ends one) with a fresh signature each time; moves no money.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => setAutopay(args, deps));
}
