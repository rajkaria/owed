import { BundleError, type BundleCall, type BundleExecutor } from "./bundle";
import {
  failure,
  idOf,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isNotification,
  isPlainObject,
  isRequest,
  isResponse,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  REQUEST_TIMEOUT,
  result,
  SERVER_ERROR,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc";
import {
  batchProblem,
  type Era,
  type McpHeaders,
  negotiateInitialize,
  readMcpHeaders,
  routeNotification,
  routeRequest,
  SERVER_INFO_META,
  SUPPORTED_PROTOCOL_VERSIONS,
  toLegacyResult,
} from "./protocol";

// POST /api/mcp: a stateless MCP Streamable HTTP endpoint (JSON replies, no SSE, no sessions) in front of the Owed
// plugin bundle. initialize, ping and server/discover are answered here; tools/list is the bundle's own (one process
// per warm instance, then cached); every tools/call runs in a fresh bundle process and its result is returned as the
// bundle wrote it, structuredContent and any io.paybox/transactionProposal included.

export const MCP_LIMITS = {
  /** Larger bodies get 413 before they are parsed. */
  bodyBytes: 64 * 1024,
  /** Messages per JSON-RPC batch (2025-03-26 clients). */
  batchMessages: 8,
  /** Bundle calls of one batch that run at once. */
  batchConcurrency: 4,
} as const;

export const MCP_INSTRUCTIONS =
  "Owed lets an agent ask anyone for money (a pay link, QR code and message to send, in USDC or SOL on Solana mainnet or USDC on Base) and check who has paid. "
  + "Owed never holds funds or signs: pay_link returns an unsigned transaction proposal for the user to approve in PayBox.";

const CAPABILITIES = { tools: { listChanged: false } } as const;

export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "Retry-After",
  "Access-Control-Max-Age": "86400",
};

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface McpHandlerOptions {
  /** Runs one operation in a fresh bundle process (bundleExecutor() in production, a fake in tests). */
  execute: BundleExecutor;
  /** Charged once per POST that carries a tools/call (the calls that start processes). */
  takeCallSlot?: (ip: string) => Promise<RateDecision>;
  clientIp?: (req: Request) => string;
  server: { name: string; version: string };
  log?: (line: string) => void;
}

interface Reply {
  status: number;
  /** undefined: 202 with no body. */
  body?: JsonRpcResponse | JsonRpcResponse[];
  headers?: Record<string, string>;
}

function respond(reply: Reply): Response {
  if (reply.body === undefined) return new Response(null, { status: reply.status, headers: { ...CORS_HEADERS, ...reply.headers } });
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...reply.headers },
  });
}

/** GET, DELETE and the rest: no SSE stream and no session to end (2026-07-28 and 2025-era guidance alike). */
export function methodNotAllowed(): Response {
  return respond({ status: 405, body: failure(null, SERVER_ERROR, "Method not allowed: POST JSON-RPC messages to this endpoint."), headers: { Allow: "POST" } });
}

/** CORS preflight: MCP clients that run in a browser may POST from any origin. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } });
}

type ReadBody = { kind: "text"; text: string } | { kind: "too_large" };

async function readBody(req: Request, maxBytes: number): Promise<ReadBody> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too_large" };
  if (!req.body) return { kind: "text", text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { kind: "too_large" };
    }
    chunks.push(value);
  }
  return { kind: "text", text: new TextDecoder().decode(Buffer.concat(chunks)) };
}

/** Runs `work` over `items` with at most `limit` in flight, keeping order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await work(items[index]);
    }
  });
  await Promise.all(lanes);
  return out;
}

const MODERN_STATUS: Record<number, number> = { [METHOD_NOT_FOUND]: 404 };

/** A client-supplied value made safe for one log line. */
const safe = (value: unknown): string => (typeof value === "string" ? value.replace(/[^\w./@:+-]/g, "?").slice(0, 64) : "-");

export function createMcpHandler(options: McpHandlerOptions) {
  const log = options.log ?? ((line: string) => console.log(line));
  let toolsList: Promise<JsonRpcResponse> | null = null;

  /** The bundle's reply to one operation, as a JSON-RPC response to the client's id. */
  async function callBundle(id: JsonRpcId, call: BundleCall, label: string): Promise<JsonRpcResponse> {
    const started = performance.now();
    try {
      const message = await options.execute(call);
      log(`mcp ${label} ${Math.round(performance.now() - started)}ms ${"error" in message ? `error ${message.error.code}` : "ok"}`);
      return "error" in message ? { jsonrpc: "2.0", id, error: message.error } : { jsonrpc: "2.0", id, result: message.result };
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      if (error instanceof BundleError) {
        console.error(`mcp ${label} ${ms}ms failed: ${error.kind}: ${error.message}${error.stderr ? ` · stderr: ${error.stderr.slice(-2000)}` : ""}`);
        if (error.kind === "timeout") return failure(id, REQUEST_TIMEOUT, "The Owed plugin did not answer within 10 seconds. Try again.");
        if (error.kind === "busy") return failure(id, SERVER_ERROR, "The Owed MCP server is busy. Try again in a few seconds.");
        if (error.kind === "output_limit") return failure(id, INTERNAL_ERROR, "The Owed plugin's answer was larger than 256 KiB.");
        return failure(id, INTERNAL_ERROR, "The Owed plugin failed to run.");
      }
      console.error(`mcp ${label} ${ms}ms failed`, error);
      return failure(id, INTERNAL_ERROR, "Internal error");
    }
  }

  /** tools/list from the bundle: one process per warm instance; a failure is not cached. */
  async function cachedToolsList(id: JsonRpcId): Promise<JsonRpcResponse> {
    if (!toolsList) {
      const attempt = callBundle(0, { method: "tools/list" }, "tools/list");
      toolsList = attempt;
      void attempt.then((reply) => {
        if ("error" in reply && toolsList === attempt) toolsList = null;
      });
    }
    const reply = await toolsList;
    return "error" in reply ? { jsonrpc: "2.0", id, error: reply.error } : result(id, reply.result);
  }

  async function toolCall(message: JsonRpcRequest, era: Era): Promise<JsonRpcResponse> {
    const params = message.params ?? {};
    const name = params.name;
    if (typeof name !== "string" || !name) return failure(message.id, INVALID_PARAMS, "Invalid params: tools/call needs params.name (a tool name)");
    if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
      return failure(message.id, INVALID_PARAMS, "Invalid params: tools/call params.arguments must be an object");
    }
    return callBundle(message.id, { method: "tools/call", params: { name, arguments: params.arguments ?? {} } }, `tools/call ${safe(name)} (${era})`);
  }

  const serverInfo = () => ({ name: options.server.name, title: "Owed", version: options.server.version });

  /** Dispatch for a request served under `era`; returns the response and its HTTP status. */
  async function dispatch(era: Era, message: JsonRpcRequest): Promise<{ status: number; body: JsonRpcResponse }> {
    const legacy = era === "legacy";
    const project = (reply: JsonRpcResponse): JsonRpcResponse =>
      legacy && "result" in reply ? { ...reply, result: toLegacyResult(reply.result) } : reply;
    const modernResult = (value: Record<string, unknown>) => ({ resultType: "complete", ...value });
    let body: JsonRpcResponse;
    switch (message.method) {
      case "initialize":
        // Only legacy routing reaches here (a modern envelope on initialize is a 2026-07-28 request for an unknown method).
        if (legacy) {
          const info = isPlainObject(message.params?.clientInfo) ? message.params.clientInfo : {};
          log(`mcp initialize ${safe(message.params?.protocolVersion)} → ${negotiateInitialize(message.params?.protocolVersion)} client=${safe(info.name)}/${safe(info.version)}`);
        }
        body = legacy
          ? result(message.id, {
            protocolVersion: negotiateInitialize(message.params?.protocolVersion),
            capabilities: CAPABILITIES,
            serverInfo: serverInfo(),
            instructions: MCP_INSTRUCTIONS,
          })
          : failure(message.id, METHOD_NOT_FOUND, "Method not found: initialize (protocol revision 2026-07-28 has no handshake; use server/discover)");
        break;
      case "server/discover":
        if (!legacy) {
          const meta = isPlainObject(message.params?._meta) ? message.params._meta : {};
          const info = isPlainObject(meta["io.modelcontextprotocol/clientInfo"]) ? meta["io.modelcontextprotocol/clientInfo"] : {};
          log(`mcp server/discover client=${safe(info.name)}/${safe(info.version)}`);
        }
        body = legacy
          ? failure(message.id, METHOD_NOT_FOUND, "Method not found: server/discover")
          : result(message.id, modernResult({
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
            capabilities: CAPABILITIES,
            instructions: MCP_INSTRUCTIONS,
            ttlMs: 0,
            cacheScope: "private",
            _meta: { [SERVER_INFO_META]: { name: options.server.name, version: options.server.version } },
          }));
        break;
      case "ping":
        body = result(message.id, legacy ? {} : modernResult({}));
        break;
      case "tools/list":
        body = project(message.params?.cursor === undefined
          ? await cachedToolsList(message.id)
          : await callBundle(message.id, { method: "tools/list", params: { cursor: message.params.cursor } }, "tools/list (page)"));
        break;
      case "tools/call":
        body = project(await toolCall(message, era));
        break;
      default:
        body = failure(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method.slice(0, 100)}`);
    }
    const status = !legacy && "error" in body ? (MODERN_STATUS[body.error.code] ?? 200) : 200;
    return { status, body };
  }

  async function rateLimited(req: Request, ids: JsonRpcId[], batch: boolean): Promise<Reply | null> {
    if (!options.takeCallSlot) return null;
    const ip = options.clientIp?.(req) ?? "unknown";
    let decision: RateDecision;
    try {
      decision = await options.takeCallSlot(ip);
    } catch (error) {
      console.error("mcp rate limit skipped", error); // fail open, like the limiter does for database errors
      return null;
    }
    if (decision.allowed) return null;
    const seconds = Math.max(1, Math.ceil(decision.retryAfterSeconds ?? 60));
    const error = (id: JsonRpcId | null) => failure(id, SERVER_ERROR, `Too many Owed tool calls from this client. Try again in ${seconds} s.`, { retryAfterSeconds: seconds });
    return { status: 429, body: batch ? ids.map(error) : error(ids[0] ?? null), headers: { "Retry-After": String(seconds) } };
  }

  async function single(req: Request, message: unknown, headers: McpHeaders): Promise<Reply> {
    if (isRequest(message)) {
      const route = routeRequest(message, headers);
      if ("rejection" in route) return { status: route.rejection.status, body: { jsonrpc: "2.0", id: message.id, error: route.rejection.error } };
      if (message.method === "tools/call") {
        const limited = await rateLimited(req, [message.id], false);
        if (limited) return limited;
      }
      return dispatch(route.era, message);
    }
    if (isNotification(message)) {
      const route = routeNotification(message, headers);
      if ("rejection" in route) return { status: route.rejection.status, body: { jsonrpc: "2.0", id: null, error: route.rejection.error } };
      return { status: 202 };
    }
    if (isResponse(message)) return { status: 202 }; // a 2025-era client answering a server request; nothing to do
    return { status: 400, body: failure(idOf(message), INVALID_REQUEST, "Invalid Request: the body is not a JSON-RPC 2.0 request or notification") };
  }

  async function batch(req: Request, messages: unknown[], headers: McpHeaders): Promise<Reply> {
    const problem = batchProblem(messages, headers, MCP_LIMITS.batchMessages);
    if (problem) return { status: problem.status, body: { jsonrpc: "2.0", id: null, error: problem.error } };
    // Validate everything first, so a refused batch starts no process.
    for (const message of messages) {
      if (!isRequest(message) && !isNotification(message) && !isResponse(message)) {
        return { status: 400, body: failure(null, INVALID_REQUEST, "Invalid Request: the batch holds a message that is not JSON-RPC 2.0") };
      }
    }
    const requests = messages.filter(isRequest);
    const routed = requests.map((message) => ({ message, route: routeRequest(message, headers) }));
    if (routed.some(({ message, route }) => message.method === "tools/call" && !("rejection" in route))) {
      const limited = await rateLimited(req, requests.map((m) => m.id), true);
      if (limited) return limited;
    }
    const bodies = await mapLimit(routed, MCP_LIMITS.batchConcurrency, async ({ message, route }) =>
      "rejection" in route ? ({ jsonrpc: "2.0", id: message.id, error: route.rejection.error } as JsonRpcResponse) : (await dispatch(route.era, message)).body);
    if (bodies.length === 0) return { status: 202 };
    return { status: 200, body: bodies };
  }

  async function post(req: Request): Promise<Response> {
    const body = await readBody(req, MCP_LIMITS.bodyBytes);
    if (body.kind === "too_large") {
      return respond({ status: 413, body: failure(null, INVALID_REQUEST, `Request body is larger than ${MCP_LIMITS.bodyBytes / 1024} KiB`) });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return respond({ status: 400, body: failure(null, PARSE_ERROR, "Parse error: the body is not valid JSON") });
    }
    const headers = readMcpHeaders(req.headers);
    return respond(Array.isArray(parsed) ? await batch(req, parsed, headers) : await single(req, parsed, headers));
  }

  return { post, methodNotAllowed, preflight };
}

