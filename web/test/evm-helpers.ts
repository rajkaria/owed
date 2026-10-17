import { readFileSync } from "node:fs";
import type { BaseRpcOptions } from "@/lib/evm/rpc";

// W3-B: real Base mainnet JSON-RPC exchanges (test/fixtures/evm/capture.ts) and a replaying fetch.

export type Exchange = { url: string; request: { method: string; params: unknown[] }; response: { status: number; body: unknown } };
export interface ScanFixture {
  recipient: string;
  head: { number: number; timestamp: number };
  recent_from: number;
  archive_from: number;
  start_block_time: number;
  transfers: Array<{ blockNumber: number; blockTimestamp: number; txHash: string; logIndex: number; from: string; to: string; value: string }>;
  exchanges: Exchange[];
}
export const scanFixture = JSON.parse(readFileSync(new URL("fixtures/evm/scan.json", import.meta.url), "utf8")) as ScanFixture;
export const settlement = JSON.parse(readFileSync(new URL("fixtures/evm/x402-settlement.json", import.meta.url), "utf8")) as {
  hash: string; transfers: Array<{ from: string; to: string; value: string }>; exchanges: Exchange[];
};

/** Replays recorded JSON-RPC exchanges; any call that wasn't recorded fails the test loudly. */
export function replay(exchanges: Exchange[], opts: { down?: string[]; calls?: string[] } = {}): BaseRpcOptions {
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    opts.calls?.push(`${new URL(url).hostname} ${body.method}`);
    if (opts.down?.includes(new URL(url).hostname)) throw new TypeError("fetch failed");
    const hit = exchanges.find((e) => e.url === url && e.request.method === body.method && JSON.stringify(e.request.params) === JSON.stringify(body.params));
    if (!hit) throw new Error(`unrecorded Base RPC call: ${url} ${body.method} ${JSON.stringify(body.params)}`);
    return Response.json(hit.response.body, { status: hit.response.status });
  }) as typeof fetch;
  return { fetch: doFetch, timeoutMs: 1000 };
}

