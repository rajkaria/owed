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

export const requestStatusSchema = z.enum(["open", "paid", "underpaid", "cancelled", "not_found", "invalid"]);
export const errorCodeSchema = z.enum(["invalid_input", "rate_limited", "not_found", "upstream_unavailable", "blocked"]);

export const createRequestReqSchema = z.object({
  recipient: addressSchema,
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
}).strict();

export const createRequestResSchema = z.object({
  id: requestIdSchema,
  link: httpsUrl,
  solana_pay_url: solanaPayUrl,
  qr_url: httpsUrl,
  reference: addressSchema,
  x402_url: httpsUrl.nullable().optional(),
  created_at: isoTime,
  flags: z.array(z.string().max(80)).max(32),
  from_domain: z.string().max(253).nullable().optional(), // W2-H verified payee
});

export const paidInfoSchema = z.object({
  signature: signatureSchema,
  payer: addressSchema,
  amount: decimalSchema,
  at: isoTime,
  rail: z.string().max(20).optional(),
});

export const getRequestResSchema = z.object({
  id: requestIdSchema,
  kind: z.string().max(20).optional(),
  recipient: addressSchema,
  amount: decimalSchema,
  token: tokenSchema,
  payer_name: z.string().max(40).nullable().optional(),
  for: z.string().max(80).nullable().optional(),
  note: z.string().max(140).nullable().optional(),
  requester_name: z.string().max(40).nullable().optional(),
  status: requestStatusSchema,
  solana_pay_url: solanaPayUrl,
  reference: addressSchema,
  x402_url: httpsUrl.nullable().optional(),
  created_at: isoTime,
  paid: paidInfoSchema.nullable().optional(),
  flags: z.array(z.string().max(80)).max(32),
  // W2-H verified payee: display copy only. pay_link re-checks the domain's DNS itself.
  from_domain: z.string().max(253).nullable().optional(),
  from_domain_verified_at: isoTime.nullable().optional(),
});

export const statusReqSchema = z.object({ ids: z.array(requestIdSchema).min(1).max(20) }).strict();

const paymentFields = {
  amount_paid: decimalSchema.optional(),
  payer: addressSchema.optional(),
  signature: signatureSchema.optional(),
  paid_at: isoTime.optional(),
};

export const statusResultSchema = z.object({
  id: requestIdSchema,
  status: requestStatusSchema,
  amount_requested: decimalSchema,
  token: tokenSchema,
  ...paymentFields,
  // Not in the fixtures yet; when the API adds it, check_payments reports how long an open request has waited.
  created_at: isoTime.optional(),
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
});

export type Token = z.infer<typeof tokenSchema>;
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
