import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, decimalSchema, requestIdSchema, tokenSchema, type CreateRequestReq, type CreateRequestRes } from "../contract.js";
// W3-B Base requests start
import { chainSchema, evmAddressSchema } from "../contract.js";
import { askForMoneyOnBase, BASE_DESCRIPTION } from "../base-request.js";
// W3-B Base requests end
import { callContext, defaultDeps, errorText, refusal, type CallContext, type Deps } from "../deps.js";
import { idMatchesTerms } from "../request-id.js";
import { USDC_MINT } from "../money.js";
// W2-E sanctions screen start
import { SCREENING_UNAVAILABLE_LINE } from "../screen.js";
// W2-E sanctions screen end
import type { TransferRequest } from "../solana-pay.js";
import { clean, quote, rateLimitedText, shareText, shortAddress } from "../text.js";
import { belowNewWalletMinimum, newWalletMinimum } from "../sol-minimum.js";
// W2-H verified payee start
import { checkFromDomain, fromDomainSchema } from "../payee.js";
// W2-H verified payee end
import { expiresInDaysInput, expiryLine, expiryProblem, OFFLINE_NO_EXPIRY } from "../expiry.js"; // W3-C
// Local-currency asks start
import {
  checkQuote, currencyInput, fiatAmountText, fiatApiRefusal, fiatHeadline, fiatOutput, fiatRateLine, parseFiatAsk, type FiatAsk,
} from "../local-currency.js";
// Local-currency asks end
// W3-S SNS names start
import { snsSourceSchema, type FiatQuoteRes } from "../contract.js";
import { looksLikeSnsName } from "../sns.js";
import { resolveName, snsLead, snsLines, snsNameSchema } from "../sns-payee.js";
// W3-S SNS names end

export const inputSchema = z.object({
  recipient: z.union([addressSchema, evmAddressSchema, snsNameSchema]).describe("The user's own PayBox Solana wallet address (from list_credentials), or with chain \"base\" their Base (0x) address. The money is paid to this address. If the user names their wallet by an SNS name (\"pay to example.sns\"), pass the name: Owed resolves it on Solana itself and payers see it as verified on-chain."), // W3-B: 0x with chain base; W3-S: an SNS name
  amount: decimalSchema.describe('Amount in whole token units as a decimal string, e.g. "15" or "2.5". Not atomic units. With currency, the amount in that currency, e.g. "1200" for ₹1,200.'),
  token: tokenSchema.default("USDC").describe('"USDC" (default) or "SOL".'),
  payer_name: z.string().min(1).max(40).optional().describe("First name of the person who owes the money, e.g. \"Priya\"."),
  for: z.string().min(1).max(80).optional().describe('What the money is for, e.g. "dinner". The payer sees it quoted.'),
  note: z.string().min(1).max(140).optional().describe("Optional longer note shown quoted on the pay page."),
  requester_name: z.string().min(1).max(40).optional().describe("The user's own first name, so the payer knows who is asking."),
  // W2-H verified payee start
  from_domain: fromDomainSchema.optional(),
  // W2-H verified payee end
  expires_in_days: expiresInDaysInput.optional(), // W3-C
  // W3-B Base requests start
  chain: chainSchema.default("solana").describe('"solana" (default) or "base": USDC on Base, paid from any Base wallet or over x402.'),
  // W3-B Base requests end
  currency: currencyInput.optional(), // local-currency asks
}).strict();

export const outputSchema = z.object({
  id: requestIdSchema.nullable().describe("Owed request id; null when the link was built offline."),
  mode: z.enum(["hosted", "offline"]),
  link: z.string().describe("The link to send to the payer."),
  solana_pay_url: z.string().nullable(), // W3-B: null on Base requests (see pay_url)
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
  // W2-E sanctions screen start
  screening: z.enum(["clear", "unavailable", "skipped"]).describe("Recipient sanctions screen (Chainalysis): clear = on no sanctions list; unavailable = the screen couldn't be reached, so the address wasn't screened."),
  // W2-E sanctions screen end
  expires_at: z.string().optional().describe("When the link stops taking payments (set by Owed's server). Absent offline or without expires_in_days."), // W3-C
  // W3-B Base requests start
  chain: chainSchema.optional().describe('"base" for a Base request (absent means Solana).'),
  pay_url: z.string().optional().describe("Base requests: the EIP-681 link a Base wallet opens (USDC transfer on chain 8453)."),
  // W3-B Base requests end
  fiat: fiatOutput.optional(), // local-currency asks: amount is then the USDC locked
  // W3-S SNS names start
  sns_name: z.string().optional().describe("The SNS name the recipient was given as; it pointed to recipient when the request was made. Absent offline."),
  sns_source: snsSourceSchema.optional().describe("Which SNS rule picked the wallet: the name's SOL record (v2 or signed v1), or its owner."),
  // W3-S SNS names end
}).strict();

export type AskInput = z.output<typeof inputSchema>;
export type AskOutput = z.output<typeof outputSchema>;

// W2-H verified payee start
/** DNS for from_domain gets 4 s (Cloudflare 2.5 s, then dns.google), leaving the API its 4 s inside PayBox's 10 s. */
export const ASK_PAYEE_BUDGET_MS = 4000;
// W2-H verified payee end
/** W3-S: an SNS name (≤2.5 s) and the DNS check share this, so the API keeps its 4 s of PayBox's 10 s. */
export const ASK_NAME_AND_DNS_BUDGET_MS = 4500;

const DESCRIPTION = [
  "Ask someone for money: creates an Owed payment request and returns a short link (with QR) that anyone can pay from any Solana wallet (Phantom, Solflare, Backpack) or from their own PayBox agent.",
  "Use it when the user says things like \"ask Priya for 15 USDC for dinner\" or \"request 0.5 SOL from Sam\".",
  "recipient is the user's own PayBox Solana wallet address (get it from list_credentials); funds go straight from the payer to it, Owed never holds money.",
  "Returns the link, a ready-to-send share_text, and the request id. Show the user the link and share_text so they can send it; later call check_payments with the id or link to see whether it was paid.",
  // W2-H verified payee start
  "If the user has a domain that publishes their wallet in DNS (_owed.<domain> TXT owed-pay=<wallet>), pass it as from_domain: Owed checks it first and payers see the request as verified from that domain.",
  // W2-H verified payee end
  // W2-E sanctions screen start
  "The recipient is screened against sanctions lists (Chainalysis) first: a listed address is refused, and if the screen can't be reached the request is still made and says so.",
  // W2-E sanctions screen end
  "If the user wants the link to stop working after a while (\"expires in 3 days\"), pass expires_in_days; cancel_request ends it at any time.", // W3-C
  "If the user asks in their own currency (\"ask Priya for ₹1,200 for dinner\", \"bill the team €45\"), pass currency (\"INR\", \"EUR\") with amount in that currency: Owed locks the USDC amount at a live rate, the payer pays that USDC, and the pay page shows both.", // local-currency asks
  BASE_DESCRIPTION, // W3-B
  "If the user gives their wallet as an SNS name (example.sns), pass it as recipient: Owed resolves it on Solana (the name's SOL record, else its owner), screens and pays that wallet, and the request shows the name as verified on-chain. Owed refuses .sol names (SNS moved to .sns; .sol isn't resolvable today), tokenized names and names with lookalike characters.", // W3-S
].join(" ");

export async function askForMoney(args: AskInput, deps: Deps = defaultDeps) {
  // W3-S SNS names start: resolve a name given as the recipient, then go on with the wallet it names.
  const started = deps.now();
  let sns: Extract<Awaited<ReturnType<typeof resolveName>>, { ok: true }> | undefined;
  if (looksLikeSnsName(args.recipient)) {
    if (args.chain === "base") return refusal("SNS names point to Solana wallets. Ask on Solana (leave chain out), or give a Base 0x address for a Base request.");
    const named = await resolveName(args.recipient, deps);
    if (!named.ok) return refusal(`${named.message} Nothing was created.`);
    sns = named;
    args = { ...args, recipient: named.wallet };
  }
  // W3-S SNS names end
  // Local-currency asks start: `amount` is in `currency`; Owed's server locks the USDC (Solana USDC only).
  let ask: FiatAsk | undefined;
  if (args.currency !== undefined) {
    if (args.chain === "base") return refusal("Local-currency asks are Solana USDC only for now. Leave chain out, or ask in USDC on Base.");
    const parsed = parseFiatAsk(args.currency, args.amount, args.token);
    if (!parsed.ok) return refusal(parsed.message);
    ask = parsed.ask;
  }
  // Local-currency asks end
  // W3-B Base requests start
  if (args.chain === "base") return askForMoneyOnBase(args, deps);
  if (args.recipient.startsWith("0x")) return refusal('That is a Base (0x) address. To ask for USDC on Base, pass chain: "base"; for Solana, use the user\'s Solana wallet address.');
  // W3-B Base requests end
  if (!deps.isSolanaAddress(args.recipient)) return refusal("recipient must be a Solana wallet address (the user's own PayBox Solana wallet).");
  const token = args.token;
  let atomic = 0n; // a local-currency ask learns its USDC amount from the server's quote
  if (!ask) {
    try {
      atomic = deps.toAtomic(args.amount, token);
    } catch (error) {
      return refusal(`${args.amount} ${token} isn't a valid amount: ${errorText(error, "use a positive decimal amount.")}`);
    }
  }
  let amount = ask ? ask.amount : deps.fromAtomic(atomic, token);
  let fiat: FiatQuoteRes | undefined; // local-currency asks
  const text = {
    payerName: clean(args.payer_name, 40) || undefined,
    forText: clean(args.for, 80) || undefined,
    note: clean(args.note, 140) || undefined,
    requesterName: clean(args.requester_name, 40) || undefined,
  };

  // QA-18: a SOL request to a never-used wallet must reach Solana's minimum; read alongside the DNS check.
  const solMinimum = token === "SOL" ? newWalletMinimum(deps.rpc(), args.recipient) : Promise.resolve(null);
  // W2-E sanctions screen start
  // The screen (≤2.5 s) runs beside the DNS check (≤4 s), never before it, so the API keeps its 4 s of PayBox's 10 s.
  const [screening, check] = await Promise.all([
    deps.screenRecipient(args.recipient, deps),
    // W2-H verified payee start
    args.from_domain !== undefined ? checkFromDomain(args.from_domain, args.recipient, deps, Math.min(ASK_PAYEE_BUDGET_MS, ASK_NAME_AND_DNS_BUDGET_MS - (deps.now() - started))) : undefined, // W3-S: less after a name
    // W2-H verified payee end
  ]);
  if (!screening.ok) return refusal(screening.message);
  // W2-E sanctions screen end

  // W2-H verified payee start
  let fromDomain: { domain: string; lines: string[] } | undefined;
  if (check) {
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
    ...(ask && { currency: ask.code }), // local-currency ask: amount is in this currency
    ...(text.payerName && { payer_name: text.payerName }),
    ...(text.forText && { for: text.forText }),
    ...(text.note && { note: text.note }),
    ...(text.requesterName && { requester_name: text.requesterName }),
    // W2-H verified payee start
    ...(fromDomain && { from_domain: fromDomain.domain }),
    // W2-H verified payee end
    ...(args.expires_in_days !== undefined && { expires_in_days: args.expires_in_days }), // W3-C
    ...(sns && { sns_name: sns.name }), // W3-S
  };

  let created: { id: string | null; mode: "hosted" | "offline"; link: string; solana_pay_url: string; qr_url: string | null; reference: string };
  let expiresAt: string | undefined; // W3-C
  try {
    const res = await ctx.api.createRequest(body);
    // Local-currency ask: the quote must be what was asked and must produce the USDC every link commits to.
    if (ask) {
      const quoted = checkQuote(res.fiat, res.amount, ask);
      if (!quoted.ok) return refusal("Owed's server returned a quote that doesn't match this request, so the link wasn't used. Nothing was created on your side; try again.");
      ({ atomic, amount, fiat } = quoted);
    }
    const mismatch = checkHosted(res, args.recipient, token, atomic, ctx, deps);
    if (mismatch) return refusal(mismatch);
    // W2-H verified payee start
    if (fromDomain && res.from_domain !== fromDomain.domain) {
      return refusal(`Owed's server didn't attach ${fromDomain.domain} to the request, so the link wasn't used. Try again, or ask without from_domain.`);
    }
    // W2-H verified payee end
    // W3-S: the server must have re-resolved and attached the same name.
    if (sns && res.sns_name !== sns.name) {
      return refusal(`Owed's server didn't attach ${sns.name} to the request, so the link wasn't used. Try again, or ask with the wallet address.`);
    }
    // W3-C: the server must have set the expiry that was asked for.
    const expiry = expiryProblem(args.expires_in_days, res.expires_at, deps.now());
    if (expiry) return refusal(expiry);
    if (args.expires_in_days !== undefined && res.expires_at) expiresAt = res.expires_at;
    created = { id: res.id, mode: "hosted", link: res.link, solana_pay_url: res.solana_pay_url as string /* W3-B: checkHosted refuses null */, qr_url: res.qr_url, reference: res.reference };
  } catch (error) {
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't create the request."));
    if (ask) return refusal(fiatApiRefusal(error, "request") ?? apiRefusal(error)); // no offline link: only the server locks a rate
    if (error.code !== "upstream_unavailable") return refusal(apiRefusal(error));
    try {
      created = buildOffline(args.recipient, amount, token, text, ctx, deps);
    } catch (offlineError) {
      return refusal(`Owed's server is unreachable and the offline link couldn't be built: ${errorText(offlineError, "unknown error")}`);
    }
  }

  const share_text = shareText({
    payerName: text.payerName, requesterName: text.requesterName, forText: text.forText, amount, token, link: created.link,
    ...(fiat && { fiat: fiatAmountText(fiat) }), // local-currency asks
  });
  const output: AskOutput = {
    ...created, recipient: args.recipient, amount, token,
    ...(text.payerName && { payer_name: text.payerName }),
    ...(text.forText && { for: text.forText }),
    share_text, status: "open",
    // W2-H verified payee start
    ...(fromDomain && created.mode === "hosted" && { from_domain: fromDomain.domain }),
    // W2-H verified payee end
    // W2-E sanctions screen start
    screening: screening.screening,
    // W2-E sanctions screen end
    ...(expiresAt && { expires_at: expiresAt }), // W3-C
    ...(fiat && { fiat: { currency: fiat.currency, amount: fiat.amount, rate: fiat.rate, rate_source: fiat.rate_source, quoted_at: fiat.quoted_at } }),
    ...(sns && created.mode === "hosted" && { sns_name: sns.name, sns_source: sns.source }), // W3-S
  };
  const from = text.payerName ? ` from ${text.payerName}` : "";
  const forPart = text.forText ? ` for ${quote(text.forText, 80)}` : "";
  const lines = [
    `Request ready: ${fiat ? fiatHeadline(fiat, amount) : `${amount} ${token}`}${from}${forPart}. Send this link: ${created.link}`,
    `Message to send: ${share_text}`,
  ];
  if (fiat) lines.push(fiatRateLine(fiat, amount)); // local-currency asks
  if (created.mode === "offline") {
    lines.push("Owed's server didn't answer, so this is a self-contained link with no short id. It works with any Solana wallet, and check_payments can verify it with the same link.");
  }
  // W2-H verified payee start
  if (fromDomain && created.mode === "hosted") lines.push(...fromDomain.lines);
  if (fromDomain && created.mode === "offline") {
    lines.push(`Offline links can't carry a domain, so payers will see this one as unverified, not as from ${fromDomain.domain}.`);
  }
  // W2-H verified payee end
  // W3-S SNS names start
  if (sns && created.mode === "hosted") lines.push(`Paid to ${snsLead(sns)}.`, ...snsLines(sns));
  if (sns && created.mode === "offline") lines.push(`Paid to ${sns.wallet}, which ${sns.name} points to. Offline links can't carry a name, so payers see the wallet address, not ${sns.name}.`);
  // W3-S SNS names end
  // W2-E sanctions screen start
  if (screening.screening === "unavailable") lines.push(SCREENING_UNAVAILABLE_LINE);
  // W2-E sanctions screen end
  // W3-C expiry
  if (expiresAt && args.expires_in_days !== undefined) lines.push(expiryLine(expiresAt, args.expires_in_days));
  if (created.mode === "offline" && args.expires_in_days !== undefined) lines.push(OFFLINE_NO_EXPIRY);
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
    if (res.solana_pay_url === null) return bad; // W3-B: a Base reply to a Solana ask
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
    case "rate_limited": return rateLimitedText(error.message); // W2-E (QA-07)
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
