import type * as z from "zod/v4";
import {
  createRequestResSchema, errorResSchema, getRequestResSchema, groupResSchema, statusRawResSchema, statusResSchema,
  type CreateGroupReq, type CreateRequestReq, type CreateRequestRes, type ErrorCode, type GetRequestRes, type GroupRes,
  type StatusRawRes, type StatusRes,
  invoiceResSchema, type CreateInvoiceReq, type InvoiceRes,
  ledgerResSchema, type LedgerReq, type LedgerRes,
  scheduleResSchema, type CreateScheduleReq, type ScheduleRes, // W3-D
} from "./contract.js";

export const DEFAULT_BASE_URL = "https://owed-omega.vercel.app";
export const API_TIMEOUT_MS = 4000;

/** Hosts whose /r/<id>, /i/<id> and /p?u= links are Owed links, in addition to the configured base URL's host. */
export const KNOWN_OWED_HOSTS = ["owed.link", "www.owed.link", "owed-omega.vercel.app", "getowed.xyz", "www.getowed.xyz"];

/** `code` mirrors the API's error codes; network errors, timeouts, 5xx and off-contract replies are `upstream_unavailable`. */
export class ApiError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly httpStatus?: number) {
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
  createSchedule(body: CreateScheduleReq): Promise<ScheduleRes>; // W3-D
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
      throw new ApiError("upstream_unavailable", "Owed's server had an error.", response.status);
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
    createSchedule: (body) => call("POST", "/schedules", scheduleResSchema, body), // W3-D
  };
}
