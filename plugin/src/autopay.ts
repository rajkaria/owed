import type { AutopayRule, GetRequestRes, InboxEntry, InboxRes } from "./contract.js";
import { within, type CallContext, type Deps } from "./deps.js";
import { fromAtomic, toAtomic, USDC_MINT } from "./money.js";
import { checkOwedTerms, REFUSE_ALREADY_PAID, REFUSE_X402_MISMATCH, x402UrlFor } from "./tools/pay_link.js";
import { signatureMatches } from "./tools/who_owes_me.js";

// F5 autopay within policy, the plugin's side. A payer's rule ("pay @landlord's monthly request up to 1,500 USDC") is
// data on Owed's server; Owed never pays anything. set_autopay stores the rule after the payer's wallet signs it;
// what_do_i_owe shows which open requests it covers and, for eligible ones, hands the agent the exact PayBox pay_x402
// call. PayBox runs it inside the user's own grant and limits (it may still ask for approval).
//
// The rule message is the server's grammar exactly (web/lib/autopay-core.ts autopayPrefix):
//   "Owed autopay for <payer>: pay <requester> up to <max> USDC per request and <max_month> USDC per month until <YYYY-MM-DD> (at <ISO time>)"
//   "Owed autopay revoke <rule id> for <payer> at <ISO time>"
// Amounts are written as fromAtomic writes them. Nothing here runs at module load (no clock, no randomness).

export const AUTOPAY_MESSAGE_VALID_MS = 5 * 60_000;
const MAX_SKEW_MS = 60_000;
export const AUTOPAY_MAX_ATOMIC = 1_000_000_000_000n;
const DAY_MS = 86_400_000;
export const X402_NETWORK_V2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const X402_NETWORK_V1 = "solana";

/** "2026-10-18T10:15:00Z": whole seconds, UTC. */
export function isoSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface RuleTerms {
  payer: string;
  requester: string;
  maxPerRequestAtomic: bigint;
  maxPerMonthAtomic: bigint;
  /** The rule's last day, YYYY-MM-DD (UTC). */
  ends: string;
}

export function autopayPrefix(t: RuleTerms): string {
  return `Owed autopay for ${t.payer}: pay ${t.requester} up to ${fromAtomic(t.maxPerRequestAtomic, "USDC")} USDC per request and ${fromAtomic(t.maxPerMonthAtomic, "USDC")} USDC per month until ${t.ends}`;
}

export function autopayMessage(t: RuleTerms, nowMs: number): string {
  return `${autopayPrefix(t)} (at ${isoSecond(nowMs)})`;
}

export function revokeMessage(ruleId: string, payer: string, nowMs: number): string {
  return `Owed autopay revoke ${ruleId} for ${payer} at ${isoSecond(nowMs)}`;
}

/** Midnight UTC of a YYYY-MM-DD date, or null. */
export function dayStart(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}

/** The latest last day: the same date a year later (Feb 29 → Mar 1), as the server allows. */
export function latestEnds(nowMs: number): string {
  const n = new Date(nowMs);
  return isoDate(Date.UTC(n.getUTCFullYear() + 1, n.getUTCMonth(), n.getUTCDate()));
}

/** null when `ends` is a date from today to a year from today; otherwise why not. */
export function endsProblem(ends: string, nowMs: number): string | null {
  const start = dayStart(ends);
  if (start === null) return "ends must be a date written YYYY-MM-DD.";
  if (start < dayStart(isoDate(nowMs))!) return `ends (${ends}) is in the past; give the rule's last day, today (${isoDate(nowMs)}) or later.`;
  const latest = latestEnds(nowMs);
  if (start > dayStart(latest)!) return `A rule can last at most a year: ends ${latest} at the latest.`;
  return null;
}

/** The last day of a rule lasting `months` from the day of `nowMs`: the same date that many months on, kept in that month. */
export function endsAfterMonths(months: number, nowMs: number): string {
  const n = new Date(nowMs);
  const y = n.getUTCFullYear();
  const m = n.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoDate(Date.UTC(y, m, Math.min(n.getUTCDate(), lastDay)));
}

/** null when the two limits are acceptable; otherwise why not. */
export function limitProblem(maxPerRequest: bigint, maxPerMonth: bigint): string | null {
  if (maxPerRequest > AUTOPAY_MAX_ATOMIC) return "max_per_request can be at most 1000000 USDC.";
  if (maxPerMonth > AUTOPAY_MAX_ATOMIC) return "max_per_month can be at most 1000000 USDC.";
  if (maxPerMonth < maxPerRequest) return "max_per_month must be at least max_per_request.";
  return null;
}

/** The "(at <ISO>)" time of a create message, or null. */
export function signedAtOf(message: string): number | null {
  const m = / \(at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\)$/.exec(message);
  if (!m) return null;
  const t = Date.parse(m[1]!);
  return Number.isFinite(t) ? t : null;
}

/** null when a freshly signed message looks right (signed `lead…`, within 5 minutes, by `signer`); else why not. */
export function freshSignatureProblem(message: string, signedAt: number | null, signature: string, signer: string, nowMs: number): string | null {
  if (signedAt === null) return "it doesn't end with the time it was made";
  if (nowMs - signedAt > AUTOPAY_MESSAGE_VALID_MS) return "it is more than 5 minutes old";
  if (signedAt - nowMs > MAX_SKEW_MS) return "it is dated in the future";
  if (!signatureMatches(message, signature, signer)) return `the signature isn't from wallet ${signer} over this exact message`;
  return null;
}

const SIGNED_RULE = /^Owed autopay for ([1-9A-HJ-NP-Za-km-z]{32,44}): pay ([1-9A-HJ-NP-Za-km-z]{32,44}) up to ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) USDC per request and ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?) USDC per month until (\d{4}-\d{2}-\d{2}) \(at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\)$/;

/** What a signed rule message says, read back from its exact text; null if it isn't one. */
export function parseSignedRule(message: string): (RuleTerms & { signedAtMs: number; endsAtMs: number }) | null {
  const m = SIGNED_RULE.exec(message);
  if (!m) return null;
  try {
    const terms: RuleTerms = { payer: m[1]!, requester: m[2]!, maxPerRequestAtomic: toAtomic(m[3]!, "USDC"), maxPerMonthAtomic: toAtomic(m[4]!, "USDC"), ends: m[5]! };
    // Only the canonical form is the server's grammar ("1500", not "1500.00").
    if (autopayPrefix(terms) !== message.slice(0, message.lastIndexOf(" (at "))) return null;
    const start = dayStart(terms.ends);
    if (start === null) return null;
    return { ...terms, signedAtMs: Date.parse(m[6]!), endsAtMs: start + DAY_MS };
  } catch {
    return null;
  }
}

/**
 * Defence in depth for an eligible line: the rule the server names must be one this payer signed (signature checked
 * here), naming this request's recipient, still running, and allowing at least this amount per request. The server
 * could only make the plugin hand out a call the payer's own signed rule allows. null when it checks out.
 */
export function signedRuleProblem(rule: AutopayRule | undefined, payer: string, recipient: string, amountAtomic: bigint, nowMs: number): string | null {
  if (!rule) return "Owed's server named a rule it didn't list";
  const signed = parseSignedRule(rule.signed_message);
  if (!signed || signed.payer !== payer) return "the rule's signed text isn't one this wallet's rule would have";
  if (!signatureMatches(rule.signed_message, rule.signature, payer)) return "the rule's signature isn't this wallet's";
  if (signed.requester !== recipient || rule.requester.wallet !== recipient) return "the signed rule names a different wallet than this request pays";
  if (amountAtomic > signed.maxPerRequestAtomic) return "the request is above the signed rule's maximum per request";
  if (nowMs >= signed.endsAtMs) return "the signed rule has ended";
  return null;
}

// ---------------------------------------------------------------------------------------------- x402

function decodeBase64Json(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

type Doc = { accepts: Array<Record<string, unknown>>; resource?: unknown; x402Version?: unknown };

function asDoc(doc: unknown): Doc | null {
  const accepts = (doc as { accepts?: unknown } | null | undefined)?.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0 || accepts.length > 8) return null;
  if (!accepts.every((a) => typeof a === "object" && a !== null && !Array.isArray(a))) return null;
  return doc as Doc;
}

export type Challenge =
  | { ok: true; x402Version: 2; accepts: Array<Record<string, unknown>>; resource: Record<string, unknown> }
  | { ok: true; x402Version: 1; accepts: Array<Record<string, unknown>> }
  | { ok: false; message: string };

/**
 * GET the request's x402 resource and read its 402 challenge, under the same rule as pay_link's x402 rail
 * (tools/pay_link.ts checkX402Challenge): every option in both generations must pay exactly this recipient this amount,
 * in USDC on Solana, scheme exact. Returns the challenge verbatim (v2 from PAYMENT-REQUIRED, with its resource block;
 * else v1 from the body) so the agent can pass it to PayBox pay_x402 unchanged.
 */
export async function readX402Challenge(
  url: string, expect: { id: string; recipient: string; amountAtomic: bigint; hosts: readonly string[] }, deps: Pick<Deps, "fetch">, timeoutMs: number,
): Promise<Challenge> {
  let res: Response;
  try {
    res = await deps.fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(Math.max(1, timeoutMs)), redirect: "error" });
  } catch {
    return { ok: false, message: "Owed's x402 endpoint couldn't be reached just now." };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 200 && (body as { paid?: unknown } | undefined)?.paid === true) return { ok: false, message: REFUSE_ALREADY_PAID };
  if (res.status !== 402) return { ok: false, message: `Owed's x402 endpoint can't take this payment (HTTP ${res.status}).` };
  const amount = expect.amountAtomic.toString();
  const v2 = asDoc(decodeBase64Json(res.headers.get("payment-required")));
  const v1 = asDoc(body);
  if (!v2 && !v1) return { ok: false, message: "Owed's x402 endpoint returned a challenge Owed can't read." };
  const ok =
    (v2?.accepts ?? []).every((a) => a.scheme === "exact" && a.network === X402_NETWORK_V2 && a.asset === USDC_MINT && a.payTo === expect.recipient && a.amount === amount)
    && (v1?.accepts ?? []).every((a) => a.scheme === "exact" && a.network === X402_NETWORK_V1 && a.asset === USDC_MINT && a.payTo === expect.recipient && a.maxAmountRequired === amount);
  if (!ok) return { ok: false, message: REFUSE_X402_MISMATCH };
  if (v2) {
    const resource = v2.resource;
    if (typeof resource !== "object" || resource === null || Array.isArray(resource) || !isOwedResource((resource as { url?: unknown }).url, expect)) {
      return { ok: false, message: "Owed's x402 challenge names a different resource than this request's." };
    }
    return { ok: true, x402Version: 2, accepts: v2.accepts, resource: resource as Record<string, unknown> };
  }
  return { ok: true, x402Version: 1, accepts: v1!.accepts };
}

/** The v2 resource is this request's /x/<id> on an Owed host (the server names its public origin, which may differ). */
function isOwedResource(value: unknown, expect: { id: string; hosts: readonly string[] }): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && expect.hosts.includes(u.host) && u.pathname === `/x/${expect.id}` && !u.search && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------- pay_x402 calls

/** Eligible lines that get a pay_x402 call per inbox read (each costs one challenge fetch inside the 8.5 s budget). */
export const AUTOPAY_CALLS_MAX = 5;
export const AUTOPAY_CHECK_TIMEOUT_MS = 3000;
/** Below this much budget the calls aren't fetched (the inbox is still shown). */
export const AUTOPAY_MIN_BUDGET_MS = 1200;

/** The exact PayBox call: the agent adds credential_id (the payer wallet's, from list_credentials). */
export interface PayX402Call {
  via: "paybox";
  tool: "pay_x402";
  credential_of: string;
  args: { accepts: Array<Record<string, unknown>>; resource_url: string; x402_version: 1 | 2; resource?: Record<string, unknown> };
}

export interface PreparedLine {
  pay_x402?: PayX402Call;
  then?: string;
  fallback?: { tool: "pay_link"; args: { link: string; sender: string; rail: "x402" } };
  /** Why an eligible line carries no call (it can still be paid by hand). */
  not_ready?: string;
}

export function thenText(resourceUrl: string): string {
  return `When pay_x402 succeeds (poll PayBox get_request with its request_id to the end), retry GET ${resourceUrl} with the header in output.value.x_payment. Only that response (paid: true) proves the payment; check_payments confirms it.`;
}

/**
 * For every line Owed's server marked eligible (at most AUTOPAY_CALLS_MAX): the payer's own signed rule must allow it,
 * the recipient must clear the sanctions screen, the request's terms must hash to its id and pay exactly this line
 * (pay_link's own checks, tools/pay_link.ts checkOwedTerms), and the live 402 challenge must pay exactly those terms.
 * Then the line gets the exact pay_x402 call (accepts verbatim) and the pay_link fallback; otherwise it says why not.
 */
export async function prepareAutopayCalls(
  inbox: InboxRes, ctx: Pick<CallContext, "base" | "hosts" | "api">, deps: Deps, budgetMs: number,
): Promise<Map<string, PreparedLine>> {
  const out = new Map<string, PreparedLine>();
  const now = deps.now();
  const rules = new Map((inbox.autopay_rules ?? []).map((r) => [r.id, r]));
  const eligible = inbox.owed.filter((e) => e.autopay?.status === "eligible");
  const candidates: InboxEntry[] = [];
  for (const [i, e] of eligible.entries()) {
    if (e.chain !== "solana" || e.token !== "USDC" || e.status !== "open") {
      out.set(e.id, { not_ready: "Owed's server marked it eligible, but only open USDC requests on Solana can be paid over x402." });
      continue;
    }
    if (i >= AUTOPAY_CALLS_MAX) {
      out.set(e.id, { not_ready: `Only the first ${AUTOPAY_CALLS_MAX} eligible requests get a payment call per inbox read; read the inbox again after paying those.` });
      continue;
    }
    let amountAtomic: bigint;
    try {
      amountAtomic = toAtomic(e.amount, "USDC");
    } catch {
      out.set(e.id, { not_ready: "Owed's server listed an amount Owed can't read." });
      continue;
    }
    const ruleProblem = signedRuleProblem(e.autopay?.rule_id ? rules.get(e.autopay.rule_id) : undefined, inbox.payer, e.recipient, amountAtomic, now);
    if (ruleProblem) {
      out.set(e.id, { not_ready: `Owed's server marked it eligible, but ${ruleProblem}, so no payment call is attached. Show it to the user.` });
      continue;
    }
    const screening = await deps.screenRecipient(e.recipient, deps);
    if (!screening.ok) {
      out.set(e.id, { not_ready: `${screening.message} No payment call is attached.` });
      continue;
    }
    candidates.push(e);
  }
  if (candidates.length === 0) return out;
  if (budgetMs < AUTOPAY_MIN_BUDGET_MS) {
    for (const e of candidates) out.set(e.id, { not_ready: "There wasn't time left to fetch its x402 challenge; read the inbox again to get the payment call." });
    return out;
  }
  const timeout = Math.min(AUTOPAY_CHECK_TIMEOUT_MS, budgetMs - 400);
  const [terms, ...challenges] = await Promise.all([
    within(ctx.api.getRequests(candidates.map((e) => e.id)).then((r) => r, () => null), timeout, () => null),
    ...candidates.map((e) => within(
      readX402Challenge(x402UrlFor(ctx.base, e.id), { id: e.id, recipient: e.recipient, amountAtomic: toAtomic(e.amount, "USDC"), hosts: ctx.hosts }, deps, timeout),
      timeout + 100, (): Challenge => ({ ok: false, message: "Owed's x402 endpoint didn't answer in time." }),
    )),
  ]);
  candidates.forEach((e, i) => {
    const rq = terms?.requests.find((r) => r.id === e.id);
    if (!terms || !rq) {
      out.set(e.id, { not_ready: "Owed's server couldn't be read to check this request's terms just now; read the inbox again to get the payment call." });
      return;
    }
    const checked = checkOwedTerms(rq, e.id, ctx, deps);
    if (typeof checked === "string") return void out.set(e.id, { not_ready: `${checked} No payment call is attached.` });
    if ("baseRequest" in checked || checked.token !== "USDC" || checked.request.recipient !== e.recipient || !termsMatchLine(rq, e)) {
      return void out.set(e.id, { not_ready: "This request's terms don't match its inbox line, so no payment call is attached. Show it to the user." });
    }
    const c = challenges[i]!;
    if (!c.ok) return void out.set(e.id, { not_ready: `${c.message} No payment call is attached.` });
    const resource_url = x402UrlFor(ctx.base, e.id);
    out.set(e.id, {
      pay_x402: {
        via: "paybox", tool: "pay_x402", credential_of: inbox.payer,
        args: c.x402Version === 2 ? { accepts: c.accepts, resource_url, x402_version: 2, resource: c.resource } : { accepts: c.accepts, resource_url, x402_version: 1 },
      },
      then: thenText(resource_url),
      fallback: { tool: "pay_link", args: { link: e.link, sender: inbox.payer, rail: "x402" } },
    });
  });
  return out;
}

/** The id-checked terms pay exactly this inbox line (recipient, USDC, amount). */
export function termsMatchLine(rq: GetRequestRes, line: { id: string; recipient: string; amount: string }): boolean {
  try {
    return rq.id === line.id && rq.recipient === line.recipient && rq.token === "USDC" && toAtomic(rq.amount, "USDC") === toAtomic(line.amount, "USDC");
  } catch {
    return false;
  }
}
