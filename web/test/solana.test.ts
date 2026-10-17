import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { rpcBatch, rpcEach, RpcError, rpcUrls } from "@/lib/solana";

// A local JSON-RPC endpoint whose behavior each test picks via the URL path.
type Handler = (body: unknown, res: ServerResponse) => void;
const handlers: Record<string, Handler> = {
  "/echo": (body, res) => {
    const reply = (m: { id: number; params: unknown[] }) => ({ jsonrpc: "2.0", id: m.id, result: m.params[0] });
    res.end(JSON.stringify(Array.isArray(body) ? [...body].reverse().map(reply) : reply(body as never)));
  },
  "/one-per-batch": (body, res) => {
    if (Array.isArray(body) && body.length > 1) {
      res.statusCode = 400;
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Maximum number of calls in a batch request is 1" } }));
      return;
    }
    handlers["/echo"](body, res);
  },
  "/rate-limited": (body, res) => {
    const items = Array.isArray(body) ? body : [body];
    res.end(JSON.stringify(items.map((m: { id: number }) => ({ jsonrpc: "2.0", id: m.id, error: { code: 429, message: "Too many requests" } }))));
  },
  "/http-500": (_body, res) => {
    res.statusCode = 500;
    res.end("oops");
  },
  "/hang": () => {
    // never answers
  },
  "/big-number": (body, res) => {
    const m = body as { id: number };
    res.end(`{"jsonrpc":"2.0","id":${m.id},"result":{"lamports":18446744073709551615,"small":5}}`);
  },
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => handlers[req.url ?? ""]?.(JSON.parse(data), res));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("batch results come back in call order whatever order the server answers", async () => {
  const out = await rpcBatch(
    [
      { method: "a", params: ["first"] },
      { method: "b", params: ["second"] },
    ],
    { urls: [`${origin}/echo`] },
  );
  assert.deepEqual(out, ["first", "second"]);
});

test("falls back to the next endpoint on HTTP errors, RPC errors and timeouts", async () => {
  const calls = [{ method: "x", params: ["ok"] }];
  assert.deepEqual(await rpcBatch(calls, { urls: [`${origin}/http-500`, `${origin}/echo`] }), ["ok"]);
  assert.deepEqual(await rpcBatch(calls, { urls: [`${origin}/rate-limited`, `${origin}/echo`] }), ["ok"]);
  assert.deepEqual(await rpcBatch(calls, { urls: [`${origin}/hang`, `${origin}/echo`], timeoutMs: 300 }), ["ok"]);
});

test("fails with RpcError when every endpoint fails, without leaking URLs", async () => {
  await assert.rejects(
    rpcBatch([{ method: "x", params: [] }], { urls: [`${origin}/http-500`, `${origin}/rate-limited`] }),
    (e: unknown) => e instanceof RpcError && /127\.0\.0\.1 returned error 429/.test(e.message) && !e.message.includes("http"),
  );
});

test("stops trying endpoints once the deadline has passed", async () => {
  const started = Date.now();
  await assert.rejects(
    rpcBatch([{ method: "x", params: [] }], { urls: [`${origin}/hang`, `${origin}/hang`, `${origin}/hang`], deadline: Date.now() + 600 }),
    RpcError,
  );
  assert.ok(Date.now() - started < 1500);
});

test("rpcEach sends calls one by one to endpoints that refuse batches", async () => {
  const calls = Array.from({ length: 12 }, (_, i) => ({ method: "getTransaction", params: [`tx${i}`] }));
  await assert.rejects(rpcBatch(calls, { urls: [`${origin}/one-per-batch`] }), RpcError);
  assert.deepEqual(await rpcEach(calls, { urls: [`${origin}/one-per-batch`] }), calls.map((c) => c.params[0]));
});

test("integers above 2^53 arrive exact", async () => {
  const [result] = await rpcBatch([{ method: "getBalance", params: [] }], { urls: [`${origin}/big-number`] });
  assert.deepEqual(result, { lamports: 18_446_744_073_709_551_615n, small: 5 });
});

test("Helius is used first when HELIUS_API_KEY is set, with public fallbacks", () => {
  const saved = process.env.HELIUS_API_KEY;
  try {
    delete process.env.HELIUS_API_KEY;
    assert.deepEqual(rpcUrls(), ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"]);
    process.env.HELIUS_API_KEY = "k&y";
    assert.deepEqual(rpcUrls(), [
      "https://mainnet.helius-rpc.com/?api-key=k%26y",
      "https://solana-rpc.publicnode.com",
      "https://api.mainnet-beta.solana.com",
    ]);
  } finally {
    if (saved === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = saved;
  }
});
