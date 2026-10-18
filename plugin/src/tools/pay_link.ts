import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError } from "../api.js";
import { addressSchema, decimalSchema, type GetRequestRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT, type Token } from "../money.js";
import { proposeSolana, proposeX402, solanaOutputSchema, x402OutputSchema } from "../paybox.js";
import type { TransferRequest } from "../solana-pay.js";
import { idMatchesTerms, VERIFIED_ID_LENGTH } from "../request-id.js";
// W2-H verified payee start
import { domainBrandFlags, PAYEE_BUDGET_MS, payeeForPayment } from "../payee.js";
// W2-H verified payee end
// W2-E sanctions screen start
import { SCREENING_UNAVAILABLE_LINE } from "../screen.js";
// W2-E sanctions screen end
import { brandFlags, cautionLine, quote, shortAddress, withoutOwnBrandFlags } from "../text.js";
// W3-B Base requests start
import { evmAddressSchema } from "../contract.js";
import { payBaseRequest } from "../base-request.js";
import { fiatLine, quoteProblem } from "../fiat.js"; // local-currency asks
// W3-B Base requests end
// W3-S SNS names start
import { tokenSchema } from "../contract.js";
import { looksLikeSnsName } from "../sns.js";
import { resolveName, SNS_BUDGET_MS, snsBrandFlags, snsForPayment, snsLead, snsLines } from "../sns-payee.js";
// W3-S SNS names end
import type { PayerInfo } from "../contract.js"; // F1
import { handleCheckBeforeFunding, handleCheckLine, payerLabel } from "../payer.js"; // F1
// F2 funding plan start
import { planIdSchema } from "../contract.js";
import { FEE_RESERVE_LAMPORTS } from "../chain.js";
import { markPlanUsed, planFunding, planResult, PLAN_RECORD_BUDGET_MS, PLAN_USED_BUDGET_MS, PRICE_BUDGET_MS, readUsablePrice, recordPlan } from "../funding.js";
// F2 funding plan end
// F7 pots start
import type { PotContributionRes, PotRes } from "../contract.js";
import { potEnded, potEndedText, potFixedAmounts, potLabel, potTermsProblem } from "../pots.js";
// F7 pots end

export const inputSchema = z.object({
  link: z.string().min(1).max(2048).describe("What to pay: an Owed link or request id, a Solana Pay transfer URL (solana:...), the text of a payment QR code, an SNS name (example.sns) with amount, or a chip-in pot (its board link, pot id or QR code) with amount."), // W3-S: or an SNS name; F7: or a pot
  sender: z.union([addressSchema, evmAddressSchema]).describe("The user's own PayBox Solana wallet address that pays (from list_credentials). Use the same wallet you pass as use_plugin.wallet_id. For a request on Base, the user's Base (0x) wallet address."), // W3-B: 0x for Base
  max_amount: decimalSchema.optional().describe("Optional ceiling in the link's token; the tool refuses if the request asks for more."),
  amount: decimalSchema.optional().describe("Only for links that don't set an amount: how much to send, in token units."),
  rail: z.enum(["solana_pay", "x402"]).optional().describe("How to pay. solana_pay (default): an unsigned Solana transaction from the user's wallet. x402: pay an Owed USDC request at its x402 URL; PayBox pays it over x402 and the facilitator covers the network fee, so no SOL is needed."),
  // W2-H verified payee start
  allow_unverified: z.boolean().optional().describe("Only when the user explicitly accepts it: pay a request that names a domain even though DNS can't be checked right now. Never pays a domain that doesn't publish the wallet."),
  // W2-H verified payee end
  token: tokenSchema.optional().describe("Only when link is an SNS name: the token to send, \"USDC\" (default) or \"SOL\"."), // W3-S
  plan_id: planIdSchema.optional().describe("Only when a funding plan from pay_link or pay_all says so: its plan_id, passed on the pay_link call that ends the plan, so Owed can count plans that led to a payment."), // F2
}).strict();

const PROPOSAL_KEY = "io.paybox/transactionProposal";
/** A Solana transaction proposal (rail solana_pay) or an x402 payment proposal (rail x402). */
export const outputSchema = z.object({
  [PROPOSAL_KEY]: z.union([solanaOutputSchema.shape[PROPOSAL_KEY], x402OutputSchema.shape[PROPOSAL_KEY]]),
}).strict();
export type PayInput = z.output<typeof inputSchema>;

/** Leaves room for process start-up and output inside PayBox's 10 s per-call limit. */
export const PAY_BUDGET_MS = 8500;

export const REFUSE_TRANSACTION_REQUEST = "This is a Solana Pay checkout link (transaction request). Owed pays transfer links only; open it in a wallet app instead.";
export const REFUSE_ALREADY_PAID = "This request is already paid.";

const DESCRIPTION = [
  "Pay someone's payment request: an Owed link or id, or any Solana Pay transfer link or QR text (USDC or SOL).",
  "Use it when the user pastes a link and says \"pay this\" or \"pay Raj's request\".",
  "sender is the user's own PayBox Solana wallet address (from list_credentials). The tool checks the request is still open and that the wallet has the funds plus about 0.003 SOL for fees, then returns an unsigned Solana transaction for the user to approve in PayBox.",
  "It refuses checkout links (Solana Pay transaction requests), paid requests and amounts above max_amount.",
  "With rail \"x402\" (Owed USDC requests only) it checks the request's live x402 challenge pays exactly the same recipient and amount, then returns an x402 payment proposal instead; use it when the user asks to pay over x402 or has no SOL for fees.",
  "Show the user the text preview: it quotes the requester's words as unverified and adds a caution if they mention a brand. Nothing is sent until the user approves in PayBox.",
  // W2-H verified payee start
  "If the request names a domain (from_domain), the tool checks that domain's DNS itself and refuses unless the domain publishes the recipient wallet; a verified domain leads the preview.",
  // W2-H verified payee end
  // W2-E sanctions screen start
  "It also screens the recipient against sanctions lists (Chainalysis) and refuses a listed address before proposing anything.",
  // W2-E sanctions screen end
  "A request on Base (USDC on chain 8453) is paid over x402 from the user's PayBox Base wallet (the facilitator pays the gas); if that can't be offered the tool says how to pay it from a Base wallet. It never builds a Solana transaction for a Base request.", // W3-B
  "To pay an SNS name (\"pay example.sns 2 USDC\"), pass the name as link with amount (and token for SOL): the tool resolves it on Solana itself and proposes a transfer to the wallet it names. A request made for an SNS name is paid only if the name still points to its wallet. .sol names are refused (SNS moved to .sns).", // W3-S
  "If the request carries the requester's X handle, the text ends with a handle check: call PayBox resolve_username with that handle before approving, and don't approve if it resolves to a different wallet than the request pays. To pay several requests with one approval, use pay_all.", // F1
  "To chip in to a pot (start_pot's board link, its 14-character id, or the text of its QR code), pass amount (or the pot's suggested amount is used; a pot that takes fixed amounts accepts only those): the tool checks the pot's id commits to the wallet and token it pays and that it hasn't ended, then makes one contribution just for this payment and proposes it. Pay a pot with pay_link, never pay_all.", // F7 pots
  "If the wallet can't cover the payment, nothing is proposed: the text gives a funding plan instead, the exact PayBox calls that fix it, best first (swap SOL for USDC, bring USDC over from Base, swap another token, buy with MoonPay through get_buy_link, or pay over x402 when only the network fee is short), each ending with pay_link again with the plan's plan_id. Show the user the options and run only the one they pick, one approval at a time, with PayBox check_operation_readiness before each step. A refused request (paid, cancelled, expired, tampered, sanctioned, a payee that doesn't check out) never gets a plan.", // F2
].join(" ");

export interface Resolved {
  /** The Owed request id, when the link is an Owed link (checked against its terms). */
  id?: string;
  request: TransferRequest;
  token: Token;
  /** Requester-written text, raw (untrusted); shown only through quote(). */
  name?: string | null;
  notes: Array<string | null | undefined>;
  flags: string[];
  // W2-H verified payee start
  /** The domain the request claims to come from (server-supplied, untrusted until DNS says so). */
  fromDomain?: string | null;
  // W2-H verified payee end
  /** Local-currency asks: what was asked, shown beside the USDC paid ("₹1,200 · 12.637145 USDC (rate locked …)"). */
  fiatLine?: string;
  // W3-S SNS names start
  /** An Owed request's SNS name (server-supplied, re-resolved before paying). */
  snsName?: string | null;
  /** A name resolved in this call (link was a bare name): already verified. */
  snsResolved?: Extract<Awaited<ReturnType<typeof resolveName>>, { ok: true }>;
  // W3-S SNS names end
  // F1 payer inbox start: labels from the server, never proof.
  /** The requester's own X handle: the agent checks it with resolve_username before approving. */
  requesterHandle?: string | null;
  /** Who the request was addressed to. */
  payer?: PayerInfo | null;
  // F1 payer inbox end
  /** F7 pots: the pot being paid (its id checked against its wallet and token); the contribution is minted later. */
  pot?: { id: string; title: string; deadline: string; recipient: string };
}

export async function payLink(args: PayInput, deps: Deps = defaultDeps) {
  const started = deps.now();
  // W3-B: a 0x sender is checked once the request turns out to be on Base.
  if (!deps.isSolanaAddress(args.sender) && !args.sender.startsWith("0x")) return refusal("sender must be a Solana wallet address (the user's own PayBox Solana wallet).");
  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  // W3-S SNS names start: a bare name is paid to the wallet it names, resolved here and now.
  const x402 = args.rail === "x402";
  let resolved: Resolved;
  let parsed;
  if (looksLikeSnsName(args.link)) {
    if (x402) return refusal(REFUSE_X402_NOT_OWED);
    const named = await resolveName(args.link, deps, SNS_BUDGET_MS);
    if (!named.ok) return refusal(`${named.message} Nothing was sent.`);
    const token = args.token ?? "USDC";
    resolved = {
      request: { recipient: named.wallet, references: [], ...(token === "USDC" && { splToken: USDC_MINT }) },
      token, name: null, notes: [], flags: [], snsResolved: named,
    };
  } else {
  // W3-S SNS names end
  try {
    parsed = deps.parseLink(args.link.trim(), ctx.hosts);
  } catch (error) {
    return refusal(errorText(error, "This isn't a payment link Owed can read."));
  }
  if (parsed.kind === "transaction") return refusal(REFUSE_TRANSACTION_REQUEST);
  if (x402 && parsed.kind !== "owed" && parsed.kind !== "pot") return refusal(REFUSE_X402_NOT_OWED); // F7: a USDC pot pays over x402 too

  if (parsed.kind === "pot") { // F7 pots: checked here; its contribution is minted right before proposing
    const result = await resolvePot(parsed, args, ctx, deps, () => PAY_BUDGET_MS - (deps.now() - started));
    if (typeof result === "string") return refusal(result);
    resolved = result;
  } else if (parsed.kind === "owed") {
    const result = await resolveOwed(parsed.id, ctx, deps);
    if (typeof result === "string") return refusal(result);
    // W3-B Base requests start
    if ("baseRequest" in result) return payBaseRequest(result.baseRequest, parsed.id, args, ctx, deps, PAY_BUDGET_MS - (deps.now() - started));
    // W3-B Base requests end
    resolved = result;
  } else {
    const token = tokenOf(parsed.request);
    if (!token) return refusal("Owed pays USDC or SOL links only.");
    const r = parsed.request;
    // An "owed:<id>" memo is Owed's own tag, not requester text.
    const memo = r.memo?.startsWith("owed:") ? undefined : r.memo;
    resolved = { request: r, token, name: r.label, notes: [r.message, memo], flags: [] };
  }
  } // W3-S: end of "not an SNS name"
  const { request, token } = resolved;
  // W3-S: token names what to send to a bare SNS name; for a link it must agree with the link.
  if (args.token !== undefined && args.token !== token) return refusal(`This link asks for ${token}, not ${args.token}. Nothing was sent.`);
  if (x402 && token !== "USDC") return refusal(REFUSE_X402_NOT_USDC);
  // W3-B: from here on the request is on Solana, so the sender must be a Solana wallet.
  if (!deps.isSolanaAddress(args.sender)) return refusal("This request is on Solana: sender must be the user's own PayBox Solana wallet address, not a 0x address.");

  if (request.recipient === args.sender) return refusal("This request pays your own wallet, so there is nothing to send.");

  let amountAtomic: bigint;
  try {
    if (request.amount !== undefined) { // a bare SNS name never sets one (W3-S)
      amountAtomic = deps.toAtomic(request.amount, token);
      if (args.amount !== undefined && deps.toAtomic(args.amount, token) !== amountAtomic) {
        return refusal(`This link already sets the amount to ${deps.fromAtomic(amountAtomic, token)} ${token}; it can't be changed.`);
      }
    } else {
      if (args.amount === undefined) {
        // W3-S: a bare SNS name
        if (resolved.snsResolved) return refusal(`How much ${token} should go to ${resolved.snsResolved.name}? Ask the user and pass it as amount.`);
        return refusal(`This link doesn't set an amount. Ask the user how much ${token} to send and pass it as amount.`);
      }
      amountAtomic = deps.toAtomic(args.amount, token);
    }
  } catch (error) {
    return refusal(`The amount isn't valid: ${errorText(error, "use a positive decimal amount.")}`);
  }
  const amount = deps.fromAtomic(amountAtomic, token);

  if (args.max_amount !== undefined) {
    let max: bigint;
    try {
      max = deps.toAtomic(args.max_amount, token);
    } catch (error) {
      return refusal(`max_amount isn't valid: ${errorText(error, "use a positive decimal amount.")}`);
    }
    if (amountAtomic > max) {
      return refusal(`This request is for ${amount} ${token}, above your limit of ${deps.fromAtomic(max, token)} ${token}. Nothing was sent.`);
    }
  }

  const remaining = () => PAY_BUDGET_MS - (deps.now() - started);
  // The x402 rail reads the live challenge while the balance check runs.
  const x402Url = x402 && resolved.id ? x402UrlFor(ctx.base, resolved.id) : null;
  const challengeCheck = x402Url
    ? checkX402Challenge(x402Url, { recipient: request.recipient, amountAtomic }, deps, Math.min(X402_CHALLENGE_TIMEOUT_MS, remaining()))
    : null;
  // W2-H verified payee start
  const payeeCheck = payeeForPayment(resolved.fromDomain, request.recipient, args.allow_unverified === true, deps,
    Math.min(PAYEE_BUDGET_MS, PAY_BUDGET_MS - (deps.now() - started)));
  // W2-H verified payee end
  // W3-S: a request made for an SNS name is paid only if the name still points to its wallet (beside the DNS check).
  const snsCheck = snsForPayment(resolved.snsName, request.recipient, args.allow_unverified === true, deps,
    Math.min(SNS_BUDGET_MS, PAY_BUDGET_MS - (deps.now() - started)));
  // W2-E sanctions screen start
  // Beside the balance and DNS checks (≤2.5 s), so it adds no time; a listed recipient is refused before any proposal.
  const screenCheck = deps.screenRecipient(request.recipient, deps);
  // W2-E sanctions screen end
  let readiness;
  try {
    readiness = await within(
      deps.payerReadiness(deps.rpc(), { sender: args.sender, recipient: request.recipient, token, amountAtomic }),
      remaining(), () => null,
    );
  } catch {
    readiness = null;
  }
  // W2-E sanctions screen start
  const screening = await screenCheck;
  if (!screening.ok) return refusal(`${screening.message} Nothing was sent.`);
  // W2-E sanctions screen end
  // W2-H verified payee start
  const payee = await payeeCheck;
  if (!payee.ok) return refusal(payee.refuse);
  // W2-H verified payee end
  // W3-S SNS names start
  const snsPayee = await snsCheck;
  if (!snsPayee.ok) return refusal(snsPayee.refuse);
  const named = resolved.snsResolved;
  const snsLead_ = named ? snsLead(named) : snsPayee.lead;
  const snsText = named ? snsLines(named) : snsPayee.lines;
  // W3-S SNS names end
  if (!readiness) return refusal("Solana couldn't be reached to check your balance. Nothing was sent; try again in a moment.");
  // Over x402 the facilitator pays the network fee, so a wallet without SOL can still pay.
  const feeOnly = x402 && readiness.reason !== undefined && FEE_SHORTFALL.test(readiness.reason);

  // W2-H verified payee start: a brand word in the claimed domain is a caution, as in the requester's text (QA-02)
  // W2-E: a brand word is cleared only by a domain this call just verified over DNS (payee.lead is set only then).
  const caution = cautionLine(withoutOwnBrandFlags(
    [...new Set([...resolved.flags, ...brandFlags(resolved.name, ...resolved.notes), ...domainBrandFlags(resolved.fromDomain), ...snsBrandFlags(named?.name ?? resolved.snsName)])], // W3-S: + brand words in the name
    payee.lead !== null ? resolved.fromDomain : null,
  ));
  // W2-H verified payee end
  const notes = resolved.notes.map((n) => quote(n, 140)).filter(Boolean);
  const name = quote(resolved.name, 40);
  const payeeLines = [...payee.lines.filter((l) => !(snsLead_ && l.startsWith("Payee not verified: no domain"))), ...snsText, // W3-S
    // W2-E sanctions screen start
    screening.screening === "unavailable" ? SCREENING_UNAVAILABLE_LINE : "",
    // W2-E sanctions screen end
    // F1 payer inbox start
    resolved.payer && resolved.payer.wallet !== args.sender
      ? `This request was addressed to ${payerLabel(resolved.payer)} (wallet ${shortAddress(resolved.payer.wallet)}), not to this wallet. Anyone can pay a link, and this settles it; check the user means to pay someone else's request.`
      : "",
    // F1 payer inbox end
  ];
  const lead = `${amount} ${token} to ${payee.lead ?? snsLead_ ?? shortAddress(request.recipient)}`;

  if (!readiness.ok && !feeOnly) {
    const reason = readiness.reason ?? "Your wallet can't cover this payment and its fees.";
    // F2 funding plan start: only a balance shortfall gets a plan (a frozen account or a below-rent first SOL payment
    // can't be funded away, and a double without balances can't be planned). Every refusal above came first.
    if (readiness.blocker !== "funds" || !readiness.funds) return refusal(reason);
    // The plan's last step pays over x402, so what would refuse x402 refuses now, before anyone funds anything.
    if (x402 && !readiness.recipientAtaExists) return refusal(REFUSE_X402_NO_ACCOUNT);
    if (x402 && challengeCheck) { // F7: a pot's x402 endpoint exists only once its contribution is minted, after funding
      const challenge = await challengeCheck;
      if (challenge !== true) return refusal(challenge);
    }
    const price = await readUsablePrice(deps, Math.min(PRICE_BUDGET_MS, remaining() - 1000));
    // F7 pots: the plan's last step pays the same pot link with the same amount; no contribution is minted until then.
    const { plan_id: planIdIn, ...again } = resolved.pot ? { ...args, amount } : args;
    const plan0 = planFunding({
      payTool: "pay_link", payArgs: again, requestIds: resolved.id ? [resolved.id] : [], sender: args.sender,
      sendUsdc: token === "USDC" ? amountAtomic : 0n, sendLamports: token === "SOL" ? amountAtomic : 0n, feeLamports: FEE_RESERVE_LAMPORTS,
      funds: readiness.funds, x402Rail: x402,
      x402Possible: token === "USDC" && (resolved.id !== undefined || resolved.pot !== undefined) && readiness.recipientAtaExists, // F7: + pots
      price,
    });
    if (!plan0) return refusal(reason);
    const plan = await recordPlan(plan0, ctx, planIdIn, Math.min(PLAN_RECORD_BUDGET_MS, remaining() - 300));
    const what = [
      `Paying ${lead}${x402 ? " over x402" : ""}.`,
      resolved.pot ? potLine(resolved.pot) : "", // F7 pots
      resolved.fiatLine ? `Asked as ${resolved.fiatLine}; a quote, not a guarantee. The USDC amount is what is paid.` : "",
      notes.length > 0 ? `Requester's note, unverified: ${notes.join(", ")}.` : "",
      name ? `Requester's name, unverified: ${name}.` : "",
    ].filter(Boolean).join(" ");
    return planResult(plan, again,
      [caution, payee.caution, `${reason} Nothing was sent.`],
      resolved.requesterHandle ? [handleCheckBeforeFunding(resolved.requesterHandle, request.recipient)] : [],
      [what, `Recipient: ${request.recipient}`, ...payeeLines]);
    // F2 funding plan end
  }

  const createRecipientAta = token === "USDC" && !readiness.recipientAtaExists;
  // F7 pots start: every check passed and the wallet can pay, so the contribution is minted now, right before the
  // proposal (a refused or short payer leaves no row), and checked like any request: its id hashes its terms, which
  // are the pot's wallet and token and the amount asked.
  let payRequest = request;
  let payX402Url = x402Url;
  if (resolved.pot) {
    if (x402 && createRecipientAta) return refusal(REFUSE_X402_NO_ACCOUNT);
    const minted = await mintContribution(resolved.pot, amountAtomic, token, ctx, deps, remaining);
    if (typeof minted === "string") return refusal(minted);
    payRequest = minted.request;
    if (x402) payX402Url = x402UrlFor(ctx.base, minted.id);
  }
  // F7 pots end
  let structuredContent;
  if (x402) {
    // An x402 payment can't open the recipient's USDC account the way the Solana Pay transaction does.
    if (createRecipientAta) return refusal(REFUSE_X402_NO_ACCOUNT);
    const challenge = resolved.pot // F7: the minted contribution's own x402 challenge
      ? await checkX402Challenge(payX402Url!, { recipient: request.recipient, amountAtomic }, deps, Math.min(X402_CHALLENGE_TIMEOUT_MS, remaining()))
      : await challengeCheck!;
    if (challenge !== true) return refusal(challenge);
    try {
      structuredContent = proposeX402({ chain: "solana:mainnet", url: payX402Url!, maxAmount: amountAtomic.toString() }).structuredContent;
    } catch (error) {
      return refusal(`Couldn't build the x402 payment: ${errorText(error, "unknown error")}`);
    }
  } else {
    try {
      const built = deps.buildTransferTx({ sender: args.sender, request: payRequest, token, amountAtomic, createRecipientAta });
      structuredContent = proposeSolana({ transactionBase64: built.transactionBase64 }).structuredContent;
    } catch (error) {
      return refusal(`Couldn't build the payment: ${errorText(error, "unknown error")}`);
    }
  }

  const preview = [
    // W2-H verified payee start
    `Pay ${lead}${x402 ? " over x402" : ""}.`, // W3-S: or the verified SNS name
    // W2-H verified payee end
    resolved.pot ? potLine(resolved.pot) : "", // F7 pots
    resolved.fiatLine ? `Asked as ${resolved.fiatLine}; a quote, not a guarantee. The USDC amount is what is paid.` : "", // local-currency asks
    notes.length > 0 ? `Requester's note, unverified: ${notes.join(", ")}.` : "",
    name ? `Requester's name, unverified: ${name}.` : "",
    createRecipientAta ? "This also opens the recipient's USDC account (about 0.002 SOL, paid by you)." : "",
    x402 ? "The x402 facilitator pays the network fee." : "",
    "Approve in PayBox to send.",
  ].filter(Boolean).join(" ");
  // W2-H verified payee start
  const text = [caution, payee.caution, preview, `Recipient: ${request.recipient}`, ...payeeLines,
    resolved.requesterHandle ? handleCheckLine(resolved.requesterHandle, request.recipient) : "", // F1
  ].filter(Boolean).join("\n");
  // W2-H verified payee end
  // F2: the call that ends a funding plan tells Owed's server (best effort, inside the budget).
  await markPlanUsed(args.plan_id, args.sender, ctx, Math.min(PLAN_USED_BUDGET_MS, remaining() - 200));
  return { content: [{ type: "text" as const, text }], structuredContent };
}

export const REFUSE_FIAT_MISMATCH = "This request's local-currency quote doesn't match its USDC amount, so the price it shows can't be trusted. Nothing was sent; ask the requester for a new link.";
export const REFUSE_UNVERIFIABLE = "This is an older Owed link whose payment details can't be checked against its id, so Owed won't pay it. Ask the requester for a new link.";
export const REFUSE_TAMPERED = "This link's payment details don't match its id: the recipient or amount may have been changed after the link was made. Nothing was sent; ask the requester for a new link.";

function tokenOf(r: TransferRequest): Token | null {
  if (r.splToken === undefined) return "SOL";
  return r.splToken === USDC_MINT ? "USDC" : null;
}

async function resolveOwed(id: string, ctx: CallContext, deps: Deps): Promise<Resolved | { baseRequest: GetRequestRes } | string> {
  if (id.length !== VERIFIED_ID_LENGTH) return REFUSE_UNVERIFIABLE;
  let rq: GetRequestRes;
  try {
    rq = await ctx.api.getRequest(id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return `No Owed request has the id ${id}. Check the link with the requester.`;
    if (error instanceof ApiError && error.code === "upstream_unavailable") {
      return "Owed's server is unreachable, so this link can't be resolved right now. Try again shortly, or ask the requester for the Solana Pay link.";
    }
    return `Owed couldn't load this request: ${errorText(error, "unknown error")}`;
  }
  return checkOwedTerms(rq, id, ctx, deps);
}

/**
 * Every check pay_link runs on an Owed request's terms as the server returned them (F1: pay_all runs the same on
 * each request it pays): open, not expired, a Solana Pay URL that pays exactly the request, and an id that is the
 * hash of those terms. A refusal sentence, a Base request (paid elsewhere), or what to pay.
 */
export function checkOwedTerms(rq: GetRequestRes, id: string, ctx: Pick<CallContext, "hosts">, deps: Pick<Deps, "now" | "parseLink" | "toAtomic">): Resolved | { baseRequest: GetRequestRes } | string {
  if (id.length !== VERIFIED_ID_LENGTH) return REFUSE_UNVERIFIABLE;
  if (rq.status === "paid") return REFUSE_ALREADY_PAID;
  if (rq.status === "cancelled") return "This request was cancelled by the requester.";
  // W3-C: the server says expired once expires_at passes; the plugin's own clock refuses it too.
  if (rq.status === "expired" || (rq.expires_at && Date.parse(rq.expires_at) <= deps.now())) {
    return `This request expired${rq.expires_at ? ` at ${rq.expires_at}` : ""} and no longer takes payments. Nothing was sent; ask the requester for a new link.`;
  }
  if (rq.status === "underpaid") {
    const paid = rq.paid ? `${rq.paid.amount} of ${rq.amount} ${rq.token}` : `part of ${rq.amount} ${rq.token}`;
    return `This request already received a partial payment (${paid}). Ask the requester for a new link for the rest.`;
  }
  if (rq.status !== "open") return `This request can't be paid (status: ${rq.status}).`;
  // W3-B Base requests: checked and paid in base-request.ts (x402 on eip155:8453, never a Solana transaction).
  if (rq.chain === "base") return { baseRequest: rq };
  if (rq.solana_pay_url === null) return "Owed's server returned a payment link it can't read. Nothing was sent."; // W3-B

  let parsed;
  try {
    parsed = deps.parseLink(rq.solana_pay_url, ctx.hosts);
  } catch {
    return "Owed's server returned a payment link it can't read. Nothing was sent.";
  }
  const token = parsed.kind === "transfer" ? tokenOf(parsed.request) : null;
  if (parsed.kind !== "transfer" || token !== rq.token || parsed.request.recipient !== rq.recipient
    || parsed.request.amount === undefined || deps.toAtomic(parsed.request.amount, token) !== deps.toAtomic(rq.amount, token)) {
    return "Owed's server returned a payment link that doesn't match the request. Nothing was sent.";
  }
  // The id is a hash of the payment terms, so the server can't swap the recipient or amount
  // behind a link someone already shared: different terms would need a different id.
  if (rq.id !== id || !parsed.request.references.includes(rq.reference)
    || !idMatchesTerms(id, { recipient: rq.recipient, token, amountAtomic: deps.toAtomic(rq.amount, token), reference: rq.reference })) {
    return REFUSE_TAMPERED;
  }
  // Local-currency asks: the quote is display only (the id commits to the USDC), but a quote that doesn't
  // produce exactly this USDC amount would tell the payer a wrong local price, so the request isn't paid.
  if (rq.fiat && quoteProblem(rq.fiat, deps.toAtomic(rq.amount, token)) !== null) return REFUSE_FIAT_MISMATCH;
  return {
    id, request: parsed.request, token,
    ...(rq.fiat && { fiatLine: fiatLine(rq.fiat, rq.amount) }),
    name: rq.requester_name, notes: [rq.for, rq.note], flags: rq.flags,
    // W2-H verified payee start
    fromDomain: rq.from_domain,
    // W2-H verified payee end
    snsName: rq.sns_name, // W3-S
    requesterHandle: rq.requester_handle ?? null, // F1
    payer: rq.payer ?? null,
  };
}

// ---- F7 pots start ----

export const REFUSE_POT_ALL = "pay_all pays requests, not pots: pay a pot with pay_link, one contribution at a time.";
/** Leaves the rest of the budget for the balance check and the proposal. */
const POT_READ_BUDGET_MS = 4000;
const POT_MINT_BUDGET_MS = 3500;

/**
 * A pot link (board, bare id, or Owed's own pot QR code) checked before anything is minted: the pot's id hashes its
 * wallet and token (with the server's nonce), it is open by the server's word and this plugin's clock, and the
 * amount is the one asked (args.amount, the QR code's ?amount=, else the suggested amount) and one the pot takes.
 * Returns what to pay (the pot's wallet and token, no reference yet) or a refusal.
 */
async function resolvePot(link: { id: string; amount?: string }, args: PayInput, ctx: CallContext, deps: Deps, remaining: () => number): Promise<Resolved | string> {
  let pot: PotRes | null;
  try {
    pot = await within(ctx.api.getPot(link.id), Math.min(POT_READ_BUDGET_MS, remaining() - 3000), () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return `No Owed pot has the id ${link.id}. Check the link with the person collecting.`;
    if (error instanceof ApiError && error.httpStatus === 404) return "This Owed server doesn't have chip-in pots yet. Nothing was sent.";
    if (error instanceof ApiError && error.code !== "upstream_unavailable") return `Owed couldn't load this pot: ${error.message}`;
    return "Owed's server is unreachable, so this pot can't be checked right now. Nothing was sent; try again shortly.";
  }
  if (!pot) return "Owed's server didn't answer in time, so this pot can't be checked right now. Nothing was sent; try again shortly.";
  const tampered = potTermsProblem(pot, link.id);
  if (tampered) return tampered;
  if (potEnded(pot, deps.now())) return potEndedText(pot);
  const token = pot.token;
  let asked: bigint | null = null;
  try {
    const fromArgs = args.amount === undefined ? null : deps.toAtomic(args.amount, token);
    const fromLink = link.amount === undefined ? null : deps.toAtomic(link.amount, token);
    if (fromArgs !== null && fromLink !== null && fromArgs !== fromLink) {
      return `This pot link asks for ${deps.fromAtomic(fromLink, token)} ${token}; it can't be changed. Use the pot's board link to give another amount. Nothing was sent.`;
    }
    asked = fromArgs ?? fromLink ?? (pot.suggested === null ? null : deps.toAtomic(pot.suggested, token));
  } catch (error) {
    return `The amount isn't valid: ${errorText(error, "use a positive decimal amount.")}`;
  }
  const fixed = potFixedAmounts(pot, deps);
  if (asked === null) {
    return `How much ${token} should go to ${potLabel(pot.title)}? Ask the user and pass it as amount${pot.any_amount ? "" : ` (this pot takes ${fixed.map((a) => `${deps.fromAtomic(a, token)} ${token}`).join(", ")} only)`}. Nothing was sent.`;
  }
  if (!pot.any_amount && !fixed.includes(asked)) {
    return `This pot takes ${fixed.map((a) => `${deps.fromAtomic(a, token)} ${token}`).join(", ")} only, not ${deps.fromAtomic(asked, token)} ${token}. Nothing was sent.`;
  }
  return {
    request: { recipient: pot.recipient, amount: deps.fromAtomic(asked, token), references: [], ...(token === "USDC" && { splToken: USDC_MINT }) },
    token, name: pot.requester_name, notes: [pot.note], flags: pot.flags,
    requesterHandle: pot.requester_handle,
    pot: { id: pot.id, title: pot.title, deadline: pot.deadline, recipient: pot.recipient },
  };
}

/** "A contribution to the pot "…" (the requester's words, unverified), open until …." */
function potLine(pot: NonNullable<Resolved["pot"]>): string {
  return `A contribution to ${potLabel(pot.title)}, which takes contributions until ${pot.deadline}.`;
}

/**
 * Mint the contribution (POST /pots/:id/contributions) and check it like any Owed request (checkOwedTerms: open, a
 * Solana Pay URL paying exactly it, an id that hashes its terms), plus: it pays the pot's wallet and token, the amount
 * asked, and names this pot. Its reference and memo then go into the proposal.
 */
async function mintContribution(
  pot: NonNullable<Resolved["pot"]>, amountAtomic: bigint, token: Token, ctx: CallContext, deps: Deps, remaining: () => number,
): Promise<{ id: string; request: TransferRequest } | string> {
  let rq: PotContributionRes | null;
  try {
    rq = await within(ctx.api.contribute(pot.id, { amount: deps.fromAtomic(amountAtomic, token), source: "plugin" }), Math.min(POT_MINT_BUDGET_MS, remaining() - 800), () => null);
  } catch (error) {
    if (error instanceof ApiError && error.code === "rate_limited") return `Owed is limiting new contributions to this pot right now: ${error.message}. Nothing was sent; try again in a few minutes.`;
    if (error instanceof ApiError && error.code === "invalid_input") return `Owed refused the contribution: ${error.message} Nothing was sent.`;
    if (error instanceof ApiError && error.code === "blocked") return `${error.message} Nothing was sent.`;
    return "Owed's server couldn't make this contribution right now. Nothing was sent; try again shortly.";
  }
  if (!rq) return "Owed's server didn't answer in time while making this contribution. Nothing was sent; try again.";
  const checked = checkOwedTerms(rq, rq.id, ctx, deps);
  if (typeof checked === "string") return checked;
  if ("baseRequest" in checked) return "Owed's server returned a contribution on another chain. Nothing was sent.";
  if (rq.pot.id !== pot.id || checked.request.recipient !== pot.recipient || checked.token !== token
    || deps.toAtomic(rq.amount, token) !== amountAtomic || (rq.kind ?? "single") !== "single") {
    return "Owed's server returned a contribution that doesn't match this pot or amount, so it wasn't paid. Nothing was sent.";
  }
  return { id: rq.id, request: checked.request };
}
// ---- F7 pots end ----

// ---- x402 rail (SPEC §5.2 T2.2) ----

export const REFUSE_X402_NOT_OWED = "x402 pays Owed requests only (an Owed link or id). Pay this link with rail solana_pay.";
export const REFUSE_X402_NOT_USDC = "x402 pays USDC requests only. Pay this request with rail solana_pay.";
export const REFUSE_X402_NO_ACCOUNT = "The recipient has no USDC account yet, and an x402 payment can't open one. Pay with rail solana_pay, which opens it (about 0.002 SOL).";
export const REFUSE_X402_MISMATCH = "This request's x402 endpoint asks for a different payment than the request itself (recipient, amount or asset). Nothing was sent.";
export const X402_CHALLENGE_TIMEOUT_MS = 3000;
const FEE_SHORTFALL = /needs about [0-9.]+ SOL for fees/;
const X402_NETWORK_V2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const X402_NETWORK_V1 = "solana";

export function x402UrlFor(base: string, id: string): string {
  return `${base}/x/${encodeURIComponent(id)}`;
}

function decodeBase64Json(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function entries(doc: unknown): Array<Record<string, unknown>> | null {
  const accepts = (doc as { accepts?: unknown } | null | undefined)?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  return accepts.every((a) => typeof a === "object" && a !== null) ? accepts as Array<Record<string, unknown>> : null;
}

/**
 * PayBox fetches the challenge again when it pays, so this can't pin what it pays; it does
 * refuse before proposing if the server's challenge disagrees with the id-checked request.
 * Every option in both x402 generations must pay exactly the request's recipient and amount.
 */
export async function checkX402Challenge(
  url: string,
  expect: { recipient: string; amountAtomic: bigint },
  deps: Pick<Deps, "fetch">,
  timeoutMs: number,
): Promise<true | string> {
  let res: Response;
  try {
    res = await deps.fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)), redirect: "error" });
  } catch {
    return "Owed's x402 endpoint couldn't be reached. Nothing was sent; try again, or pay with rail solana_pay.";
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 200 && (body as { paid?: unknown } | undefined)?.paid === true) return REFUSE_ALREADY_PAID;
  if (res.status !== 402) {
    const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
    return `Owed's x402 endpoint can't take this payment (HTTP ${res.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}). Nothing was sent.`;
  }
  const amount = expect.amountAtomic.toString();
  const v2 = entries(decodeBase64Json(res.headers.get("payment-required")));
  const v1 = entries(body);
  if (!v2 && !v1) return "Owed's x402 endpoint returned a challenge Owed can't read. Nothing was sent.";
  const ok =
    (v2 ?? []).every((a) => a.scheme === "exact" && a.network === X402_NETWORK_V2 && a.asset === USDC_MINT && a.payTo === expect.recipient && a.amount === amount)
    && (v1 ?? []).every((a) => a.scheme === "exact" && a.network === X402_NETWORK_V1 && a.asset === USDC_MINT && a.payTo === expect.recipient && a.maxAmountRequired === amount);
  return ok ? true : REFUSE_X402_MISMATCH;
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("pay_link", {
    title: "Pay a payment request",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args) => payLink(args, deps));
}
