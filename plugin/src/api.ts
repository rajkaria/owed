import type * as z from "zod/v4";
import {
  createRequestResSchema, errorResSchema, getRequestResSchema, groupResSchema, statusRawResSchema, statusResSchema,
  type CreateGroupReq, type CreateRequestReq, type CreateRequestRes, type ErrorCode, type GetRequestRes, type GroupRes,
  type StatusRawRes, type StatusRes,
  invoiceResSchema, type CreateInvoiceReq, type InvoiceRes,
  ledgerResSchema, type LedgerReq, type LedgerRes,
  cancelResSchema, type CancelReq, type CancelRes,
  scheduleResSchema, type CreateScheduleReq, type ScheduleRes, // W3-D
  matchResSchema, restResSchema, attributedResSchema, type MatchReq, type MatchRes, type RestReq, type RestRes, type AttributedReq, type AttributedRes, // 0012
  bulkRequestsResSchema, inboxBlockResSchema, inboxResSchema, type BulkRequestsRes, type InboxBlockReq, type InboxBlockRes, type InboxReq, type InboxRes, // F1
  createPlanResSchema, planUsedResSchema, type CreatePlanReq, type CreatePlanRes, type PlanUsedReq, type PlanUsedRes, // F2
  addExpenseResSchema, groupLedgerResSchema, settleUpResSchema, type AddExpenseReq, type AddExpenseRes, type CreateGroupLedgerReq, type GroupLedgerRes, type SettleUpReq, type SettleUpRes, // F6 ledger
  invoiceTermsResSchema, createRefundResSchema, refundResSchema, refundsLookupResSchema, statementResSchema, ledgerResF8Schema, // F8 invoices
  type CreateInvoiceTermsReq, type InvoiceTermsRes, type CreateRefundReq, type CreateRefundRes, type RefundRes, type RefundsLookupRes, type StatementRes, type LedgerResF8, // F8 invoices
} from "./contract.js";

export const DEFAULT_BASE_URL = "https://owed-omega.vercel.app";
export const API_TIMEOUT_MS = 4000;

/** Hosts whose /r/<id>, /i/<id> and /p?u= links are Owed links, in addition to the configured base URL's host. */
export const KNOWN_OWED_HOSTS = ["owed.link", "www.owed.link", "owed-omega.vercel.app", "getowed.xyz", "www.getowed.xyz"];

/** `code` mirrors the API's error codes; network errors, timeouts, 5xx and off-contract replies are `upstream_unavailable`. */
export class ApiError extends Error {
  /** A 5xx reply's own contract message (e.g. why no exchange rate could be locked); `message` stays generic. */
  constructor(readonly code: ErrorCode, message: string, readonly httpStatus?: number, readonly detail?: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Reads OWED_BASE_URL at call time; it must be an https origin (a trailing slash is fine). */
export function resolveBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.OWED_BASE_URL?.trim();
  if (!raw) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OWED_BASE_URL is not a valid URL. Set it to an https origin such as https://owed.link.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("OWED_BASE_URL must be an https origin with no path, such as https://owed.link.");
  }
  return url.origin;
}

export function owedHosts(base: string): string[] {
  return [...new Set([new URL(base).host, ...KNOWN_OWED_HOSTS])];
}

export interface ApiClient {
  readonly base: string;
  createRequest(body: CreateRequestReq): Promise<CreateRequestRes>;
  getRequest(id: string): Promise<GetRequestRes>;
  status(ids: string[]): Promise<StatusRes>;
  statusRaw(solanaPayUrl: string): Promise<StatusRawRes>;
  createGroup(body: CreateGroupReq): Promise<GroupRes>;
  createInvoice(body: CreateInvoiceReq): Promise<InvoiceRes>;
  ledger(body: LedgerReq): Promise<LedgerRes>;
  getGroup(id: string): Promise<GroupRes>;
  getInvoice(id: string): Promise<InvoiceRes>;
  /** W3-C: cancel a request with the recipient's signed message. */
  cancelRequest(id: string, body: CancelReq): Promise<CancelRes>;
  createSchedule(body: CreateScheduleReq): Promise<ScheduleRes>; // W3-D
  /** 0012: attribute a payment without the reference to a request, with the recipient's signed message. */
  matchPayment(id: string, body: MatchReq): Promise<MatchRes>;
  /** 0012: ask for the rest of an underpaid request (one linked request for exactly the remainder). */
  askForRest(id: string, body: RestReq): Promise<RestRes>;
  /** 0012: which transactions already settle a request, which keys are Owed references. */
  attributed(body: AttributedReq): Promise<AttributedRes>;
  /** F1: the open requests addressed to a payer, with the payer's signed message. */
  inbox(body: InboxReq): Promise<InboxRes>;
  /** F1: block or unblock a requester wallet for a payer, with the payer's signed message; answers with the inbox. */
  inboxBlock(body: InboxBlockReq): Promise<InboxBlockRes>;
  /** F1: up to 20 requests' terms in one call (pay_all). */
  getRequests(ids: string[]): Promise<BulkRequestsRes>;
  /** F2: record a funding plan offered to a sender; answers with its plan_id. */
  createPlan(body: CreatePlanReq): Promise<CreatePlanRes>;
  /** F2: a plan's final pay_link / pay_all returned a payment proposal. */
  planUsed(id: string, body: PlanUsedReq): Promise<PlanUsedRes>;
  /** F6 ledger: start a group ledger; GET one (chain: false skips the server's chain check); a signed expense; a signed settle-up. */
  createLedger(body: CreateGroupLedgerReq): Promise<GroupLedgerRes>;
  getLedger(id: string, options?: { chain?: boolean }): Promise<GroupLedgerRes>;
  addExpense(id: string, body: AddExpenseReq): Promise<AddExpenseRes>;
  settleLedger(id: string, body: SettleUpReq): Promise<SettleUpRes>;
  // F8 invoices start
  /** An invoice with optional terms (installments, early-pay discount, late fee, chase days); the reply carries `terms`. */
  createInvoiceTerms(body: CreateInvoiceTermsReq): Promise<InvoiceTermsRes>;
  /** An invoice with its terms, the plan that opened it, and its refunds. */
  getInvoiceTerms(id: string): Promise<InvoiceTermsRes>;
  /** A refund of a paid request, with the recipient's signed message; answers with the pending refund and its fresh reference. */
  createRefund(body: CreateRefundReq): Promise<CreateRefundRes>;
  getRefund(id: string): Promise<RefundRes>;
  /** Up to 20 requests' refunds (what was paid, refunded, pending, still refundable). */
  refundsFor(ids: string[]): Promise<RefundsLookupRes>;
  /** A client's statement for a month, with the recipient's signed ledger message. */
  statement(query: { recipient: string; client: string; month?: string; signed_message: string; signature: string }): Promise<StatementRes>;
  /** The ledger with F8's optional fields on each entry (chase days, the reminder due, refunds). */
  ledgerF8(body: LedgerReq): Promise<LedgerResF8>;
  // F8 invoices end
}

export interface ApiOptions {
  base?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function makeApi(options: ApiOptions = {}): ApiClient {
  const base = options.base ?? resolveBaseUrl();
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;

  async function call<S extends z.ZodType>(method: "GET" | "POST", path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await doFetch(`${base}/api/v1${path}`, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ApiError("upstream_unavailable", timedOut ? "Owed's server did not answer in time." : "Owed's server could not be reached.");
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (response.status >= 500) {
      const detail = errorResSchema.safeParse(json);
      throw new ApiError("upstream_unavailable", "Owed's server had an error.", response.status, detail.success ? detail.data.error.message : undefined);
    }
    if (!response.ok) {
      const parsed = errorResSchema.safeParse(json);
      // A 4xx without the contract's error body (an HTML 404 from a missing route, a proxy page) means the API isn't there.
      if (!parsed.success) throw new ApiError("upstream_unavailable", "Owed's server gave an unexpected reply.", response.status);
      throw new ApiError(parsed.data.error.code, parsed.data.error.message, response.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError("upstream_unavailable", "Owed's server gave an unexpected reply.", response.status);
    return parsed.data;
  }

  return {
    base,
    createRequest: (body) => call("POST", "/requests", createRequestResSchema, body),
    getRequest: (id) => call("GET", `/requests/${encodeURIComponent(id)}`, getRequestResSchema),
    status: (ids) => call("POST", "/status", statusResSchema, { ids }),
    statusRaw: (solanaPayUrl) => call("POST", "/status-raw", statusRawResSchema, { solana_pay_url: solanaPayUrl }),
    createGroup: (body) => call("POST", "/groups", groupResSchema, body),
    createInvoice: (body) => call("POST", "/invoices", invoiceResSchema, body),
    ledger: (body) => call("POST", "/ledger", ledgerResSchema, body),
    getGroup: (id) => call("GET", `/groups/${encodeURIComponent(id)}`, groupResSchema),
    getInvoice: (id) => call("GET", `/invoices/${encodeURIComponent(id)}`, invoiceResSchema),
    cancelRequest: (id, body) => call("POST", `/requests/${encodeURIComponent(id)}/cancel`, cancelResSchema, body), // W3-C
    createSchedule: (body) => call("POST", "/schedules", scheduleResSchema, body), // W3-D
    matchPayment: (id, body) => call("POST", `/requests/${encodeURIComponent(id)}/match`, matchResSchema, body), // 0012
    askForRest: (id, body) => call("POST", `/requests/${encodeURIComponent(id)}/rest`, restResSchema, body),
    attributed: (body) => call("POST", "/attributed", attributedResSchema, body),
    inbox: (body) => call("POST", "/inbox", inboxResSchema, body), // F1
    inboxBlock: (body) => call("POST", "/inbox/block", inboxBlockResSchema, body),
    getRequests: (ids) => call("GET", `/requests?ids=${ids.map(encodeURIComponent).join(",")}`, bulkRequestsResSchema),
    createPlan: (body) => call("POST", "/plans", createPlanResSchema, body), // F2
    planUsed: (id, body) => call("POST", `/plans/${encodeURIComponent(id)}/used`, planUsedResSchema, body),
    createLedger: (body) => call("POST", "/ledgers", groupLedgerResSchema, body), // F6 ledger
    getLedger: (id, options) => call("GET", `/ledgers/${encodeURIComponent(id)}${options?.chain === false ? "?chain=0" : ""}`, groupLedgerResSchema),
    addExpense: (id, body) => call("POST", `/ledgers/${encodeURIComponent(id)}/expenses`, addExpenseResSchema, body),
    settleLedger: (id, body) => call("POST", `/ledgers/${encodeURIComponent(id)}/settle`, settleUpResSchema, body),
    // F8 invoices start
    createInvoiceTerms: (body) => call("POST", "/invoices", invoiceTermsResSchema, body),
    getInvoiceTerms: (id) => call("GET", `/invoices/${encodeURIComponent(id)}`, invoiceTermsResSchema),
    createRefund: (body) => call("POST", "/refunds", createRefundResSchema, body),
    getRefund: (id) => call("GET", `/refunds/${encodeURIComponent(id)}`, refundResSchema),
    refundsFor: (ids) => call("GET", `/refunds?requests=${ids.map(encodeURIComponent).join(",")}`, refundsLookupResSchema),
    statement: (q) => call("GET", `/statements?${new URLSearchParams({ recipient: q.recipient, client: q.client, ...(q.month && { month: q.month }), signed_message: q.signed_message, signature: q.signature })}`, statementResSchema),
    ledgerF8: (body) => call("POST", "/ledger", ledgerResF8Schema, body),
    // F8 invoices end
  };
}
