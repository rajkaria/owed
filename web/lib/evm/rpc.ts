import { isHexAddress, toChecksumAddress } from "./address";
import { BASE_USDC, TRANSFER_TOPIC } from "./base";

// Base mainnet JSON-RPC, keyless. Observed 2026-10-17 (see docs/FACTS.md):
// - base-rpc.publicnode.com serves eth_getLogs (with blockTimestamp) for ranges up to 10,000
//   blocks, but only for roughly the newest 10,000 blocks (~5.5 h); older ranges and old
//   receipts answer 403 "Archive requests require a personal token".
// - base.gateway.tenderly.co serves the archive, 1,000 blocks per eth_getLogs.
// So the newest blocks go to publicnode in one call (tenderly as its fallback), older blocks
// to tenderly in 1,000-block chunks under a per-check budget; callers keep a cursor.

export const PUBLICNODE_URL = "https://base-rpc.publicnode.com";
export const TENDERLY_URL = "https://base.gateway.tenderly.co";
export const BASE_RPC_URLS = [PUBLICNODE_URL, TENDERLY_URL];
/** Blocks back from the head that publicnode still serves logs for, with margin. */
export const RECENT_WINDOW = 9000;
export const ARCHIVE_SPAN = 1000;
/** At most this many archive calls per scan; the cursor carries on from where a scan stops. */
export const MAX_ARCHIVE_CALLS = 8;
const ARCHIVE_PARALLEL = 4;

export class BaseRpcError extends Error {}

export interface BaseRpcOptions {
  /** Endpoints for head reads and recent logs, tried in order. */
  urls?: string[];
  /** Endpoint for archive logs and receipts. */
  archiveUrl?: string;
  fetch?: typeof fetch;
  /** Per-endpoint timeout. */
  timeoutMs?: number;
  /** Epoch ms after which no further call is started. */
  deadline?: number;
}

interface JsonRpcReply {
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function callOne(url: string, method: string, params: unknown[], o: BaseRpcOptions): Promise<unknown> {
  const host = new URL(url).hostname;
  const remaining = (o.deadline ?? Infinity) - Date.now();
  if (remaining < 200) throw new BaseRpcError("Base RPC: time budget spent");
  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(Math.min(o.timeoutMs ?? 3000, remaining)),
      cache: "no-store",
    });
  } catch (e) {
    throw new BaseRpcError(`Base RPC: ${host} ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable"}`);
  }
  let reply: JsonRpcReply;
  try {
    reply = (await res.json()) as JsonRpcReply;
  } catch {
    throw new BaseRpcError(`Base RPC: ${host} answered HTTP ${res.status} without JSON`);
  }
  if (reply.error || !res.ok || !("result" in reply)) {
    throw new BaseRpcError(`Base RPC: ${host} ${method} failed (${reply.error?.code ?? res.status}: ${String(reply.error?.message ?? "").slice(0, 80)})`);
  }
  return reply.result;
}

/** Tries each endpoint in order; throws BaseRpcError when none answers. */
export async function baseRpc(method: string, params: unknown[], o: BaseRpcOptions = {}, urls = o.urls ?? BASE_RPC_URLS): Promise<unknown> {
  let last: unknown = new BaseRpcError("Base RPC: no endpoint");
  for (const url of urls) {
    try {
      return await callOne(url, method, params, o);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const hex = (n: number) => `0x${n.toString(16)}`;

function quantity(v: unknown, what: string): number {
  if (typeof v !== "string" || !/^0x[0-9a-f]{1,14}$/i.test(v)) throw new BaseRpcError(`Base RPC: bad ${what}`);
  return Number.parseInt(v, 16);
}

export interface BlockHead {
  number: number;
  /** Unix seconds. */
  timestamp: number;
}

export async function getBlock(tag: "latest" | number, o: BaseRpcOptions = {}): Promise<BlockHead> {
  const urls = tag === "latest" ? o.urls ?? BASE_RPC_URLS : [o.archiveUrl ?? TENDERLY_URL, ...(o.urls ?? BASE_RPC_URLS)];
  const block = (await baseRpc("eth_getBlockByNumber", [tag === "latest" ? "latest" : hex(tag), false], o, urls)) as
    { number?: unknown; timestamp?: unknown } | null;
  if (!block) throw new BaseRpcError("Base RPC: block not found");
  return { number: quantity(block.number, "block number"), timestamp: quantity(block.timestamp, "block timestamp") };
}

export interface TransferLog {
  blockNumber: number;
  /** Unix seconds; null when the endpoint left it out. */
  blockTimestamp: number | null;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
}

const TOPIC_ADDRESS = /^0x0{24}([0-9a-fA-F]{40})$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A USDC Transfer log, or null for anything else (another token, removed by a reorg, malformed). */
export function decodeTransferLog(raw: unknown): TransferLog | null {
  const l = raw as {
    address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; blockTimestamp?: unknown;
    transactionHash?: unknown; logIndex?: unknown; removed?: unknown;
  } | null;
  if (!l || typeof l.address !== "string" || l.address.toLowerCase() !== BASE_USDC.toLowerCase()) return null;
  if (l.removed === true || !Array.isArray(l.topics) || l.topics.length !== 3 || l.topics[0] !== TRANSFER_TOPIC) return null;
  const from = TOPIC_ADDRESS.exec(String(l.topics[1]));
  const to = TOPIC_ADDRESS.exec(String(l.topics[2]));
  if (!from || !to || typeof l.data !== "string" || !WORD.test(l.data)) return null;
  if (typeof l.transactionHash !== "string" || !TX_HASH.test(l.transactionHash)) return null;
  try {
    return {
      blockNumber: quantity(l.blockNumber, "log block"),
      blockTimestamp: typeof l.blockTimestamp === "string" ? quantity(l.blockTimestamp, "log timestamp") : null,
      txHash: l.transactionHash.toLowerCase(),
      logIndex: quantity(l.logIndex, "log index"),
      from: toChecksumAddress(`0x${from[1]}`),
      to: toChecksumAddress(`0x${to[1]}`),
      value: BigInt(l.data),
    };
  } catch {
    return null;
  }
}

function topicFor(address: string): string {
  if (!isHexAddress(address)) throw new BaseRpcError("not a 0x address");
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

async function logsIn(url: string, to: string, fromBlock: number, toBlock: number, o: BaseRpcOptions): Promise<TransferLog[]> {
  const raw = await callOne(url, "eth_getLogs", [{
    address: BASE_USDC, topics: [TRANSFER_TOPIC, null, topicFor(to)], fromBlock: hex(fromBlock), toBlock: hex(toBlock),
  }], o);
  if (!Array.isArray(raw)) throw new BaseRpcError("Base RPC: eth_getLogs returned no list");
  return raw.map(decodeTransferLog).filter((l): l is TransferLog => l !== null);
}

export interface LogScan {
  logs: TransferLog[];
  /** Every block in [fromBlock, scannedTo] was read; fromBlock - 1 when nothing could be read. */
  scannedTo: number;
}

/**
 * USDC transfers to `to` in [fromBlock, toBlock] (toBlock near the head). Archive ranges are read
 * oldest first in 1,000-block chunks, at most MAX_ARCHIVE_CALLS per scan, so a scan may stop early:
 * `scannedTo` says how far it got. Throws BaseRpcError only when nothing at all could be read.
 */
export async function scanTransfersTo(to: string, fromBlock: number, toBlock: number, o: BaseRpcOptions = {}): Promise<LogScan> {
  if (toBlock < fromBlock) return { logs: [], scannedTo: toBlock };
  const recentFrom = Math.max(fromBlock, toBlock - RECENT_WINDOW);
  const archive = o.archiveUrl ?? TENDERLY_URL;
  const logs: TransferLog[] = [];

  // Archive part, oldest first, contiguous.
  if (fromBlock < recentFrom) {
    const chunks: Array<[number, number]> = [];
    for (let start = fromBlock; start < recentFrom && chunks.length < MAX_ARCHIVE_CALLS; start += ARCHIVE_SPAN) {
      chunks.push([start, Math.min(start + ARCHIVE_SPAN - 1, recentFrom - 1)]);
    }
    const results: Array<TransferLog[] | null> = new Array(chunks.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const i = next++;
        try {
          results[i] = await logsIn(archive, to, chunks[i][0], chunks[i][1], o);
        } catch {
          results[i] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ARCHIVE_PARALLEL, chunks.length) }, worker));
    let scannedTo = fromBlock - 1;
    for (let i = 0; i < chunks.length; i++) {
      const got = results[i];
      if (!got) break;
      logs.push(...got);
      scannedTo = chunks[i][1];
    }
    if (scannedTo < recentFrom - 1) {
      if (scannedTo < fromBlock) throw new BaseRpcError("Base RPC: archive logs unavailable");
      return { logs, scannedTo };
    }
  }

  // Recent part: one publicnode call, else tenderly in chunks.
  try {
    logs.push(...(await logsIn((o.urls ?? BASE_RPC_URLS)[0], to, recentFrom, toBlock, o)));
    return { logs, scannedTo: toBlock };
  } catch {
    let scannedTo = recentFrom - 1;
    for (let start = recentFrom; start <= toBlock; start += ARCHIVE_SPAN) {
      const end = Math.min(start + ARCHIVE_SPAN - 1, toBlock);
      try {
        logs.push(...(await logsIn(archive, to, start, end, o)));
      } catch {
        break;
      }
      scannedTo = end;
    }
    if (scannedTo < fromBlock) throw new BaseRpcError("Base RPC: logs unavailable");
    return { logs, scannedTo };
  }
}

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: number;
  logs: TransferLog[];
}

/** The transaction's receipt, or null if no endpoint knows it yet. */
export async function getReceipt(txHash: string, o: BaseRpcOptions = {}): Promise<Receipt | null> {
  const urls = [...(o.urls ?? BASE_RPC_URLS)];
  const archive = o.archiveUrl ?? TENDERLY_URL;
  if (!urls.includes(archive)) urls.push(archive);
  let found: unknown = null;
  let answered = false;
  for (const url of urls) {
    try {
      found = await callOne(url, "eth_getTransactionReceipt", [txHash], o);
      answered = true;
      if (found) break;
    } catch {
      // publicnode answers 403 for receipts it doesn't hold; try the next endpoint.
    }
  }
  if (!found) {
    if (answered) return null;
    throw new BaseRpcError("Base RPC: receipt unavailable");
  }
  const r = found as { status?: unknown; blockNumber?: unknown; logs?: unknown; transactionHash?: unknown };
  if (typeof r.transactionHash === "string" && r.transactionHash.toLowerCase() !== txHash.toLowerCase()) {
    throw new BaseRpcError("Base RPC: receipt for a different transaction");
  }
  const blockNumber = quantity(r.blockNumber, "receipt block");
  const logs = (Array.isArray(r.logs) ? r.logs : [])
    .map((l) => decodeTransferLog({ ...(l as object), blockNumber: (l as { blockNumber?: unknown }).blockNumber ?? r.blockNumber }))
    .filter((l): l is TransferLog => l !== null);
  return { status: r.status === "0x1" ? "success" : "reverted", blockNumber, logs };
}
