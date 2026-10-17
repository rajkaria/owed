import "server-only";

// Server-side Solana JSON-RPC: Helius when HELIUS_API_KEY is set, publicnode otherwise.
// Calls go out as one JSON-RPC batch per round trip. Integers beyond 2^53 (large
// lamport balances) are parsed as bigint so no amount is ever rounded.

export const PUBLIC_RPC_URLS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

export interface RpcCall {
  method: string;
  params: unknown[];
}

/** Message never contains the RPC URL (it can carry the API key). */
export class RpcError extends Error {}

export function rpcUrls(): string[] {
  const key = process.env.HELIUS_API_KEY?.trim();
  return key
    ? [`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, ...PUBLIC_RPC_URLS]
    : [...PUBLIC_RPC_URLS];
}

type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

const bigintReviver: Reviver = (_key, value, context) =>
  typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)
    ? BigInt(context.source)
    : value;

/** JSON.parse that keeps integers above Number.MAX_SAFE_INTEGER exact (as bigint). */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, bigintReviver as Parameters<typeof JSON.parse>[1]);
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcOptions {
  urls?: string[];
  /** Per-endpoint timeout. */
  timeoutMs?: number;
  /** Epoch ms after which no further endpoint is tried. */
  deadline?: number;
}

/**
 * Run calls as one JSON-RPC batch, trying each URL in order until one answers every
 * call without an error. Results come back in call order.
 */
export async function rpcBatch(
  calls: readonly RpcCall[],
  { urls = rpcUrls(), timeoutMs = 3000, deadline = Infinity }: RpcOptions = {},
): Promise<unknown[]> {
  if (calls.length === 0) return [];
  const messages = calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params }));
  const body = JSON.stringify(messages.length === 1 ? messages[0] : messages);
  let lastProblem = "no RPC endpoint configured";
  for (const url of urls) {
    const host = new URL(url).hostname;
    const remaining = deadline - Date.now();
    if (remaining < 250) {
      lastProblem = "time budget spent";
      break;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(Math.min(timeoutMs, remaining)),
        cache: "no-store",
      });
      if (!res.ok) {
        lastProblem = `${host} answered HTTP ${res.status}`;
        continue;
      }
      const parsed = parseJsonExact(await res.text());
      const items = (Array.isArray(parsed) ? parsed : [parsed]) as RpcResponse[];
      const failed = items.find((r) => r.error);
      if (failed || items.length !== calls.length) {
        lastProblem = `${host} returned ${failed ? `error ${failed.error!.code}` : "an incomplete batch"}`;
        continue;
      }
      const byId = new Map(items.map((r) => [r.id, r.result]));
      return calls.map((_, i) => byId.get(i) ?? null);
    } catch (e) {
      lastProblem = `${host} ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable"}`;
    }
  }
  throw new RpcError(`Solana RPC unavailable (${lastProblem})`);
}

const PARALLEL = 8;

/**
 * Run calls as separate requests, up to 8 at a time. For methods that public endpoints
 * refuse to batch (publicnode allows one getTransaction per batch).
 */
export async function rpcEach(calls: readonly RpcCall[], options: RpcOptions = {}): Promise<unknown[]> {
  const results: unknown[] = new Array(calls.length);
  let next = 0;
  const worker = async () => {
    while (next < calls.length) {
      const i = next++;
      [results[i]] = await rpcBatch([calls[i]], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, calls.length) }, worker));
  return results;
}
