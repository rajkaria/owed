import "server-only";
import { cache } from "react";
import type { GroupLedgerResponse } from "@/lib/contract";
import { isLedgerId, loadLedger, toPublicLedger } from "@/lib/ledgers";

/** Chain check budget for a page render: a slow RPC never holds the page; the page's polling takes over. */
const PAGE_CHAIN_BUDGET_MS = 1200;

/** One read per ledger per render, shared by the page and its metadata. */
export const loadPageLedger = cache(async (id: string, origin: string): Promise<GroupLedgerResponse | null> => {
  if (!isLedgerId(id)) return null;
  const loaded = await loadLedger(id, { deadline: Date.now() + PAGE_CHAIN_BUDGET_MS, timeoutMs: PAGE_CHAIN_BUDGET_MS });
  return loaded ? toPublicLedger(loaded, origin) : null;
});
