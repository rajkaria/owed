import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, decimalSchema, requestIdSchema, tokenSchema, type CreateRequestReq, type CreateRequestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import { idMatchesTerms } from "../request-id.js";
import { USDC_MINT } from "../money.js";
import type { TransferRequest } from "../solana-pay.js";
import { clean, quote, shareText, shortAddress } from "../text.js";
import { belowNewWalletMinimum, newWalletMinimum } from "../sol-minimum.js";
// W2-H verified payee start
import { checkFromDomain, fromDomainSchema } from "../payee.js";
// W2-H verified payee end

export const inputSchema = z.object({
  recipient: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials). The money is paid to this address."),
  amount: decimalSchema.describe('Amount in whole token units as a decimal string, e.g. "15" or "2.5". Not atomic units.'),
  token: tokenSchema.default("USDC").describe('"USDC" (default) or "SOL".'),
  payer_name: z.string().min(1).max(40).optional().describe("First name of the person who owes the money, e.g. \"Priya\"."),
  for: z.string().min(1).max(80).optional().describe('What the money is for, e.g. "dinner". The payer sees it quoted.'),
  note: z.string().min(1).max(140).optional().describe("Optional longer note shown quoted on the pay page."),
  requester_name: z.string().min(1).max(40).optional().describe("The user's own first name, so the payer knows who is asking."),
  // W2-H verified payee start
  from_domain: fromDomainSchema.optional(),
  // W2-H verified payee end
}).strict();

export const outputSchema = z.object({
  id: requestIdSchema.nullable().describe("Owed request id; null when the link was built offline."),
  mode: z.enum(["hosted", "offline"]),
  link: z.string().describe("The link to send to the payer."),
  solana_pay_url: z.string(),
  qr_url: z.string().nullable().describe("QR image URL; null offline (the link's page shows the QR)."),
  reference: z.string().describe("Solana Pay reference key that identifies the payment on-chain."),
  recipient: z.string(),
  amount: z.string(),
  token: tokenSchema,
  payer_name: z.string().optional(),
  for: z.string().optional(),
  share_text: z.string().describe("A ready-to-send message for the payer."),
  status: z.literal("open"),
  // W2-H verified payee start
  from_domain: z.string().optional().describe("The verified domain payers see on the request (lower-case ASCII). Absent offline: offline links carry no domain."),
  // W2-H verified payee end
}).strict();

export type AskInput = z.output<typeof inputSchema>;
export type AskOutput = z.output<typeof outputSchema>;

// W2-H verified payee start
/** DNS for from_domain gets 4 s (Cloudflare 2.5 s, then dns.google), leaving the API its 4 s inside PayBox's 10 s. */
export const ASK_PAYEE_BUDGET_MS = 4000;
// W2-H verified payee end

const DESCRIPTION = [
  "Ask someone for money: creates an Owed payment request and returns a short link (with QR) that anyone can pay from any Solana wallet (Phantom, Solflare, Backpack) or from their own PayBox agent.",
  "Use it when the user says things like \"ask Priya for 15 USDC for dinner\" or \"request 0.5 SOL from Sam\".",
  "recipient is the user's own PayBox Solana wallet address (get it from list_credentials); funds go straight from the payer to it, Owed never holds money.",
  "Returns the link, a ready-to-send share_text, and the request id. Show the user the link and share_text so they can send it; later call check_payments with the id or link to see whether it was paid.",
  // W2-H verified payee start
  "If the user has a domain that publishes their wallet in DNS (_owed.<domain> TXT owed-pay=<wallet>), pass it as from_domain: Owed checks it first and payers see the request as verified from that domain.",
  // W2-H verified payee end
].join(" ");

export async function askForMoney(args: AskInput, deps: Deps = defaultDeps) {
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const token = args.token;
  let atomic: bigint;
  try {
    atomic = deps.toAtomic(args.amount, token);
  } catch (error) {
    return refusal(`${args.amount} ${token} isn't a valid amount: ${errorText(error, "use a positive decimal amount.")}`);
  }
  const amount = deps.fromAtomic(atomic, token);
  const text = {
    payerName: clean(args.payer_name, 40) || undefined,
    forText: clean(args.for, 80) || undefined,
    note: clean(args.note, 140) || undefined,
    requesterName: clean(args.requester_name, 40) || undefined,
  };

  // QA-18: a SOL request to a never-used wallet must reach Solana's minimum; read alongside the DNS check.
  const solMinimum = token === "SOL" ? newWalletMinimum(deps.rpc(), args.recipient) : Promise.resolve(null);

  // W2-H verified payee start
  let fromDomain: { domain: string; lines: string[] } | undefined;
  if (args.from_domain !== undefined) {
    const check = await checkFromDomain(args.from_domain, args.recipient, deps, ASK_PAYEE_BUDGET_MS);
    if (!check.ok) return refusal(check.message);
    fromDomain = { domain: check.from_domain, lines: check.lines };
  }
  // W2-H verified payee end

  const minimum = await solMinimum;
  if (minimum !== null && atomic < minimum) {
    return refusal(belowNewWalletMinimum(shortAddress(args.recipient), deps.fromAtomic(minimum, "SOL"), `a ${amount} SOL request`));
  }

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  const body: CreateRequestReq = {
    recipient: args.recipient, amount, token, source: "plugin",
    ...(text.payerName && { payer_name: text.payerName }),
    ...(text.forText && { for: text.forText }),
    ...(text.note && { note: text.note }),
    ...(text.requesterName && { requester_name: text.requesterName }),
    // W2-H verified payee start
    ...(fromDomain && { from_domain: fromDomain.domain }),
    // W2-H verified payee end
  };

  let created: { id: string | null; mode: "hosted" | "offline"; link: string; solana_pay_url: string; qr_url: string | null; reference: string };
  try {
    const res = await ctx.api.createRequest(body);
    const mismatch = checkHosted(res, args.recipient, token, atomic, ctx, deps);
    if (mismatch) return refusal(mismatch);
    // W2-H verified payee start
    if (fromDomain && res.from_domain !== fromDomain.domain) {
      return refusal(`Owed's server didn't attach ${fromDomain.domain} to the request, so the link wasn't used. Try again, or ask without from_domain.`);
    }
    // W2-H verified payee end
    created = { id: res.id, mode: "hosted", link: res.link, solana_pay_url: res.solana_pay_url, qr_url: res.qr_url, reference: res.reference };
  } catch (error) {
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't create the request."));
    if (error.code !== "upstream_unavailable") return refusal(apiRefusal(error));
    try {
      created = buildOffline(args.recipient, amount, token, text, ctx, deps);
    } catch (offlineError) {
      return refusal(`Owed's server is unreachable and the offline link couldn't be built: ${errorText(offlineError, "unknown error")}`);
    }
  }

  const share_text = shareText({ payerName: text.payerName, requesterName: text.requesterName, forText: text.forText, amount, token, link: created.link });
  const output: AskOutput = {
    ...created, recipient: args.recipient, amount, token,
    ...(text.payerName && { payer_name: text.payerName }),
    ...(text.forText && { for: text.forText }),
    share_text, status: "open",
    // W2-H verified payee start
    ...(fromDomain && created.mode === "hosted" && { from_domain: fromDomain.domain }),
    // W2-H verified payee end
  };
  const from = text.payerName ? ` from ${text.payerName}` : "";
  const forPart = text.forText ? ` for ${quote(text.forText, 80)}` : "";
  const lines = [
    `Request ready: ${amount} ${token}${from}${forPart}. Send this link: ${created.link}`,
    `Message to send: ${share_text}`,
  ];
  if (created.mode === "offline") {
    lines.push("Owed's server didn't answer, so this is a self-contained link with no short id. It works with any Solana wallet, and check_payments can verify it with the same link.");
  }
  // W2-H verified payee start
  if (fromDomain && created.mode === "hosted") lines.push(...fromDomain.lines);
  if (fromDomain && created.mode === "offline") {
    lines.push(`Offline links can't carry a domain, so payers will see this one as unverified, not as from ${fromDomain.domain}.`);
  }
  // W2-H verified payee end
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

/**
 * The server builds what the payer pays; refuse to hand out a link that pays anyone or anything else.
 * The page link's host isn't pinned: the server's domain can change before the plugin's OWED_BASE_URL does.
 */
function checkHosted(res: CreateRequestRes, recipient: string, token: "USDC" | "SOL", atomic: bigint, ctx: CallContext, deps: Deps): string | null {
  const bad = "Owed's server returned a payment link that doesn't match this request, so it wasn't used. Nothing was created on your side; try again.";
  try {
    if (new URL(res.link).protocol !== "https:") return bad;
    const parsed = deps.parseLink(res.solana_pay_url, ctx.hosts);
    if (parsed.kind !== "transfer") return bad;
    const r = parsed.request;
    const expectedMint = token === "USDC" ? USDC_MINT : undefined;
    if (r.recipient !== recipient || r.splToken !== expectedMint || !r.references.includes(res.reference)) return bad;
    if (r.amount === undefined || deps.toAtomic(r.amount, token) !== atomic) return bad;
    // The id must commit to these exact terms, or a payer's pay_link would refuse the link.
    if (!idMatchesTerms(res.id, { recipient, token, amountAtomic: atomic, reference: res.reference })) return bad;
    return null;
  } catch {
    return bad;
  }
}

function buildOffline(
  recipient: string, amount: string, token: "USDC" | "SOL",
  text: { requesterName?: string; forText?: string }, ctx: CallContext, deps: Deps,
) {
  const reference = deps.newReference();
  const request: TransferRequest = {
    recipient, amount, references: [reference],
    ...(token === "USDC" && { splToken: USDC_MINT }),
    ...(text.requesterName && { label: text.requesterName }),
    ...(text.forText && { message: text.forText }),
  };
  const solana_pay_url = deps.buildTransferUrl(request);
  return {
    id: null, mode: "offline" as const, link: `${ctx.base}/p?u=${encodeURIComponent(solana_pay_url)}`,
    solana_pay_url, qr_url: null, reference,
  };
}

function apiRefusal(error: ApiError): string {
  switch (error.code) {
    case "rate_limited": return "Owed is limiting new requests for this wallet right now. Try again in a few minutes.";
    case "blocked": return `Owed can't create a request for this recipient. ${error.message}`;
    case "invalid_input": return `Owed rejected the request: ${error.message}`;
    default: return `Owed couldn't create the request: ${error.message}`;
  }
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("ask_for_money", {
    title: "Ask someone for money",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => askForMoney(args, deps));
}
