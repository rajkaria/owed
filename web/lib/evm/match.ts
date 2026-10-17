import type { TransferLog } from "./rpc";

// Which USDC transfer pays which Base request. Base transfers carry no Solana Pay reference, so a
// request is matched on what the chain does show: the recipient, the exact amount, and a block
// time at or after the request was created. Rules:
// - exact amount: more or less than asked is not this request's payment;
// - one transfer settles at most one request, and a transaction that already settles a request
//   (any rail) never settles another;
// - two open requests with the same recipient and amount can't be told apart on chain, so the
//   oldest request takes the earliest transfer, whichever of them a status check happens to read.

export interface OpenBaseRequest {
  id: string;
  recipient: string;
  amountAtomic: bigint;
  /** created_at, Unix seconds. */
  createdUnix: number;
}

export interface TimedTransfer extends TransferLog {
  /** Block time, Unix seconds (estimated from the block number when the endpoint omitted it). */
  at: number;
}

export interface Assignment {
  requestId: string;
  transfer: TimedTransfer;
}

/** A block may be stamped up to a block before a transaction in it was sent; allow that much and no more. */
export const CREATION_SLACK_SECONDS = 5;

export function assignTransfers(
  requests: readonly OpenBaseRequest[],
  transfers: readonly TimedTransfer[],
  usedTxHashes: ReadonlySet<string>,
): Assignment[] {
  const used = new Set([...usedTxHashes].map((h) => h.toLowerCase()));
  const queue = [...transfers].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const oldestFirst = [...requests].sort((a, b) => a.createdUnix - b.createdUnix || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: Assignment[] = [];
  for (const r of oldestFirst) {
    const hit = queue.find((t) =>
      !used.has(t.txHash.toLowerCase())
      && t.to.toLowerCase() === r.recipient.toLowerCase()
      && t.value === r.amountAtomic
      && t.at >= r.createdUnix - CREATION_SLACK_SECONDS,
    );
    if (!hit) continue;
    used.add(hit.txHash.toLowerCase());
    out.push({ requestId: r.id, transfer: hit });
  }
  return out;
}

/** Block time from the head's, for endpoints that leave blockTimestamp out (2-second blocks). */
export function estimateBlockTime(blockNumber: number, head: { number: number; timestamp: number }, blockSeconds = 2): number {
  return head.timestamp - (head.number - blockNumber) * blockSeconds;
}

/** First block to scan for a request created at `createdUnix`, a minute early to absorb clock and estimate error. */
export function estimateStartBlock(createdUnix: number, head: { number: number; timestamp: number }, blockSeconds = 2): number {
  const back = Math.ceil((head.timestamp - createdUnix + 60) / blockSeconds);
  return Math.max(0, Math.min(head.number, head.number - back));
}
