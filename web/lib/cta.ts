import "server-only";
import { after } from "next/server";
import { DbError, sql } from "./db";
import { ApiError } from "./http";
import { isRequestId, VERIFIED_ID_LENGTH } from "./ids";
import { take, type RateRule } from "./ratelimit";
import { formatAmount, fromAtomic, toAtomic, TOKEN_DECIMALS, type Token } from "./view/money";
import type { PayModel } from "./view/request-view";

// SP1 "New to crypto? Pay with PayBox" on the pay page (/r/<id>), for payers who have no wallet yet:
// make a PayBox account, buy the amount with MoonPay's checkout inside PayBox, then tell Claude "Pay this: <link>"
// (the Owed plugin's pay_link does the rest, behind a passkey). Two parts:
// - the view: when the section shows and what it says (Owed's own words plus the share link, never requester text);
// - the counters (migration 0016): clicks on the account link and copies of the prompt, per request and UTC day,
//   with nothing about the person (no IP, no user agent, no cookie). GET /api/v1/stats shows the totals.

// ---------------------------------------------------------------------------------------------- view

/** Where "Create a PayBox account" lands, after GET /api/v1/cta/paybox counts the click. */
export const PAYBOX_APP_URL = "https://app.paybox.sh";

/** The section's fixed words. Claims trace to docs (PayBox's get_buy_link: MoonPay checkout, card or bank, ID check). */
export const PAYBOX_CTA_COPY = {
  heading: "New to crypto? Pay with PayBox",
  account: {
    text: "Create a PayBox account at",
    linkText: "app.paybox.sh",
    after: ", connect it to Claude and turn on Owed under Plugins.",
    note: "PayBox is MoonPay's wallet for AI agents.",
  },
  checkout: "PayBox's Buy uses MoonPay's checkout (card or bank), which checks your ID the first time.",
  tell: "Tell Claude:",
  approve: "Claude shows you the payment first. Nothing is sent until you approve it in PayBox with your passkey.",
} as const;

export interface PayboxCtaView {
  requestId: string;
  heading: string;
  /** Step 1: "Create a PayBox account at <app.paybox.sh>, …". */
  account: { text: string; linkText: string; after: string; note: string };
  /** The account link: the counting redirect (GET /api/v1/cta/paybox), never app.paybox.sh directly. */
  accountHref: string;
  /** Step 2: what to buy, for this request's chain and token. */
  buy: string;
  checkout: string;
  /** Step 3: "Pay this: <share link>", copied with one button. */
  tell: string;
  prompt: string;
  approve: string;
}

/**
 * The statuses that show the section: only "open".
 * - underpaid: pay_link refuses it ("This request already received a partial payment… Ask the requester for a new
 *   link for the rest", plugin/src/tools/pay_link.ts resolveOwed), and the page says paying again sends the full
 *   amount. The rest has its own request (ask_for_rest), whose page shows the section.
 * - paid, cancelled, expired: nothing to pay. A request that doesn't exist 404s before any model is built.
 * If pay_link learns to pay the rest of an underpaid request, add "underpaid" here (and render the section
 * outside the open-only actions slot, see components/pay-view.tsx).
 */
const SHOWN_FOR: ReadonlySet<unknown> = new Set(["open"]);

/**
 * The section is switched on per deployment with OWED_PAYBOX_CTA=1. Step 3 only works once a newcomer can turn Owed on
 * in PayBox (listed in the catalog, or added by URL through the remote MCP endpoint), so it stays off until that is
 * proven on mainnet; the counters and routes work either way.
 */
export function ctaEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OWED_PAYBOX_CTA === "1";
}

export function ctaStatusShows(status: unknown): boolean {
  return SHOWN_FOR.has(status);
}

/** pay_link's reserve for Solana network fees (plugin/src/chain.ts FEE_RESERVE_LAMPORTS): about 0.003 SOL. */
const SOL_FEE_RESERVE_LAMPORTS = 3_000_000n;

function buyLine(chain: PayModel["chain"], token: Token, amount: string): string | null {
  // Base: pay_link pays over x402 from the PayBox Base wallet and the facilitator pays the gas (plugin/src/base-request.ts).
  if (chain === "base") return token === "USDC" ? `Buy at least ${formatAmount(amount, "USDC")} on Base in PayBox.` : null;
  // Solana: pay_link's transaction needs about 0.003 SOL in the wallet for fees (plugin/src/chain.ts payerReadiness).
  if (token === "USDC") return `Buy at least ${formatAmount(amount, "USDC")} on Solana in PayBox, and about 0.003 SOL for the network fee.`;
  const lamports = toAtomic(amount, TOKEN_DECIMALS.SOL);
  if (lamports === null) return null;
  const total = fromAtomic(lamports + SOL_FEE_RESERVE_LAMPORTS, TOKEN_DECIMALS.SOL);
  return `Buy at least ${formatAmount(total, "SOL")} in PayBox: ${formatAmount(amount, "SOL")} for the request and about 0.003 SOL for the network fee.`;
}

/**
 * The section for this pay page, or null where it must not show: not an open hosted request; an older 10-character
 * id (pay_link refuses those); past its expiry; or a request with a brand word in it (the page shows a caution, and
 * walking a newcomer through buying crypto to pay a possible impersonator is exactly the wrong nudge).
 */
export function payboxCta(model: PayModel, now: number = Date.now()): PayboxCtaView | null {
  if (model.kind !== "hosted" || model.poll?.endpoint !== "/api/v1/status") return null;
  const id = model.poll.id;
  if (id.length !== VERIFIED_ID_LENGTH || !isRequestId(id)) return null;
  if (!ctaStatusShows(model.initial.status)) return null;
  if (model.expiresAt && Date.parse(model.expiresAt) <= now) return null;
  if (model.brandWords.length > 0) return null;
  if (model.amount === null) return null;
  const buy = buyLine(model.chain, model.token, model.amount);
  if (buy === null) return null;
  const accountHref = `/api/v1/cta/paybox?r=${encodeURIComponent(id)}`;
  return {
    requestId: id,
    heading: PAYBOX_CTA_COPY.heading,
    account: { ...PAYBOX_CTA_COPY.account },
    accountHref,
    buy,
    checkout: PAYBOX_CTA_COPY.checkout,
    tell: PAYBOX_CTA_COPY.tell,
    // The share link only: Owed's origin and the id. pay_link's description matches "pay this" + a link.
    prompt: `Pay this: ${model.shareLink}`,
    approve: PAYBOX_CTA_COPY.approve,
  };
}

// ---------------------------------------------------------------------------------------------- counters

export const CTA_EVENTS = ["paybox_click", "prompt_copy"] as const;
export type CtaEvent = (typeof CTA_EVENTS)[number];

/** Per request and per kind, then all requests together (a backstop). Keys name the request, never the client. */
export const CTA_LIMITS = { perRequestPerHour: 30, globalPerHour: 3000 } as const;
const HOUR = 3600;

function ctaRules(event: CtaEvent, requestId: string): RateRule[] {
  return [
    { key: `cta:${event}:request:${requestId}`, max: CTA_LIMITS.perRequestPerHour, windowSeconds: HOUR, scope: "request" },
    { key: `cta:${event}:all`, max: CTA_LIMITS.globalPerHour, windowSeconds: HOUR, scope: "global" },
  ];
}

export type CtaOutcome = { kind: "recorded" } | { kind: "unknown_request" } | { kind: "limited"; retryAfterSeconds: number };

/**
 * Count one event for a request: today's row for (kind, request) gains one. A request that doesn't exist counts
 * nothing and spends no rate budget; over a cap nothing is counted.
 */
export async function recordCtaEvent(event: CtaEvent, requestId: string): Promise<CtaOutcome> {
  if (!isRequestId(requestId)) return { kind: "unknown_request" };
  const [found] = await sql("select 1 as one from requests where id = $1", [requestId]);
  if (!found) return { kind: "unknown_request" };
  const slot = await take(ctaRules(event, requestId));
  if (!slot.allowed) return { kind: "limited", retryAfterSeconds: slot.retryAfterSeconds ?? 60 };
  const rows = await sql(
    `insert into cta_events (kind, request_id)
     select $1, id from requests where id = $2
     on conflict (kind, request_id, day) do update set events = cta_events.events + 1
     returning events`,
    [event, requestId],
  );
  return rows.length > 0 ? { kind: "recorded" } : { kind: "unknown_request" };
}

// The redirect never waits for the counter: inside a request the write runs after the response is sent
// (Vercel's waitUntil), so a sleeping database can't slow the way to PayBox. Outside one (tests, scripts) it
// runs in the background and ctaSettled() waits for it. A failure is logged and swallowed.
const pending = new Set<Promise<void>>();

export function recordCtaLater(event: CtaEvent, requestId: string): void {
  const run = async () => {
    try {
      const outcome = await recordCtaEvent(event, requestId);
      if (outcome.kind === "limited") console.warn(`cta: ${event} for ${requestId} not counted (over the hourly cap)`);
    } catch (e) {
      console.warn(`cta: ${event} not counted: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  try {
    after(run);
    return;
  } catch {
    // Not inside a request scope.
  }
  const p = run();
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/** Resolves once every count started outside a request is written (or has failed). */
export async function ctaSettled(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

/** POST /api/v1/cta body: {event: "prompt_copy", request: "<id>"}. Clicks on the account link count only through the redirect. */
export function parseCtaBody(body: unknown): { event: "prompt_copy"; request: string } {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) throw new ApiError("invalid_input", 'body must be {"event":"prompt_copy","request":"<request id>"}');
  if (b.event !== "prompt_copy") {
    throw new ApiError("invalid_input", 'event: must be "prompt_copy" (clicks on the PayBox link are counted by GET /api/v1/cta/paybox)');
  }
  if (!isRequestId(b.request)) throw new ApiError("invalid_input", "request: must be an Owed request id");
  return { event: "prompt_copy", request: b.request };
}

export interface CtaTotals {
  paybox_clicks: number;
  prompt_copies: number;
}

/** Totals since the counters started, or null when they can't be read (e.g. before migration 0016 is applied). */
export async function ctaTotals(): Promise<CtaTotals | null> {
  try {
    const [row] = await sql(
      `select coalesce(sum(events) filter (where kind = 'paybox_click'), 0)::text as paybox_clicks,
              coalesce(sum(events) filter (where kind = 'prompt_copy'), 0)::text as prompt_copies
         from cta_events`,
    );
    return { paybox_clicks: Number(row.paybox_clicks), prompt_copies: Number(row.prompt_copies) };
  } catch (e) {
    if (!(e instanceof DbError)) throw e;
    console.warn(`cta: totals unavailable: ${e.code ?? ""} ${e.message}`);
    return null;
  }
}
