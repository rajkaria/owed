// MCP protocol versions and per-message era routing for POST /api/mcp, a dual-era Streamable HTTP endpoint:
//
// - Legacy clients (2025-11-25 and earlier) open with `initialize`; this endpoint answers the version they asked for
//   when it serves it and holds no session afterwards (no Mcp-Session-Id), so every later request stands alone.
// - Modern clients (2026-07-28, what the PayBox sandbox and the Owed bundle speak) send no handshake: every request
//   carries `_meta["io.modelcontextprotocol/protocolVersion"]` and the matching HTTP headers.
//
// The rules follow the MCP spec (basic/transports/streamable-http, basic/versioning for 2026-07-28) and mirror the
// classification of @modelcontextprotocol/server 2.0.0 (`classifyInboundRequest`), the SDK the bundle is built with.
// One deliberate difference: a missing Mcp-Method or Mcp-Name header is accepted (the body is the source of truth and
// nothing in front of this endpoint routes on those headers); a header that is present must match the body.
import {
  HEADER_MISMATCH,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isPlainObject,
  type JsonRpcErrorObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
  UNSUPPORTED_PROTOCOL_VERSION,
} from "./jsonrpc";

/** The revision the bundle speaks (plugin/starter-version.json). web/test/mcp-bundle.test.ts checks the meta file agrees. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** Handshake-era revisions `initialize` can negotiate: the list @modelcontextprotocol/core 2.0.0 accepts, newest first. */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];

export const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";
export const CLIENT_INFO_META = "io.modelcontextprotocol/clientInfo";
export const CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
export const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

export const isModernVersion = (version: string): boolean => version >= MODERN_PROTOCOL_VERSION;
const isLegacySupported = (version: string): boolean => (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(version);

/**
 * The version an `initialize` reply names: the client's own when this endpoint serves it, else the newest legacy
 * revision (the client then accepts it or disconnects). `initialize` is the legacy handshake, so it never answers
 * 2026-07-28: like the SDK, a modern client is served through its per-request `_meta` instead.
 */
export function negotiateInitialize(requested: unknown): string {
  return typeof requested === "string" && isLegacySupported(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0];
}

/** The MCP request headers, trimmed of HTTP optional whitespace; absent headers are undefined. */
export interface McpHeaders {
  protocolVersion?: string;
  method?: string;
  name?: string;
}

export function readMcpHeaders(headers: Headers): McpHeaders {
  const get = (name: string) => {
    const value = headers.get(name);
    return value === null ? undefined : value.replace(/^[ \t]+|[ \t]+$/g, "");
  };
  return { protocolVersion: get("mcp-protocol-version"), method: get("mcp-method"), name: get("mcp-name") };
}

/** A refused message: the HTTP status and the JSON-RPC error to answer it with. */
export interface Rejection {
  status: number;
  error: JsonRpcErrorObject;
}

export type Era = "legacy" | "modern";

export type Route<M> = { era: Era; message: M } | { rejection: Rejection };

const reject = (status: number, code: number, message: string, data?: unknown): { rejection: Rejection } =>
  ({ rejection: { status, error: { code, message, ...(data === undefined ? {} : { data }) } } });

const mismatch = (message: string) => reject(400, HEADER_MISMATCH, `Header mismatch: ${message}`);

const unsupported = (requested: string) =>
  reject(400, UNSUPPORTED_PROTOCOL_VERSION, `Unsupported protocol version: ${requested}`, { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested });

function metaOf(params: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(params)) return undefined;
  return isPlainObject(params._meta) ? params._meta : undefined;
}

/** The body's protocol-version claim: undefined when absent, null when present but not a string. */
function claimOf(params: unknown): string | null | undefined {
  const meta = metaOf(params);
  if (!meta || !(PROTOCOL_VERSION_META in meta)) return undefined;
  const value = meta[PROTOCOL_VERSION_META];
  return typeof value === "string" ? value : null;
}

/** The first problem with a 2026-07-28 per-request envelope, or undefined when it is valid. */
export function envelopeProblem(meta: Record<string, unknown>): string | undefined {
  if (typeof meta[PROTOCOL_VERSION_META] !== "string") return `${PROTOCOL_VERSION_META} must be a string`;
  if (!(CLIENT_CAPABILITIES_META in meta)) return `${CLIENT_CAPABILITIES_META} is missing`;
  if (!isPlainObject(meta[CLIENT_CAPABILITIES_META])) return `${CLIENT_CAPABILITIES_META} must be an object`;
  if (CLIENT_INFO_META in meta) {
    const info = meta[CLIENT_INFO_META];
    if (!isPlainObject(info) || typeof info.name !== "string" || typeof info.version !== "string") {
      return `${CLIENT_INFO_META} must be an object with string name and version`;
    }
  }
  return undefined;
}

const BASE64_PREFIX = "=?base64?";
const BASE64_SUFFIX = "?=";
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** An Mcp-Name / Mcp-Param-* value: the `=?base64?…?=` sentinel decoded as UTF-8, else as sent. Undefined if invalid. */
export function decodeHeaderValue(value: string): string | undefined {
  if (!(value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX) && value.length >= BASE64_PREFIX.length + BASE64_SUFFIX.length)) return value;
  const b64 = value.slice(BASE64_PREFIX.length, value.length - BASE64_SUFFIX.length);
  if (!CANONICAL_BASE64.test(b64)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(b64, "base64"));
  } catch {
    return undefined;
  }
}

/** Methods whose Mcp-Name header mirrors a body field. */
const NAME_SOURCE: Record<string, "name" | "uri"> = { "tools/call": "name", "prompts/get": "name", "resources/read": "uri" };

/** Which era serves this request, or why it is refused before it is dispatched. */
export function routeRequest(message: JsonRpcRequest, headers: McpHeaders): Route<JsonRpcRequest> {
  const headerVersion = headers.protocolVersion;
  const headerUnsupported = headerVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion);
  const headerIsModern = headerVersion === MODERN_PROTOCOL_VERSION;
  const claim = claimOf(message.params);

  // `initialize` is the legacy handshake unless the body carries a modern envelope claim.
  if (message.method === "initialize" && !(typeof claim === "string" && isModernVersion(claim))) {
    if (headerUnsupported) return unsupported(headerVersion);
    if (headerIsModern) return mismatch(`an initialize request (legacy handshake) was sent with MCP-Protocol-Version ${headerVersion}`);
    return { era: "legacy", message };
  }

  if (claim !== undefined) {
    if (claim === null) return reject(400, INVALID_PARAMS, `Invalid _meta envelope: ${PROTOCOL_VERSION_META} must be a string`);
    if (headerVersion !== undefined && headerVersion !== claim) {
      return mismatch(`MCP-Protocol-Version header ${headerVersion} does not match the body's ${PROTOCOL_VERSION_META} ${claim}`);
    }
    // A claim naming a handshake-era revision carries no envelope semantics: serve the request as legacy.
    if (isLegacySupported(claim)) return { era: "legacy", message };
    if (claim !== MODERN_PROTOCOL_VERSION) return unsupported(claim);
    const problem = envelopeProblem(metaOf(message.params)!);
    if (problem) return reject(400, INVALID_PARAMS, `Invalid _meta envelope for protocol revision ${MODERN_PROTOCOL_VERSION}: ${problem}`);
    if (headers.method !== undefined && headers.method !== message.method) {
      return mismatch(`Mcp-Method header ${headers.method} does not match the body's method ${message.method}`);
    }
    const source = Object.hasOwn(NAME_SOURCE, message.method) ? NAME_SOURCE[message.method] : undefined;
    if (source && headers.name !== undefined) {
      const decoded = decodeHeaderValue(headers.name);
      if (decoded === undefined) return mismatch("the Mcp-Name header carries an invalid Base64 value");
      const bodyValue = message.params?.[source];
      if (typeof bodyValue === "string" && decoded !== bodyValue) {
        return mismatch(`Mcp-Name header ${JSON.stringify(decoded)} does not match the body's params.${source} ${JSON.stringify(bodyValue)}`);
      }
    }
    return { era: "modern", message };
  }

  if (headerUnsupported) return unsupported(headerVersion);
  if (headerIsModern) {
    return reject(400, INVALID_PARAMS, `Invalid params: MCP-Protocol-Version ${headerVersion} needs the per-request _meta envelope (${PROTOCOL_VERSION_META}, ${CLIENT_CAPABILITIES_META})`);
  }
  return { era: "legacy", message };
}

/** Notifications are accepted (202) and dropped unless their headers or envelope are malformed. */
export function routeNotification(message: JsonRpcNotification, headers: McpHeaders): Route<JsonRpcNotification> {
  const headerVersion = headers.protocolVersion;
  const claim = claimOf(message.params);
  if (claim === null) return reject(400, INVALID_PARAMS, `Invalid _meta envelope: ${PROTOCOL_VERSION_META} must be a string`);
  if (claim !== undefined && headerVersion !== undefined && headerVersion !== claim) {
    return mismatch(`MCP-Protocol-Version header ${headerVersion} does not match the notification's ${PROTOCOL_VERSION_META} ${claim}`);
  }
  const version = claim ?? headerVersion;
  if (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return unsupported(version);
  const era: Era = version !== undefined && isModernVersion(version) ? "modern" : "legacy";
  if (era === "modern" && headers.method !== undefined && headers.method !== message.method) {
    return mismatch(`Mcp-Method header ${headers.method} does not match the notification's method ${message.method}`);
  }
  return { era, message };
}

/** Batches are a 2025-03-26 feature: legacy only, and never with a modern envelope or header. */
export function batchProblem(messages: readonly unknown[], headers: McpHeaders, maxMessages: number): Rejection | undefined {
  if (messages.length === 0) return { status: 400, error: { code: INVALID_REQUEST, message: "Invalid Request: empty JSON-RPC batch" } };
  if (messages.length > maxMessages) return { status: 400, error: { code: INVALID_REQUEST, message: `Invalid Request: a batch holds at most ${maxMessages} messages` } };
  if (messages.some((m) => isPlainObject(m) && claimOf(m.params) !== undefined)) {
    return { status: 400, error: { code: INVALID_REQUEST, message: `Invalid Request: batches cannot carry protocol revision ${MODERN_PROTOCOL_VERSION} requests` } };
  }
  const headerVersion = headers.protocolVersion;
  if (headerVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(headerVersion)) return unsupported(headerVersion).rejection;
  if (headerVersion === MODERN_PROTOCOL_VERSION) {
    return { status: 400, error: { code: HEADER_MISMATCH, message: `Header mismatch: MCP-Protocol-Version ${headerVersion} does not allow batches` } };
  }
  return undefined;
}

/** Result fields that exist only on the 2026-07-28 wire (SEP-2322 resultType, SEP-2549 caching). */
const MODERN_ONLY_RESULT_FIELDS = ["resultType", "ttlMs", "cacheScope"];

/**
 * A bundle result as a legacy client receives it: the 2026-07-28-only fields and the per-result serverInfo stamp
 * (legacy clients got serverInfo from `initialize`) removed, everything else (content, structuredContent with any
 * io.paybox/transactionProposal, isError, tools) untouched. This is what the SDK's 2025 codec sends for the same
 * handler output. Modern clients get the bundle's result verbatim.
 */
export function toLegacyResult(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const key of MODERN_ONLY_RESULT_FIELDS) delete out[key];
  if (isPlainObject(out._meta) && SERVER_INFO_META in out._meta) {
    const { [SERVER_INFO_META]: _serverInfo, ...rest } = out._meta;
    void _serverInfo;
    if (Object.keys(rest).length) out._meta = rest;
    else delete out._meta;
  }
  return out;
}
