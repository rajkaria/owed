import * as z from "zod/v4";
import { REQUEST_ID_RE } from "./request-id.js";

// Zod mirror of the Owed HTTP API (/api/v1). web/lib/contract.ts holds the same shapes;
// both sides parse every file in contract/fixtures/. Response objects are not strict so an
// additive server change never breaks an uploaded plugin version.

export const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const tokenSchema = z.enum(["USDC", "SOL"]);
export const decimalSchema = z.string().max(40).regex(DECIMAL);
export const addressSchema = z.string().min(32).max(44).regex(BASE58);
export const requestIdSchema = z.string().regex(REQUEST_ID_RE);
export const signatureSchema = z.string().min(64).max(90).regex(BASE58);
const isoTime = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
const httpsUrl = z.string().max(2048).regex(/^https:\/\//);
const solanaPayUrl = z.string().max(2048).regex(/^solana:/);
// W3-B Base requests: a Base request's recipient and payer are 0x addresses, its payment a 0x transaction hash.
export const chainSchema = z.enum(["solana", "base"]);
export const evmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const anyAddress = z.union([addressSchema, evmAddressSchema]);
const anySignature = z.union([signatureSchema, txHashSchema]);
const payUrl = z.string().max(2048).regex(/^(solana|ethereum):/);

// W3-C: + "expired" (an open request past its expires_at; the server computes it).
export const requestStatusSchema = z.enum(["open", "paid", "underpaid", "cancelled", "expired", "not_found", "invalid"]);
/** W3-C: optional expiry on creation, whole days. The server sets expires_at from its own clock. */
export const expiresInDaysSchema = z.number().int().min(1).max(90);
export const errorCodeSchema = z.enum(["invalid_input", "rate_limited", "not_found", "upstream_unavailable", "blocked"]);

export const createRequestReqSchema = z.object({
  recipient: anyAddress, // W3-B: a 0x address with chain "base"
  amount: decimalSchema,
  token: tokenSchema,
  payer_name: z.string().max(40).optional(),
  for: z.string().max(80).optional(),
  note: z.string().max(140).optional(),
  requester_name: z.string().max(40).optional(),
  kind: z.literal("single").optional(),
  group_id: z.string().max(40).optional(),
  source: z.enum(["plugin", "web"]),
  from_domain: z.string().min(1).max(253).optional(), // W2-H verified payee: the plugin checked it over DNS first
  expires_in_days: expiresInDaysSchema.optional(), // W3-C
  chain: chainSchema.optional(), // W3-B: absent = solana
}).strict();

export const createRequestResSchema = z.object({
  id: requestIdSchema,
  link: httpsUrl,
  solana_pay_url: solanaPayUrl.nullable(), // W3-B: null on Base requests
  qr_url: httpsUrl,
  reference: addressSchema,
  x402_url: httpsUrl.nullable().optional(),
  created_at: isoTime,
  flags: z.array(z.string().max(80)).max(32),
  from_domain: z.string().max(253).nullable().optional(), // W2-H verified payee
  expires_at: isoTime.nullable().optional(), // W3-C
  chain: chainSchema.optional(), // W3-B: absent = solana
  pay_url: payUrl.optional(), // W3-B: what a wallet opens (solana:, or ethereum: EIP-681 on Base)
});

export const paidInfoSchema = z.object({
  signature: anySignature, // W3-B
  payer: anyAddress, // W3-B
  amount: decimalSchema,
  at: isoTime,
  rail: z.string().max(20).optional(),
});

export const getRequestResSchema = z.object({
  id: requestIdSchema,
  kind: z.string().max(20).optional(),
  recipient: anyAddress, // W3-B
  amount: decimalSchema,
  token: tokenSchema,
  payer_name: z.string().max(40).nullable().optional(),
  for: z.string().max(80).nullable().optional(),
  note: z.string().max(140).nullable().optional(),
  requester_name: z.string().max(40).nullable().optional(),
  status: requestStatusSchema,
  solana_pay_url: solanaPayUrl.nullable(), // W3-B: null on Base requests
  reference: addressSchema,
  x402_url: httpsUrl.nullable().optional(),
  created_at: isoTime,
  paid: paidInfoSchema.nullable().optional(),
  flags: z.array(z.string().max(80)).max(32),
  // W2-H verified payee: display copy only. pay_link re-checks the domain's DNS itself.
  from_domain: z.string().max(253).nullable().optional(),
  from_domain_verified_at: isoTime.nullable().optional(),
  // W3-C: when it stops taking payments, and the recipient's signed cancellation (display; never trusted for paying).
  expires_at: isoTime.nullable().optional(),
  cancelled: z.object({ at: isoTime, signed_message: z.string().max(200), signature: z.string().max(200) }).nullable().optional(),
  chain: chainSchema.optional(), // W3-B: absent = solana
  pay_url: payUrl.optional(), // W3-B
});

export const statusReqSchema = z.object({ ids: z.array(requestIdSchema).min(1).max(20) }).strict();

const paymentFields = {
  amount_paid: decimalSchema.optional(),
  payer: anyAddress.optional(), // W3-B
  signature: anySignature.optional(), // W3-B
  paid_at: isoTime.optional(),
};

// A result for an id the server doesn't know ("not_found") or can't read ("invalid") carries only id and status
// (QA-05); every other status names the amount and token, as contract/shapes.mjs requires.
export const statusResultSchema = z.object({
  id: requestIdSchema,
  status: requestStatusSchema,
  amount_requested: decimalSchema.optional(),
  token: tokenSchema.optional(),
  ...paymentFields,
  // check_payments turns it into how long an open request has waited.
  created_at: isoTime.optional(),
  expires_at: isoTime.optional(), // W3-C
  cancelled_at: isoTime.optional(),
  chain: chainSchema.optional(), // W3-B: "base" on Base requests (their payment links go to Basescan)
}).superRefine((r, ctx) => {
  if (r.status === "not_found" || r.status === "invalid") return;
  for (const key of ["amount_requested", "token"] as const) {
    if (r[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: `missing for status ${r.status}` });
  }
});

export const statusResSchema = z.object({ results: z.array(statusResultSchema).max(20) });

export const statusRawReqSchema = z.object({ solana_pay_url: solanaPayUrl }).strict();

export const statusRawResSchema = z.object({
  status: requestStatusSchema,
  amount_requested: decimalSchema.optional(),
  token: tokenSchema.optional(),
  ...paymentFields,
});

export const statsResSchema = z.object({
  paid_count: z.number().int().nonnegative(),
  paid_volume_usdc: decimalSchema,
  since: isoTime,
});

// Split bills: POST /groups (and GET /groups/:id, same shape). Share ids commit to their terms like any
// request id; the group id commits to the share ids in order (tools/split_bill.ts `groupIdFor`).
export const groupIdSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/);

export const createGroupReqSchema = z.object({
  recipient: addressSchema,
  total: decimalSchema,
  token: tokenSchema,
  title: z.string().min(1).max(60),
  people: z.array(z.object({ name: z.string().min(1).max(40), amount: decimalSchema.optional() }).strict()).min(2).max(20),
  requester_name: z.string().max(40).optional(),
  source: z.enum(["plugin", "web"]),
  from_domain: z.string().min(1).max(253).optional(),
  expires_in_days: expiresInDaysSchema.optional(), // W3-C
}).strict();

export const groupShareSchema = z.object({
  id: requestIdSchema,
  // Caps are in UTF-16 units here; the server caps code points, so leave room.
  name: z.string().max(160).nullable(),
  amount: decimalSchema,
  status: z.string().max(20),
  link: httpsUrl,
  solana_pay_url: solanaPayUrl,
  reference: addressSchema,
  paid: paidInfoSchema.nullable().optional(),
  from_domain: z.string().max(253).nullable().optional(), // W2-H: split_bill checks every share echoes the domain
});

export const groupResSchema = z.object({
  id: groupIdSchema,
  link: httpsUrl,
  title: z.string().max(240).nullable(),
  recipient: addressSchema,
  token: tokenSchema,
  total: decimalSchema,
  requester_name: z.string().max(160).nullable().optional(),
  created_at: isoTime,
  flags: z.array(z.string().max(80)).max(32),
  from_domain: z.string().max(253).nullable().optional(),
  from_domain_verified_at: isoTime.nullable().optional(),
  share_count: z.number().int().min(2).max(20),
  paid_count: z.number().int().nonnegative(),
  amount_received: decimalSchema,
  shares: z.array(groupShareSchema).min(2).max(20),
  expires_at: isoTime.optional(), // W3-C
});

export const errorResSchema = z.object({
  error: z.object({ code: errorCodeSchema, message: z.string().max(500) }),
});

// ---- invoices (POST /api/v1/invoices, GET /api/v1/invoices/:id) ----
// An invoice is one request for its total with the same id, so the request schemas above apply to it too.

export const INVOICE_LIMITS = { business_name: 60, client_name: 60, description: 80, invoice_number: 20, notes: 280, items: 20 } as const;
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A positive decimal with at most 4 places ("1.5" hours). */
export const quantitySchema = z.string().max(20).regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$/);

export const createInvoiceReqSchema = z.object({
  recipient: addressSchema,
  token: tokenSchema,
  business_name: z.string().min(1).max(INVOICE_LIMITS.business_name),
  client_name: z.string().min(1).max(INVOICE_LIMITS.client_name),
  items: z.array(z.object({
    description: z.string().min(1).max(INVOICE_LIMITS.description),
    quantity: quantitySchema.optional(),
    unit_price: decimalSchema,
  }).strict()).min(1).max(INVOICE_LIMITS.items),
  due_date: isoDateSchema,
  invoice_number: z.string().min(1).max(INVOICE_LIMITS.invoice_number).optional(),
  notes: z.string().min(1).max(INVOICE_LIMITS.notes).optional(),
  from_domain: z.string().min(1).max(253).optional(),
  source: z.enum(["plugin", "web"]),
  expires_in_days: expiresInDaysSchema.optional(), // W3-C
}).strict();

export const invoiceResSchema = z.object({
  id: requestIdSchema,
  link: httpsUrl,
  request_link: httpsUrl,
  solana_pay_url: solanaPayUrl,
  qr_url: httpsUrl,
  reference: addressSchema,
  x402_url: httpsUrl.nullable().optional(),
  recipient: addressSchema,
  token: tokenSchema,
  business_name: z.string().max(INVOICE_LIMITS.business_name),
  client_name: z.string().max(INVOICE_LIMITS.client_name),
  invoice_number: z.string().max(INVOICE_LIMITS.invoice_number).nullable(),
  notes: z.string().max(INVOICE_LIMITS.notes).nullable(),
  issue_date: isoDateSchema,
  due_date: isoDateSchema,
  items: z.array(z.object({
    description: z.string().max(INVOICE_LIMITS.description),
    quantity: quantitySchema,
    unit_price: decimalSchema,
    amount: decimalSchema,
  })).min(1).max(INVOICE_LIMITS.items),
  total: decimalSchema,
  status: requestStatusSchema,
  paid: paidInfoSchema.nullable().optional(),
  created_at: isoTime,
  flags: z.array(z.string().max(80)).max(32),
  from_domain: z.string().max(253).nullable().optional(),
  from_domain_verified_at: isoTime.nullable().optional(),
  expires_at: isoTime.optional(), // W3-C
  cancelled_at: isoTime.optional(),
});

export type Token = z.infer<typeof tokenSchema>;
export type Chain = z.infer<typeof chainSchema>; // W3-B
export type RequestStatus = z.infer<typeof requestStatusSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type CreateRequestReq = z.infer<typeof createRequestReqSchema>;
export type CreateRequestRes = z.infer<typeof createRequestResSchema>;
export type GetRequestRes = z.infer<typeof getRequestResSchema>;
export type StatusReq = z.infer<typeof statusReqSchema>;
export type StatusRes = z.infer<typeof statusResSchema>;
export type StatusResult = z.infer<typeof statusResultSchema>;
export type StatusRawReq = z.infer<typeof statusRawReqSchema>;
export type StatusRawRes = z.infer<typeof statusRawResSchema>;
export type StatsRes = z.infer<typeof statsResSchema>;
export type ErrorRes = z.infer<typeof errorResSchema>;
export type CreateGroupReq = z.infer<typeof createGroupReqSchema>;
export type GroupRes = z.infer<typeof groupResSchema>;
export type CreateInvoiceReq = z.infer<typeof createInvoiceReqSchema>;
export type InvoiceRes = z.infer<typeof invoiceResSchema>;

// W2-D: POST /api/v1/ledger (who_owes_me). A fresh recipient signature unlocks the ledger once.
export const ledgerReqSchema = z.object({
  recipient: addressSchema,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
  csv: z.literal(true).optional(), // W3-D: also mint a 10-minute CSV download link
}).strict();

export const ledgerEntrySchema = z.object({
  id: requestIdSchema,
  kind: z.string().max(20),
  link: httpsUrl,
  amount: decimalSchema,
  token: tokenSchema,
  status: z.enum(["open", "underpaid", "paid"]),
  payer_name: z.string().max(40).nullable(),
  for: z.string().max(80).nullable(),
  created_at: isoTime,
  amount_due: decimalSchema.optional(),
  amount_paid: decimalSchema.optional(),
  payer: addressSchema.optional(),
  signature: signatureSchema.optional(),
  paid_at: isoTime.optional(),
  group_id: z.string().max(40).nullable(),
  // Split shares: the bill's title and board; invoices: number and due date. Optional so an older server still parses.
  group_title: z.string().max(240).nullable().optional(),
  group_link: httpsUrl.nullable().optional(),
  invoice_number: z.string().max(80).nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  from_domain: z.string().max(253).nullable(),
  flags: z.array(z.string().max(80)).max(32).optional(),
  // W3-D: the monthly schedule and month that opened this request (null or absent for one-off requests).
  schedule_id: z.string().max(40).nullable().optional(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable().optional(),
});

// W3-D: a monthly schedule as the ledger lists it.
export const scheduleSummarySchema = z.object({
  id: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/),
  status: z.string().max(20),
  amount: decimalSchema,
  token: tokenSchema,
  payer_name: z.string().max(40).nullable(),
  for: z.string().max(80).nullable(),
  day_of_month: z.number().int().min(1).max(28),
  months: z.number().int().min(1).max(120).nullable(),
  requests_opened: z.number().int().nonnegative(),
  next_request_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  created_at: isoTime,
  from_domain: z.string().max(253).nullable(),
  last_error: z.string().max(400).nullable(),
  requests: z.array(z.object({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    id: requestIdSchema,
    link: httpsUrl,
    status: z.string().max(20),
  })).max(24),
});

export const ledgerResSchema = z.object({
  recipient: addressSchema,
  caution: z.string().max(400).optional(),
  generated_at: isoTime,
  chain_checked: z.boolean(),
  open: z.array(ledgerEntrySchema).max(100),
  paid_recently: z.array(ledgerEntrySchema).max(100),
  totals: z.array(z.object({
    token: tokenSchema,
    outstanding: decimalSchema,
    received_30d: decimalSchema,
    open_count: z.number().int().nonnegative(),
    paid_count: z.number().int().nonnegative(),
  })).max(2),
  truncated: z.boolean(),
  schedules: z.array(scheduleSummarySchema).max(20).optional(), // W3-D
  csv: z.object({ url: httpsUrl, expires_at: isoTime }).nullable().optional(), // W3-D: null = export not configured
});

export type LedgerReq = z.infer<typeof ledgerReqSchema>;
export type LedgerRes = z.infer<typeof ledgerResSchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

// W3-C: POST /api/v1/requests/:id/cancel (cancel_request). The recipient's wallet signs
// "Owed cancel <id> for <recipient> at <ISO time>"; the server accepts it once, within 5 minutes.
export const cancelReqSchema = z.object({
  recipient: addressSchema,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();

export const cancelResSchema = getRequestResSchema.extend({ already_cancelled: z.boolean() });

export type CancelReq = z.infer<typeof cancelReqSchema>;
export type CancelRes = z.infer<typeof cancelResSchema>;
export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;

// W3-D: POST /api/v1/schedules (ask_every_month). Same payer, amount and text on the same day each month (UTC).
export const createScheduleReqSchema = z.object({
  recipient: addressSchema,
  amount: decimalSchema,
  token: tokenSchema,
  payer_name: z.string().max(40).optional(),
  for: z.string().max(80).optional(),
  requester_name: z.string().max(40).optional(),
  day_of_month: z.number().int().min(1).max(28),
  months: z.number().int().min(1).max(120).optional(),
  from_domain: z.string().min(1).max(253).optional(),
  source: z.enum(["plugin", "web"]),
}).strict();

export const scheduleResSchema = z.object({
  id: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/),
  recipient: addressSchema,
  amount: decimalSchema,
  token: tokenSchema,
  payer_name: z.string().max(40).nullable(),
  for: z.string().max(80).nullable(),
  requester_name: z.string().max(40).nullable().optional(),
  day_of_month: z.number().int().min(1).max(28),
  months: z.number().int().min(1).max(120).nullable(),
  first_period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  status: z.string().max(20),
  next_request_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  created_at: isoTime,
  flags: z.array(z.string().max(80)).max(32),
  from_domain: z.string().max(253).nullable().optional(),
  from_domain_verified_at: isoTime.nullable().optional(),
  first_request: z.object({
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    id: requestIdSchema,
    link: httpsUrl,
    solana_pay_url: solanaPayUrl,
    qr_url: httpsUrl,
    reference: addressSchema,
    x402_url: httpsUrl.nullable().optional(),
    created_at: isoTime,
    flags: z.array(z.string().max(80)).max(32),
    from_domain: z.string().max(253).nullable().optional(),
  }).nullable(),
});

export type CreateScheduleReq = z.infer<typeof createScheduleReqSchema>;
export type ScheduleRes = z.infer<typeof scheduleResSchema>;
