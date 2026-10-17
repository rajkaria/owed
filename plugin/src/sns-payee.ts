import * as z from "zod/v4";
import { within, type Deps } from "./deps.js";
import { domainBrandFlags } from "./payee.js";
import { looksLikeSnsName, pointsTo, resolveSnsName, sourceText, type SnsResult } from "./sns.js";
import { brandFlags, shortAddress } from "./text.js";

// W3-S: what the tools say and do with an SNS name (resolution itself is src/sns.ts).
// ask_for_money resolves a name given as the recipient and sends it to the API as sns_name; the server
// re-resolves it before storing it. pay_link re-resolves a request's sns_name before proposing and refuses if
// it now points elsewhere; it also pays a bare name ("pay bonfida.sns 2 USDC"). verify_payee reports it.

/** One getMultipleAccounts call: 3 s per RPC host in chain.ts, cut to this so a slow host can't eat the 10 s. */
export const SNS_BUDGET_MS = 2500;

export const snsNameSchema = z.string().min(1).max(140).refine(looksLikeSnsName, "an SNS name ending in .sns");

const timedOut = (name: string): SnsResult => ({
  ok: false, name: null, code: "unavailable",
  message: `Solana didn't answer in time to resolve ${name.trim().slice(0, 140).replace(/[^\x20-\x7e]/g, "?")}. Try again in a moment.`,
});

/** Resolves over the plugin's RPC hosts within `budgetMs`. Never throws. */
export async function resolveName(name: string, deps: Pick<Deps, "rpc">, budgetMs: number = SNS_BUDGET_MS): Promise<SnsResult> {
  let rpc;
  try {
    rpc = deps.rpc();
  } catch {
    return timedOut(name);
  }
  return within(resolveSnsName(name, (method, params) => rpc.call(method, params)), budgetMs, () => timedOut(name));
}

/** "bonfida.sns (verified on-chain: bonfida.sns points to Fw1E…Lb1v)": leads "Pay 5 USDC to …". */
export function snsLead(r: Extract<SnsResult, { ok: true }>): string {
  return `${r.name} (verified on-chain: ${r.name} points to ${shortAddress(r.wallet)})`;
}

/** The lines under a verified name: what was checked, what it proves, then the name's own warnings. */
export function snsLines(r: Extract<SnsResult, { ok: true }>): string[] {
  return [
    `Verified on-chain: ${pointsTo(r.name, r.wallet, r.source)}, read from Solana just now. That proves who controls the name, not what the request is for.`,
    ...r.warnings,
  ];
}

/** Brand words in a name ("phantom.sns", "ph4ntom.sns"), as caution flags for cautionLine. */
export function snsBrandFlags(name: string | null | undefined): string[] {
  if (!name) return [];
  return [...new Set([...brandFlags(name), ...domainBrandFlags(name.replace(/_/g, "-").replace(/\.sns$/, ".example"))])];
}

export type SnsPayee =
  | { ok: true; lead: string | null; lines: string[] }
  | { ok: false; refuse: string };

/**
 * For pay_link on an Owed request that names an SNS name: paid only if the name still points to the recipient
 * (the wallet in the id-checked terms). If Solana can't be read, refused unless the user accepted paying
 * without the check (allow_unverified), and then the name is never shown as verified.
 */
export async function snsForPayment(
  name: string | null | undefined, recipient: string, allowUnverified: boolean, deps: Pick<Deps, "rpc">, budgetMs: number = SNS_BUDGET_MS,
): Promise<SnsPayee> {
  if (!name) return { ok: true, lead: null, lines: [] };
  const r = await resolveName(name, deps, budgetMs);
  if (r.ok && r.wallet === recipient) return { ok: true, lead: snsLead(r), lines: snsLines(r) };
  const shown = r.name ?? `"${name.slice(0, 60).replace(/[^\x20-\x7e]/g, "?")}"`;
  if (r.ok) {
    return { ok: false, refuse: `${r.name} now points to a different wallet than when this request was made (it points to ${shortAddress(r.wallet)} through ${sourceText(r.source)}; the request pays ${shortAddress(recipient)}). Nothing was sent. Ask the requester for a new link.` };
  }
  if (r.code === "unavailable") {
    if (allowUnverified) return { ok: true, lead: null, lines: [`Name not verified: the request was made for ${shown}, but Solana couldn't be read to check it; paying anyway because allow_unverified is set.`] };
    return { ok: false, refuse: `This request was made for ${shown}, but Solana couldn't be read to check that the name still points to this wallet. Nothing was sent. Try again shortly, or pass allow_unverified: true only if the user accepts paying without the check.` };
  }
  return { ok: false, refuse: `This request was made for ${shown}, which no longer names this wallet: ${r.message} Nothing was sent.` };
}
