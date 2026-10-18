// F7 chip-in pots: the checks every tool runs on a pot as Owed's server returned it, and how a pot is shown.
// A pot id commits to who it pays and in what token (request-id.ts potIdFor over the server's nonce), so a server
// that swapped the wallet behind a shared pot link would change the id. Requester text (title, note, name) is
// untrusted: cleaned, quoted, labelled unverified, brand-flagged.

import type { PotRes } from "./contract.js";
import type { Deps } from "./deps.js";
import type { Token } from "./money.js";
import { potIdMatchesTerms } from "./request-id.js";
import { quote, shortAddress } from "./text.js";

export const POT_TITLE_MAX = 80;
export const REFUSE_POT_TAMPERED = "This pot's id doesn't match the wallet and token it pays: the recipient may have been changed after the pot was shared. Nothing was sent; ask the person collecting for the pot link again.";
export const REFUSE_POT_ANSWER = "Owed's server answered with a different pot than the one asked for. Nothing was sent.";

/** The pot's id hashes its recipient, token and nonce, and it is the pot asked for. A refusal sentence, or null. */
export function potTermsProblem(pot: PotRes, id: string): string | null {
  if (pot.id !== id) return REFUSE_POT_ANSWER;
  if (!potIdMatchesTerms(id, { recipient: pot.recipient, token: pot.token, nonce: pot.nonce })) return REFUSE_POT_TAMPERED;
  return null;
}

/** Ended by the server's word or past its deadline by this plugin's own clock. */
export function potEnded(pot: Pick<PotRes, "status" | "deadline">, now: number): boolean {
  return pot.status === "ended" || Date.parse(pot.deadline) <= now;
}

export function potEndedText(pot: Pick<PotRes, "deadline">): string {
  return `This pot ended at ${pot.deadline} and no longer takes contributions. Nothing was sent.`;
}

/** The amounts a pot that takes only fixed amounts accepts: the suggested one, then the presets, each once (atomic). */
export function potFixedAmounts(pot: Pick<PotRes, "suggested" | "presets" | "token">, deps: Pick<Deps, "toAtomic">): bigint[] {
  const out: bigint[] = [];
  for (const a of [...(pot.suggested === null ? [] : [pot.suggested]), ...pot.presets]) {
    const atomic = deps.toAtomic(a, pot.token);
    if (!out.includes(atomic)) out.push(atomic);
  }
  return out;
}

/** "42.5 of 100 USDC raised from 3 contributions" */
export function potProgress(pot: Pick<PotRes, "totals" | "target" | "token">): string {
  const count = `${pot.totals.count} ${pot.totals.count === 1 ? "contribution" : "contributions"}`;
  return pot.target === null ? `${pot.totals.raised} ${pot.token} raised from ${count}` : `${pot.totals.raised} of ${pot.target} ${pot.token} raised from ${count}`;
}

/** `pot "Team dinner" (the requester's words, unverified)` */
export function potLabel(title: string | null | undefined): string {
  const t = quote(title, POT_TITLE_MAX);
  return t ? `the pot ${t} (the requester's words, unverified)` : "the pot";
}

/** One line per recent contribution, newest first. */
export function contributionLines(pot: Pick<PotRes, "contributions" | "token">, max = 5): string[] {
  return pot.contributions.slice(0, max).map((c) => `  ${c.amount} ${pot.token} from ${shortAddress(c.payer)} at ${c.at}${c.rail !== "solana_pay" ? ` (${c.rail})` : ""}: https://solscan.io/tx/${c.signature}`);
}

export type PotToken = Token;
