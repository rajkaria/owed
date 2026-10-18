import { z } from "zod";
import { TEXT_LIMITS } from "./safety";
import { isSolanaAddress } from "./solana-pay";

// Zod mirror of the /api/v1 contract. contract/fixtures/*.json must all parse
// (test/contract.test.ts), and plugin/src/contract.ts mirrors the same shapes.

export const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const decimal = z.string().regex(DECIMAL, "must be a decimal string");
// W2-E: the regex alone let 32–44 character strings that don't decode to 32 bytes through, and
// `new PublicKey()` in the create routes then threw a plain Error (HTTP 500 instead of 400).
const base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address")
  .refine(isSolanaAddress, "must be a base58 Solana address (32 bytes)");
const requestId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{10}(?:[1-9A-HJ-NP-Za-km-z]{2})?$/, "must be a 12-character Owed id");
const isoTime = z.iso.datetime();
const token = z.enum(["USDC", "SOL"]);
// W3-B Base requests: a Base request's recipient and payer are 0x addresses, its payment a 0x transaction hash.
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x Base address");
const anyAddress = z.union([base58Key, evmAddress]);
const chain = z.enum(["solana", "base"]);

// W3-C: optional expiry, in whole days. The server computes expires_at from its own clock; no client time is taken.
export const EXPIRES_IN_DAYS = { min: 1, max: 90 } as const;
const expiresInDays = z
  .number({ error: "expires_in_days must be a whole number of days from 1 to 90" })
  .int("expires_in_days must be a whole number of days from 1 to 90")
  .min(EXPIRES_IN_DAYS.min, "expires_in_days must be at least 1")
  .max(EXPIRES_IN_DAYS.max, "expires_in_days can be at most 90")
  .nullish();
const requestStatus = z.enum(["open", "paid", "underpaid", "cancelled", "expired"]);
/** W3-C: the recipient's signed cancellation, public so anyone can check it came from the wallet the request pays. */
export const CancelProof = z.object({ at: isoTime, signed_message: z.string().max(200), signature: z.string().max(200) });

// Local-currency asks: `currency` (ISO 4217, lib/fiat.ts allowlist) makes the body's amounts that currency; the
// server locks a USDC amount at a live rate (lib/fx.ts). Responses carry the quote as `fiat`, display only:
// the USDC amount, which the id commits to, is what is owed. Absent on USDC/SOL asks.
const currency = z.string().min(1).max(8).nullish();
export const FiatQuote = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount: decimal,
  /** Units of `currency` per 1 USDC. amount / rate, rounded up to 6 decimals, is the USDC amount. */
  rate: decimal,
  rate_source: z.string().min(1).max(120),
  quoted_at: isoTime,
});
export type FiatQuote = z.infer<typeof FiatQuote>;

// Raw text may be longer than its cap: links and invisible characters are stripped
// first, then the clean text is cut to the cap. 4x the cap bounds the work.
const untrusted = (cap: number) => z.string().max(cap * 4).nullish();

export const snsSource = z.enum(["sol_record_v2", "sol_record_v1", "owner"]); // W3-S

// F1 payer inbox. A create body may say who it is addressed to; lib/inbox-payer.ts checks it (the handle's format,
// the wallet, an .sns name resolved on Solana). Replies echo what was stored. Handles are labels, never verified.
export const PayerBody = z.object({
  wallet: z.string().max(64).nullish(),
  handle: z.string().max(32).nullish(),
  sns: z.string().min(1).max(140).nullish(),
});
export type PayerBody = z.infer<typeof PayerBody>;
const handle = z.string().regex(/^[a-z0-9_]{1,15}$/, "must be an X handle, lower case without @");
export const PayerInfo = z.object({ wallet: base58Key, handle: handle.nullable(), sns: z.string().max(140).nullable() });
const requesterHandleBody = z.string().max(32).nullish();

export const CreateRequestBody = z.object({
  recipient: z.string().max(64), // W3-B: checked per chain below

  amount: z.string().max(40),
  token: token.default("USDC"),
  payer_name: untrusted(TEXT_LIMITS.payer_name),
  for: untrusted(TEXT_LIMITS.for),
  note: untrusted(TEXT_LIMITS.note),
  requester_name: untrusted(TEXT_LIMITS.requester_name),
  kind: z.literal("single").default("single"),
  source: z.enum(["plugin", "web"]).default("web"),
  // W2-H verified payee: re-checked over DNS before the request is created (lib/payee.ts).
  from_domain: z.string().min(1).max(253).nullish(),
  expires_in_days: expiresInDays, // W3-C
  chain: chain.default("solana"), // W3-B
  currency, // local-currency ask: `amount` is in this currency
  sns_name: z.string().min(1).max(140).nullish(), // W3-S: re-resolved to recipient before the request is created (lib/sns.ts)
  payer: PayerBody.nullish(), // F1: who it is addressed to (never part of the id)
  requester_handle: requesterHandleBody, // F1: the requester's own X handle, a label
  deposit_url: z.string().max(2048).nullish(), // F3 deposit link: PayBox get_deposit_link's URL, checked in lib/deposit-link.ts
}).superRefine((b, ctx) => {
  // W3-B: a Solana request keeps its base58 rule and message; a Base request takes a 0x address.
  const schema = b.chain === "base" ? evmAddress : base58Key;
  const r = schema.safeParse(b.recipient);
  if (!r.success) ctx.addIssue({ code: "custom", path: ["recipient"], message: r.error.issues[0]?.message ?? "invalid recipient" });
});
export type CreateRequestBody = z.infer<typeof CreateRequestBody>;

export const CreateRequestResponse = z.object({
  id: requestId,
  link: z.url(),
  solana_pay_url: z.string().startsWith("solana:").nullable(), // W3-B: null on Base
  qr_url: z.url(),
  reference: base58Key,
  x402_url: z.url().nullable(),
  created_at: isoTime,
  flags: z.array(z.string()),
  from_domain: z.string().nullable().optional(), // W2-H verified payee
  expires_at: isoTime.nullable().optional(), // W3-C
  chain: chain.optional(), // W3-B (absent = solana)
  pay_url: z.string().optional(), // W3-B: the link a wallet opens (solana: or ethereum:)
  amount: decimal.optional(), // local-currency asks: the USDC amount locked (the caller didn't know it)
  fiat: FiatQuote.optional(),
  sns_name: z.string().nullable().optional(), // W3-S
  sns_source: snsSource.nullable().optional(),
  payer: PayerInfo.nullable().optional(), // F1
  requester_handle: handle.nullable().optional(),
  deposit_url: z.url().optional(), // F3 deposit link: as stored (only when the body carried one)
});
export type CreateRequestResponse = z.infer<typeof CreateRequestResponse>;

export const PaidInfo = z.object({
  signature: z.string(),
  payer: anyAddress, // W3-B
  amount: decimal,
  at: isoTime,
  rail: z.enum(["solana_pay", "x402", "base_transfer", "matched", "moonpay_card", "bank_transfer"]), // W3-B: base_transfer; 0012: matched (no reference, see `matched`); moonpay_card: paid by card; F3 bank rail: bank_transfer (0023, only on bank-paid requests)
});

// 0012: a payment without the request's reference, attributed by the recipient's own signed message. Display
// copy always says "matched by the recipient (no reference on the payment)", never the referenced badge.
export const MatchedInfo = z.object({
  signature: z.string(),
  covers: z.enum(["full", "rest"]),
  payer: base58Key,
  amount: decimal,
  at: isoTime,
  confirmed_by: base58Key,
  confirmed_at: isoTime,
  signed_message: z.string().max(200),
  message_signature: z.string().max(200),
});
const RestLink = z.object({ id: requestId, status: requestStatus, link: z.url().optional() });

export const GetRequestResponse = z.object({
  id: requestId,
  kind: z.enum(["single", "split_share", "invoice"]),
  recipient: anyAddress, // W3-B
  amount: decimal,
  token,
  payer_name: z.string().nullable(),
  for: z.string().nullable(),
  note: z.string().nullable(),
  requester_name: z.string().nullable(),
  status: requestStatus, // W3-C: + "expired"
  solana_pay_url: z.string().startsWith("solana:").nullable(), // W3-B: null on Base
  reference: base58Key,
  x402_url: z.url().nullable(),
  created_at: isoTime,
  paid: PaidInfo.nullable().optional(),
  flags: z.array(z.string()),
  // W2-H verified payee: display only; the plugin re-reads DNS before paying.
  from_domain: z.string().nullable().optional(),
  from_domain_verified_at: isoTime.nullable().optional(),
  // W3-C expiry + cancel
  expires_at: isoTime.nullable().optional(),
  cancelled: CancelProof.nullable().optional(),
  chain: chain.optional(), // W3-B (absent = solana)
  pay_url: z.string().optional(), // W3-B
  // 0012 matched payments + ask_for_rest
  matched: MatchedInfo.nullable().optional(),
  rest_of: requestId.nullable().optional(),
  rest_request: RestLink.nullable().optional(),
  fiat: FiatQuote.optional(), // local-currency asks
  // W3-S: the SNS name that pointed to recipient when the request was made. Display only; the plugin re-resolves it.
  sns_name: z.string().nullable().optional(),
  sns_source: snsSource.nullable().optional(),
  sns_resolved_at: isoTime.nullable().optional(),
  // F1: who it is addressed to, and the requester's own X handle (labels, not verified by Owed).
  payer: PayerInfo.nullable().optional(),
  requester_handle: handle.nullable().optional(),
  // F3 deposit link: the requester's PayBox Open Deposit URL and when it was added (PayBox reuses an unpaid link for 24 h).
  deposit_url: z.url().optional(),
  deposit_url_added_at: isoTime.optional(),
});
export type GetRequestResponse = z.infer<typeof GetRequestResponse>;

export const StatusBody = z.object({
  ids: z.array(z.string().max(64)).min(1).max(20),
});

export const StatusValue = z.enum(["open", "paid", "underpaid", "cancelled", "expired", "not_found", "invalid"]); // W3-C: + expired
export type StatusValue = z.infer<typeof StatusValue>;

const PaymentFields = {
  amount_requested: decimal.optional(),
  token: token.optional(),
  amount_paid: decimal.optional(),
  payer: anyAddress.optional(), // W3-B
  signature: z.string().optional(),
  paid_at: isoTime.optional(),
};

export const StatusResult = z.object({
  id: z.string(), status: StatusValue, ...PaymentFields, created_at: isoTime.optional(),
  expires_at: isoTime.optional(), cancelled_at: isoTime.optional(), // W3-C
  chain: chain.optional(), // W3-B
  // 0012: how it was paid, the recipient's match (no reference on the payment) and the follow-up for the rest.
  rail: PaidInfo.shape.rail.optional(),
  matched: z.object({ signature: z.string(), covers: z.enum(["full", "rest"]), amount: decimal, confirmed_at: isoTime }).optional(),
  rest_of: requestId.optional(),
  rest_request: requestId.optional(),
  fiat: FiatQuote.optional(), // local-currency asks
  deposit_link: z.boolean().optional(), // F3 deposit link: the request carries a PayBox Deposit link (match_payments counts such a payment)
});
export type StatusResult = z.infer<typeof StatusResult>;

export const StatusResponse = z.object({ results: z.array(StatusResult) });

export const StatusRawBody = z.object({ solana_pay_url: z.string().min(1).max(2048) });

export const StatusRawResponse = z.object({ status: StatusValue, ...PaymentFields });
export type StatusRawResponse = z.infer<typeof StatusRawResponse>;

export const StatsResponse = z.object({
  paid_count: z.number().int().nonnegative(),
  paid_volume_usdc: decimal,
  since: isoTime,
  cta: z.object({ paybox_clicks: z.number().int().nonnegative(), prompt_copies: z.number().int().nonnegative() }).optional(), // SP1
});

// Split bills: POST /api/v1/groups, GET /api/v1/groups/:id (one response shape for both).
const groupId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed group id");

export const CreateGroupBody = z.object({
  recipient: base58Key,
  total: z.string().max(40),
  token: token.default("USDC"),
  title: z.string().min(1).max(60 * 4),
  people: z
    .array(z.object({ name: z.string().min(1).max(TEXT_LIMITS.payer_name * 4), amount: z.string().max(40).nullish(), payer: PayerBody.nullish() }))
    .min(2, "a split needs at least 2 people")
    .max(20, "a split takes at most 20 people"),
  requester_name: untrusted(TEXT_LIMITS.requester_name),
  source: z.enum(["plugin", "web"]).default("web"),
  from_domain: z.string().min(1).max(253).nullish(),
  expires_in_days: expiresInDays, // W3-C: every share expires together
  currency, // local-currency split: `total` and people's amounts are in this currency
  requester_handle: requesterHandleBody, // F1
});
export type CreateGroupBody = z.infer<typeof CreateGroupBody>;

export const GroupShare = z.object({
  id: requestId,
  name: z.string().nullable(),
  amount: decimal,
  status: requestStatus,
  link: z.url(),
  solana_pay_url: z.string().startsWith("solana:"),
  reference: base58Key,
  paid: PaidInfo.nullable(),
  from_domain: z.string().nullable().optional(), // W2-H: each share carries the group's verified domain
  fiat: FiatQuote.optional(), // local-currency split: this share's amount in the bill's currency, at the group's rate
  payer: PayerInfo.optional(), // F1: who this share is addressed to
});

export const GroupResponse = z.object({
  id: groupId,
  link: z.url(),
  title: z.string().nullable(),
  recipient: base58Key,
  token,
  total: decimal,
  requester_name: z.string().nullable(),
  created_at: isoTime,
  flags: z.array(z.string()),
  from_domain: z.string().nullable(),
  from_domain_verified_at: isoTime.nullable(),
  share_count: z.number().int().min(2).max(20),
  paid_count: z.number().int().nonnegative(),
  amount_received: decimal,
  shares: z.array(GroupShare).min(2).max(20),
  expires_at: isoTime.optional(), // W3-C: when every share stops taking payments (absent: never)
  fiat: FiatQuote.optional(), // local-currency split: the bill's total in its currency; `total` is the shares' USDC sum
  requester_handle: handle.optional(), // F1
});
export type GroupResponse = z.infer<typeof GroupResponse>;
// ---- invoices (POST /api/v1/invoices, GET /api/v1/invoices/:id) ----

export const INVOICE_LIMITS = { business_name: 60, client_name: 60, description: 80, invoice_number: 20, notes: 280, items: 20 } as const;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date written YYYY-MM-DD");
const domain = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/).max(253);

export const CreateInvoiceBody = z.object({
  recipient: base58Key,
  token: token.default("USDC"),
  business_name: z.string().min(1).max(INVOICE_LIMITS.business_name * 4),
  client_name: z.string().min(1).max(INVOICE_LIMITS.client_name * 4),
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(INVOICE_LIMITS.description * 4),
        quantity: z.string().max(20).default("1"),
        unit_price: z.string().max(40),
      }),
    )
    .min(1)
    .max(INVOICE_LIMITS.items),
  due_date: isoDate,
  invoice_number: untrusted(INVOICE_LIMITS.invoice_number),
  notes: untrusted(INVOICE_LIMITS.notes),
  from_domain: z.string().min(1).max(253).nullish(),
  source: z.enum(["plugin", "web"]).default("web"),
  expires_in_days: expiresInDays, // W3-C: must reach the due date
  currency, // local-currency invoice: every unit_price is in this currency
  payer: PayerBody.nullish(), // F1: the client, as a payer the inbox lists it for
  requester_handle: requesterHandleBody,
  deposit_url: z.string().max(2048).nullish(), // F3 deposit link: plain USDC invoices only (lib/deposit-link.ts)
});
export type CreateInvoiceBody = z.infer<typeof CreateInvoiceBody>;

export const InvoiceResponse = z.object({
  id: requestId,
  link: z.url(),
  request_link: z.url(),
  solana_pay_url: z.string().startsWith("solana:"),
  qr_url: z.url(),
  reference: base58Key,
  x402_url: z.url().nullable(),
  recipient: base58Key,
  token,
  business_name: z.string().max(INVOICE_LIMITS.business_name),
  client_name: z.string().max(INVOICE_LIMITS.client_name),
  invoice_number: z.string().max(INVOICE_LIMITS.invoice_number).nullable(),
  notes: z.string().max(INVOICE_LIMITS.notes).nullable(),
  issue_date: isoDate,
  due_date: isoDate,
  items: z
    .array(
      z.object({
        description: z.string().max(INVOICE_LIMITS.description),
        quantity: decimal,
        unit_price: decimal,
        amount: decimal,
      }),
    )
    .min(1)
    .max(INVOICE_LIMITS.items),
  total: decimal,
  status: requestStatus, // W3-C: + "expired"
  paid: PaidInfo.nullable(),
  created_at: isoTime,
  flags: z.array(z.string()),
  from_domain: domain.nullable(),
  from_domain_verified_at: isoTime.nullable(),
  // W3-C expiry + cancel (absent when not set)
  expires_at: isoTime.optional(),
  cancelled_at: isoTime.optional(),
  // Local-currency invoice: items' unit_price and amount are in fiat.currency, fiat.amount is their sum,
  // and `total` is the USDC locked for it.
  fiat: FiatQuote.optional(),
  payer: PayerInfo.optional(), // F1
  requester_handle: handle.optional(),
  deposit_url: z.url().optional(), // F3 deposit link: on the invoice's own request
});
export type InvoiceResponse = z.infer<typeof InvoiceResponse>;

export const ErrorCode = z.enum(["invalid_input", "rate_limited", "not_found", "upstream_unavailable", "blocked"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });

// W2-D: POST /api/v1/ledger (who_owes_me). The signature unlocks one recipient's ledger once.
export const LedgerBody = z.object({
  recipient: base58Key,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
  csv: z.boolean().optional(), // W3-D: also return a 10-minute CSV download link
}).strict();
export type LedgerBody = z.infer<typeof LedgerBody>;

const LedgerEntry = z.object({
  id: requestId,
  kind: z.enum(["single", "split_share", "invoice"]),
  link: z.url(),
  amount: decimal,
  token,
  status: z.enum(["open", "underpaid", "paid"]),
  payer_name: z.string().nullable(),
  for: z.string().nullable(),
  created_at: isoTime,
  amount_due: decimal.optional(),
  amount_paid: decimal.optional(),
  payer: base58Key.optional(),
  signature: z.string().optional(),
  paid_at: isoTime.optional(),
  group_id: z.string().nullable(),
  group_title: z.string().nullable(),
  group_link: z.url().nullable(),
  invoice_number: z.string().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  from_domain: z.string().nullable(),
  flags: z.array(z.string()),
  // W3-D: the monthly schedule and month ("YYYY-MM") that opened this request; null for one-off requests.
  schedule_id: z.string().nullable().optional(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional(),
  // 0012: paid rail, the recipient's match (no reference on the payment), and the rest-of links.
  rail: PaidInfo.shape.rail.optional(),
  matched: z.object({ signature: z.string(), covers: z.enum(["full", "rest"]), amount: decimal, confirmed_at: isoTime }).optional(),
  rest_of: requestId.optional(),
  rest_request: requestId.optional(),
  fiat: FiatQuote.optional(), // local-currency asks
  deposit_link: z.boolean().optional(), // F3 deposit link: carries a PayBox Deposit link (match_payments counts such a payment)
});

export const LedgerResponse = z.object({
  recipient: base58Key,
  caution: z.string(),
  generated_at: isoTime,
  chain_checked: z.boolean(),
  open: z.array(LedgerEntry),
  paid_recently: z.array(LedgerEntry),
  totals: z.array(z.object({
    token,
    outstanding: decimal,
    received_30d: decimal,
    open_count: z.number().int().nonnegative(),
    paid_count: z.number().int().nonnegative(),
  })),
  truncated: z.boolean(),
  schedules: z.array(z.lazy(() => ScheduleSummary)).optional(), // W3-D
  csv: z.object({ url: z.url(), expires_at: isoTime }).nullable().optional(), // W3-D: null when export isn't configured
});
export type LedgerResponse = z.infer<typeof LedgerResponse>;

// W3-C: POST /api/v1/requests/:id/cancel (cancel_request). The recipient's wallet signs
// "Owed cancel <id> for <recipient> at <ISO time>"; the signature works once, within 5 minutes.
export const CancelBody = z.object({
  recipient: base58Key,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export type CancelBody = z.infer<typeof CancelBody>;

/** The request after the cancel, plus whether it had already been cancelled (cancelling twice changes nothing). */
export const CancelResponse = GetRequestResponse.extend({ already_cancelled: z.boolean() });
export type CancelResponse = z.infer<typeof CancelResponse>;

// ---- W3-D: recurring requests (POST /api/v1/schedules) ----

const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a month written YYYY-MM");
const scheduleId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed schedule id");

export const CreateScheduleBody = z.object({
  recipient: base58Key,
  amount: z.string().max(40),
  token: token.default("USDC"),
  payer_name: untrusted(TEXT_LIMITS.payer_name),
  for: untrusted(TEXT_LIMITS.for),
  requester_name: untrusted(TEXT_LIMITS.requester_name),
  day_of_month: z.number().int().min(1, "day_of_month must be 1 to 28").max(28, "day_of_month must be 1 to 28 (every month has those days)"),
  months: z.number().int().min(1).max(120).nullish(),
  from_domain: z.string().min(1).max(253).nullish(),
  source: z.enum(["plugin", "web"]).default("web"),
  currency, // refused: a rate locked today would be wrong next month
  payer: PayerBody.nullish(), // F1: every month's request is addressed to this payer
  requester_handle: requesterHandleBody,
});
export type CreateScheduleBody = z.infer<typeof CreateScheduleBody>;

export const ScheduleRequestRef = z.object({
  period,
  id: requestId,
  link: z.url(),
  status: z.string(),
});

export const ScheduleSummary = z.object({
  id: scheduleId,
  status: z.enum(["active", "ended", "stopped"]),
  amount: decimal,
  token,
  payer_name: z.string().nullable(),
  for: z.string().nullable(),
  day_of_month: z.number().int().min(1).max(28),
  months: z.number().int().min(1).max(120).nullable(),
  requests_opened: z.number().int().nonnegative(),
  next_request_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  created_at: isoTime,
  from_domain: z.string().nullable(),
  last_error: z.string().nullable(),
  requests: z.array(ScheduleRequestRef),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummary>;

export const ScheduleResponse = z.object({
  id: scheduleId,
  recipient: base58Key,
  amount: decimal,
  token,
  payer_name: z.string().nullable(),
  for: z.string().nullable(),
  requester_name: z.string().nullable(),
  day_of_month: z.number().int().min(1).max(28),
  months: z.number().int().min(1).max(120).nullable(),
  first_period: period,
  status: z.enum(["active", "ended", "stopped"]),
  next_request_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  created_at: isoTime,
  flags: z.array(z.string()),
  from_domain: domain.nullable(),
  from_domain_verified_at: isoTime.nullable(),
  /** This month's request when the schedule's day is today; null otherwise. */
  first_request: z.object({
    period,
    id: requestId,
    link: z.url(),
    solana_pay_url: z.string().startsWith("solana:"),
    qr_url: z.url(),
    reference: base58Key,
    x402_url: z.url().nullable(),
    created_at: isoTime,
    flags: z.array(z.string()),
    from_domain: domain.nullable(),
  }).nullable(),
  payer: PayerInfo.optional(), // F1
  requester_handle: handle.optional(),
});
export type ScheduleResponse = z.infer<typeof ScheduleResponse>;

// ---- 0012: matched payments (match_payments) and ask_for_rest ----

// POST /api/v1/requests/:id/match. The recipient's wallet signs "Owed match <transaction> to <id> for <recipient> at <ISO>";
// the signature works once, within 5 minutes. The server re-reads the transaction before marking the request paid.
export const MatchBody = z.object({
  recipient: base58Key,
  transaction: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, "must be a Solana transaction signature"),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export type MatchBody = z.infer<typeof MatchBody>;

/** The request after the match, plus whether this transaction had already been matched to it (nothing changed). */
export const MatchResponse = GetRequestResponse.extend({ already_matched: z.boolean() });
export type MatchResponse = z.infer<typeof MatchResponse>;

// POST /api/v1/requests/:id/rest: a new request for exactly what an underpaid request still owes (at most one).
export const RestBody = z.object({ source: z.enum(["plugin", "web"]).default("web") }).strict();
export const RestResponse = CreateRequestResponse.extend({
  recipient: anyAddress,
  amount: decimal,
  token,
  rest_of: requestId,
  already_asked: z.boolean(),
});
export type RestResponse = z.infer<typeof RestResponse>;

// POST /api/v1/attributed: which transactions already settle an Owed request, and which keys are Owed references.
// match_payments asks before it offers a candidate, so a counted payment is never offered twice.
export const AttributedBody = z.object({
  signatures: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, "must be a Solana transaction signature")).max(100),
  keys: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 key")).max(256).default([]),
}).strict();
export const AttributedResponse = z.object({
  attributed: z.array(z.object({ signature: z.string(), request_id: requestId, how: z.enum(["reference", "matched", "x402"]) })),
  references: z.array(z.object({ key: z.string(), request_id: requestId })),
});
export type AttributedResponse = z.infer<typeof AttributedResponse>;

// ---- F1: the payer inbox (what_do_i_owe), blocking a requester, and bulk terms for pay_all ----

// POST /api/v1/inbox. The payer's wallet signs "Owed inbox access for <payer> at <ISO time>" (once, within 5 minutes).
export const InboxBody = z.object({
  payer: base58Key,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export type InboxBody = z.infer<typeof InboxBody>;

export const InboxEntry = z.object({
  id: requestId,
  kind: z.enum(["single", "split_share", "invoice"]),
  link: z.url(),
  status: z.enum(["open", "underpaid"]),
  amount: decimal,
  amount_due: decimal,
  token,
  chain,
  recipient: anyAddress,
  requester_name: z.string().nullable(),
  requester_handle: handle.nullable(),
  for: z.string().nullable(),
  from_domain: z.string().nullable(),
  sns_name: z.string().nullable(),
  created_at: isoTime,
  expires_at: isoTime.nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  invoice_number: z.string().nullable(),
  group_title: z.string().nullable(),
  addressed_as: z.object({ handle: handle.nullable(), sns: z.string().nullable() }),
  first_time: z.boolean(),
  flags: z.array(z.string()),
  fiat: FiatQuote.optional(),
  autopay: z.lazy(() => AutopayVerdict).optional(), // F5 autopay: only when the payer has a rule (shapes at the end)
});
export type InboxEntry = z.infer<typeof InboxEntry>;

export const InboxResponse = z.object({
  payer: base58Key,
  caution: z.string(),
  generated_at: isoTime,
  chain_checked: z.boolean(),
  owed: z.array(InboxEntry),
  base: z.array(InboxEntry),
  totals: z.array(z.object({ token, chain, amount_due: decimal, count: z.number().int().nonnegative() })),
  blocked_hidden: z.number().int().nonnegative(),
  blocked_requesters: z.array(anyAddress),
  truncated: z.boolean(),
  autopay_rules: z.array(z.lazy(() => AutopayRule)).max(20).optional(), // F5 autopay: the payer's live rules
});
export type InboxResponse = z.infer<typeof InboxResponse>;

// POST /api/v1/inbox/block. The payer's wallet signs "Owed block <requester> for <payer> at <ISO time>" (or unblock).
export const InboxBlockBody = z.object({
  payer: base58Key,
  requester: z.string().max(64),
  action: z.enum(["block", "unblock"]),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export type InboxBlockBody = z.infer<typeof InboxBlockBody>;

export const InboxBlockResponse = z.object({
  payer: base58Key,
  requester: anyAddress,
  action: z.enum(["block", "unblock"]),
  blocked: z.boolean(),
  changed: z.boolean(),
  inbox: InboxResponse,
});
export type InboxBlockResponse = z.infer<typeof InboxBlockResponse>;

// GET /api/v1/requests?ids=a,b,c (1 to 20): each request in the shape GET /api/v1/requests/<id> returns, in the
// order asked; ids Owed doesn't know are listed in not_found.
export const BulkRequestsResponse = z.object({
  requests: z.array(GetRequestResponse).max(20),
  not_found: z.array(z.string()).max(20),
});
export type BulkRequestsResponse = z.infer<typeof BulkRequestsResponse>;

// ---- F2: funding plans (migration 0018, lib/plans.ts) ----
// pay_link / pay_all return a funding plan when the sender's wallet is short (the exact PayBox calls that fix it).
// POST /api/v1/plans records that one was offered: who it was for, which requests, the shortfall and which kinds of
// option (never a balance). POST /api/v1/plans/<id>/used: its final pay_link / pay_all proposed the payment.
// GET /api/v1/plans/stats: offered, used, paid. The funding_plan document itself is the plugin's output (in its
// text, as a ```json block); it is mirrored here so both sides parse every contract fixture.

export const PLAN_OPTION_KINDS = ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc", "x402", "swap_usdc_for_sol", "buy_sol"] as const;
const planOptionKind = z.enum(PLAN_OPTION_KINDS);
export const planId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed plan id");
const positiveAtomic = z.string().regex(/^[1-9][0-9]{0,30}$/, "must be a positive whole number of atomic units");
const anyAtomic = z.string().regex(/^(0|[1-9][0-9]{0,30})$/, "must be a whole number of atomic units");

export const CreatePlanBody = z.object({
  tool: z.enum(["pay_link", "pay_all"]),
  sender: anyAddress,
  request_ids: z.array(requestId).max(20),
  shortfall: z.object({ token, atomic: positiveAtomic }).strict(),
  options: z.array(planOptionKind).min(1).max(8),
}).strict().superRefine((b, ctx) => {
  if (new Set(b.request_ids).size !== b.request_ids.length) ctx.addIssue({ code: "custom", path: ["request_ids"], message: "lists an id twice" });
  if (new Set(b.options).size !== b.options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "lists a kind twice" });
  if (b.tool === "pay_all" && b.request_ids.length === 0) ctx.addIssue({ code: "custom", path: ["request_ids"], message: "pay_all plans name their requests" });
});
export type CreatePlanBody = z.infer<typeof CreatePlanBody>;
export const CreatePlanResponse = z.object({ plan_id: planId, created_at: isoTime });
export type CreatePlanResponse = z.infer<typeof CreatePlanResponse>;

export const PlanUsedBody = z.object({ sender: anyAddress }).strict();
export type PlanUsedBody = z.infer<typeof PlanUsedBody>;
export const PlanUsedResponse = z.object({ plan_id: planId, used_at: isoTime, already_used: z.boolean() });
export type PlanUsedResponse = z.infer<typeof PlanUsedResponse>;

export const PlanStatsResponse = z.object({
  offered: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative(),
  since: isoTime,
});
export type PlanStatsResponse = z.infer<typeof PlanStatsResponse>;

const PlanAmount = z.object({ token, atomic: anyAtomic, display: z.string().max(60) }).strict();
const PlanStep = z.object({
  via: z.enum(["paybox", "owed"]),
  tool: z.string().min(1).max(40),
  args: z.record(z.string(), z.unknown()),
  credential_of: z.string().max(64).nullable(),
  missing: z.array(z.string().max(40)).max(8).optional(),
  why: z.string().max(800),
}).strict();
const PlanOption = PlanStep.extend({ kind: planOptionKind, check: PlanStep.optional(), then: z.array(PlanStep).max(4) }).strict();
export const FundingPlan = z.object({
  plan_id: planId.nullable(),
  pay_tool: z.enum(["pay_link", "pay_all"]),
  request_ids: z.array(requestId).max(20),
  sender: anyAddress,
  shortfall: PlanAmount,
  have: z.array(PlanAmount).max(2),
  need: z.array(PlanAmount).max(2),
  options: z.array(PlanOption).min(1).max(8),
}).strict();
export type FundingPlan = z.infer<typeof FundingPlan>;
/** The ```json block a plan travels in. */
export const FundingPlanDoc = z.object({ funding_plan: FundingPlan }).strict();

// ---- F6 ledger: group ledgers and settle-up (migration 0020, lib/ledgers.ts) ----
// POST /api/v1/ledgers starts one (the owner is member 0); GET /api/v1/ledgers/<id> reads it with live balances and
// settle-up statuses (?chain=0 skips the chain check). POST /api/v1/ledgers/<id>/expenses and /settle are writes, each
// signed once, within 5 minutes, by a wallet named in the ledger (the owner's or a member's):
//   "Owed add expense <digest> (<total> <currency>) to ledger <id> by <signer> at <ISO>"
//   "Owed settle up ledger <id> v<version>: <n> requests, <total> USDC by <signer> at <ISO>"
// (lib/ledgers-math.ts expenseDigest / settlePrefix). Members are named by position; amounts are decimal strings in
// the expense's currency (USDC, or a local currency locked to USDC per expense); net and to_settle may be negative.
export const ledgerId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed ledger id");
const memberPosition = z.number().int().min(0).max(19);
const ledgerSignedDecimal = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, "must be a decimal string");
const ledgerSplit = z.enum(["even", "shares", "exact", "items"]);

export const CreateLedgerBody = z.object({
  title: z.string().max(240),
  owner: z.string().max(64),
  owner_name: z.string().max(160),
  members: z.array(z.object({ name: z.string().max(160), payer: PayerBody.nullish() })).min(1).max(19),
  source: z.enum(["plugin", "web"]).default("web"),
});
export type CreateLedgerBody = z.infer<typeof CreateLedgerBody>;

export const AddExpenseBody = z.object({
  signer: z.string().max(64),
  description: z.string().max(320).nullish(),
  paid_by: memberPosition,
  amount: z.string().max(40),
  currency: z.string().min(1).max(8).nullish(),
  split: ledgerSplit,
  among: z.array(memberPosition).min(1).max(20).nullish(),
  shares: z.array(z.object({ member: memberPosition, shares: z.string().max(20) })).min(1).max(20).nullish(),
  amounts: z.array(z.object({ member: memberPosition, amount: z.string().max(40) })).min(1).max(20).nullish(),
  items: z.array(z.object({
    description: z.string().max(240).nullish(), amount: z.string().max(40), members: z.array(memberPosition).min(1).max(20),
  })).min(1).max(30).nullish(),
  tax: z.string().max(40).nullish(),
  tip: z.string().max(40).nullish(),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
});
export type AddExpenseBody = z.infer<typeof AddExpenseBody>;

export const SettleUpBody = z.object({
  signer: z.string().max(64),
  version: z.number().int().min(0),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
});
export type SettleUpBody = z.infer<typeof SettleUpBody>;

export const LedgerMember = z.object({
  position: memberPosition, name: z.string().max(160), wallet: base58Key.nullable(), handle: handle.nullable(), sns: z.string().max(140).nullable(),
});
export const LedgerExpense = z.object({
  position: z.number().int().min(0).max(99),
  description: z.string().max(320).nullable(),
  paid_by: memberPosition,
  split: ledgerSplit,
  /** "USDC", or the ISO 4217 code every amount of this expense except `amount` and the shares' `amount` is in. */
  currency: z.string().regex(/^(USDC|[A-Z]{3})$/),
  total: decimal,
  /** USDC: the sum of the shares' amount (what the payer is credited). */
  amount: decimal,
  tax: decimal.nullable(),
  tip: decimal.nullable(),
  fiat: FiatQuote.nullable(),
  items: z.array(z.object({ description: z.string().max(240).nullable(), amount: decimal, members: z.array(memberPosition).min(1).max(20) })).max(30).nullable(),
  shares: z.array(z.object({ member: memberPosition, weight: decimal.nullable(), share: decimal, amount: decimal })).min(1).max(20),
  recorded_by: base58Key,
  recorded_at: isoTime,
  signed_message: z.string().max(200),
  signature: z.string().max(200),
  flags: z.array(z.string()),
});
export const LedgerTransfer = z.object({
  position: z.number().int().min(0).max(18),
  from: memberPosition,
  to: memberPosition,
  amount: decimal,
  request_id: requestId,
  link: z.url(),
  status: requestStatus,
  paid: PaidInfo.nullable(),
  addressed: z.boolean(),
});
export const GroupLedgerResponse = z.object({
  id: ledgerId,
  link: z.url(),
  title: z.string().max(240),
  owner: base58Key,
  created_at: isoTime,
  version: z.number().int().min(0),
  flags: z.array(z.string()),
  caution: z.string().max(400),
  members: z.array(LedgerMember).min(2).max(20),
  expenses: z.array(LedgerExpense).max(100),
  balances: z.array(z.object({
    member: memberPosition, paid: decimal, share: decimal, sent: decimal, received: decimal, net: ledgerSignedDecimal,
    pending_out: decimal, pending_in: decimal, to_settle: ledgerSignedDecimal,
  })).min(2).max(20),
  plan: z.array(z.object({ from: memberPosition, to: memberPosition, amount: decimal, payable: z.boolean() })).max(19),
  settlements: z.array(z.object({
    round: z.number().int().min(0), recorded_by: base58Key, recorded_at: isoTime, signed_message: z.string().max(200), signature: z.string().max(200),
    transfers: z.array(LedgerTransfer).min(1).max(19),
  })).max(50),
  totals: z.object({ spent: decimal, expense_count: z.number().int().min(0).max(100), open_requests: z.number().int().nonnegative() }),
  fiat_beside: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), rate: decimal, rate_source: z.string().min(1).max(120), quoted_at: isoTime }).nullable(),
  settled: z.boolean(),
  chain_checked: z.boolean(),
});
export type GroupLedgerResponse = z.infer<typeof GroupLedgerResponse>;

export const AddExpenseResponse = z.object({ added: z.number().int().min(0).max(99), ledger: GroupLedgerResponse });
export type AddExpenseResponse = z.infer<typeof AddExpenseResponse>;

export const SettleUpResponse = z.object({
  round: z.number().int().min(0),
  created: z.array(z.object({
    position: z.number().int().min(0).max(18), from: memberPosition, to: memberPosition, amount: decimal,
    request: z.object({
      id: requestId, link: z.url(), solana_pay_url: z.string().max(2048), reference: base58Key, recipient: base58Key,
      payer: PayerInfo.nullable(), payer_name: z.string().max(160).nullable(), for: z.string().max(320).nullable(),
      note: z.string().max(560).nullable(), requester_name: z.string().max(160).nullable(), requester_handle: handle.nullable(), created_at: isoTime,
    }),
  })).min(1).max(19),
  unpayable: z.array(z.object({ from: memberPosition, to: memberPosition, amount: decimal, reason: z.literal("no_wallet") })).max(19),
  ledger: GroupLedgerResponse,
});
export type SettleUpResponse = z.infer<typeof SettleUpResponse>;
// ---- F6 ledger end ----

// ---- F8 invoices start: invoice terms, refunds, statements ----
// POST /api/v1/invoices takes optional terms (installments, early_discount, late_fee, chase); GET /api/v1/invoices/:id
// adds `terms` (the plan, invoice-level status), `term_of` (an invoice a plan opened) and refunds. Every field optional.
const f8Percent = z.string().regex(/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/, "must be a percent like 10 or 2.5 (at most 2 decimal places)");
const f8Interval = z.union([z.literal("monthly"), z.number().int().min(7, "installments.interval must be at least 7 days").max(365, "installments.interval can be at most 365 days")]);
const f8Role = z.enum(["installment", "early_price", "full_price", "late_fee"]);
const refundId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed refund id");
const signedDecimal = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/, "must be a decimal string");

export const InvoiceTermsFields = {
  installments: z.object({
    count: z.number().int().min(2, "installments.count must be 2 to 12").max(12, "installments.count must be 2 to 12"),
    interval: f8Interval.default("monthly"),
    first_due: isoDate.nullish(),
  }).nullish(),
  early_discount: z.object({ amount: z.string().max(40).nullish(), percent: f8Percent.nullish(), until: isoDate }).nullish(),
  late_fee: z.object({ amount: z.string().max(40).nullish(), percent: f8Percent.nullish() }).nullish(),
  chase: z.union([z.literal(false), z.object({ days: z.array(z.number().int().min(1).max(90)).min(1).max(3) })]).nullish(),
};
export const CreateInvoiceTermsBody = CreateInvoiceBody.extend(InvoiceTermsFields);
export type CreateInvoiceTermsBody = z.infer<typeof CreateInvoiceTermsBody>;

export const TermRequest = z.object({
  role: f8Role,
  seq: z.number().int().min(1).max(12),
  amount: decimal,
  fiat_amount: decimal.optional(),
  due_date: isoDate,
  opens_on: isoDate,
  status: z.enum(["open", "paid", "underpaid", "cancelled", "expired", "scheduled", "skipped"]),
  id: requestId.nullable(),
  link: z.url().nullable(),
  skip_reason: z.string().max(200).nullable(),
  paid: z.object({ amount: decimal, at: isoTime, signature: z.string(), on_time: z.boolean() }).optional(),
  superseded_by: requestId.optional(),
});

export const InvoiceTerms = z.object({
  status: requestStatus,
  paid_so_far: decimal,
  remaining: decimal,
  pay_now: z.object({
    id: requestId, link: z.url(), amount: decimal, due_date: isoDate.nullable(), role: z.enum(["installment", "early_price", "full_price", "late_fee", "invoice"]),
    seq: z.number().int().min(1).max(12).nullable(),
  }).nullable(),
  installments: z.object({ count: z.number().int().min(2).max(12), interval: f8Interval, interval_label: z.string().max(40), plan: z.array(TermRequest).min(2).max(12) }).nullable(),
  early_discount: z.object({
    early_price: decimal, full_price: decimal, discount: decimal, percent: z.string().nullable(), until: isoDate,
    early: TermRequest, full: TermRequest, paid_with: z.enum(["early", "full"]).nullable(),
  }).nullable(),
  late_fee: z.object({ amount: decimal, percent: z.string().nullable(), applies_after: isoDate, request: TermRequest }).nullable(),
  chase: z.object({ days: z.array(z.number().int().min(1).max(90)).min(1).max(3) }).nullable(),
  refunded: decimal,
});

export const TermOf = z.object({
  invoice_id: requestId, link: z.url(), role: f8Role, seq: z.number().int().min(1).max(12), count: z.number().int().min(2).max(12).nullable(), label: z.string().max(40),
});

export const InvoiceTermsResponse = InvoiceResponse.extend({
  terms: InvoiceTerms.optional(),
  term_of: TermOf.optional(),
  superseded_by: requestId.optional(),
  refunded: decimal.optional(),
  refunds: z.array(z.object({
    id: refundId, request_id: requestId, amount: decimal, status: z.enum(["pending", "confirmed", "lapsed"]),
    confirmed_at: isoTime.optional(), signature: z.string().optional(),
  })).max(100).optional(),
});
export type InvoiceTermsResponse = z.infer<typeof InvoiceTermsResponse>;

// POST /api/v1/refunds. The recipient's wallet signs "Owed refund <amount> <token> of <request> to <payer> for <recipient> at <ISO>".
export const CreateRefundBody = z.object({
  request: requestId,
  recipient: base58Key,
  amount: z.string().max(40),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export type CreateRefundBody = z.infer<typeof CreateRefundBody>;

const refundConfirmed = z.object({ signature: z.string(), amount: decimal, at: isoTime });
export const RefundResponse = z.object({
  id: refundId,
  request_id: requestId,
  request_link: z.url(),
  recipient: base58Key,
  payer: base58Key,
  token,
  amount: decimal,
  reference: base58Key,
  memo: z.string().regex(/^owed-refund:[1-9A-HJ-NP-Za-km-z]{12}$/),
  status: z.enum(["pending", "confirmed", "lapsed"]),
  created_at: isoTime,
  signed_message: z.string().max(200),
  signature: z.string().max(200),
  confirmed: refundConfirmed.nullable(),
});
export type RefundResponse = z.infer<typeof RefundResponse>;

/** POST's reply: the refund, and what the request's refunds come to now (this one included). */
export const CreateRefundResponse = RefundResponse.extend({ paid: decimal, refunded: decimal, pending: decimal, refundable: decimal });
export type CreateRefundResponse = z.infer<typeof CreateRefundResponse>;

export const RefundSummary = z.object({
  request_id: requestId,
  token,
  paid: decimal.nullable(),
  refunded: decimal,
  pending: decimal,
  refundable: decimal,
  refunds: z.array(z.object({ id: refundId, amount: decimal, status: z.enum(["pending", "confirmed", "lapsed"]), created_at: isoTime, confirmed: refundConfirmed.nullable() })).max(100),
});

// GET /api/v1/refunds?requests=a,b,c (1 to 20): each request's refunds, chain-checked when pending.
export const RefundsLookupResponse = z.object({
  requests: z.array(RefundSummary).max(20),
  not_found: z.array(z.string()).max(20),
  chain_checked: z.boolean(),
});
export type RefundsLookupResponse = z.infer<typeof RefundsLookupResponse>;

// GET /api/v1/statements?recipient&client&month&signed_message&signature (the recipient's signed ledger message).
export const StatementResponse = z.object({
  recipient: base58Key,
  client: z.string().min(1).max(64),
  month: period,
  from: isoTime,
  to: isoTime,
  generated_at: isoTime,
  caution: z.string(),
  chain_checked: z.boolean(),
  invoices: z.array(z.object({
    id: requestId, invoice_number: z.string().nullable(), issue_date: isoDate, due_date: isoDate, total: decimal, token, status: requestStatus, link: z.url(),
  })).max(200),
  lines: z.array(z.object({
    at: isoTime, kind: z.enum(["invoiced", "cancelled", "expired", "paid", "refunded"]), request_id: requestId, invoice_id: requestId.nullable(),
    invoice_number: z.string().nullable(), description: z.string().max(160), token, amount: decimal, signature: z.string().nullable(), link: z.url(),
  })).max(5000),
  totals: z.array(z.object({ token, opening: signedDecimal, invoiced: decimal, cancelled: decimal, paid: decimal, refunded: decimal, closing: signedDecimal })).max(2),
  truncated: z.boolean(),
  csv: z.object({ url: z.url(), expires_at: isoTime }).nullable(),
  page: z.object({ url: z.url(), expires_at: isoTime }).nullable(),
});
export type StatementResponse = z.infer<typeof StatementResponse>;
// ---- F8 invoices end ----

// ---- S1 alerts start: paid alerts (migration 0025, lib/alerts/*) ----
// POST /api/v1/alerts: the wallet signs "Owed alerts for <wallet> at <ISO time>" (once, within 5 minutes) and names a
// channel. Telegram answers with a one-time /start code inside a t.me deep link (15 minutes); email (only when the
// deployment has it configured) sends a confirm link (24 hours). POST /api/v1/alerts/confirm turns an email link on;
// POST /api/v1/alerts/unsubscribe (also RFC 8058 one-click) turns any alert email's subscription off. Tokens are
// base64url, 43 characters; Owed stores only their sha256.
const alertId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character alert id");
const alertSignedFields = {
  wallet: base58Key,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
};
export const ALERT_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const CreateAlertBody = z.discriminatedUnion("channel", [
  z.object({ ...alertSignedFields, channel: z.literal("telegram") }).strict(),
  z.object({ ...alertSignedFields, channel: z.literal("email"), email: z.string().max(254).regex(ALERT_EMAIL, "must be an email address like you@example.com") }).strict(),
]);
export type CreateAlertBody = z.infer<typeof CreateAlertBody>;

const alertPending = {
  id: alertId,
  wallet: base58Key,
  status: z.literal("pending"),
  created_at: isoTime,
  /** When the /start code or the confirm link stops working. */
  expires_at: isoTime,
  next: z.string().max(300),
};
export const CreateAlertResponse = z.discriminatedUnion("channel", [
  z.object({
    ...alertPending,
    channel: z.literal("telegram"),
    telegram: z.object({ bot: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/), code: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), link: z.url() }),
  }),
  z.object({ ...alertPending, channel: z.literal("email"), email: z.object({ address: z.string().max(254) }) }),
]);
export type CreateAlertResponse = z.infer<typeof CreateAlertResponse>;

export const AlertTokenBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "must be the token from the link") }).strict();
export type AlertTokenBody = z.infer<typeof AlertTokenBody>;

export const ConfirmAlertResponse = z.object({
  id: alertId,
  wallet: base58Key,
  channel: z.literal("email"),
  status: z.literal("active"),
  activated_at: isoTime,
  already_active: z.boolean(),
});
export type ConfirmAlertResponse = z.infer<typeof ConfirmAlertResponse>;

export const UnsubscribeAlertResponse = z.object({
  id: alertId,
  wallet: base58Key,
  channel: z.enum(["telegram", "email"]),
  status: z.literal("unsubscribed"),
  unsubscribed_at: isoTime,
  already_unsubscribed: z.boolean(),
});
export type UnsubscribeAlertResponse = z.infer<typeof UnsubscribeAlertResponse>;
// ---- S1 alerts end ----
// ---- F4 cash out start (SP9): /api/v1/cash-out, /api/v1/cash-out/<id>, /api/v1/cash-out/accounts ----
// The recipient sells USDC to MoonPay, which pays their bank. Owed never holds it: the plugin proposes one transfer from
// the user's wallet to a deposit address that only ever comes from MoonPay (lib/moonpay/cash-out.ts).
const cashOutId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed cash-out id");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be a lower-case UUID");
export const CreateCashOutBody = z.object({
  wallet: base58Key,
  amount: z.string().max(40).optional(),
  request_ids: z.array(requestId).min(1).max(20).optional(),
  fiat_currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter currency code").optional(),
}).strict();
export type CreateCashOutBody = z.infer<typeof CreateCashOutBody>;
export const CashOutStatusBody = z.object({ wallet: base58Key }).strict();
export const CashOutResponse = z.object({
  id: cashOutId,
  wallet: base58Key,
  amount: decimal,
  token: z.literal("USDC"),
  fiat_currency: z.string().regex(/^[a-z]{3}$/).nullable(),
  request_ids: z.array(requestId).max(20),
  requests_total: decimal.optional(),
  mode: z.enum(["sell_widget", "enterprise"]),
  status: z.enum(["created", "waiting_for_deposit", "pending", "completed", "failed", "requote_required"]),
  widget_url: z.url().nullable(),
  moonpay_transaction_id: z.string().max(100).nullable(),
  deposit_address: base58Key.nullable(),
  transfer_signature: z.string().max(120).nullable(),
  failure_reason: z.string().max(300).nullable(),
  problem: z.string().max(400).nullable(),
  account: z.object({ id: uuid, liquidation_address: base58Key, signed_message: z.string().max(200), signature: z.string().max(200) }).nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type CashOutResponse = z.infer<typeof CashOutResponse>;
/** POST /api/v1/cash-out/accounts and /api/v1/virtual-accounts: first without, then with, the wallet's signature. */
export const RouteAccountBody = z.object({
  wallet: base58Key,
  autoramp_id: uuid,
  signed_message: z.string().min(1).max(200).optional(),
  signature: z.string().min(64).max(200).optional(),
}).strict();
export type RouteAccountBody = z.infer<typeof RouteAccountBody>;
const payoutCurrency = z.enum(["EUR", "USD", "GBP"]);
export const CashOutAccountResponse = z.union([
  z.object({ step: z.literal("sign"), message_to_sign: z.string().max(200), sign_by: isoTime, liquidation_address: base58Key, currency: payoutCurrency, payout_rail: z.string().max(16) }),
  z.object({ step: z.literal("stored"), id: uuid, wallet: base58Key, liquidation_address: base58Key, currency: payoutCurrency, payout_rail: z.string().max(16), status: z.enum(["active", "closed"]), created_at: isoTime }),
]);
export type CashOutAccountResponse = z.infer<typeof CashOutAccountResponse>;
// ---- F4 cash out end ----

// ---- F3 bank rail start (SP9): /api/v1/virtual-accounts. Off unless OWED_BANK_RAIL=1. ----
const payerRail = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SEPA"), iban: z.string().max(34), bic: z.string().max(11).nullable(), account_holder: z.string().max(140).nullable(), bank_name: z.string().max(140).nullable() }),
  z.object({ type: z.enum(["ACH", "Wire", "RTP", "FedNow"]), routing_number: z.string().max(9), account_number: z.string().max(34), account_holder: z.string().max(140).nullable(), bank_name: z.string().max(140).nullable() }),
  z.object({ type: z.enum(["CHAPS", "FPS"]), sort_code: z.string().max(8), account_number: z.string().max(8), account_holder: z.string().max(140).nullable(), bank_name: z.string().max(140).nullable() }),
]);
export const VirtualAccountResponse = z.union([
  z.object({ step: z.literal("sign"), message_to_sign: z.string().max(200), sign_by: isoTime, currency: payoutCurrency, rails: z.array(payerRail).min(1).max(6) }),
  z.object({ step: z.literal("stored"), id: uuid, wallet: base58Key, currency: payoutCurrency, rails: z.array(payerRail).min(1).max(6), status: z.enum(["active", "closed"]), created_at: isoTime }),
]);
export type VirtualAccountResponse = z.infer<typeof VirtualAccountResponse>;
// ---- F3 bank rail end ----
// ---- F5 autopay start: payer rules (migration 0022, lib/autopay.ts) ----
// POST /api/v1/autopay stores a payer's rule; the payer's wallet signs, once and within 5 minutes,
//   "Owed autopay for <payer>: pay <requester> up to <max> USDC per request and <max_month> USDC per month until <YYYY-MM-DD> (at <ISO>)"
// with the amounts written as fromAtomic writes them ("1500", "0.5"). POST /api/v1/autopay/revoke ends one:
//   "Owed autopay revoke <rule id> for <payer> at <ISO>".
// The rule matches the requester's wallet only; handle and sns are labels. The signed inbox carries the payer's live rules
// (autopay_rules) and a verdict per line (autopay). Owed never pays: what_do_i_owe hands the agent PayBox pay_x402 calls.
const ruleId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed autopay rule id");

export const AutopayRequesterBody = z.object({
  wallet: z.string().max(64),
  handle: z.string().max(32).nullish(),
  sns: z.string().min(1).max(140).nullish(),
}).strict();

export const AutopayCreateBody = z.object({
  payer: base58Key,
  requester: AutopayRequesterBody,
  token: z.literal("USDC").default("USDC"),
  max_per_request: z.string().max(40),
  max_per_month: z.string().max(40),
  ends: z.string().max(10),
  signed_message: z.string().min(1).max(300),
  signature: z.string().min(64).max(200),
}).strict();
export type AutopayCreateBody = z.infer<typeof AutopayCreateBody>;

export const AutopayRevokeBody = z.object({
  payer: base58Key,
  rule_id: ruleId,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export type AutopayRevokeBody = z.infer<typeof AutopayRevokeBody>;

export const AutopayRule = z.object({
  id: ruleId,
  payer: base58Key,
  requester: z.object({ wallet: base58Key, handle: handle.nullable(), sns: z.string().max(140).nullable() }),
  token: z.literal("USDC"),
  max_per_request: decimal,
  max_per_month: decimal,
  /** The rule's last day (UTC); it stops at ends_at, the start of the next day. */
  ends: isoDate,
  ends_at: isoTime,
  created_at: isoTime,
  status: z.enum(["active", "ended", "revoked"]),
  revoked_at: isoTime.nullable(),
  replaced_by: ruleId.nullable(),
  /** The UTC month used_this_month counts (YYYY-MM): paid to the requester since the month began and the rule was made. */
  month: period,
  used_this_month: decimal,
  signed_message: z.string().max(300),
  signature: z.string().max(200),
});
export type AutopayRule = z.infer<typeof AutopayRule>;

export const AutopayCreateResponse = z.object({ rule: AutopayRule, replaced: ruleId.nullable() });
export type AutopayCreateResponse = z.infer<typeof AutopayCreateResponse>;

export const AutopayRevokeResponse = z.object({ rule: AutopayRule, already_revoked: z.boolean() });
export type AutopayRevokeResponse = z.infer<typeof AutopayRevokeResponse>;

export const AutopayVerdict = z.object({
  status: z.enum(["eligible", "over_limit", "not_covered"]),
  rule_id: ruleId.optional(),
  reason: z.string().max(300),
});
export type AutopayVerdict = z.infer<typeof AutopayVerdict>;
// ---- F5 autopay end ----
// ---- F7 pots start ----
// Chip-in pots (decision D15, migration 0019). POST /api/v1/pots, GET /api/v1/pots/:id, POST /api/v1/pots/:id/contributions.
// A pot id is the last 14 base58 characters of sha256("owed-pot:v1\n" recipient "\n" asset "\n" nonce) (lib/ids.ts).
// A contribution is an ordinary request (kind 'single') that carries `pot`; nothing else about requests changes.
export const potId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{14}$/, "must be a 14-character Owed pot id");
export const POT_DEADLINE_DAYS = { min: 1, max: 90 } as const;
const potAmountText = z.string().max(40);

export const CreatePotBody = z.object({
  recipient: base58Key,
  token: token.default("USDC"),
  title: z.string().min(1).max(80 * 4),
  note: untrusted(140),
  requester_name: untrusted(TEXT_LIMITS.requester_name),
  requester_handle: requesterHandleBody,
  target: potAmountText.nullish(),
  suggested: potAmountText.nullish(),
  any_amount: z.boolean().nullish(),
  presets: z.array(potAmountText).max(4, "presets: at most 4 amounts").nullish(),
  /** An exact end (ISO); or deadline_days; default 30 days. */
  deadline: isoTime.nullish(),
  deadline_days: z.number({ error: "deadline_days must be a whole number of days from 1 to 90" }).int("deadline_days must be a whole number of days from 1 to 90")
    .min(POT_DEADLINE_DAYS.min, "deadline_days must be at least 1").max(POT_DEADLINE_DAYS.max, "deadline_days can be at most 90").nullish(),
  source: z.enum(["plugin", "web"]).default("web"),
});
export type CreatePotBody = z.infer<typeof CreatePotBody>;

export const ContributionBody = z.object({
  amount: potAmountText.nullish(),
  source: z.enum(["plugin", "web"]).default("web"),
});
export type ContributionBody = z.infer<typeof ContributionBody>;

const potLinkAmount = z.object({ amount: decimal, url: z.string().max(2048) });
export const PotResponse = z.object({
  id: potId,
  link: z.url(),
  recipient: base58Key,
  token,
  nonce: base58Key,
  title: z.string().min(1).max(120),
  note: z.string().nullable(),
  requester_name: z.string().nullable(),
  requester_handle: handle.nullable(),
  target: decimal.nullable(),
  suggested: decimal.nullable(),
  any_amount: z.boolean(),
  presets: z.array(decimal).max(4),
  deadline: isoTime,
  status: z.enum(["open", "ended"]),
  created_at: isoTime,
  flags: z.array(z.string()),
  totals: z.object({ raised: decimal, count: z.number().int().nonnegative() }),
  contributions: z.array(z.object({ id: requestId, amount: decimal, payer: base58Key, signature: z.string(), at: isoTime, rail: PaidInfo.shape.rail })).max(100),
  chain_checked: z.boolean(),
  links: z.object({ board: z.url(), transaction_request: z.array(potLinkAmount).max(5), x402: z.array(potLinkAmount).max(4) }),
});
export type PotResponse = z.infer<typeof PotResponse>;

/** A contribution: a request (GET /api/v1/requests/:id shape) that names its pot. */
export const PotRef = z.object({ id: potId, title: z.string().min(1).max(120), link: z.url() });
export const PotContributionResponse = GetRequestResponse.extend({ pot: PotRef });
export type PotContributionResponse = z.infer<typeof PotContributionResponse>;

/** who_owes_me: a recipient's open pots (POST /api/v1/ledger adds `pots`). */
export const PotSummary = z.object({
  id: potId, link: z.url(), title: z.string(), token, raised: decimal, count: z.number().int().nonnegative(),
  target: decimal.nullable(), deadline: isoTime, flags: z.array(z.string()),
});
export const LedgerPotsResponse = LedgerResponse.extend({ pots: z.array(PotSummary).max(20).optional() });
export type LedgerPotsResponse = z.infer<typeof LedgerPotsResponse>;

/** GET /api/v1/stats adds pots: how many were started and how many contributions were paid (also in paid_count). */
export const StatsPotsResponse = StatsResponse.extend({
  pots: z.object({ count: z.number().int().nonnegative(), paid_contributions: z.number().int().nonnegative() }).optional(),
});
// ---- F7 pots end ----
