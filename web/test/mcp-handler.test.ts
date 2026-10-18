import { test } from "node:test";
import assert from "node:assert/strict";
import { BundleError, type BundleCall } from "@/lib/mcp/bundle";
import type { JsonRpcResponse } from "@/lib/mcp/jsonrpc";
import { createMcpHandler, MCP_INSTRUCTIONS, MCP_LIMITS, methodNotAllowed, preflight, type RateDecision } from "@/lib/mcp/server";

// POST /api/mcp's JSON-RPC handling (lib/mcp/server.ts) with a fake bundle executor: no processes, no network.

const URL_ = "https://www.getowed.xyz/api/mcp";
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};
const SERVER_INFO_STAMP = { "io.modelcontextprotocol/serverInfo": { name: "owed", version: "0.1.0" } };

// A pay_link result recorded from the real bundle (web/mcp/owed-plugin.mjs, sha256 95d86a9b…) for a 1 USDC Solana Pay
// link, with Solana RPC answered from plugin/test/fixtures/chain/readiness-usdc-existing-recipient.json.
const PAY_LINK_RESULT = {
  content: [{
    type: "text",
    text: "Pay 1 USDC to FN6G…cbvs. Approve in PayBox to send.\nRecipient: FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs\nPayee not verified: no domain on this request.",
  }],
  structuredContent: {
    "io.paybox/transactionProposal": {
      version: "1",
      expiresAt: "2026-10-18T01:32:54Z",
      kind: "solana",
      chain: "solana:mainnet",
      transaction: {
        transactionBase64: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAMG1FK+FUB7XKP1xWiJcmpZ4Y7Cl0PflSU2kJXEJIX6Z/AW77giAe9T+ZK2+/tVmjUS17SpMivBY75cgI+CY9wLU2d1Tal1/Sa6yYnp48PBO7YXrXFMUEa2OpmvVOMgWhP0c6hrmCRlf7iaVvieipYyh8C8SS+L3wH3e+Yg/L1EUcnG+nrzvtutOj1l82qryXQxsbvkwtL24OR8pgIDRS9dYQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABBQUCBAEAAwoMQEIPAAAAAAAG",
      },
    },
  },
  resultType: "complete",
  _meta: SERVER_INFO_STAMP,
};

const TOOLS_RESULT = {
  tools: [
    { name: "ask_for_money", description: "Ask", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    { name: "pay_link", description: "Pay", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  ],
  resultType: "complete",
  ttlMs: 0,
  cacheScope: "private",
  _meta: SERVER_INFO_STAMP,
};

interface FakeOptions {
  respond?: (call: BundleCall) => Promise<JsonRpcResponse> | JsonRpcResponse;
  rate?: RateDecision;
}

function setup(options: FakeOptions = {}) {
  const calls: BundleCall[] = [];
  const slots: string[] = [];
  const logs: string[] = [];
  const handler = createMcpHandler({
    execute: async (call) => {
      calls.push(call);
      if (options.respond) return options.respond(call);
      if (call.method === "tools/list") return { jsonrpc: "2.0", id: 1, result: structuredClone(TOOLS_RESULT) };
      if (call.method === "tools/call" && call.params?.name === "pay_link") return { jsonrpc: "2.0", id: 1, result: structuredClone(PAY_LINK_RESULT) };
      return { jsonrpc: "2.0", id: 1, error: { code: -32602, message: `Tool ${String(call.params?.name)} not found` } };
    },
    takeCallSlot: async (ip) => {
      slots.push(ip);
      return options.rate ?? { allowed: true };
    },
    clientIp: (req) => req.headers.get("x-real-ip") ?? "unknown",
    server: { name: "owed", version: "0.1.0" },
    log: (line) => logs.push(line),
  });
  return { handler, calls, slots, logs };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function send(handler: ReturnType<typeof createMcpHandler>, body: unknown, headers: Record<string, string> = {}) {
  const res = await handler.post(post(body, headers));
  const text = await res.text();
  return { res, status: res.status, json: text ? JSON.parse(text) : undefined, text };
}

const modernHeaders = (method: string, name?: string) => ({
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": method,
  ...(name ? { "mcp-name": name } : {}),
});
const modern = (id: number | string, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: ENVELOPE } });

// ------------------------------------------------------------------------------------- legacy (initialize) clients

for (const version of ["2025-06-18", "2025-03-26", "2025-11-25"]) {
  test(`initialize ${version}: the same version back, tools capability, serverInfo, instructions, no session`, async () => {
    const { handler, calls } = setup();
    const { res, status, json } = await send(handler, {
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "claude", version: "1" } },
    });
    assert.equal(status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("mcp-session-id"), null);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(json, {
      jsonrpc: "2.0", id: 0,
      result: {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "owed", title: "Owed", version: "0.1.0" },
        instructions: MCP_INSTRUCTIONS,
      },
    });
    assert.equal(calls.length, 0, "initialize starts no process");
  });
}

test("initialize with an unknown or a 2026-07-28 version answers the newest handshake revision", async () => {
  const { handler } = setup();
  for (const asked of ["2099-01-01", "2026-07-28"]) {
    const { json } = await send(handler, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    assert.equal(json.result.protocolVersion, "2025-11-25", asked);
  }
});

test("instructions are one or two sentences about what Owed does", () => {
  const sentences = MCP_INSTRUCTIONS.split(/(?<=\.)\s+/).filter(Boolean);
  assert.ok(sentences.length >= 1 && sentences.length <= 2, MCP_INSTRUCTIONS);
  assert.match(MCP_INSTRUCTIONS, /ask anyone for money/);
});

test("notifications/initialized and other notifications: 202, empty body", async () => {
  const { handler, calls } = setup();
  for (const method of ["notifications/initialized", "notifications/cancelled", "notifications/whatever"]) {
    const { status, text, res } = await send(handler, { jsonrpc: "2.0", method }, { "mcp-protocol-version": "2025-06-18" });
    assert.equal(status, 202, method);
    assert.equal(text, "");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }
  assert.equal(calls.length, 0);
});

test("a posted JSON-RPC response is accepted (202)", async () => {
  const { handler } = setup();
  const { status } = await send(handler, { jsonrpc: "2.0", id: 5, result: {} });
  assert.equal(status, 202);
});

test("ping → {}", async () => {
  const { handler } = setup();
  const { status, json } = await send(handler, { jsonrpc: "2.0", id: "p", method: "ping" }, { "mcp-protocol-version": "2025-06-18" });
  assert.equal(status, 200);
  assert.deepEqual(json, { jsonrpc: "2.0", id: "p", result: {} });
});

test("tools/list: the bundle's tools, read from the bundle once per instance, projected for legacy clients", async () => {
  const { handler, calls } = setup();
  const first = await send(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { jsonrpc: "2.0", id: 1, result: { tools: TOOLS_RESULT.tools } });
  const second = await send(handler, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(second.json.result.tools, TOOLS_RESULT.tools);
  assert.equal(second.json.id, 2);
  assert.deepEqual(calls, [{ method: "tools/list" }], "one bundle process for both lists");
});

test("tools/list: concurrent first calls share one bundle process; a failed list is not cached", async () => {
  let fail = true;
  let resolveList!: () => void;
  const gate = new Promise<void>((r) => { resolveList = r; });
  const { handler, calls } = setup({
    respond: async () => {
      await gate;
      if (fail) throw new BundleError("timeout", "slow");
      return { jsonrpc: "2.0", id: 1, result: structuredClone(TOOLS_RESULT) };
    },
  });
  const pending = [1, 2, 3].map((id) => send(handler, { jsonrpc: "2.0", id, method: "tools/list" }));
  resolveList();
  const replies = await Promise.all(pending);
  assert.equal(calls.length, 1);
  for (const reply of replies) assert.equal(reply.json.error.code, -32001);
  fail = false;
  const retry = await send(handler, { jsonrpc: "2.0", id: 4, method: "tools/list" });
  assert.equal(retry.json.result.tools.length, 2);
  assert.equal(calls.length, 2);
});

test("tools/list with a cursor goes to the bundle (it never paginates today)", async () => {
  const { handler, calls } = setup({ respond: () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid cursor" } }) });
  const { json } = await send(handler, { jsonrpc: "2.0", id: 9, method: "tools/list", params: { cursor: "abc" } });
  assert.deepEqual(calls, [{ method: "tools/list", params: { cursor: "abc" } }]);
  assert.deepEqual(json, { jsonrpc: "2.0", id: 9, error: { code: -32602, message: "Invalid cursor" } });
});

test("tools/call pay_link (legacy client): the bundle's proposal passes through unchanged", async () => {
  const { handler, calls, slots } = setup();
  const args = { link: "solana:FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs?amount=1", sender: "FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT" };
  const { status, json } = await send(
    handler,
    { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "pay_link", arguments: args, _meta: { progressToken: 7 } } },
    { "mcp-protocol-version": "2025-06-18", "x-real-ip": "203.0.113.9" },
  );
  assert.equal(status, 200);
  assert.deepEqual(calls, [{ method: "tools/call", params: { name: "pay_link", arguments: args } }], "only name and arguments reach the bundle");
  assert.deepEqual(slots, ["203.0.113.9"]);
  const { resultType: _r, _meta: _m, ...legacyView } = PAY_LINK_RESULT;
  void _r; void _m;
  assert.deepEqual(json, { jsonrpc: "2.0", id: 42, result: legacyView });
  assert.deepEqual(json.result.structuredContent, PAY_LINK_RESULT.structuredContent);
  assert.deepEqual(json.result.content, PAY_LINK_RESULT.content);
});

test("tools/call pay_link (2026-07-28 client): the bundle's result verbatim", async () => {
  const { handler } = setup();
  const { status, json } = await send(
    handler,
    modern("c1", "tools/call", { name: "pay_link", arguments: { link: "x", sender: "y" } }),
    modernHeaders("tools/call", "pay_link"),
  );
  assert.equal(status, 200);
  assert.deepEqual(json, { jsonrpc: "2.0", id: "c1", result: PAY_LINK_RESULT });
});

test("tools/call errors from the bundle (unknown tool) are returned as the bundle wrote them", async () => {
  const { handler } = setup();
  const { status, json } = await send(handler, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(status, 200);
  assert.deepEqual(json, { jsonrpc: "2.0", id: 3, error: { code: -32602, message: "Tool nope not found" } });
});

test("tools/call with bad params is -32602 without starting a process", async () => {
  const { handler, calls, slots } = setup();
  for (const params of [{}, { name: "" }, { name: 5 }, { name: "pay_link", arguments: [1] }, { name: "pay_link", arguments: "x" }]) {
    const { json } = await send(handler, { jsonrpc: "2.0", id: 1, method: "tools/call", params });
    assert.equal(json.error.code, -32602, JSON.stringify(params));
  }
  assert.equal(calls.length, 0);
  assert.equal(slots.length, 5, "each POST with a tools/call is still counted");
});

test("bundle failures map to JSON-RPC errors (timeout -32001), never to a crash", async () => {
  const cases: Array<[BundleError | Error, number, RegExp]> = [
    [new BundleError("timeout", "x", "secret stderr"), -32001, /10 seconds/],
    [new BundleError("output_limit", "x"), -32603, /256 KiB/],
    [new BundleError("exited", "x"), -32603, /failed to run/],
    [new BundleError("spawn_failed", "x"), -32603, /failed to run/],
    [new BundleError("protocol", "x"), -32603, /failed to run/],
    [new BundleError("busy", "x"), -32000, /busy/],
    [new Error("boom"), -32603, /Internal error/],
  ];
  const errors = console.error;
  console.error = () => undefined;
  try {
    for (const [error, code, message] of cases) {
      const { handler } = setup({ respond: () => { throw error; } });
      const { status, json, text } = await send(handler, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pay_link", arguments: {} } });
      assert.equal(status, 200);
      assert.equal(json.error.code, code);
      assert.match(json.error.message, message);
      assert.ok(!text.includes("secret stderr"), "stderr never reaches the client");
    }
  } finally {
    console.error = errors;
  }
});

test("unknown methods: -32601 (in-band for legacy clients, HTTP 404 for 2026-07-28)", async () => {
  const { handler } = setup();
  for (const method of ["resources/list", "prompts/list", "logging/setLevel", "server/discover"]) {
    const legacy = await send(handler, { jsonrpc: "2.0", id: 1, method }, { "mcp-protocol-version": "2025-06-18" });
    assert.equal(legacy.status, 200, method);
    assert.equal(legacy.json.error.code, -32601, method);
  }
  const modernReply = await send(handler, modern(1, "resources/list"), modernHeaders("resources/list"));
  assert.equal(modernReply.status, 404);
  assert.equal(modernReply.json.error.code, -32601);
  const initializeModern = await send(handler, modern(2, "initialize"), modernHeaders("initialize"));
  assert.equal(initializeModern.status, 404);
});

// --------------------------------------------------------------------------------------- 2026-07-28 (modern) clients

test("server/discover: supported versions, capabilities, serverInfo, instructions", async () => {
  const { handler, calls } = setup();
  const { status, json } = await send(handler, modern("d", "server/discover"), modernHeaders("server/discover"));
  assert.equal(status, 200);
  assert.deepEqual(json.result, {
    resultType: "complete",
    supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"],
    capabilities: { tools: { listChanged: false } },
    instructions: MCP_INSTRUCTIONS,
    ttlMs: 0,
    cacheScope: "private",
    _meta: SERVER_INFO_STAMP,
  });
  assert.equal(calls.length, 0);
});

test("2026-07-28 tools/list and ping keep the modern result fields", async () => {
  const { handler } = setup();
  const list = await send(handler, modern(1, "tools/list"), modernHeaders("tools/list"));
  assert.deepEqual(list.json.result, TOOLS_RESULT);
  const ping = await send(handler, modern(2, "ping"), modernHeaders("ping"));
  assert.deepEqual(ping.json.result, { resultType: "complete" });
});

test("2026-07-28 header/body disagreements are 400 -32020 and start no process", async () => {
  const { handler, calls, slots } = setup();
  const call = modern(1, "tools/call", { name: "pay_link", arguments: {} });
  for (const headers of [modernHeaders("tools/list"), modernHeaders("tools/call", "check_payments"), { ...modernHeaders("tools/call"), "mcp-protocol-version": "2025-06-18" }]) {
    const { status, json } = await send(handler, call, headers);
    assert.equal(status, 400);
    assert.equal(json.error.code, -32020);
    assert.equal(json.id, 1);
  }
  assert.equal(calls.length, 0);
  assert.equal(slots.length, 0, "refused before the rate limit");
});

test("unsupported versions are 400 -32022 with the supported list", async () => {
  const { handler } = setup();
  const byHeader = await send(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2030-01-01" });
  assert.equal(byHeader.status, 400);
  assert.equal(byHeader.json.error.code, -32022);
  assert.ok(byHeader.json.error.data.supported.includes("2026-07-28"));
  const byEnvelope = await send(handler, { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { ...ENVELOPE, "io.modelcontextprotocol/protocolVersion": "2030-01-01" } } });
  assert.equal(byEnvelope.status, 400);
  assert.equal(byEnvelope.json.error.code, -32022);
});

// ------------------------------------------------------------------------------------------- JSON and HTTP edges

test("bad JSON → 400 -32700; not JSON-RPC → 400 -32600", async () => {
  const { handler } = setup();
  for (const body of ["{", "", "not json", "{\"jsonrpc\":"]) {
    const { status, json } = await send(handler, body);
    assert.equal(status, 400, body);
    assert.deepEqual(json, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the body is not valid JSON" } });
  }
  for (const body of [{}, { jsonrpc: "2.0" }, { jsonrpc: "2.0", id: 4, method: 5 }, 42, "str", null]) {
    const { status, json } = await send(handler, JSON.stringify(body));
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, -32600);
  }
  const withId = await send(handler, { jsonrpc: "2.0", id: 4, method: 5 });
  assert.equal(withId.json.id, 4);
});

test("bodies over 64 KiB → 413 (declared or streamed)", async () => {
  const { handler, calls } = setup();
  const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pay_link", arguments: { link: "x".repeat(MCP_LIMITS.bodyBytes) } } });
  const tooBig = await send(handler, big);
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.json.error.code, -32600);
  // A declared Content-Length over the cap is refused before reading.
  const declared = await send(handler, "{}", { "content-length": String(MCP_LIMITS.bodyBytes + 1) });
  assert.equal(declared.status, 413);
  // No Content-Length: the reader stops past the cap.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 80; i += 1) controller.enqueue(encoder.encode("x".repeat(1024)));
      controller.close();
    },
  });
  const streamed = await handler.post(new Request(URL_, { method: "POST", body: stream, duplex: "half" } as RequestInit));
  assert.equal(streamed.status, 413);
  // Just under the cap is parsed.
  const fits = await send(handler, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MCP_LIMITS.bodyBytes - 200) } }));
  assert.equal(fits.status, 200);
  assert.equal(calls.length, 0);
});

test("GET and DELETE → 405 with Allow: POST; OPTIONS is a CORS preflight", async () => {
  const res = methodNotAllowed();
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal((await res.json()).error.code, -32000);
  const pre = preflight();
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(pre.headers.get("access-control-allow-methods")!, /POST/);
  for (const h of ["Content-Type", "MCP-Protocol-Version", "Mcp-Method", "Mcp-Name"]) assert.match(pre.headers.get("access-control-allow-headers")!, new RegExp(h));
  assert.equal(pre.headers.get("access-control-allow-credentials"), null, "no credentials: nothing sensitive is shared");
});

// --------------------------------------------------------------------------------------------------- batches

test("batch (2025-03-26): responses in order, notifications produce none", async () => {
  const { handler, calls, slots } = setup();
  const { status, json } = await send(handler, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pay_link", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "nope" },
  ]);
  assert.equal(status, 200);
  assert.deepEqual(json.map((r: { id: number }) => r.id), [1, 2, 3, 4]);
  assert.equal(json[0].result.protocolVersion, "2025-03-26");
  assert.equal(json[1].result.tools.length, 2);
  assert.deepEqual(json[2].result.structuredContent, PAY_LINK_RESULT.structuredContent);
  assert.equal(json[3].error.code, -32601);
  assert.equal(calls.length, 2);
  assert.equal(slots.length, 1, "one rate-limit event per POST");
});

test("batch of notifications only → 202; empty, oversized, modern or malformed batches → 400", async () => {
  const { handler, calls } = setup();
  assert.equal((await send(handler, [{ jsonrpc: "2.0", method: "notifications/initialized" }])).status, 202);
  const empty = await send(handler, []);
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error.code, -32600);
  const oversized = await send(handler, Array.from({ length: MCP_LIMITS.batchMessages + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" })));
  assert.equal(oversized.status, 400);
  const withModern = await send(handler, [modern(1, "tools/list")]);
  assert.equal(withModern.status, 400);
  const malformed = await send(handler, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pay_link" } }, { nope: true }]);
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 0, "a refused batch starts no process");
});

// ------------------------------------------------------------------------------------------------- rate limit

test("rate limit: only POSTs with a tools/call are counted; over the limit → 429 + Retry-After", async () => {
  const { handler, calls, slots } = setup({ rate: { allowed: false, retryAfterSeconds: 17 } });
  // Cheap methods are never counted or refused.
  for (const body of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
  ]) assert.equal((await send(handler, body)).status, 200);
  assert.equal(slots.length, 0);
  const limited = await send(handler, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pay_link", arguments: {} } }, { "x-real-ip": "198.51.100.7" });
  assert.equal(limited.status, 429);
  assert.equal(limited.res.headers.get("retry-after"), "17");
  assert.equal(limited.json.id, 4);
  assert.equal(limited.json.error.code, -32000);
  assert.deepEqual(limited.json.error.data, { retryAfterSeconds: 17 });
  assert.deepEqual(slots, ["198.51.100.7"]);
  assert.deepEqual(calls.map((c) => c.method), ["tools/list"], "the refused call started no process");
  const batch = await send(handler, [{ jsonrpc: "2.0", id: 5, method: "ping" }, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "pay_link", arguments: {} } }]);
  assert.equal(batch.status, 429);
  assert.deepEqual(batch.json.map((r: { id: number }) => r.id), [5, 6]);
});

test("rate limit: a limiter that throws fails open (the call still runs)", async () => {
  const errors = console.error;
  console.error = () => undefined;
  try {
    const calls: BundleCall[] = [];
    const handler = createMcpHandler({
      execute: async (call) => { calls.push(call); return { jsonrpc: "2.0", id: 1, result: structuredClone(PAY_LINK_RESULT) }; },
      takeCallSlot: async () => { throw new Error("db down"); },
      server: { name: "owed", version: "0.1.0" },
      log: () => undefined,
    });
    const { status, json } = await send(handler, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pay_link", arguments: {} } });
    assert.equal(status, 200);
    assert.ok(json.result.structuredContent);
    assert.equal(calls.length, 1);
  } finally {
    console.error = errors;
  }
});

test("logs say which client and protocol connect, with client text sanitized", async () => {
  const { handler, logs } = setup();
  await send(handler, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "PayBox\nFAKE line", version: "2.1" } } });
  await send(handler, modern(2, "server/discover"), modernHeaders("server/discover"));
  await send(handler, modern(3, "tools/call", { name: "pay_link", arguments: {} }), modernHeaders("tools/call", "pay_link"));
  assert.equal(logs[0], "mcp initialize 2025-06-18 → 2025-06-18 client=PayBox?FAKE?line/2.1");
  assert.equal(logs[1], "mcp server/discover client=test-client/1");
  assert.match(logs[2], /^mcp tools\/call pay_link \(modern\) \d+ms ok$/);
  assert.ok(logs.every((line) => !line.includes("\n")));
});

test("OWED_MCP_CALLS_PER_MINUTE overrides the 120/min tool-call limit only with a sane whole number", async () => {
  const { mcpCallsPerMinute, MCP_CALL_LIMITS } = await import("@/lib/mcp/limits");
  assert.equal(MCP_CALL_LIMITS.perIp, 120);
  assert.equal(MCP_CALL_LIMITS.windowSeconds, 60);
  assert.equal(mcpCallsPerMinute(undefined), 120);
  assert.equal(mcpCallsPerMinute("600"), 600);
  assert.equal(mcpCallsPerMinute(" 1000 "), 1000);
  for (const bad of ["", "0", "-5", "1.5", "abc", "1e3", "200000"]) assert.equal(mcpCallsPerMinute(bad), 120, bad);
});
