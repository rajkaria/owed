import "server-only";
import { ZodError } from "zod";
import type { ErrorCode } from "./contract";
import { DbError } from "./db";
import { RpcError } from "./solana";

// JSON responses and errors for /api routes: {error:{code,message}}.

const STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  blocked: 403,
  not_found: 404,
  rate_limited: 429,
  upstream_unavailable: 503,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;

  constructor(code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.code = code;
    this.headers = headers;
  }
}

const NO_STORE = { "Cache-Control": "no-store" };

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(data, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

export function errorResponse(code: ErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, { status: STATUS[code], headers });
}

function zodMessage(e: ZodError): string {
  const issue = e.issues[0];
  const path = issue?.path.join(".");
  return path ? `${path}: ${issue.message}` : (issue?.message ?? "invalid input");
}

/** Map any thrown error to a contract error response; unknown errors are logged, not leaked. */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof ApiError) return errorResponse(e.code, e.message, e.headers);
  if (e instanceof ZodError) return errorResponse("invalid_input", zodMessage(e));
  if (e instanceof RpcError) return errorResponse("upstream_unavailable", "Solana RPC is unavailable, try again shortly");
  if (e instanceof DbError) {
    console.error(`database error: ${e.code ?? ""} ${e.message}`);
    return errorResponse("upstream_unavailable", "storage is unavailable, try again shortly");
  }
  console.error("unhandled API error", e);
  return json({ error: { code: "upstream_unavailable", message: "internal error" } }, { status: 500 });
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError("invalid_input", "request body is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("invalid_input", "request body must be JSON");
  }
}

/** Public origin for links: OWED_BASE_URL in production, else the host that served this request. */
export function baseUrl(req: Request): string {
  const configured = process.env.OWED_BASE_URL?.trim().replace(/\/+$/, "");
  return configured || new URL(req.url).origin;
}
