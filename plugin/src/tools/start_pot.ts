import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, decimalSchema, tokenSchema, type CreatePotReq, type PotRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import type { Token } from "../money.js";
import { normalizeHandle, requesterHandleInput } from "../payer.js";
import { POT_TITLE_MAX, potFixedAmounts, potLabel, potTermsProblem } from "../pots.js";
import { brandFlags, cautionLine, clean, LINK_REMOVED, quote, rateLimitedText, shortAddress } from "../text.js";

// start_pot (F7): a chip-in pot. The user collects into their own wallet from anyone: a gift, a team dinner, a
// fundraiser. The pot's board is a link (and printable QR codes) anyone can pay from any Solana wallet; each scan or
// click makes its own contribution (an ordinary Owed request with a fresh reference), so every one is counted on
// its own and the board total is what the chain says arrived. Every pot ends: default 30 days, at most 90.

const DAY_MS = 86_400_000;
const MIN_DEADLINE_MS = 10 * 60_000;

export const inputSchema = z.object({
  recipient: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials): every contribution is paid straight to it."),
  title: z.string().min(1).max(POT_TITLE_MAX).describe('What the pot is for, e.g. "Farewell gift for Ana". Everyone sees it quoted.'),
  token: tokenSchema.optional().describe('"USDC" (default) or "SOL".'),
  target: decimalSchema.optional().describe("Optional goal in the pot's token, shown as progress on the board."),
  suggested_amount: decimalSchema.optional().describe("Optional default contribution, e.g. 10. The board's first QR code and a payer's agent use it when no amount is given."),
  any_amount: z.boolean().optional().describe("Default true: contributors may give any amount. false: only suggested_amount and x402_presets are accepted."),
  x402_presets: z.array(decimalSchema).min(1).max(4).optional().describe("USDC pots only: up to 4 fixed amounts (e.g. 5, 10, 20), each with its own x402 endpoint an AI agent can pay, and a QR code on the board."),
  deadline: z.string().max(40).optional().describe("When the pot stops taking contributions, ISO time (at least 10 minutes and at most 90 days away). Or use deadline_days."),
  deadline_days: z.number().int().min(1).max(90).optional().describe("Days until the pot ends (1 to 90). Default 30. Don't pass both deadline and deadline_days."),
  note: z.string().max(140).optional().describe("Optional short note shown on the board, quoted."),
  requester_name: z.string().max(40).optional().describe("The user's first name as contributors will see it."),
  requester_handle: requesterHandleInput.optional(),
}).strict();

const amountLink = z.object({ amount: z.string(), url: z.string() }).strict();
export const outputSchema = z.object({
  pot_id: z.string().describe("Pass it (or link) to check_payments to see the board, or to pay_link to contribute."),
  link: z.string().describe("The pot's board: share this. It shows the total, every contribution, QR codes and a pay button."),
  recipient: z.string(),
  token: tokenSchema,
  title: z.string(),
  target: z.string().nullable(),
  suggested_amount: z.string().nullable(),
  any_amount: z.boolean(),
  deadline: z.string(),
  qr_links: z.array(amountLink).describe("One Solana Pay transaction request per fixed amount (what the board's QR codes encode): each scan makes its own contribution."),
  x402_presets: z.array(amountLink).describe("USDC presets an AI agent can pay over x402."),
  nonce: z.string().describe("pot_id is the hash of recipient, token and this nonce: payers' agents check it before paying."),
  caution: z.string().optional(),
}).strict();

export type StartPotInput = z.output<typeof inputSchema>;
export type StartPotOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Start a chip-in pot: collect money from anyone into the user's own wallet, for a gift, a team dinner, a trip kitty or a fundraiser.",
  "Use it when the user says things like \"start a pot for Ana's farewell gift\" or \"collect 10 USDC from everyone for the dinner\".",
  "recipient is the user's own PayBox Solana wallet (from list_credentials). title says what it is for. Optional: target, suggested_amount (the default contribution), any_amount (false = only the fixed amounts), x402_presets (USDC only, up to 4 amounts AI agents can pay over x402), deadline or deadline_days (default 30 days, at most 90: every pot ends), note, requester_name, requester_handle.",
  "Returns the pot's board link to share: anyone can chip in from any Solana wallet by scanning one of its QR codes (each scan makes its own contribution, so everyone is counted on their own), from their own payment link, or by asking their own agent to pay the board link with pay_link. The board shows the total against the target and every contribution as it lands. Owed never holds the money: every contribution goes straight to the recipient.",
  "Show the user the board link and the deadline. check_payments with the pot id shows what was raised.",
].join(" ");

function parseAmount(text: string | undefined, token: Token, field: string, deps: Deps): bigint | null | string {
  if (text === undefined) return null;
  try {
    return deps.toAtomic(text, token);
  } catch (error) {
    return `${field} isn't a valid ${token} amount: ${errorText(error, "use a positive decimal amount.")}`;
  }
}

export async function startPot(args: StartPotInput, deps: Deps = defaultDeps) {
  const now = deps.now();
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const title = clean(args.title, POT_TITLE_MAX);
  if (!/[\p{L}\p{N}]/u.test(title.split(LINK_REMOVED).join(""))) return refusal('title needs some readable text, e.g. "Farewell gift for Ana" (links are removed).');
  const token: Token = args.token ?? "USDC";
  const target = parseAmount(args.target, token, "target", deps);
  const suggested = parseAmount(args.suggested_amount, token, "suggested_amount", deps);
  if (typeof target === "string") return refusal(target);
  if (typeof suggested === "string") return refusal(suggested);
  const presets: bigint[] = [];
  for (const [i, p] of (args.x402_presets ?? []).entries()) {
    const a = parseAmount(p, token, `x402_presets[${i}]`, deps);
    if (typeof a === "string") return refusal(a);
    if (presets.includes(a!)) return refusal("Each x402 preset must be a different amount.");
    presets.push(a!);
  }
  if (presets.length > 0 && token !== "USDC") return refusal("x402 presets are USDC only (x402 pays USDC). Leave x402_presets out for a SOL pot, or make it a USDC pot.");
  const anyAmount = args.any_amount ?? true;
  if (!anyAmount && suggested === null && presets.length === 0) return refusal("A pot that takes only fixed amounts needs suggested_amount or x402_presets.");
  if (args.deadline !== undefined && args.deadline_days !== undefined) return refusal("Pass deadline or deadline_days, not both.");
  let deadline: string | undefined;
  if (args.deadline !== undefined) {
    const at = Date.parse(args.deadline);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(args.deadline) || !Number.isFinite(at)) return refusal('deadline must be an ISO time like "2026-11-30T18:00:00Z".');
    if (at < now + MIN_DEADLINE_MS) return refusal("deadline must be at least 10 minutes from now.");
    if (at > now + 90 * DAY_MS - 5 * 60_000) return refusal("deadline can be at most 90 days from now: every pot ends.");
    deadline = new Date(at).toISOString().replace(".000Z", "Z");
  }
  const note = args.note === undefined ? "" : clean(args.note, 140);
  const name = args.requester_name === undefined ? "" : clean(args.requester_name, 40);
  const handle = args.requester_handle === undefined ? null : normalizeHandle(args.requester_handle);

  const screen = await deps.screenRecipient(args.recipient, deps);
  if (!screen.ok) return refusal(screen.message);

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  const body: CreatePotReq = {
    recipient: args.recipient, token, title, source: "plugin",
    ...(note && { note }), ...(name && { requester_name: name }), ...(handle && { requester_handle: handle }),
    ...(args.target !== undefined && { target: deps.fromAtomic(target!, token) }),
    ...(args.suggested_amount !== undefined && { suggested: deps.fromAtomic(suggested!, token) }),
    any_amount: anyAmount,
    ...(presets.length > 0 && { presets: presets.map((p) => deps.fromAtomic(p, token)) }),
    ...(deadline ? { deadline } : { deadline_days: args.deadline_days ?? 30 }),
  };
  let pot: PotRes;
  try {
    pot = await ctx.api.createPot(body);
  } catch (error) {
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't start the pot."));
    if (error.code === "rate_limited") return refusal(rateLimitedText(error.message));
    if (error.code === "invalid_input" || error.code === "blocked") return refusal(`Owed refused the pot: ${error.message} Nothing was created.`);
    if (error.httpStatus === 404) return refusal("This Owed server doesn't have chip-in pots yet. Nothing was created.");
    return refusal(`Owed couldn't start the pot: ${error.message} Nothing was created; try again shortly.`);
  }

  // The pot must commit to exactly this wallet and token, and hold exactly what was asked.
  const wrong = potTermsProblem(pot, pot.id)
    ?? (pot.recipient !== args.recipient || pot.token !== token ? "Owed's server returned a pot that pays a different wallet or token, so it wasn't used." : null)
    ?? (!sameAmounts(pot, { target, suggested, presets, anyAmount }, deps) ? "Owed's server returned a pot with different amounts than asked, so it wasn't used." : null)
    ?? linksProblem(pot, ctx, deps);
  if (wrong) return refusal(`${wrong} Try again.`);
  const ask = Date.parse(deadline ?? new Date(now + (args.deadline_days ?? 30) * DAY_MS).toISOString());
  if (Math.abs(Date.parse(pot.deadline) - ask) > 10 * 60_000 || pot.status !== "open") {
    return refusal("Owed's server returned a pot with a different deadline than asked, so it wasn't used. Try again.");
  }

  const caution = cautionLine([...new Set([...pot.flags, ...brandFlags(args.title, args.note, args.requester_name, handle?.replace(/_/g, " "))])]);
  const qr = pot.links.transaction_request.map((l) => ({ amount: l.amount, url: l.url }));
  const x402 = pot.links.x402.map((l) => ({ amount: l.amount, url: l.url }));
  const lines = [
    caution ?? "",
    `Pot ready: ${potLabel(title)}, collecting ${token} into ${shortAddress(pot.recipient)}${pot.target ? `, target ${pot.target} ${token}` : ""}. Board: ${pot.link}`,
    `It takes contributions until ${pot.deadline}${pot.any_amount ? (pot.suggested ? `; suggested ${pot.suggested} ${token}, any amount welcome` : "; any amount") : `; only ${potFixedAmounts(pot, deps).map((a) => `${deps.fromAtomic(a, token)} ${token}`).join(", ")}`}.`,
    note ? `Note shown on the board: ${quote(note, 140)}.` : "",
    "Share the board link. Anyone can chip in from any Solana wallet: scan a QR code on the board (each scan makes its own contribution, so everyone is counted on their own), get their own payment link there, or ask their own agent to pay the board link with pay_link.",
    qr.length > 0 ? `QR codes (Solana Pay transaction requests, printable from the board): ${qr.map((l) => `${l.amount} ${token}: ${l.url}`).join(" · ")}` : "",
    x402.length > 0 ? `x402 presets for AI agents: ${x402.map((l) => `${l.amount} USDC: ${l.url}`).join(" · ")}` : "",
    handle ? `Contributors see "@${handle}" as your handle, marked not verified by Owed.` : "",
    `Pot id ${pot.id}: it is the hash of this wallet, the token and nonce ${pot.nonce}, so a payer's agent can check the pot pays you before paying. check_payments with the pot id shows what was raised.`,
  ].filter(Boolean);
  const output: StartPotOutput = {
    pot_id: pot.id, link: pot.link, recipient: pot.recipient, token, title: pot.title, target: pot.target, suggested_amount: pot.suggested,
    any_amount: pot.any_amount, deadline: pot.deadline, qr_links: qr, x402_presets: x402, nonce: pot.nonce, ...(caution && { caution }),
  };
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

function sameAmounts(pot: PotRes, want: { target: bigint | null; suggested: bigint | null; presets: bigint[]; anyAmount: boolean }, deps: Deps): boolean {
  const at = (v: string | null) => (v === null ? null : deps.toAtomic(v, pot.token));
  return at(pot.target) === want.target && at(pot.suggested) === want.suggested && pot.any_amount === want.anyAmount
    && pot.presets.length === want.presets.length && pot.presets.every((p, i) => deps.toAtomic(p, pot.token) === want.presets[i]);
}

/** The board on an Owed host; each QR code is Owed's own pot transaction request for one of its fixed amounts; each x402 URL a preset. */
function linksProblem(pot: PotRes, ctx: CallContext, deps: Deps): string | null {
  const bad = "Owed's server returned pot links that don't point at this pot, so it wasn't used.";
  let board: URL;
  try {
    board = new URL(pot.link);
  } catch {
    return bad;
  }
  if (board.protocol !== "https:" || !ctx.hosts.includes(board.host.toLowerCase()) || board.pathname !== `/pot/${pot.id}`) return bad;
  const fixed = potFixedAmounts(pot, deps);
  if (pot.links.transaction_request.length !== fixed.length) return bad;
  for (const [i, l] of pot.links.transaction_request.entries()) {
    let parsed;
    try {
      parsed = deps.parseLink(l.url, ctx.hosts);
    } catch {
      return bad;
    }
    if (parsed.kind !== "pot" || parsed.id !== pot.id || parsed.amount === undefined || deps.toAtomic(parsed.amount, pot.token) !== fixed[i]) return bad;
  }
  const presets = pot.presets.map((p) => deps.toAtomic(p, pot.token));
  if (pot.links.x402.length !== (pot.token === "USDC" ? presets.length : 0)) return bad;
  for (const [i, l] of pot.links.x402.entries()) {
    if (l.url !== `${board.origin}/x/pot/${pot.id}/${l.amount}` || deps.toAtomic(l.amount, pot.token) !== presets[i]) return bad;
  }
  return null;
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("start_pot", {
    title: "Start a chip-in pot",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => startPot(args, deps));
}
