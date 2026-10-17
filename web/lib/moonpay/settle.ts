import "server-only";
import type { RequestRow } from "../requests";
import { rpcBatch, type RpcOptions } from "../solana";
import type { ParsedTransaction } from "../validate";
import {
  assess,
  judgeTransaction,
  NOT_BEFORE_SLACK_SECONDS,
  POLL_FOR_SECONDS,
  SENT_GIVE_UP_SECONDS,
  shouldApply,
  type CardRequest,
} from "./attribution";
import { transactionsForRequest } from "./client";
import { moonpayConfig, type MoonpayConfig } from "./config";
import { store, type Purchase, type Store } from "./store";
import type { MoonpayTx } from "./transaction";

// Card purchases, end to end. Two ways in, one rule:
// - status checks (settleFromChain: POST /status, GET /requests/:id, the pay page) poll MoonPay's
//   by-external-id API for requests whose card checkout was opened in the last day, at most every 15 s;
// - MoonPay's signed webhook (app/api/hooks/moonpay) reports a purchase as it changes.
// Either way MoonPay's report is stored, and the Solana transaction it names is checked on chain
// (attribution.ts) before anything is marked paid.

export interface CardDeps {
  config: MoonpayConfig | null;
  store: Store;
  fetchTransactions: (requestId: string, config: MoonpayConfig, deadline?: number) => Promise<MoonpayTx[]>;
  getTransaction: (signature: string, rpc: RpcOptions) => Promise<ParsedTransaction | null>;
}

async function getTransaction(signature: string, rpc: RpcOptions): Promise<ParsedTransaction | null> {
  const [tx] = (await rpcBatch(
    // Mainnet carries v1 transactions; asking for at most v0 makes the node refuse them.
    [{ method: "getTransaction", params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }],
    rpc,
  )) as (ParsedTransaction | null)[];
  return tx ?? null;
}

export function defaultDeps(): CardDeps {
  return { config: moonpayConfig(), store, fetchTransactions: transactionsForRequest, getTransaction };
}

/** Store what MoonPay says about one purchase, if it is about this request and newer than what we have. */
export async function ingest(tx: MoonpayTx, req: CardRequest, deps: Pick<CardDeps, "store">): Promise<"ignored" | "unchanged" | "stored"> {
  const verdict = assess(tx, req);
  if (verdict.state === "ignore") {
    console.warn(`moonpay ${tx.id}: ignored (${verdict.reason})`);
    return "ignored";
  }
  const stored = await deps.store.get(tx.id);
  if (stored && stored.requestId !== req.id) return "ignored";
  if (!shouldApply(stored, verdict, tx.updatedAt)) return "unchanged";
  const error = verdict.state === "failed" ? verdict.reason : null;
  return (await deps.store.report(tx, req.id, verdict.state, error, stored?.state ?? null)) ? "stored" : "unchanged";
}

/** Check one sent purchase on chain. True if the request is now settled by card. */
export async function verifyPurchase(
  purchase: Purchase,
  row: Pick<RequestRow, "id" | "recipient" | "amountAtomic">,
  notBeforeUnix: number,
  rpc: RpcOptions,
  deps: Pick<CardDeps, "store" | "getTransaction">,
): Promise<boolean> {
  if (purchase.state !== "sent" || !purchase.signature) return false;
  const tx = await deps.getTransaction(purchase.signature, rpc);
  const verdict = judgeTransaction(tx, purchase.signature, { recipient: row.recipient, amountAtomic: row.amountAtomic, notBeforeUnix });
  if (verdict.state === "verified" || verdict.state === "underpaid") return deps.store.settle(purchase, verdict.state, verdict.credit);
  if (verdict.state === "mismatch") {
    console.warn(`moonpay ${purchase.moonpayId}: ${verdict.reason}`);
    await deps.store.fail(purchase.moonpayId, verdict.reason);
  } else if (purchase.ageSeconds > SENT_GIVE_UP_SECONDS) {
    await deps.store.fail(purchase.moonpayId, "the named transaction never appeared on chain");
  }
  return false;
}

/** Statuses a card delivery can still settle (W3-C: late money is still recorded, as for Solana Pay). */
function cardCheckable(row: RequestRow): boolean {
  return (row.status === "open" || row.status === "expired" || row.status === "cancelled") && row.token === "USDC" && (row.chain ?? "solana") === "solana";
}

/**
 * Returns the ids of requests marked paid (or underpaid) by card. Never throws: a status check must not
 * fail because of MoonPay. Off (no queries, no calls) unless MoonPay is configured.
 */
export async function settlePendingMoonpay(rows: readonly RequestRow[], rpc: RpcOptions = {}, deps: CardDeps = defaultDeps()): Promise<Set<string>> {
  const settled = new Set<string>();
  const config = deps.config;
  if (!config) return settled;
  const byId = new Map(rows.filter(cardCheckable).map((r) => [r.id, r]));
  if (byId.size === 0) return settled;
  try {
    const ids = [...byId.keys()];
    const [checkouts, waiting] = await Promise.all([deps.store.checkouts(ids), deps.store.open(ids)]);
    if (checkouts.length === 0 && waiting.length === 0) return settled; // no card checkout for these: nothing to ask
    const notBefore = new Map(checkouts.map((c) => [c.requestId, c.firstStartedUnix - NOT_BEFORE_SLACK_SECONDS]));

    // Ask MoonPay about each recent checkout whose poll slot is free.
    let polled = false;
    await Promise.all(checkouts.filter((c) => c.pollable).map(async (c) => {
      const row = byId.get(c.requestId)!;
      try {
        if (!(await deps.store.claimPoll(c.requestId))) return;
        polled = true;
        const txs = await deps.fetchTransactions(c.requestId, config, rpc.deadline);
        for (const tx of txs) await ingest(tx, row, deps);
      } catch (e) {
        console.warn(`moonpay poll ${c.requestId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));

    // Then check every named transaction on chain.
    const purchases = polled ? await deps.store.open(ids) : waiting;
    await Promise.all(purchases.map(async (p) => {
      const row = byId.get(p.requestId);
      if (!row) return;
      try {
        const since = notBefore.get(p.requestId) ?? Math.floor(Date.now() / 1000) - p.ageSeconds - POLL_FOR_SECONDS;
        if (await verifyPurchase(p, row, since, rpc, deps)) settled.add(row.id);
      } catch (e) {
        console.warn(`moonpay purchase ${p.moonpayId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  } catch (e) {
    console.warn(`moonpay check skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
  return settled;
}
