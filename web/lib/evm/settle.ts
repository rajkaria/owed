import "server-only";
import { isUniqueViolation, sql, type Row } from "../db";
import type { RequestRow } from "../requests";
import { store as x402Store, type Receipt, type Store } from "../x402/store";
import { sameEvmAddress } from "./address";
import { BASE_BLOCK_SECONDS } from "./base";
import { assignTransfers, estimateBlockTime, estimateStartBlock, type OpenBaseRequest, type TimedTransfer } from "./match";
import { getBlock, scanTransfersTo, type BaseRpcOptions, type BlockHead, type LogScan } from "./rpc";

// Settling Base requests (sprint W3-B) from Base USDC Transfer logs to the recipient. Every open
// Base request to the same recipient is matched together (lib/evm/match.ts: exact amount, after
// creation, oldest request first, one transaction per request), so the result doesn't depend on
// which request's page happened to ask. Each request keeps chain_cursor, the last block scanned
// for it, so a check reads only blocks it hasn't seen (minus a few, in case an endpoint lagged).
// A transfer that is an x402 settlement already on record is marked paid over x402.

export interface BaseSettleDeps {
  head(o: BaseRpcOptions): Promise<BlockHead>;
  /** Timestamp of an arbitrary block (archive), to check where a request's scan starts. */
  blockTime(n: number, o: BaseRpcOptions): Promise<number>;
  scan(recipient: string, fromBlock: number, toBlock: number, o: BaseRpcOptions): Promise<LogScan>;
  store: Store;
}

const defaults: BaseSettleDeps = {
  head: (o) => getBlock("latest", o),
  blockTime: async (n, o) => (await getBlock(n, o)).timestamp,
  scan: scanTransfersTo,
  store: x402Store,
};

const RECHECK_MS = 3000;
/** Blocks below the head re-read on the next check, in case a load-balanced endpoint hadn't indexed them yet. */
export const RESCAN_BLOCKS = 10;
/** Open Base requests per recipient matched in one pass. */
const MAX_OPEN_PER_RECIPIENT = 50;
const lastScanned = new Map<string, number>();

interface OpenRow extends OpenBaseRequest {
  cursor: number | null;
}

async function openRequestsTo(recipient: string): Promise<OpenRow[]> {
  const rows = await sql(
    `select id, recipient, amount_atomic::text as amount_atomic, extract(epoch from created_at)::bigint::text as created_unix,
            chain_cursor::text as chain_cursor
       from requests
      where chain = 'base' and status = 'open' and recipient = $1
      order by created_at asc, id asc
      limit ${MAX_OPEN_PER_RECIPIENT}`,
    [recipient],
  );
  return rows.map((r: Row) => ({
    id: r.id!,
    recipient: r.recipient!,
    amountAtomic: BigInt(r.amount_atomic!),
    createdUnix: Number(r.created_unix),
    cursor: r.chain_cursor == null ? null : Number(r.chain_cursor),
  }));
}

async function usedTransactions(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await sql(`select paid_signature from requests where paid_signature = any($1::text[])`, [hashes]);
  return new Set(rows.map((r) => r.paid_signature!.toLowerCase()));
}

async function recordTransfer(requestId: string, t: TimedTransfer): Promise<boolean> {
  try {
    const rows = await sql(
      `update requests
          set status = 'paid', paid_signature = $2, paid_payer = $3, paid_amount_atomic = $4,
              paid_at = to_timestamp($5::bigint), paid_rail = 'base_transfer', chain_cursor = $6
        where id = $1 and chain = 'base' and status = 'open'
        returning id`,
      [requestId, t.txHash, t.from, t.value, t.at, t.blockNumber],
    );
    return rows.length > 0;
  } catch (e) {
    if (isUniqueViolation(e, "requests_paid_signature_key")) {
      console.warn(`request ${requestId}: Base transaction ${t.txHash} already settles another request`);
      return false;
    }
    throw e;
  }
}

/** An x402 attempt on record for this request that this transfer completes, if any. */
function x402ReceiptFor(receipts: readonly Receipt[], requestId: string, t: TimedTransfer): Receipt | undefined {
  return receipts.find((r) => r.requestId === requestId && (
    (r.signature !== null && r.signature.toLowerCase() === t.txHash)
    || (r.signature === null && r.state === "unknown" && r.payer !== null && sameEvmAddress(r.payer, t.from))
  ));
}

async function settleRecipient(
  recipient: string, head: BlockHead, o: BaseRpcOptions, deps: BaseSettleDeps, paid: Set<string>,
): Promise<void> {
  const open = await openRequestsTo(recipient);
  if (open.length === 0) return;

  const toBlock = head.number;
  let fromBlock = toBlock + 1;
  for (const r of open) {
    let start = r.cursor !== null ? r.cursor + 1 : estimateStartBlock(r.createdUnix, head, BASE_BLOCK_SECONDS);
    if (r.cursor === null && start < toBlock) {
      // Don't trust the 2-second block assumption blindly: the start block must predate the request.
      try {
        const t = await deps.blockTime(start, o);
        if (t > r.createdUnix - 60) start = Math.max(0, start - (t - r.createdUnix + 60));
      } catch {
        // Archive header unavailable: the estimate already starts a minute early.
      }
    }
    fromBlock = Math.min(fromBlock, start);
  }

  const scan = await deps.scan(recipient, fromBlock, toBlock, o);
  const transfers: TimedTransfer[] = scan.logs
    .filter((l) => l.blockNumber <= scan.scannedTo && sameEvmAddress(l.to, recipient))
    .map((l) => ({ ...l, at: l.blockTimestamp ?? estimateBlockTime(l.blockNumber, head, BASE_BLOCK_SECONDS) }));
  const amounts = new Set(open.map((r) => r.amountAtomic));
  const candidates = transfers.filter((t) => amounts.has(t.value));

  if (candidates.length > 0) {
    const used = await usedTransactions([...new Set(candidates.map((t) => t.txHash))]);
    let receipts: Receipt[] = [];
    try {
      receipts = await deps.store.pending(open.map((r) => r.id));
    } catch (e) {
      console.warn(`Base x402 receipts unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const a of assignTransfers(open, candidates, used)) {
      const t = a.transfer;
      const receipt = x402ReceiptFor(receipts, a.requestId, t);
      let done: boolean;
      if (receipt) {
        if (receipt.signature === null) await deps.store.settled(receipt.id, t.txHash, t.from);
        done = await deps.store.verified(
          { id: receipt.id, requestId: a.requestId },
          { signature: t.txHash, payer: t.from, amountAtomic: t.value, at: new Date(t.at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), slot: t.blockNumber },
        );
      } else {
        done = await recordTransfer(a.requestId, t);
      }
      if (done) paid.add(a.requestId);
    }
  }

  // Everything still open has been checked up to scannedTo; re-read the last few blocks next time.
  const cursor = Math.max(0, scan.scannedTo - RESCAN_BLOCKS);
  const stillOpen = open.filter((r) => !paid.has(r.id)).map((r) => r.id);
  if (stillOpen.length > 0 && scan.scannedTo >= fromBlock) {
    await sql(
      `update requests set chain_cursor = greatest(coalesce(chain_cursor, 0), $2::bigint)
        where id = any($1::text[]) and chain = 'base' and status = 'open'`,
      [stillOpen, cursor],
    );
  }
}

/**
 * Check open Base requests against Base (at most once per 3 s per recipient per server instance)
 * and persist any payment found. Returns the ids now paid. Throws BaseRpcError only when Base
 * can't be read at all.
 */
export async function settleBaseRequests(
  rows: readonly RequestRow[], o: BaseRpcOptions = {}, deps: BaseSettleDeps = defaults,
): Promise<Set<string>> {
  const paid = new Set<string>();
  const now = Date.now();
  const recipients = [...new Set(rows.filter((r) => r.chain === "base" && r.status === "open").map((r) => r.recipient))]
    .filter((rc) => now - (lastScanned.get(rc) ?? 0) >= RECHECK_MS);
  if (recipients.length === 0) return paid;
  const head = await deps.head(o);
  if (lastScanned.size > 10_000) lastScanned.clear();
  const failures: unknown[] = [];
  await Promise.all(recipients.map(async (rc) => {
    try {
      await settleRecipient(rc, head, o, deps, paid);
      lastScanned.set(rc, now);
    } catch (e) {
      failures.push(e);
    }
  }));
  if (failures.length === recipients.length && paid.size === 0) throw failures[0];
  for (const e of failures) console.warn(`Base settle: ${e instanceof Error ? e.message : String(e)}`);
  return paid;
}

/** Tests only. */
export function resetBaseThrottle(): void {
  lastScanned.clear();
}
