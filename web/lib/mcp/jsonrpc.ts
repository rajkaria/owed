// JSON-RPC 2.0 message shapes and the error codes POST /api/mcp answers with (MCP adds -32020 and -32022).

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId | null; result: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: JsonRpcErrorObject };

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** Implementation-defined server errors (-32000..-32099): too many calls, server busy. */
export const SERVER_ERROR = -32000;
/** The tool ran past its budget (the code the MCP TypeScript SDK uses for a request timeout). */
export const REQUEST_TIMEOUT = -32001;
/** MCP 2026-07-28: HTTP headers disagree with the body, or a header is malformed. */
export const HEADER_MISMATCH = -32020;
/** MCP 2026-07-28: the requested protocol version is not served here. */
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

export function isRequest(value: unknown): value is JsonRpcRequest {
  return isPlainObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && isId(value.id)
    && (value.params === undefined || isPlainObject(value.params));
}

export function isNotification(value: unknown): value is JsonRpcNotification {
  return isPlainObject(value) && value.jsonrpc === "2.0" && typeof value.method === "string" && !("id" in value)
    && (value.params === undefined || isPlainObject(value.params));
}

/** A JSON-RPC response posted by the client (2025-era servers accept and drop these). */
export function isResponse(value: unknown): boolean {
  return isPlainObject(value) && value.jsonrpc === "2.0" && !("method" in value) && "id" in value
    && (("result" in value) !== ("error" in value));
}

/** The id to answer a malformed message with: its own when it has a usable one, else null. */
export function idOf(value: unknown): JsonRpcId | null {
  return isPlainObject(value) && isId(value.id) ? value.id : null;
}

export function result(id: JsonRpcId | null, value: Record<string, unknown>): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: value };
}

export function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
