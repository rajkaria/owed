import { z } from "zod";
import { TEXT_LIMITS } from "./safety";

// Zod mirror of the /api/v1 contract. contract/fixtures/*.json must all parse
// (test/contract.test.ts), and plugin/src/contract.ts mirrors the same shapes.

export const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const decimal = z.string().regex(DECIMAL, "must be a decimal string");
const base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 Solana address");
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

// Raw text may be longer than its cap: links and invisible characters are stripped
// first, then the clean text is cut to the cap. 4x the cap bounds the work.
const untrusted = (cap: number) => z.string().max(cap * 4).nullish();

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
});
export type CreateRequestResponse = z.infer<typeof CreateRequestResponse>;

export const PaidInfo = z.object({
  signature: z.string(),
  payer: anyAddress, // W3-B
  amount: decimal,
  at: isoTime,
  rail: z.enum(["solana_pay", "x402", "base_transfer"]), // W3-B: base_transfer
});

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
});

// Split bills: POST /api/v1/groups, GET /api/v1/groups/:id (one response shape for both).
const groupId = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/, "must be a 12-character Owed group id");

export const CreateGroupBody = z.object({
  recipient: base58Key,
  total: z.string().max(40),
  token: token.default("USDC"),
  title: z.string().min(1).max(60 * 4),
  people: z
    .array(z.object({ name: z.string().min(1).max(TEXT_LIMITS.payer_name * 4), amount: z.string().max(40).nullish() }))
    .min(2, "a split needs at least 2 people")
    .max(20, "a split takes at most 20 people"),
  requester_name: untrusted(TEXT_LIMITS.requester_name),
  source: z.enum(["plugin", "web"]).default("web"),
  from_domain: z.string().min(1).max(253).nullish(),
  expires_in_days: expiresInDays, // W3-C: every share expires together
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
});
export type ScheduleResponse = z.infer<typeof ScheduleResponse>;
