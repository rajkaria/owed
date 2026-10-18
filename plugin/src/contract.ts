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

// Local-currency asks: `currency` (ISO 4217, src/fiat.ts allowlist) makes a create body's amounts that currency;
// the server locks a USDC amount at a live rate. Replies carry the quote as `fiat`, display only: the id commits
// to the USDC amount, and amount / rate rounded up to 6 decimals must give it (src/fiat.ts quoteProblem).
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);
export const fiatQuoteSchema = z.object({
  currency: currencySchema,
  amount: decimalSchema,
  rate: decimalSchema,
  rate_source: z.string().min(1).max(120),
  quoted_at: isoTime,
});
export const snsSourceSchema = z.enum(["sol_record_v2", "sol_record_v1", "owner"]); // W3-S

// F1 payer inbox. A create body may say who it is addressed to: the payer's Solana wallet, with the X handle the agent
// resolved it from (PayBox resolve_username) or an .sns name. Handles are labels, lower case without "@"; Owed never
// verifies them. Replies echo what the server stored. The payer is never part of a request id.
export const handleSchema = z.string().regex(/^[a-z0-9_]{1,15}$/);
export const payerReqSchema = z.object({
  wallet: addressSchema.optional(),
  handle: handleSchema.optional(),
  sns: z.string().min(1).max(140).optional(),
}).strict();
export const payerInfoSchema = z.object({ wallet: addressSchema, handle: handleSchema.nullable(), sns: z.string().max(140).nullable() });
export type PayerReq = z.infer<typeof payerReqSchema>;
export type PayerInfo = z.infer<typeof payerInfoSchema>;

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
  currency: currencySchema.optional(), // local-currency ask: `amount` is in this currency
  sns_name: z.string().min(1).max(140).optional(), // W3-S: the plugin resolved it to recipient first
  payer: payerReqSchema.optional(), // F1
  requester_handle: handleSchema.optional(),
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
  amount: decimalSchema.optional(), // local-currency asks: the USDC amount locked
  fiat: fiatQuoteSchema.optional(),
  sns_name: z.string().max(140).nullable().optional(), // W3-S: the name the server re-resolved to recipient
  sns_source: snsSourceSchema.nullable().optional(),
  payer: payerInfoSchema.nullable().optional(), // F1
  requester_handle: handleSchema.nullable().optional(),
});

export const paidInfoSchema = z.object({
  signature: anySignature, // W3-B
  payer: anyAddress, // W3-B
  amount: decimalSchema,
  at: isoTime,
  rail: z.string().max(20).optional(),
});

// 0012: a payment without the request's reference that the recipient's wallet attributed to it (signed message),
// as the full record on a request and as the short form in status results and ledger entries.
export const matchedSchema = z.object({
  signature: signatureSchema,
  covers: z.enum(["full", "rest"]),
  payer: addressSchema,
  amount: decimalSchema,
  at: isoTime,
  confirmed_by: addressSchema,
  confirmed_at: isoTime,
  signed_message: z.string().max(200),
  message_signature: z.string().max(200),
});
export const matchedLiteSchema = z.object({ signature: signatureSchema, covers: z.enum(["full", "rest"]), amount: decimalSchema, confirmed_at: isoTime });
const restLinkSchema = z.object({ id: requestIdSchema, status: requestStatusSchema, link: httpsUrl.optional() });
const railSchema = z.string().max(20);

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
  // 0012 matched payments + ask_for_rest
  matched: matchedSchema.nullable().optional(),
  rest_of: requestIdSchema.nullable().optional(),
  rest_request: restLinkSchema.nullable().optional(),
  fiat: fiatQuoteSchema.optional(), // local-currency asks
  // W3-S: display copy only. pay_link re-resolves the name itself before paying.
  sns_name: z.string().max(140).nullable().optional(),
  sns_source: snsSourceSchema.nullable().optional(),
  sns_resolved_at: isoTime.nullable().optional(),
  // F1: who it is addressed to, and the requester's own X handle (labels: pay_link asks the agent to check the handle).
  payer: payerInfoSchema.nullable().optional(),
  requester_handle: handleSchema.nullable().optional(),
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
  // 0012: how it was paid, the recipient's match (no reference on the payment), the ask_for_rest links.
  rail: railSchema.optional(),
  matched: matchedLiteSchema.optional(),
  rest_of: requestIdSchema.optional(),
  rest_request: requestIdSchema.optional(),
  fiat: fiatQuoteSchema.optional(), // local-currency asks
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
  people: z.array(z.object({ name: z.string().min(1).max(40), amount: decimalSchema.optional(), payer: payerReqSchema.optional() }).strict()).min(2).max(20), // F1: + payer
  requester_name: z.string().max(40).optional(),
  source: z.enum(["plugin", "web"]),
  from_domain: z.string().min(1).max(253).optional(),
  expires_in_days: expiresInDaysSchema.optional(), // W3-C
  currency: currencySchema.optional(), // local-currency split: total and people's amounts are in this currency
  requester_handle: handleSchema.optional(), // F1
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
  fiat: fiatQuoteSchema.optional(), // local-currency split: this share in the bill's currency
  payer: payerInfoSchema.optional(), // F1
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
  fiat: fiatQuoteSchema.optional(), // local-currency split: the bill's total; `total` is the shares' USDC sum
  requester_handle: handleSchema.optional(), // F1
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
  currency: currencySchema.optional(), // local-currency invoice: every unit_price is in this currency
  payer: payerReqSchema.optional(), // F1: the client as a payer
  requester_handle: handleSchema.optional(),
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
  // Local-currency invoice: items are in fiat.currency, fiat.amount is their sum, `total` the USDC locked.
  fiat: fiatQuoteSchema.optional(),
  payer: payerInfoSchema.optional(), // F1
  requester_handle: handleSchema.optional(),
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
export type FiatQuoteRes = z.infer<typeof fiatQuoteSchema>;

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
  // 0012: paid rail, the recipient's match (no reference on the payment), the ask_for_rest links.
  rail: railSchema.optional(),
  matched: matchedLiteSchema.optional(),
  rest_of: requestIdSchema.optional(),
  rest_request: requestIdSchema.optional(),
  fiat: fiatQuoteSchema.optional(), // local-currency asks
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
  payer: payerReqSchema.optional(), // F1
  requester_handle: handleSchema.optional(),
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
  payer: payerInfoSchema.optional(), // F1
  requester_handle: handleSchema.optional(),
});

export type CreateScheduleReq = z.infer<typeof createScheduleReqSchema>;
export type ScheduleRes = z.infer<typeof scheduleResSchema>;

// ---- 0012: matched payments (match_payments) and ask_for_rest ----

// POST /api/v1/requests/:id/match. The recipient's wallet signs "Owed match <transaction> to <id> for <recipient> at <ISO>";
// the server accepts it once, within 5 minutes, after re-reading the transaction on chain.
export const matchReqSchema = z.object({
  recipient: addressSchema,
  transaction: signatureSchema,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export const matchResSchema = getRequestResSchema.extend({ already_matched: z.boolean() });

// POST /api/v1/requests/:id/rest: one new request for exactly what an underpaid request still owes.
export const restReqSchema = z.object({ source: z.enum(["plugin", "web"]).optional() }).strict();
export const restResSchema = createRequestResSchema.extend({
  recipient: anyAddress,
  amount: decimalSchema,
  token: tokenSchema,
  rest_of: requestIdSchema,
  already_asked: z.boolean(),
});

// POST /api/v1/attributed: which transactions already settle an Owed request, and which keys are Owed references.
export const attributedReqSchema = z.object({
  signatures: z.array(signatureSchema).max(100),
  keys: z.array(addressSchema).max(256).optional(),
}).strict();
export const attributedResSchema = z.object({
  attributed: z.array(z.object({ signature: signatureSchema, request_id: requestIdSchema, how: z.enum(["reference", "matched", "x402"]) })).max(200),
  references: z.array(z.object({ key: addressSchema, request_id: requestIdSchema })).max(256),
});

export type MatchReq = z.infer<typeof matchReqSchema>;
export type MatchRes = z.infer<typeof matchResSchema>;
export type RestReq = z.infer<typeof restReqSchema>;
export type RestRes = z.infer<typeof restResSchema>;
export type AttributedReq = z.infer<typeof attributedReqSchema>;
export type AttributedRes = z.infer<typeof attributedResSchema>;

// ---- F1: the payer inbox (what_do_i_owe), blocking a requester, bulk terms for pay_all ----

// POST /api/v1/inbox. The payer's wallet signs "Owed inbox access for <payer> at <ISO>"; the server accepts it once, within 5 minutes.
export const inboxReqSchema = z.object({
  payer: addressSchema,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();

export const inboxEntrySchema = z.object({
  id: requestIdSchema,
  kind: z.string().max(20),
  link: httpsUrl,
  status: z.enum(["open", "underpaid"]),
  amount: decimalSchema,
  amount_due: decimalSchema,
  token: tokenSchema,
  chain: chainSchema,
  recipient: anyAddress,
  requester_name: z.string().max(160).nullable(),
  requester_handle: handleSchema.nullable(),
  for: z.string().max(320).nullable(),
  from_domain: z.string().max(253).nullable(),
  sns_name: z.string().max(140).nullable(),
  created_at: isoTime,
  expires_at: isoTime.nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  invoice_number: z.string().max(80).nullable(),
  group_title: z.string().max(240).nullable(),
  addressed_as: z.object({ handle: handleSchema.nullable(), sns: z.string().max(140).nullable() }),
  first_time: z.boolean(),
  flags: z.array(z.string().max(80)).max(32),
  fiat: fiatQuoteSchema.optional(),
});

export const inboxResSchema = z.object({
  payer: addressSchema,
  caution: z.string().max(400),
  generated_at: isoTime,
  chain_checked: z.boolean(),
  owed: z.array(inboxEntrySchema).max(100),
  base: z.array(inboxEntrySchema).max(100),
  totals: z.array(z.object({ token: tokenSchema, chain: chainSchema, amount_due: decimalSchema, count: z.number().int().nonnegative() })).max(3),
  blocked_hidden: z.number().int().nonnegative(),
  blocked_requesters: z.array(anyAddress).max(50),
  truncated: z.boolean(),
});

// POST /api/v1/inbox/block. The payer's wallet signs "Owed block <requester> for <payer> at <ISO>" (or unblock); the reply carries the inbox after it.
export const inboxBlockReqSchema = z.object({
  payer: addressSchema,
  requester: anyAddress,
  action: z.enum(["block", "unblock"]),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();
export const inboxBlockResSchema = z.object({
  payer: addressSchema,
  requester: anyAddress,
  action: z.enum(["block", "unblock"]),
  blocked: z.boolean(),
  changed: z.boolean(),
  inbox: inboxResSchema,
});

// GET /api/v1/requests?ids=a,b,c: 1 to 20 requests, each as GET /api/v1/requests/<id> returns it; unknown ids apart.
export const bulkRequestsResSchema = z.object({
  requests: z.array(getRequestResSchema).max(20),
  not_found: z.array(z.string().max(20)).max(20),
});

export type InboxReq = z.infer<typeof inboxReqSchema>;
export type InboxRes = z.infer<typeof inboxResSchema>;
export type InboxEntry = z.infer<typeof inboxEntrySchema>;
export type InboxBlockReq = z.infer<typeof inboxBlockReqSchema>;
export type InboxBlockRes = z.infer<typeof inboxBlockResSchema>;
export type BulkRequestsRes = z.infer<typeof bulkRequestsResSchema>;

// ---- F2: funding plans (pay_link / pay_all when the sender's wallet is short) ----
// The plugin can't call PayBox tools, so when a payment can't be covered it returns the exact PayBox calls that fix it
// (a swap, a bridge from Base, a MoonPay buy link), as text plus this machine-readable funding_plan. Owed's server
// records each plan it is offered (POST /api/v1/plans) so it can count offered vs used vs paid; the final pay_link /
// pay_all echoes plan_id (POST /api/v1/plans/<id>/used). The server never sees balances, only the shortfall.

export const PLAN_OPTION_KINDS = ["swap_sol", "bridge_base_usdc", "swap_other", "buy_usdc", "x402", "swap_usdc_for_sol", "buy_sol"] as const;
export const planOptionKindSchema = z.enum(PLAN_OPTION_KINDS);
export type PlanOptionKind = z.infer<typeof planOptionKindSchema>;
export const planIdSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/);
const positiveAtomic = z.string().regex(/^[1-9][0-9]{0,30}$/);
const anyAtomic = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);

// POST /api/v1/plans: a plan was offered. request_ids is empty for a link that isn't an Owed request.
export const createPlanReqSchema = z.object({
  tool: z.enum(["pay_link", "pay_all"]),
  sender: anyAddress,
  request_ids: z.array(requestIdSchema).max(20),
  shortfall: z.object({ token: tokenSchema, atomic: positiveAtomic }).strict(),
  options: z.array(planOptionKindSchema).min(1).max(8),
}).strict();
export const createPlanResSchema = z.object({ plan_id: planIdSchema, created_at: isoTime });

// POST /api/v1/plans/<id>/used: the plan's final pay_link / pay_all returned a payment proposal for the same sender.
export const planUsedReqSchema = z.object({ sender: anyAddress }).strict();
export const planUsedResSchema = z.object({ plan_id: planIdSchema, used_at: isoTime, already_used: z.boolean() });

// GET /api/v1/plans/stats: plans offered, used (a proposal followed) and paid (every request in it paid by its sender after the offer).
export const planStatsResSchema = z.object({
  offered: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative(),
  since: isoTime,
});

// The funding_plan the tools return (inside a ```json block of their text: pay_link's output schema is PayBox's
// strict proposal envelope, so a plan can't be structuredContent). Steps name the exact arguments, except
// credential_id: `credential_of` says whose PayBox credential to add (a wallet address, or "base_wallet" for the
// user's PayBox Base wallet); `via: "owed"` steps are Owed tools called through PayBox use_plugin, with
// `credential_of` as use_plugin.wallet_id. `missing` lists arguments only the agent can fill in (e.g. a request_id
// PayBox returns, or the token the user picks).
const planAmountSchema = z.object({ token: tokenSchema, atomic: anyAtomic, display: z.string().max(60) }).strict();
export const planStepSchema = z.object({
  via: z.enum(["paybox", "owed"]),
  tool: z.string().min(1).max(40),
  args: z.record(z.string(), z.unknown()),
  credential_of: z.string().max(64).nullable(),
  missing: z.array(z.string().max(40)).max(8).optional(),
  why: z.string().max(800),
}).strict();
export const planOptionSchema = planStepSchema.extend({
  kind: planOptionKindSchema,
  check: planStepSchema.optional(),
  then: z.array(planStepSchema).max(4),
}).strict();
export const fundingPlanSchema = z.object({
  plan_id: planIdSchema.nullable(),
  pay_tool: z.enum(["pay_link", "pay_all"]),
  request_ids: z.array(requestIdSchema).max(20),
  sender: anyAddress,
  shortfall: planAmountSchema,
  have: z.array(planAmountSchema).max(2),
  need: z.array(planAmountSchema).max(2),
  options: z.array(planOptionSchema).min(1).max(8),
}).strict();

export type CreatePlanReq = z.infer<typeof createPlanReqSchema>;
export type CreatePlanRes = z.infer<typeof createPlanResSchema>;
export type PlanUsedReq = z.infer<typeof planUsedReqSchema>;
export type PlanUsedRes = z.infer<typeof planUsedResSchema>;
export type PlanStatsRes = z.infer<typeof planStatsResSchema>;
export type PlanAmount = z.infer<typeof planAmountSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type PlanOption = z.infer<typeof planOptionSchema>;
export type FundingPlan = z.infer<typeof fundingPlanSchema>;
/** The ```json block a plan travels in: {"funding_plan": …}. */
export const fundingPlanDocSchema = z.object({ funding_plan: fundingPlanSchema }).strict();

// ---- F6 ledger: group ledgers and settle-up (start_ledger, add_expense, ledger_balances, settle_up) ----
// POST /api/v1/ledgers, GET /api/v1/ledgers/<id>, POST /api/v1/ledgers/<id>/expenses and /settle. Writes are signed by
// a wallet named in the ledger, once, within 5 minutes (src/ledger-math.ts expensePrefix / settlePrefix). Members are
// positions (0 = the owner); amounts are decimal strings in the expense's currency except the USDC `amount`s; net and
// to_settle may be negative. Responses are not strict, so an additive server change never breaks this plugin.
export const groupLedgerIdSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/);
const glMemberSchema = z.number().int().min(0).max(19);
const glSignedDecimal = z.string().max(41).regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
export const glSplitSchema = z.enum(["even", "shares", "exact", "items"]);
const glCurrencySchema = z.string().regex(/^(USDC|[A-Z]{3})$/);

export const createGroupLedgerReqSchema = z.object({
  title: z.string().min(1).max(60),
  owner: addressSchema,
  owner_name: z.string().min(1).max(40),
  members: z.array(z.object({ name: z.string().min(1).max(40), payer: payerReqSchema.optional() }).strict()).min(1).max(19),
  source: z.enum(["plugin", "web"]),
}).strict();

export const addExpenseReqSchema = z.object({
  signer: addressSchema,
  description: z.string().min(1).max(80).optional(),
  paid_by: glMemberSchema,
  amount: decimalSchema,
  currency: glCurrencySchema.optional(),
  split: glSplitSchema,
  among: z.array(glMemberSchema).min(1).max(20).optional(),
  shares: z.array(z.object({ member: glMemberSchema, shares: decimalSchema }).strict()).min(1).max(20).optional(),
  amounts: z.array(z.object({ member: glMemberSchema, amount: decimalSchema }).strict()).min(1).max(20).optional(),
  items: z.array(z.object({ description: z.string().min(1).max(60).optional(), amount: decimalSchema, members: z.array(glMemberSchema).min(1).max(20) }).strict()).min(1).max(30).optional(),
  tax: decimalSchema.optional(),
  tip: decimalSchema.optional(),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();

export const settleUpReqSchema = z.object({
  signer: addressSchema,
  version: z.number().int().min(0),
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();

export const groupLedgerExpenseSchema = z.object({
  position: z.number().int().min(0).max(99),
  description: z.string().max(320).nullable(),
  paid_by: glMemberSchema,
  split: glSplitSchema,
  currency: glCurrencySchema,
  total: decimalSchema,
  amount: decimalSchema,
  tax: decimalSchema.nullable(),
  tip: decimalSchema.nullable(),
  fiat: fiatQuoteSchema.nullable(),
  items: z.array(z.object({ description: z.string().max(240).nullable(), amount: decimalSchema, members: z.array(glMemberSchema).min(1).max(20) })).max(30).nullable(),
  shares: z.array(z.object({ member: glMemberSchema, weight: decimalSchema.nullable(), share: decimalSchema, amount: decimalSchema })).min(1).max(20),
  recorded_by: addressSchema,
  recorded_at: isoTime,
  signed_message: z.string().max(200),
  signature: z.string().max(200),
  flags: z.array(z.string().max(80)).max(32),
});

export const groupLedgerTransferSchema = z.object({
  position: z.number().int().min(0).max(18),
  from: glMemberSchema,
  to: glMemberSchema,
  amount: decimalSchema,
  request_id: requestIdSchema,
  link: httpsUrl,
  status: z.enum(["open", "paid", "underpaid", "cancelled", "expired"]),
  paid: paidInfoSchema.nullable(),
  addressed: z.boolean(),
});

export const groupLedgerResSchema = z.object({
  id: groupLedgerIdSchema,
  link: httpsUrl,
  title: z.string().max(240),
  owner: addressSchema,
  created_at: isoTime,
  version: z.number().int().min(0),
  flags: z.array(z.string().max(80)).max(32),
  caution: z.string().max(400),
  members: z.array(z.object({
    position: glMemberSchema, name: z.string().max(160), wallet: addressSchema.nullable(), handle: handleSchema.nullable(), sns: z.string().max(140).nullable(),
  })).min(2).max(20),
  expenses: z.array(groupLedgerExpenseSchema).max(100),
  balances: z.array(z.object({
    member: glMemberSchema, paid: decimalSchema, share: decimalSchema, sent: decimalSchema, received: decimalSchema, net: glSignedDecimal,
    pending_out: decimalSchema, pending_in: decimalSchema, to_settle: glSignedDecimal,
  })).min(2).max(20),
  plan: z.array(z.object({ from: glMemberSchema, to: glMemberSchema, amount: decimalSchema, payable: z.boolean() })).max(19),
  settlements: z.array(z.object({
    round: z.number().int().min(0), recorded_by: addressSchema, recorded_at: isoTime, signed_message: z.string().max(200), signature: z.string().max(200),
    transfers: z.array(groupLedgerTransferSchema).min(1).max(19),
  })).max(50),
  totals: z.object({ spent: decimalSchema, expense_count: z.number().int().min(0).max(100), open_requests: z.number().int().nonnegative() }),
  fiat_beside: z.object({ currency: currencySchema, rate: decimalSchema, rate_source: z.string().min(1).max(120), quoted_at: isoTime }).nullable(),
  settled: z.boolean(),
  chain_checked: z.boolean(),
});

export const addExpenseResSchema = z.object({ added: z.number().int().min(0).max(99), ledger: groupLedgerResSchema });

export const settleUpResSchema = z.object({
  round: z.number().int().min(0),
  created: z.array(z.object({
    position: z.number().int().min(0).max(18), from: glMemberSchema, to: glMemberSchema, amount: decimalSchema,
    request: z.object({
      id: requestIdSchema, link: httpsUrl, solana_pay_url: solanaPayUrl, reference: addressSchema, recipient: addressSchema,
      payer: payerInfoSchema.nullable(), payer_name: z.string().max(160).nullable(), for: z.string().max(320).nullable(),
      note: z.string().max(560).nullable(), requester_name: z.string().max(160).nullable(), requester_handle: handleSchema.nullable(), created_at: isoTime,
    }),
  })).min(1).max(19),
  unpayable: z.array(z.object({ from: glMemberSchema, to: glMemberSchema, amount: decimalSchema, reason: z.literal("no_wallet") })).max(19),
  ledger: groupLedgerResSchema,
});

export type CreateGroupLedgerReq = z.infer<typeof createGroupLedgerReqSchema>;
export type AddExpenseReq = z.infer<typeof addExpenseReqSchema>;
export type SettleUpReq = z.infer<typeof settleUpReqSchema>;
export type GroupLedgerRes = z.infer<typeof groupLedgerResSchema>;
export type GroupLedgerExpense = z.infer<typeof groupLedgerExpenseSchema>;
export type AddExpenseRes = z.infer<typeof addExpenseResSchema>;
export type SettleUpRes = z.infer<typeof settleUpResSchema>;
// ---- F6 ledger end ----

// ---- F8 invoices start: invoice terms, refunds, statements ----
// POST /api/v1/invoices takes optional terms; GET /api/v1/invoices/:id adds `terms` (the invoice as a whole), `term_of`
// (an invoice a plan opened) and refunds. A request id commits to its exact amount, so every term that changes what is
// owed opens a new request (a whole invoice of its own); the invoice's own request asks for installment 1 or the early price.
const f8PercentSchema = z.string().regex(/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$/);
export const f8IntervalSchema = z.union([z.literal("monthly"), z.number().int().min(7).max(365)]);
export const f8ChaseSchema = z.union([z.literal(false), z.object({ days: z.array(z.number().int().min(1).max(90)).min(1).max(3) }).strict()]);
const f8RoleSchema = z.enum(["installment", "early_price", "full_price", "late_fee"]);
export const refundIdSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/);

export const createInvoiceTermsReqSchema = createInvoiceReqSchema.extend({
  installments: z.object({ count: z.number().int().min(2).max(12), interval: f8IntervalSchema.optional(), first_due: isoDateSchema.optional() }).strict().optional(),
  early_discount: z.object({ amount: decimalSchema.optional(), percent: f8PercentSchema.optional(), until: isoDateSchema }).strict().optional(),
  late_fee: z.object({ amount: decimalSchema.optional(), percent: f8PercentSchema.optional() }).strict().optional(),
  chase: f8ChaseSchema.optional(),
}).strict();

export const termRequestSchema = z.object({
  role: f8RoleSchema,
  seq: z.number().int().min(1).max(12),
  amount: decimalSchema,
  fiat_amount: decimalSchema.optional(),
  due_date: isoDateSchema,
  opens_on: isoDateSchema,
  status: z.enum(["open", "paid", "underpaid", "cancelled", "expired", "scheduled", "skipped"]),
  id: requestIdSchema.nullable(),
  link: httpsUrl.nullable(),
  skip_reason: z.string().max(200).nullable(),
  paid: z.object({ amount: decimalSchema, at: isoTime, signature: signatureSchema, on_time: z.boolean() }).optional(),
  superseded_by: requestIdSchema.optional(),
});

export const invoiceTermsSchema = z.object({
  status: requestStatusSchema,
  paid_so_far: decimalSchema,
  remaining: decimalSchema,
  pay_now: z.object({
    id: requestIdSchema, link: httpsUrl, amount: decimalSchema, due_date: isoDateSchema.nullable(),
    role: z.enum(["installment", "early_price", "full_price", "late_fee", "invoice"]), seq: z.number().int().min(1).max(12).nullable(),
  }).nullable(),
  installments: z.object({ count: z.number().int().min(2).max(12), interval: f8IntervalSchema, interval_label: z.string().max(40), plan: z.array(termRequestSchema).min(2).max(12) }).nullable(),
  early_discount: z.object({
    early_price: decimalSchema, full_price: decimalSchema, discount: decimalSchema, percent: z.string().max(6).nullable(), until: isoDateSchema,
    early: termRequestSchema, full: termRequestSchema, paid_with: z.enum(["early", "full"]).nullable(),
  }).nullable(),
  late_fee: z.object({ amount: decimalSchema, percent: z.string().max(6).nullable(), applies_after: isoDateSchema, request: termRequestSchema }).nullable(),
  chase: z.object({ days: z.array(z.number().int().min(1).max(90)).min(1).max(3) }).nullable(),
  refunded: decimalSchema,
});

export const termOfSchema = z.object({
  invoice_id: requestIdSchema, link: httpsUrl, role: f8RoleSchema, seq: z.number().int().min(1).max(12), count: z.number().int().min(2).max(12).nullable(), label: z.string().max(40),
});

export const invoiceTermsResSchema = invoiceResSchema.extend({
  terms: invoiceTermsSchema.optional(),
  term_of: termOfSchema.optional(),
  superseded_by: requestIdSchema.optional(),
  refunded: decimalSchema.optional(),
  refunds: z.array(z.object({
    id: refundIdSchema, request_id: requestIdSchema, amount: decimalSchema, status: z.enum(["pending", "confirmed", "lapsed"]),
    confirmed_at: isoTime.optional(), signature: signatureSchema.optional(),
  })).max(100).optional(),
});

// POST /api/v1/refunds. The recipient's wallet signs "Owed refund <amount> <token> of <request> to <payer> for <recipient> at <ISO>".
export const createRefundReqSchema = z.object({
  request: requestIdSchema,
  recipient: addressSchema,
  amount: decimalSchema,
  signed_message: z.string().min(1).max(200),
  signature: z.string().min(64).max(200),
}).strict();

const refundConfirmedSchema = z.object({ signature: signatureSchema, amount: decimalSchema, at: isoTime });
export const refundResSchema = z.object({
  id: refundIdSchema,
  request_id: requestIdSchema,
  request_link: httpsUrl,
  recipient: addressSchema,
  payer: addressSchema,
  token: tokenSchema,
  amount: decimalSchema,
  reference: addressSchema,
  memo: z.string().regex(/^owed-refund:[1-9A-HJ-NP-Za-km-z]{12}$/),
  status: z.enum(["pending", "confirmed", "lapsed"]),
  created_at: isoTime,
  signed_message: z.string().max(200),
  signature: z.string().max(200),
  confirmed: refundConfirmedSchema.nullable(),
});
export const createRefundResSchema = refundResSchema.extend({ paid: decimalSchema, refunded: decimalSchema, pending: decimalSchema, refundable: decimalSchema });

export const refundSummarySchema = z.object({
  request_id: requestIdSchema,
  token: tokenSchema,
  paid: decimalSchema.nullable(),
  refunded: decimalSchema,
  pending: decimalSchema,
  refundable: decimalSchema,
  refunds: z.array(z.object({ id: refundIdSchema, amount: decimalSchema, status: z.enum(["pending", "confirmed", "lapsed"]), created_at: isoTime, confirmed: refundConfirmedSchema.nullable() })).max(100),
});
// GET /api/v1/refunds?requests=a,b,c (1 to 20).
export const refundsLookupResSchema = z.object({
  requests: z.array(refundSummarySchema).max(20),
  not_found: z.array(z.string().max(20)).max(20),
  chain_checked: z.boolean(),
});

// GET /api/v1/statements?recipient&client&month&signed_message&signature (the recipient's signed ledger message).
const f8SignedDecimal = z.string().max(41).regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);
export const statementResSchema = z.object({
  recipient: addressSchema,
  client: z.string().min(1).max(64),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  from: isoTime,
  to: isoTime,
  generated_at: isoTime,
  caution: z.string().max(400),
  chain_checked: z.boolean(),
  invoices: z.array(z.object({
    id: requestIdSchema, invoice_number: z.string().max(80).nullable(), issue_date: isoDateSchema, due_date: isoDateSchema, total: decimalSchema, token: tokenSchema,
    status: requestStatusSchema, link: httpsUrl,
  })).max(200),
  lines: z.array(z.object({
    at: isoTime, kind: z.enum(["invoiced", "cancelled", "expired", "paid", "refunded"]), request_id: requestIdSchema, invoice_id: requestIdSchema.nullable(),
    invoice_number: z.string().max(80).nullable(), description: z.string().max(160), token: tokenSchema, amount: decimalSchema, signature: signatureSchema.nullable(), link: httpsUrl,
  })).max(5000),
  totals: z.array(z.object({
    token: tokenSchema, opening: f8SignedDecimal, invoiced: decimalSchema, cancelled: decimalSchema, paid: decimalSchema, refunded: decimalSchema, closing: f8SignedDecimal,
  })).max(2),
  truncated: z.boolean(),
  csv: z.object({ url: httpsUrl, expires_at: isoTime }).nullable(),
  page: z.object({ url: httpsUrl, expires_at: isoTime }).nullable(),
});

// POST /api/v1/ledger with F8's optional fields on each entry (lib/invoice-terms.ts withInvoiceTerms): chase days when an
// invoice chases on other days (or not: null), the reminder due today, and confirmed refunds.
export const ledgerEntryF8Schema = ledgerEntrySchema.extend({
  chase: z.object({ days: z.array(z.number().int().min(1).max(90)).min(1).max(3) }).nullable().optional(),
  reminder: z.object({ tone: z.enum(["polite", "firm", "formal"]), days_overdue: z.number().int().nonnegative() }).optional(),
  refunded: decimalSchema.optional(),
});
export const ledgerResF8Schema = ledgerResSchema.extend({
  open: z.array(ledgerEntryF8Schema).max(100),
  paid_recently: z.array(ledgerEntryF8Schema).max(100),
});

export type CreateInvoiceTermsReq = z.infer<typeof createInvoiceTermsReqSchema>;
export type InvoiceTermsRes = z.infer<typeof invoiceTermsResSchema>;
export type InvoiceTerms = z.infer<typeof invoiceTermsSchema>;
export type TermRequest = z.infer<typeof termRequestSchema>;
export type CreateRefundReq = z.infer<typeof createRefundReqSchema>;
export type RefundRes = z.infer<typeof refundResSchema>;
export type CreateRefundRes = z.infer<typeof createRefundResSchema>;
export type RefundSummary = z.infer<typeof refundSummarySchema>;
export type RefundsLookupRes = z.infer<typeof refundsLookupResSchema>;
export type StatementRes = z.infer<typeof statementResSchema>;
export type LedgerEntryF8 = z.infer<typeof ledgerEntryF8Schema>;
export type LedgerResF8 = z.infer<typeof ledgerResF8Schema>;
// ---- F8 invoices end ----

// ---- S1 alerts start: paid alerts (server-only: no tool calls these; mirrored so both sides parse every fixture) ----
// POST /api/v1/alerts (the wallet's signed "Owed alerts for <wallet> at <ISO>" + a channel), POST /api/v1/alerts/confirm
// and /unsubscribe (a 43-character token).
const alertIdSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/);
const alertEmailSchema = z.string().max(254).regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/);
const alertSignedFields = { wallet: addressSchema, signed_message: z.string().min(1).max(200), signature: z.string().min(64).max(200) };
export const createAlertReqSchema = z.discriminatedUnion("channel", [
  z.object({ ...alertSignedFields, channel: z.literal("telegram") }).strict(),
  z.object({ ...alertSignedFields, channel: z.literal("email"), email: alertEmailSchema }).strict(),
]);
const alertPendingFields = { id: alertIdSchema, wallet: addressSchema, status: z.literal("pending"), created_at: isoTime, expires_at: isoTime, next: z.string().max(300) };
export const createAlertResSchema = z.discriminatedUnion("channel", [
  z.object({
    ...alertPendingFields,
    channel: z.literal("telegram"),
    telegram: z.object({ bot: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,31}$/), code: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), link: httpsUrl }),
  }),
  z.object({ ...alertPendingFields, channel: z.literal("email"), email: z.object({ address: alertEmailSchema }) }),
]);
export const alertTokenReqSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const confirmAlertResSchema = z.object({
  id: alertIdSchema, wallet: addressSchema, channel: z.literal("email"), status: z.literal("active"), activated_at: isoTime, already_active: z.boolean(),
});
export const unsubscribeAlertResSchema = z.object({
  id: alertIdSchema, wallet: addressSchema, channel: z.enum(["telegram", "email"]), status: z.literal("unsubscribed"), unsubscribed_at: isoTime, already_unsubscribed: z.boolean(),
});
// ---- S1 alerts end ----
// ---- F4 cash out start (SP9): POST /api/v1/cash-out, GET /api/v1/cash-out/<id>, POST /api/v1/cash-out/accounts ----
// The user sells USDC to MoonPay, which pays their bank. The server returns MoonPay's deposit address only while MoonPay
// waits for exactly this deposit; the plugin checks every term again before it proposes a transfer (tools/cash_out.ts).
export const cashOutIdSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{12}$/);
const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const createCashOutReqSchema = z.object({
  wallet: addressSchema,
  amount: decimalSchema.optional(),
  request_ids: z.array(requestIdSchema).min(1).max(20).optional(),
  fiat_currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
}).strict();
export const cashOutStatusSchema = z.enum(["created", "waiting_for_deposit", "pending", "completed", "failed", "requote_required"]);
export const cashOutResSchema = z.object({
  id: cashOutIdSchema,
  wallet: addressSchema,
  amount: decimalSchema,
  token: z.literal("USDC"),
  fiat_currency: z.string().regex(/^[a-z]{3}$/).nullable(),
  request_ids: z.array(requestIdSchema).max(20),
  requests_total: decimalSchema.optional(),
  mode: z.enum(["sell_widget", "enterprise"]),
  status: cashOutStatusSchema,
  widget_url: httpsUrl.nullable(),
  moonpay_transaction_id: z.string().max(100).nullable(),
  deposit_address: addressSchema.nullable(),
  transfer_signature: z.string().max(120).nullable(),
  failure_reason: z.string().max(300).nullable(),
  problem: z.string().max(400).nullable(),
  account: z.object({ id: uuidSchema, liquidation_address: addressSchema, signed_message: z.string().max(200), signature: z.string().max(200) }).nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type CreateCashOutReq = z.infer<typeof createCashOutReqSchema>;
export type CashOutRes = z.infer<typeof cashOutResSchema>;
export const routeAccountReqSchema = z.object({
  wallet: addressSchema,
  autoramp_id: uuidSchema,
  signed_message: z.string().min(1).max(200).optional(),
  signature: z.string().min(64).max(200).optional(),
}).strict();
export const cashOutAccountResSchema = z.union([
  z.object({ step: z.literal("sign"), message_to_sign: z.string().max(200), sign_by: isoTime, liquidation_address: addressSchema, currency: z.enum(["EUR", "USD", "GBP"]), payout_rail: z.string().max(16) }),
  z.object({ step: z.literal("stored"), id: uuidSchema, wallet: addressSchema, liquidation_address: addressSchema, currency: z.enum(["EUR", "USD", "GBP"]), payout_rail: z.string().max(16), status: z.enum(["active", "closed"]), created_at: isoTime }),
]);
export type RouteAccountReq = z.infer<typeof routeAccountReqSchema>;
export type CashOutAccountRes = z.infer<typeof cashOutAccountResSchema>;
// ---- F4 cash out end ----
