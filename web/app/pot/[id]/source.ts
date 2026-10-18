import "server-only";
import { cache } from "react";
import type { PotResponse } from "@/lib/contract";
import { isPotId } from "@/lib/ids";
import { loadPotBoard, toPublicPot } from "@/lib/pots";

/** Chain check budget for a page render: a slow RPC never holds the page; the board's polling takes over. */
const PAGE_CHAIN_BUDGET_MS = 1200;

/** One read per pot per render, shared by the page, its metadata and its preview card. Never mints anything. */
export const loadPagePot = cache(async (id: string, origin: string): Promise<PotResponse | null> => {
  if (!isPotId(id)) return null;
  const board = await loadPotBoard(id, { budgetMs: PAGE_CHAIN_BUDGET_MS });
  return board ? toPublicPot(board.pot, origin, board) : null;
});
