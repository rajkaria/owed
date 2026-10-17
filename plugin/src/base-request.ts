import { ApiError } from "./api.js";
import type { CreateRequestReq, CreateRequestRes, GetRequestRes } from "./contract.js";
import { callContext, errorText, refusal, type CallContext, type Deps } from "./deps.js";
import { BASE_CAIP2, BASE_USDC, eip681Transfer, isHexAddress, parseEvmAddress, sameEvmAddress } from "./evm.js";
import { checkFromDomain, domainBrandFlags, PAYEE_BUDGET_MS, payeeForPayment } from "./payee.js";
import { proposeX402 } from "./paybox.js";
import { idMatchesTerms, VERIFIED_ID_LENGTH } from "./request-id.js";
import { brandFlags, cautionLine, clean, quote, shortAddress } from "./text.js";
import { expiryLine, expiryProblem } from "./expiry.js"; // W3-C on Base

// W3-B Base requests, plugin side. USDC on Base (eip155:8453):
// - ask_for_money with chain "base" creates a hosted request whose link opens an EIP-681 USDC
//   transfer; there is no offline fallback, because only the server reads Base for its status.
// - pay_link on a Base request proposes an x402 payment on eip155:8453 through the request's
//   /x/<id> endpoint (PayBox pays from its Base wallet; the facilitator pays the gas), or, when
//   that can't be offered, says to pay the EIP-681 link from a Base wallet. Never a Solana proposal.
// The plugin never reads Base itself, so no new network host: everything goes through Owed's API,
// and every term the server returns is checked against the id (a hash of the terms, chain included).

export const BASE_DESCRIPTION = 'chain "base" asks for USDC on Base instead: recipient is then the user\'s Base (0x) address, and the payer pays from any Base wallet (MetaMask, Coinbase Wallet, Phantom) or their PayBox agent over x402.';

export const REFUSE_BASE_OFFLINE = "Owed's server is unreachable, and a Base request needs it (Owed reads Base for its status). Nothing was created; try again in a moment, or ask on Solana.";
export const REFUSE_BASE_TAMPERED = "This Base request's payment details don't match its id: the recipient or amount may have been changed after the link was made. Nothing was sent; ask the requester for a new link.";
export const REFUSE_BASE_SOLANA_RAIL = "This request is on Base, so it can't be paid with a Solana transaction.";

export interface BaseAskArgs {
  recipient: string;
  amount: string;
  token: "USDC" | "SOL";
  payer_name?: string;
  for?: string;
  note?: string;
  requester_name?: string;
  from_domain?: string;
  expires_in_days?: number; // W3-C
}

/** The Base share message: same shape as text.ts shareText, with "any Base wallet". Inputs already clean()ed. */
export function baseShareText(i: { payerName?: string; requesterName?: string; forText?: string; amount: string; link: string }): string {
  const greeting = i.payerName
    ? (i.requesterName ? `Hey ${i.payerName}, it's ${i.requesterName}.` : `Hey ${i.payerName}!`)
    : (i.requesterName ? `Hi, it's ${i.requesterName}.` : "Hi!");
  const ask = i.forText
    ? `Your share for "${i.forText.replace(/"/g, "'")}" is ${i.amount} USDC on Base.`
    : `This is a request for ${i.amount} USDC on Base.`;
  return `${greeting} ${ask} Pay from any Base wallet here: ${i.link}`;
}

/** ask_for_money with chain "base". */
export async function askForMoneyOnBase(args: BaseAskArgs, deps: Deps) {
  const recipient = parseEvmAddress(args.recipient);
  if (!recipient) {
    return refusal(isHexAddress(args.recipient.trim())
      ? "That Base address has a wrong checksum (its mixed upper/lower case doesn't match). Copy it again from the wallet; nothing was created."
      : "With chain \"base\", recipient must be the user's own Base (0x…) wallet address.");
  }
  if (args.token !== "USDC") return refusal("Base requests are USDC only. Ask for USDC, or use chain \"solana\" for SOL.");
  let atomic: bigint;
  try {
    atomic = deps.toAtomic(args.amount, "USDC");
  } catch (error) {
    return refusal(`${args.amount} USDC isn't a valid amount: ${errorText(error, "use a positive decimal amount.")}`);
  }
  const amount = deps.fromAtomic(atomic, "USDC");
  const text = {
    payerName: clean(args.payer_name, 40) || undefined,
    forText: clean(args.for, 80) || undefined,
    note: clean(args.note, 140) || undefined,
    requesterName: clean(args.requester_name, 40) || undefined,
  };

  let fromDomain: { domain: string; lines: string[] } | undefined;
  if (args.from_domain !== undefined) {
    const check = await checkFromDomain(args.from_domain, recipient, deps, 4000);
    if (!check.ok) return refusal(check.message);
    fromDomain = { domain: check.from_domain, lines: check.lines };
  }

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }
  const body: CreateRequestReq = {
    recipient, amount, token: "USDC", source: "plugin", chain: "base",
    ...(text.payerName && { payer_name: text.payerName }),
    ...(text.forText && { for: text.forText }),
    ...(text.note && { note: text.note }),
    ...(text.requesterName && { requester_name: text.requesterName }),
    ...(fromDomain && { from_domain: fromDomain.domain }),
    ...(args.expires_in_days !== undefined && { expires_in_days: args.expires_in_days }), // W3-C
  };

  let res: CreateRequestRes;
  try {
    res = await ctx.api.createRequest(body);
  } catch (error) {
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't create the request."));
    if (error.code === "upstream_unavailable") return refusal(REFUSE_BASE_OFFLINE);
    if (error.code === "rate_limited") return refusal("Owed is limiting new requests for this wallet right now. Try again in a few minutes.");
    return refusal(`Owed rejected the request: ${error.message}`);
  }
  // The server builds what the payer pays; refuse a link that pays anyone or anything else.
  const payUrl = eip681Transfer(recipient, atomic);
  let linkOk = false;
  try {
    linkOk = new URL(res.link).protocol === "https:";
  } catch {
    linkOk = false;
  }
  if (!linkOk || res.chain !== "base" || res.pay_url !== payUrl || res.solana_pay_url !== null
    || !idMatchesTerms(res.id, { recipient, token: "USDC", amountAtomic: atomic, reference: res.reference, chain: "base" })) {
    return refusal("Owed's server returned a payment link that doesn't match this request, so it wasn't used. Try again.");
  }
  if (fromDomain && res.from_domain !== fromDomain.domain) {
    return refusal(`Owed's server didn't attach ${fromDomain.domain} to the request, so the link wasn't used. Try again, or ask without from_domain.`);
  }
  // W3-C: the server must have set the expiry that was asked for.
  const expiry = expiryProblem(args.expires_in_days, res.expires_at, deps.now());
  if (expiry) return refusal(expiry);
  const expiresAt = args.expires_in_days !== undefined && res.expires_at ? res.expires_at : undefined;

  const share_text = baseShareText({ ...text, amount, link: res.link });
  const output = {
    id: res.id, mode: "hosted" as const, link: res.link, solana_pay_url: null, qr_url: res.qr_url, reference: res.reference,
    recipient, amount, token: "USDC" as const,
    ...(text.payerName && { payer_name: text.payerName }),
    ...(text.forText && { for: text.forText }),
    share_text, status: "open" as const,
    ...(fromDomain && { from_domain: fromDomain.domain }),
    chain: "base" as const, pay_url: payUrl,
    ...(expiresAt && { expires_at: expiresAt }), // W3-C
  };
  const from = text.payerName ? ` from ${text.payerName}` : "";
  const forPart = text.forText ? ` for ${quote(text.forText, 80)}` : "";
  const lines = [
    `Request ready: ${amount} USDC on Base${from}${forPart}. Send this link: ${res.link}`,
    `Message to send: ${share_text}`,
    `It pays ${shortAddress(recipient)} on Base (USDC ${shortAddress(BASE_USDC)}). check_payments reads it from Base.`,
    ...(fromDomain ? fromDomain.lines : []),
    ...(expiresAt && args.expires_in_days !== undefined ? [expiryLine(expiresAt, args.expires_in_days)] : []), // W3-C
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

/** A Base request's terms, checked against its id and its EIP-681 link; a refusal string if anything disagrees. */
export function checkBaseTerms(rq: GetRequestRes, id: string, deps: Pick<Deps, "toAtomic">): { recipient: string; amountAtomic: bigint } | string {
  if (rq.id !== id || id.length !== VERIFIED_ID_LENGTH) return REFUSE_BASE_TAMPERED;
  const recipient = parseEvmAddress(rq.recipient);
  if (!recipient || recipient !== rq.recipient || rq.token !== "USDC") return REFUSE_BASE_TAMPERED;
  let amountAtomic: bigint;
  try {
    amountAtomic = deps.toAtomic(rq.amount, "USDC");
  } catch {
    return REFUSE_BASE_TAMPERED;
  }
  if (rq.pay_url !== eip681Transfer(recipient, amountAtomic)) return REFUSE_BASE_TAMPERED;
  if (!idMatchesTerms(id, { recipient, token: "USDC", amountAtomic, reference: rq.reference, chain: "base" })) return REFUSE_BASE_TAMPERED;
  return { recipient, amountAtomic };
}

export const X402_BASE_NETWORK_V1 = "base";

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

const same = (a: unknown, b: string) => typeof a === "string" && sameEvmAddress(a, b);

/**
 * The live /x/<id> challenge must offer only exact USDC payments on Base of exactly this amount to
 * exactly this recipient, in both x402 generations. true, "paid", or why not.
 */
export async function checkBaseX402Challenge(
  url: string, expect: { recipient: string; amountAtomic: bigint }, deps: Pick<Deps, "fetch">, timeoutMs: number,
): Promise<true | "paid" | string> {
  let res: Response;
  try {
    res = await deps.fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)), redirect: "error" });
  } catch {
    return "Owed's x402 endpoint couldn't be reached";
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 200 && (body as { paid?: unknown } | undefined)?.paid === true) return "paid";
  if (res.status !== 402) {
    const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
    return `Owed's x402 endpoint can't take it (HTTP ${res.status}${typeof message === "string" ? `: ${clean(message, 160)}` : ""})`;
  }
  const amount = expect.amountAtomic.toString();
  const v2 = entries(decodeBase64Json(res.headers.get("payment-required")));
  const v1 = entries(body);
  if (!v2 && !v1) return "Owed's x402 endpoint returned a challenge Owed can't read";
  const ok =
    (v2 ?? []).every((a) => a.scheme === "exact" && a.network === BASE_CAIP2 && same(a.asset, BASE_USDC) && same(a.payTo, expect.recipient) && a.amount === amount)
    && (v1 ?? []).every((a) => a.scheme === "exact" && a.network === X402_BASE_NETWORK_V1 && same(a.asset, BASE_USDC) && same(a.payTo, expect.recipient) && a.maxAmountRequired === amount);
  return ok ? true : "mismatch";
}

export interface BasePayArgs {
  sender: string;
  max_amount?: string;
  amount?: string;
  rail?: "solana_pay" | "x402";
  allow_unverified?: boolean;
}

/** pay_link on a Base request (already status-checked by resolveOwed: open, 12-char id). */
export async function payBaseRequest(rq: GetRequestRes, id: string, args: BasePayArgs, ctx: CallContext, deps: Deps, budgetMs: number) {
  const started = deps.now();
  const terms = checkBaseTerms(rq, id, deps);
  if (typeof terms === "string") return refusal(terms);
  const { recipient, amountAtomic } = terms;
  const amount = deps.fromAtomic(amountAtomic, "USDC");
  const walletLink = eip681Transfer(recipient, amountAtomic);
  const pageLink = `${ctx.base}/r/${encodeURIComponent(id)}`;
  const fromWallet = `Pay it from a Base wallet instead (MetaMask, Coinbase Wallet, Phantom): open ${pageLink} and scan its QR, or open ${walletLink}`;

  if (args.rail === "solana_pay") return refusal(`${REFUSE_BASE_SOLANA_RAIL} Pay it with rail "x402" (PayBox pays from your Base wallet), or ${fromWallet.charAt(0).toLowerCase()}${fromWallet.slice(1)}.`);
  if (sameEvmAddress(args.sender, recipient)) return refusal("This request pays your own wallet, so there is nothing to send.");
  try {
    if (args.amount !== undefined && deps.toAtomic(args.amount, "USDC") !== amountAtomic) {
      return refusal(`This link already sets the amount to ${amount} USDC; it can't be changed.`);
    }
    if (args.max_amount !== undefined) {
      const max = deps.toAtomic(args.max_amount, "USDC");
      if (amountAtomic > max) return refusal(`This request is for ${amount} USDC, above your limit of ${deps.fromAtomic(max, "USDC")} USDC. Nothing was sent.`);
    }
  } catch (error) {
    return refusal(`The amount isn't valid: ${errorText(error, "use a positive decimal amount.")}`);
  }

  const remaining = () => budgetMs - (deps.now() - started);
  const x402Url = `${ctx.base}/x/${encodeURIComponent(id)}`;
  const [payee, challenge] = await Promise.all([
    payeeForPayment(rq.from_domain, recipient, args.allow_unverified === true, deps, Math.min(PAYEE_BUDGET_MS, remaining())),
    checkBaseX402Challenge(x402Url, { recipient, amountAtomic }, deps, Math.min(3000, remaining())),
  ]);
  if (!payee.ok) return refusal(payee.refuse);
  if (challenge === "paid") return refusal("This request is already paid.");
  if (challenge === "mismatch") {
    return refusal(`This request's x402 endpoint asks for a different payment than the request itself (recipient, amount or asset), so Owed won't propose it. Nothing was sent. ${fromWallet}, after checking it pays ${amount} USDC to ${recipient}.`);
  }
  if (challenge !== true) return refusal(`Owed can't offer this Base payment to PayBox right now (${challenge}). Nothing was sent. ${fromWallet}.`);

  let structuredContent;
  try {
    structuredContent = proposeX402({ chain: BASE_CAIP2, url: x402Url, maxAmount: amountAtomic.toString() }).structuredContent;
  } catch (error) {
    return refusal(`Couldn't build the x402 payment: ${errorText(error, "unknown error")}. ${fromWallet}.`);
  }
  // Brand words in the requester's text or in the claimed domain are a caution, as on Solana (QA-02).
  const caution = cautionLine([...new Set([...rq.flags, ...brandFlags(rq.requester_name, rq.for, rq.note), ...domainBrandFlags(rq.from_domain)])]);
  const notes = [rq.for, rq.note].map((n) => quote(n, 140)).filter(Boolean);
  const name = quote(rq.requester_name, 40);
  const preview = [
    `Pay ${amount} USDC on Base to ${payee.lead ?? shortAddress(recipient)} over x402.`,
    notes.length > 0 ? `Requester's note, unverified: ${notes.join(", ")}.` : "",
    name ? `Requester's name, unverified: ${name}.` : "",
    `PayBox pays from your Base wallet, which needs ${amount} USDC on Base; the x402 facilitator pays the gas.`,
    "Approve in PayBox to send.",
  ].filter(Boolean).join(" ");
  const text = [caution, payee.caution, preview, `Recipient: ${recipient} (Base)`, ...payee.lines].filter(Boolean).join("\n");
  return { content: [{ type: "text" as const, text }], structuredContent };
}
