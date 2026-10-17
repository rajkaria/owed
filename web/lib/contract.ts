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

// Raw text may be longer than its cap: links and invisible characters are stripped
// first, then the clean text is cut to the cap. 4x the cap bounds the work.
const untrusted = (cap: number) => z.string().max(cap * 4).nullish();

export const CreateRequestBody = z.object({
  recipient: base58Key,
  amount: z.string().max(40),
  token: token.default("USDC"),
  payer_name: untrusted(TEXT_LIMITS.payer_name),
  for: untrusted(TEXT_LIMITS.for),
  note: untrusted(TEXT_LIMITS.note),
  requester_name: untrusted(TEXT_LIMITS.requester_name),
  kind: z.literal("single").default("single"),
  source: z.enum(["plugin", "web"]).default("web"),
});
export type CreateRequestBody = z.infer<typeof CreateRequestBody>;

export const CreateRequestResponse = z.object({
  id: requestId,
  link: z.url(),
  solana_pay_url: z.string().startsWith("solana:"),
  qr_url: z.url(),
  reference: base58Key,
  x402_url: z.url().nullable(),
  created_at: isoTime,
  flags: z.array(z.string()),
});
export type CreateRequestResponse = z.infer<typeof CreateRequestResponse>;

export const PaidInfo = z.object({
  signature: z.string(),
  payer: base58Key,
  amount: decimal,
  at: isoTime,
  rail: z.enum(["solana_pay", "x402"]),
});

export const GetRequestResponse = z.object({
  id: requestId,
  kind: z.enum(["single", "split_share", "invoice"]),
  recipient: base58Key,
  amount: decimal,
  token,
  payer_name: z.string().nullable(),
  for: z.string().nullable(),
  note: z.string().nullable(),
  requester_name: z.string().nullable(),
  status: z.enum(["open", "paid", "underpaid", "cancelled"]),
  solana_pay_url: z.string().startsWith("solana:"),
  reference: base58Key,
  x402_url: z.url().nullable(),
  created_at: isoTime,
  paid: PaidInfo.nullable().optional(),
  flags: z.array(z.string()),
});
export type GetRequestResponse = z.infer<typeof GetRequestResponse>;

export const StatusBody = z.object({
  ids: z.array(z.string().max(64)).min(1).max(20),
});

export const StatusValue = z.enum(["open", "paid", "underpaid", "cancelled", "not_found", "invalid"]);
export type StatusValue = z.infer<typeof StatusValue>;

const PaymentFields = {
  amount_requested: decimal.optional(),
  token: token.optional(),
  amount_paid: decimal.optional(),
  payer: base58Key.optional(),
  signature: z.string().optional(),
  paid_at: isoTime.optional(),
};

export const StatusResult = z.object({ id: z.string(), status: StatusValue, ...PaymentFields, created_at: isoTime.optional() });
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
  status: z.enum(["open", "paid", "underpaid", "cancelled"]),
  paid: PaidInfo.nullable(),
  created_at: isoTime,
  flags: z.array(z.string()),
  from_domain: domain.nullable(),
  from_domain_verified_at: isoTime.nullable(),
});
export type InvoiceResponse = z.infer<typeof InvoiceResponse>;

export const ErrorCode = z.enum(["invalid_input", "rate_limited", "not_found", "upstream_unavailable", "blocked"]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({ error: z.object({ code: ErrorCode, message: z.string() }) });
