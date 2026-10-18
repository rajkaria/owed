import { test } from "node:test";
import assert from "node:assert/strict";
import { HEADER_MISMATCH, INVALID_PARAMS, INVALID_REQUEST, isNotification, isRequest, isResponse, UNSUPPORTED_PROTOCOL_VERSION } from "@/lib/mcp/jsonrpc";
import {
  batchProblem,
  decodeHeaderValue,
  envelopeProblem,
  LEGACY_PROTOCOL_VERSIONS,
  MODERN_PROTOCOL_VERSION,
  negotiateInitialize,
  readMcpHeaders,
  routeNotification,
  routeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  toLegacyResult,
} from "@/lib/mcp/protocol";

// Version negotiation and per-message era routing for POST /api/mcp (lib/mcp/protocol.ts).

const envelope = (version = MODERN_PROTOCOL_VERSION) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
});
const modern = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0" as const, id: 1, method, params: { ...params, _meta: envelope() } });
const legacy = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0" as const, id: 1, method, ...(params ? { params } : {}) });

test("supports 2026-07-28 and every handshake revision the MCP SDK 2.0.0 accepts", () => {
  assert.equal(MODERN_PROTOCOL_VERSION, "2026-07-28");
  for (const v of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(v), v);
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ["2026-07-28", ...LEGACY_PROTOCOL_VERSIONS]);
});

test("initialize answers the client's version when served, else the newest handshake revision", () => {
  assert.equal(negotiateInitialize("2025-06-18"), "2025-06-18");
  assert.equal(negotiateInitialize("2025-03-26"), "2025-03-26");
  assert.equal(negotiateInitialize("2025-11-25"), "2025-11-25");
  assert.equal(negotiateInitialize("2024-11-05"), "2024-11-05");
  assert.equal(negotiateInitialize("1999-01-01"), "2025-11-25");
  assert.equal(negotiateInitialize(undefined), "2025-11-25");
  assert.equal(negotiateInitialize(20250618), "2025-11-25");
  // initialize is the legacy handshake: a modern client is served through its per-request envelope instead.
  assert.equal(negotiateInitialize("2026-07-28"), "2025-11-25");
});

test("JSON-RPC shapes: request, notification, response", () => {
  assert.ok(isRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assert.ok(isRequest({ jsonrpc: "2.0", id: "a", method: "ping", params: {} }));
  assert.ok(!isRequest({ jsonrpc: "2.0", id: null, method: "ping" }));
  assert.ok(!isRequest({ jsonrpc: "1.0", id: 1, method: "ping" }));
  assert.ok(!isRequest({ jsonrpc: "2.0", id: 1, method: "ping", params: [1] }));
  assert.ok(isNotification({ jsonrpc: "2.0", method: "notifications/initialized" }));
  assert.ok(!isNotification({ jsonrpc: "2.0", method: "x", id: 1 }));
  assert.ok(isResponse({ jsonrpc: "2.0", id: 1, result: {} }));
  assert.ok(!isResponse({ jsonrpc: "2.0", id: 1, result: {}, error: {} }));
});

test("headers are read case-insensitively and trimmed", () => {
  const h = readMcpHeaders(new Headers({ "MCP-Protocol-Version": " 2026-07-28\t", "mcp-method": "tools/call", "Mcp-Name": "pay_link" }));
  assert.deepEqual(h, { protocolVersion: "2026-07-28", method: "tools/call", name: "pay_link" });
  assert.deepEqual(readMcpHeaders(new Headers()), { protocolVersion: undefined, method: undefined, name: undefined });
});

test("legacy requests route as legacy; a supported MCP-Protocol-Version header is fine, an unknown one is 400", () => {
  assert.deepEqual(routeRequest(legacy("initialize", { protocolVersion: "2025-06-18" }), {}), { era: "legacy", message: legacy("initialize", { protocolVersion: "2025-06-18" }) });
  assert.equal((routeRequest(legacy("tools/list"), { protocolVersion: "2025-06-18" }) as { era: string }).era, "legacy");
  assert.equal((routeRequest(legacy("tools/list"), {}) as { era: string }).era, "legacy"); // no header: assume 2025-03-26
  const bad = routeRequest(legacy("tools/list"), { protocolVersion: "2099-01-01" });
  assert.ok("rejection" in bad);
  assert.equal(bad.rejection.status, 400);
  assert.equal(bad.rejection.error.code, UNSUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(bad.rejection.error.data, { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: "2099-01-01" });
});

test("initialize with a 2026-07-28 header is a header mismatch", () => {
  const r = routeRequest(legacy("initialize", { protocolVersion: "2025-06-18" }), { protocolVersion: "2026-07-28" });
  assert.ok("rejection" in r);
  assert.equal(r.rejection.status, 400);
  assert.equal(r.rejection.error.code, HEADER_MISMATCH);
});

test("2026-07-28 requests route as modern, with or without the mirrored headers", () => {
  const call = modern("tools/call", { name: "pay_link", arguments: {} });
  assert.equal((routeRequest(call, {}) as { era: string }).era, "modern");
  assert.equal((routeRequest(call, { protocolVersion: "2026-07-28", method: "tools/call", name: "pay_link" }) as { era: string }).era, "modern");
  // initialize carrying a valid modern envelope is a modern request (for a method 2026-07-28 doesn't define).
  assert.equal((routeRequest(modern("initialize"), {}) as { era: string }).era, "modern");
});

test("modern headers that disagree with the body are -32020 HeaderMismatch (400)", () => {
  const call = modern("tools/call", { name: "pay_link", arguments: {} });
  for (const headers of [
    { protocolVersion: "2025-06-18" },
    { method: "tools/list" },
    { name: "check_payments" },
    { name: "=?base64?not base64!?=" },
  ]) {
    const r = routeRequest(call, headers);
    assert.ok("rejection" in r, JSON.stringify(headers));
    assert.equal(r.rejection.status, 400);
    assert.equal(r.rejection.error.code, HEADER_MISMATCH);
  }
  // A Base64-encoded Mcp-Name is decoded before comparing.
  const encoded = `=?base64?${Buffer.from("pay_link").toString("base64")}?=`;
  assert.equal((routeRequest(call, { name: encoded }) as { era: string }).era, "modern");
});

test("a 2026-07-28 header without the body envelope, or a broken envelope, is -32602 (400)", () => {
  const noEnvelope = routeRequest(legacy("tools/list"), { protocolVersion: "2026-07-28" });
  assert.ok("rejection" in noEnvelope);
  assert.equal(noEnvelope.rejection.status, 400);
  assert.equal(noEnvelope.rejection.error.code, INVALID_PARAMS);

  const noCaps = { jsonrpc: "2.0" as const, id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };
  const r = routeRequest(noCaps, {});
  assert.ok("rejection" in r);
  assert.equal(r.rejection.error.code, INVALID_PARAMS);
  assert.match(r.rejection.error.message, /clientCapabilities is missing/);

  const nonString = { jsonrpc: "2.0" as const, id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": 20260728 } } };
  const r2 = routeRequest(nonString, {});
  assert.ok("rejection" in r2);
  assert.equal(r2.rejection.error.code, INVALID_PARAMS);
});

test("an envelope naming an unknown revision is UnsupportedProtocolVersion with the supported list", () => {
  const future = { jsonrpc: "2.0" as const, id: 1, method: "tools/list", params: { _meta: envelope("2027-01-01") } };
  const r = routeRequest(future, {});
  assert.ok("rejection" in r);
  assert.equal(r.rejection.status, 400);
  assert.equal(r.rejection.error.code, UNSUPPORTED_PROTOCOL_VERSION);
  assert.deepEqual(r.rejection.error.data, { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: "2027-01-01" });
});

test("envelope validation", () => {
  assert.equal(envelopeProblem(envelope()), undefined);
  assert.equal(envelopeProblem({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }), undefined);
  assert.match(envelopeProblem({ "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": [] })!, /must be an object/);
  assert.match(envelopeProblem({ ...envelope(), "io.modelcontextprotocol/clientInfo": "x" })!, /clientInfo/);
});

test("Mcp-Name Base64 sentinel decoding", () => {
  assert.equal(decodeHeaderValue("pay_link"), "pay_link");
  assert.equal(decodeHeaderValue(`=?base64?${Buffer.from("Hello, 世界").toString("base64")}?=`), "Hello, 世界");
  assert.equal(decodeHeaderValue("=?base64?***?="), undefined);
  assert.equal(decodeHeaderValue(`=?base64?${Buffer.from([0xff, 0xfe]).toString("base64")}?=`), undefined); // not UTF-8
});

test("notifications: accepted under either era unless malformed", () => {
  assert.equal((routeNotification({ jsonrpc: "2.0", method: "notifications/initialized" }, {}) as { era: string }).era, "legacy");
  assert.equal((routeNotification({ jsonrpc: "2.0", method: "notifications/initialized" }, { protocolVersion: "2025-06-18" }) as { era: string }).era, "legacy");
  assert.equal((routeNotification({ jsonrpc: "2.0", method: "notifications/x", params: { _meta: envelope() } }, {}) as { era: string }).era, "modern");
  const unknown = routeNotification({ jsonrpc: "2.0", method: "notifications/initialized" }, { protocolVersion: "2099-01-01" });
  assert.ok("rejection" in unknown && unknown.rejection.status === 400);
  const mismatched = routeNotification({ jsonrpc: "2.0", method: "notifications/x", params: { _meta: envelope() } }, { protocolVersion: "2025-06-18" });
  assert.ok("rejection" in mismatched && mismatched.rejection.error.code === HEADER_MISMATCH);
});

test("batches: legacy only, non-empty, at most the limit", () => {
  assert.equal(batchProblem([legacy("ping")], {}, 8), undefined);
  assert.equal(batchProblem([], {}, 8)?.error.code, INVALID_REQUEST);
  assert.equal(batchProblem(Array.from({ length: 9 }, () => legacy("ping")), {}, 8)?.error.code, INVALID_REQUEST);
  assert.equal(batchProblem([modern("tools/list")], {}, 8)?.error.code, INVALID_REQUEST);
  assert.equal(batchProblem([legacy("ping")], { protocolVersion: "2026-07-28" }, 8)?.error.code, HEADER_MISMATCH);
  assert.equal(batchProblem([legacy("ping")], { protocolVersion: "2099-01-01" }, 8)?.error.code, UNSUPPORTED_PROTOCOL_VERSION);
});

test("legacy projection drops only the 2026-07-28 result fields and the serverInfo stamp", () => {
  const proposal = { "io.paybox/transactionProposal": { version: "1", kind: "solana", chain: "solana:mainnet", transaction: { transactionBase64: "AQ==" } } };
  const bundle = {
    content: [{ type: "text", text: "Pay 1 USDC" }],
    structuredContent: proposal,
    isError: false,
    resultType: "complete",
    ttlMs: 0,
    cacheScope: "private",
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "owed", version: "0.1.0" } },
  };
  assert.deepEqual(toLegacyResult(bundle), { content: bundle.content, structuredContent: proposal, isError: false });
  // Other _meta keys survive; the input is not mutated.
  const kept = toLegacyResult({ ...bundle, _meta: { ...bundle._meta, "io.paybox/x": 1 } });
  assert.deepEqual(kept._meta, { "io.paybox/x": 1 });
  assert.equal(bundle.resultType, "complete");
});
