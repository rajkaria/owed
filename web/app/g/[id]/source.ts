import "server-only";
import { cache } from "react";
import { isGroupId, loadGroup, toPublicGroup, type PublicGroup } from "@/lib/groups";

/** Chain check budget for a page render: a slow RPC never holds the page; the board's polling takes over. */
const PAGE_CHAIN_BUDGET_MS = 1200;

/** One read per group per render, shared by the page, its metadata and its preview card. */
export const loadBoardGroup = cache(async (id: string, origin: string): Promise<PublicGroup | null> => {
  if (!isGroupId(id)) return null;
  const loaded = await loadGroup(id, { deadline: Date.now() + PAGE_CHAIN_BUDGET_MS, timeoutMs: PAGE_CHAIN_BUDGET_MS });
  return loaded ? toPublicGroup(loaded, origin) : null;
});
