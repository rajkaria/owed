// View model for the split-bill board (/g/[id]). Pure: the page renders it on the
// server, the board updates it in the browser from POST /api/v1/status, tests call it.

import type { PublicGroup } from "@/lib/groups";
import { formatAmount, fromAtomic, isToken, toAtomic, TOKEN_DECIMALS, type Token } from "@/lib/view/money";
import { brandWordsFromFlags, detectBrandWords, stateFromStatus } from "@/lib/view/request-view";
import { cleanText, LIMITS } from "@/lib/view/text";

export const TITLE_LIMIT = 60;

export type ShareStatus = "open" | "paid" | "underpaid" | "cancelled" | "expired"; // W3-C: + expired

export interface BoardShare {
  id: string;
  /** The requester-written name (quoted on screen), or "Person N" when there is none. */
  label: string;
  quoted: boolean;
  amount: string;
  status: ShareStatus;
  paidAmount: string | null;
  payer: string | null;
  signature: string | null;
  at: string | null;
  payLink: string;
}

export interface BoardModel {
  id: string;
  link: string;
  /** Requester-written, cleaned; render quoted. */
  title: string | null;
  /** Requester's name, or null when there is none or the split is brand-flagged. */
  requester: string | null;
  brandWords: string[];
  token: Token;
  total: string;
  recipient: string;
  fromDomain: string | null;
  fromDomainVerifiedAt: string | null;
  shares: BoardShare[];
  /** W3-C: when the shares stop taking payments (ISO), or null. */
  expiresAt: string | null;
}

const STATUSES: readonly ShareStatus[] = ["open", "paid", "underpaid", "cancelled", "expired"];

export function boardFromGroup(g: PublicGroup, origin: string): BoardModel {
  const token: Token = isToken(g.token) ? g.token : "USDC";
  const names = g.shares.map((s) => cleanText(s.name, LIMITS.name));
  const brandWords = Array.from(
    // W2-E: a brand word the server-verified from_domain owns isn't a caution.
    new Set([
      ...brandWordsFromFlags(g.flags, g.from_domain_verified_at ? g.from_domain : null),
      ...detectBrandWords([g.title, g.requester_name, ...g.shares.map((s) => s.name)], g.from_domain_verified_at ? g.from_domain : null),
    ]),
  );
  return {
    id: g.id,
    link: `${origin}/g/${encodeURIComponent(g.id)}`,
    title: cleanText(g.title, TITLE_LIMIT),
    requester: brandWords.length > 0 ? null : cleanText(g.requester_name, LIMITS.name),
    brandWords,
    token,
    total: g.total,
    recipient: g.recipient,
    fromDomain: g.from_domain,
    fromDomainVerifiedAt: g.from_domain_verified_at,
    shares: g.shares.map((s, i) => ({
      id: s.id,
      label: names[i] ?? `Person ${i + 1}`,
      quoted: names[i] !== null,
      amount: s.amount,
      status: STATUSES.includes(s.status) ? s.status : "open",
      paidAmount: s.paid?.amount ?? null,
      payer: s.paid?.payer ?? null,
      signature: s.paid?.signature ?? null,
      at: s.paid?.at ?? null,
      payLink: `${origin}/r/${encodeURIComponent(s.id)}`,
    })),
    expiresAt: g.expires_at ?? null, // W3-C
  };
}

/** Shares whose status can still change; the board polls only these. */
export function unsettledIds(model: BoardModel): string[] {
  return model.shares.filter((s) => s.status === "open" || s.status === "underpaid").map((s) => s.id);
}

/**
 * Apply one POST /api/v1/status response. Results that don't parse, or that would move a
 * settled share backwards, are ignored, so a flaky response never un-pays anyone on screen.
 */
export function applyStatus(model: BoardModel, json: unknown): BoardModel {
  const results = json && typeof json === "object" ? (json as { results?: unknown }).results : null;
  if (!Array.isArray(results)) return model;
  const byId = new Map<string, unknown>();
  for (const r of results) if (r && typeof r === "object" && typeof (r as { id?: unknown }).id === "string") byId.set((r as { id: string }).id, r);
  let changed = false;
  const shares = model.shares.map((share): BoardShare => {
    if (share.status === "paid" || share.status === "cancelled" || share.status === "expired" || !byId.has(share.id)) return share;
    const next = stateFromStatus(byId.get(share.id), share.amount, model.token);
    if (!next || next.status === "open") return share;
    changed = true;
    if (next.status === "paid") {
      return { ...share, status: "paid", paidAmount: next.amount, payer: next.payer, signature: next.signature, at: next.at };
    }
    if (next.status === "underpaid") {
      return { ...share, status: "underpaid", paidAmount: next.amountPaid, payer: next.payer, signature: next.signature, at: next.at };
    }
    return { ...share, status: next.status }; // W3-C: cancelled or expired
  });
  return changed ? { ...model, shares } : model;
}

export interface Progress {
  paid: number;
  count: number;
  /** What has arrived across all shares, as a decimal string. */
  received: string;
  /** Every share is paid, cancelled or expired. */
  done: boolean;
  /** One segment per share, sized by its amount (basis points of the total). */
  segments: Array<{ id: string; status: ShareStatus; basisPoints: number }>;
}

export function progress(model: BoardModel): Progress {
  const decimals = TOKEN_DECIMALS[model.token];
  const total = toAtomic(model.total, decimals) ?? BigInt(0);
  let received = BigInt(0);
  for (const s of model.shares) {
    if ((s.status === "paid" || s.status === "underpaid") && s.paidAmount) received += toAtomic(s.paidAmount, decimals) ?? BigInt(0);
  }
  return {
    paid: model.shares.filter((s) => s.status === "paid").length,
    count: model.shares.length,
    received: fromAtomic(received, decimals),
    done: model.shares.every((s) => s.status === "paid" || s.status === "cancelled" || s.status === "expired"),
    segments: model.shares.map((s) => {
      const amount = toAtomic(s.amount, decimals) ?? BigInt(0);
      return { id: s.id, status: s.status, basisPoints: total > BigInt(0) ? Number((amount * BigInt(10000)) / total) : 0 };
    }),
  };
}

/** "2 of 3 paid" */
export function paidLine(p: Pick<Progress, "paid" | "count">): string {
  return `${p.paid} of ${p.count} paid`;
}

/** "1 of 1.5 USDC received" */
export function receivedLine(model: BoardModel, p: Pick<Progress, "received">): string {
  return `${p.received} of ${formatAmount(model.total, model.token)} received`;
}

/** Page title: never echoes requester text, so a flagged split can't title its own preview. */
export function boardTitle(model: BoardModel, p: Progress): string {
  return `Split bill: ${paidLine(p)}`;
}

export function boardDescription(model: BoardModel, p: Progress): string {
  const how = "Pay your share with any Solana wallet, or with your AI agent in PayBox.";
  const what = model.title && model.brandWords.length === 0 ? ` for “${model.title}”` : "";
  return `${receivedLine(model, p)}${what}. ${how}`;
}
