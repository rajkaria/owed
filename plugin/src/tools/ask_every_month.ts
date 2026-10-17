import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { ApiError, makeApi } from "../api.js";
import { addressSchema, decimalSchema, requestIdSchema, tokenSchema, type CreateScheduleReq, type ScheduleRes } from "../contract.js";
import { callContext, defaultDeps, errorText, refusal, within, type CallContext, type Deps } from "../deps.js";
import { USDC_MINT } from "../money.js";
import { checkFromDomain, fromDomainSchema, type FromDomainCheck } from "../payee.js";
import { idMatchesTerms } from "../request-id.js";
import { screenRecipient, type Screening } from "../screen.js";
import { cautionLine, clean, quote } from "../text.js";

// ask_every_month (W3-D): the same request on the same day of every month, e.g. rent on the 1st. Owed's
// server stores the schedule; when today is the day it opens this month's request at once, otherwise it
// says when. A daily cron on the server opens each later month's request (the plugin never needs it), and
// who_owes_me lists the schedule and every request it opened, with the links to send.

/** PayBox gives a call 10 s; screening, the DNS check and the API call share it. */
const CALL_BUDGET_MS = 9500;
/** Storing the schedule can also open this month's request: one more write than ask_for_money. */
export const SCHEDULE_API_TIMEOUT_MS = 5000;
const LIMITS = { payer_name: 40, for: 80, requester_name: 40 } as const;

export const inputSchema = z.object({
  recipient: addressSchema.describe("The user's own PayBox Solana wallet address (from list_credentials). Every month's payment goes to this address."),
  amount: decimalSchema.describe('Amount asked each month, in whole token units as a decimal string, e.g. "450" or "12.5". Not atomic units.'),
  token: tokenSchema.default("USDC").describe('"USDC" (default) or "SOL".'),
  payer_name: z.string().min(1).max(LIMITS.payer_name).describe('First name of the person who pays each month, e.g. "Sam".'),
  for: z.string().min(1).max(LIMITS.for).describe('What the money is for, e.g. "rent". The payer sees it quoted.'),
  day_of_month: z.number().int().min(1).max(28)
    .describe("Day of the month (1–28, UTC) each request opens. 29–31 aren't allowed because some months don't have them; use 28 for month end."),
  months: z.number().int().min(1).max(120).optional()
    .describe("How many monthly requests in total, counting the first. Omit for every month with no end date."),
  requester_name: z.string().min(1).max(LIMITS.requester_name).optional().describe("The user's own first name, so the payer knows who is asking."),
  from_domain: fromDomainSchema.optional(),
}).strict();

const firstRequestSchema = z.object({
  id: requestIdSchema,
  period: z.string().describe('The month this request is for, "YYYY-MM".'),
  link: z.string().describe("This month's link to send to the payer."),
  solana_pay_url: z.string(),
  qr_url: z.string(),
  reference: z.string(),
}).strict();

export const outputSchema = z.object({
  schedule_id: z.string().describe("Owed schedule id; who_owes_me lists it with each month's request."),
  recipient: z.string(),
  amount: z.string(),
  token: tokenSchema,
  payer_name: z.string(),
  for: z.string(),
  day_of_month: z.number().int(),
  months: z.number().int().nullable().describe("Total monthly requests; null = every month, no end date."),
  status: z.string(),
  next_request_on: z.string().nullable().describe('When the next request opens, "YYYY-MM-DD" (UTC). After first_request, that is next month.'),
  first_request: firstRequestSchema.nullable().describe("This month's request, opened now because today is the day; null otherwise."),
  share_text: z.string().optional().describe("A ready-to-send message for this month's request (only with first_request)."),
  from_domain: z.string().optional().describe("The verified domain payers see on every month's request."),
}).strict();

export type EveryMonthInput = z.output<typeof inputSchema>;
export type EveryMonthOutput = z.output<typeof outputSchema>;

const DESCRIPTION = [
  "Ask someone for the same amount every month, e.g. \"ask Sam for 450 USDC rent on the 1st\": stores a monthly schedule and opens a new Owed payment request on that day each month (UTC).",
  "If today is that day, this month's request opens right away and its link is returned to send; otherwise it says when the first one opens.",
  "recipient is the user's own PayBox Solana wallet (from list_credentials); every payment goes straight from the payer to it.",
  "Each month's request is an ordinary Owed request: anyone pays it from any Solana wallet or their own agent, and check_payments, write_reminder and pay_link work on it.",
  "who_owes_me lists every schedule and each month's request with its link, so the user can send it.",
  "day_of_month is 1–28 so every month has it. months limits how many requests are made (omit for no end date).",
  "Like ask_for_money, pass from_domain if the user's domain publishes their wallet in DNS (_owed.<domain> TXT owed-pay=<wallet>): Owed checks it now and again before every month's request.",
].join(" ");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Nov 2026" from "2026-11-01". */
export function readableDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "the 1st", "the 22nd". */
export function dayLabel(day: number): string {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `the ${day}${suffix}`;
}

/** The message the requester sends with a month's link. Inputs must already be clean()ed. */
export function monthlyShareText(i: { payerName: string; requesterName?: string; forText: string; amount: string; token: string; day: number; link: string }): string {
  const greeting = i.requesterName ? `Hey ${i.payerName}, it's ${i.requesterName}.` : `Hey ${i.payerName}!`;
  return `${greeting} Here's this month's request for "${i.forText.replace(/"/g, "'")}": ${i.amount} ${i.token}, due on ${dayLabel(i.day)} each month. ` +
    `Pay with any Solana wallet here: ${i.link}`;
}

export async function askEveryMonth(
  args: EveryMonthInput,
  deps: Deps = defaultDeps,
  screen: (addr: string) => Promise<Screening> = screenRecipient,
  checkDomain: typeof checkFromDomain = checkFromDomain,
) {
  const started = deps.now();
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
    payerName: clean(args.payer_name, LIMITS.payer_name),
    forText: clean(args.for, LIMITS.for),
    requesterName: clean(args.requester_name, LIMITS.requester_name) || undefined,
  };
  if (!text.payerName || !text.forText) return refusal("payer_name and for need some text once links are removed. Nothing was set up.");

  let ctx: CallContext;
  try {
    ctx = callContext(deps);
  } catch (error) {
    return refusal(errorText(error, "Owed is misconfigured."));
  }

  // Screening and the DNS check run side by side; together with the API call they must fit 10 s.
  const budgetLeft = () => CALL_BUDGET_MS - (deps.now() - started);
  const domainBudget = Math.max(0, budgetLeft() - SCHEDULE_API_TIMEOUT_MS - 500);
  const [screening, domain] = await Promise.all([
    screen(args.recipient),
    args.from_domain !== undefined ? checkDomain(args.from_domain, args.recipient, deps, domainBudget) : Promise.resolve(null as FromDomainCheck | null),
  ]);
  if (!screening.ok) return refusal(screening.message);
  if (domain && !domain.ok) return refusal(domain.message.replace("the request wasn't created", "no monthly request was set up"));

  const body: CreateScheduleReq = {
    recipient: args.recipient, amount, token, source: "plugin",
    payer_name: text.payerName,
    for: text.forText,
    ...(text.requesterName && { requester_name: text.requesterName }),
    day_of_month: args.day_of_month,
    ...(args.months !== undefined && { months: args.months }),
    ...(domain?.ok && { from_domain: domain.from_domain }),
  };

  const api = makeApi({ base: ctx.base, fetch: deps.fetch, timeoutMs: SCHEDULE_API_TIMEOUT_MS });
  const outcome = await within<{ res: ScheduleRes } | { error: unknown }>(
    api.createSchedule(body).then((res) => ({ res }), (error: unknown) => ({ error })),
    Math.max(0, Math.min(SCHEDULE_API_TIMEOUT_MS + 250, budgetLeft())),
    () => ({ error: new ApiError("upstream_unavailable", "Owed's server did not answer in time.") }),
  );
  if ("error" in outcome) {
    const error = outcome.error;
    if (!(error instanceof ApiError)) return refusal(errorText(error, "Couldn't set up the monthly request."));
    return refusal(apiRefusal(error));
  }
  const res = outcome.res;

  const mismatch = checkSchedule(res, body, atomic, ctx, deps);
  if (mismatch) return refusal(mismatch);

  const first = res.first_request;
  const share_text = first
    ? monthlyShareText({ payerName: text.payerName, requesterName: text.requesterName, forText: text.forText, amount, token, day: args.day_of_month, link: first.link })
    : undefined;
  const output: EveryMonthOutput = {
    schedule_id: res.id,
    recipient: args.recipient,
    amount,
    token,
    payer_name: text.payerName,
    for: text.forText,
    day_of_month: res.day_of_month,
    months: res.months,
    status: res.status,
    next_request_on: res.next_request_on,
    first_request: first
      ? { id: first.id, period: first.period, link: first.link, solana_pay_url: first.solana_pay_url, qr_url: first.qr_url, reference: first.reference }
      : null,
    ...(share_text && { share_text }),
    ...(domain?.ok && { from_domain: domain.from_domain }),
  };

  const runs = res.months === null ? "every month, no end date" : `${res.months} ${res.months === 1 ? "month" : "months"} in all`;
  const lines = [
    `Monthly request set: ${amount} ${token} from ${quote(text.payerName, LIMITS.payer_name)} for ${quote(text.forText, LIMITS.for)} on ${dayLabel(res.day_of_month)} of each month (UTC), ${runs}.`,
  ];
  if (first) {
    lines.push(`Today is the day, so this month's request is open now. Send this link: ${first.link}`);
    lines.push(`Message to send: ${share_text}`);
    if (res.next_request_on) lines.push(`The next one opens on ${readableDate(res.next_request_on)}.`);
  } else if (res.next_request_on) {
    lines.push(`The first request opens on ${readableDate(res.next_request_on)}. Owed opens one each month on that day; who_owes_me lists each with its link to send.`);
  }
  if (domain?.ok) lines.push(...domain.lines);
  const caution = cautionLine(first?.flags ?? res.flags);
  if (caution) lines.push(caution);
  if (screening.screening === "unavailable") lines.push("Recipient screening was unavailable, so this address wasn't screened.");
  lines.push(`Schedule id: ${res.id}.`);
  return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: output };
}

/**
 * The server stores what every later month asks for, and builds this month's payment; refuse a reply
 * that would ask for anything else, or pay anyone else, than this call set up.
 */
function checkSchedule(res: ScheduleRes, body: CreateScheduleReq, atomic: bigint, ctx: CallContext, deps: Deps): string | null {
  const bad = "Owed's server answered with a monthly request that doesn't match what was asked, so it wasn't used. Check who_owes_me before trying again.";
  try {
    if (res.recipient !== body.recipient || res.token !== body.token || res.day_of_month !== body.day_of_month) return bad;
    if (deps.toAtomic(res.amount, body.token) !== atomic) return bad;
    if ((res.months ?? undefined) !== body.months) return bad;
    if ((res.from_domain ?? undefined) !== body.from_domain) return bad;
    const first = res.first_request;
    if (!first) return null;
    if (new URL(first.link).protocol !== "https:" || !first.link.endsWith(`/${first.id}`)) return bad;
    const parsed = deps.parseLink(first.solana_pay_url, ctx.hosts);
    if (parsed.kind !== "transfer") return bad;
    const r = parsed.request;
    const expectedMint = body.token === "USDC" ? USDC_MINT : undefined;
    if (r.recipient !== body.recipient || r.splToken !== expectedMint || !r.references.includes(first.reference)) return bad;
    if (r.amount === undefined || deps.toAtomic(r.amount, body.token) !== atomic) return bad;
    // The id must commit to these exact terms, or a payer's pay_link would refuse the link.
    if (!idMatchesTerms(first.id, { recipient: body.recipient, token: body.token, amountAtomic: atomic, reference: first.reference })) return bad;
    if ((first.from_domain ?? undefined) !== body.from_domain) return bad;
    return null;
  } catch {
    return bad;
  }
}

function apiRefusal(error: ApiError): string {
  switch (error.code) {
    case "rate_limited": return "Owed is limiting new requests for this wallet right now. Try again in a few minutes.";
    case "blocked": return `Owed can't set up requests for this recipient. ${error.message}`;
    case "invalid_input": return `Owed rejected the monthly request: ${error.message}`;
    default:
      return "Owed's server couldn't be reached or didn't answer in time, so the monthly request may not have been saved. " +
        "Run who_owes_me to check before asking again; ask_for_money can still make this month's request on its own.";
  }
}

export function register(server: McpServer, deps: Deps = defaultDeps) {
  server.registerTool("ask_every_month", {
    title: "Ask for money every month",
    description: DESCRIPTION,
    inputSchema,
    outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => askEveryMonth(args, deps));
}
