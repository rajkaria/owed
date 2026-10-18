import { PublicKey } from "@solana/web3.js";
import * as z from "zod/v4";
import { addressSchema, type PayerInfo, type PayerReq } from "./contract.js";
import type { Deps } from "./deps.js";
import { looksLikeSnsName } from "./sns.js";
import { resolveName, SNS_BUDGET_MS } from "./sns-payee.js";
import { shortAddress } from "./text.js";

// F1: who a request is addressed to, as the asking tools take it. The payer is a Solana wallet, found one of three ways:
//   {handle, wallet}  an X handle the AGENT resolved with PayBox resolve_username (a plugin can't call PayBox tools and
//                     Owed can't resolve handles), so the wallet comes with it; the handle is a label, never proof;
//   {sns}             an .sns name, resolved here on Solana (the server resolves it again before storing it);
//   {wallet}          the payer's wallet itself.
// The payer's what_do_i_owe inbox lists the request once it is stored. The payer is never part of the request id.
// requester_handle is the user's own X handle: a label the payer's agent checks with resolve_username before paying.

export const HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

export const handleInput = z.string().min(1).max(16).regex(HANDLE_RE);

export const PAYER_DESCRIPTION =
  "Optional: who should pay, so the request also shows up in their own agent's inbox (what_do_i_owe) and they can pay it there. " +
  "If the user names an X handle (\"ask @sam\"), first call PayBox resolve_username with that handle, tell the user which handle resolved to which Solana wallet, then pass both as {handle, wallet}. " +
  "For an SNS name pass {sns: \"name.sns\"}: Owed resolves it on Solana. Or pass {wallet} if the user gives the payer's wallet. " +
  "A handle is a label: Owed doesn't verify it.";

export const payerInput = z.object({
  handle: handleInput.optional().describe('The payer\'s X handle, e.g. "@sam". Only with wallet: the Solana address PayBox resolve_username returned for it.'),
  wallet: addressSchema.optional().describe("The payer's Solana wallet address (from resolve_username for a handle, or given by the user)."),
  sns: z.string().min(1).max(140).optional().describe('The payer\'s SNS name, e.g. "sam.sns": Owed resolves it on Solana.'),
}).strict().describe(PAYER_DESCRIPTION);

export const requesterHandleInput = handleInput.describe(
  "Optional: the user's own X handle, e.g. \"@raj\". The payer sees it as \"not verified by Owed\", and the payer's agent checks it with PayBox resolve_username before paying.",
);

export const payerOutput = z.object({
  wallet: z.string(),
  handle: z.string().nullable().describe("The X handle the request was addressed to (a label; Owed doesn't verify handles)."),
  sns: z.string().nullable().describe("The SNS name that pointed to the wallet when the request was made."),
}).strict();

export type PayerInput = z.output<typeof payerInput>;

/** "@Sam_OK" → "sam_ok"; null for none or anything that isn't a handle. */
export function normalizeHandle(input: string | undefined | null): string | null {
  if (input == null) return null;
  const m = HANDLE_RE.exec(input.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export type PayerResolution =
  | { ok: true; body: PayerReq; payer: PayerInfo; lines: string[] }
  | { ok: false; message: string };

/**
 * Checks and completes the payer before anything is created: a handle must come with the wallet resolve_username
 * returned, an .sns name is resolved on Solana (and must match a wallet given with it), and the wallet must be one
 * that can sign and not the recipient's own. `who` names the person in refusals ("the payer", "Sam").
 */
export async function resolvePayer(
  input: PayerInput, recipient: string, deps: Pick<Deps, "rpc">, budgetMs: number = SNS_BUDGET_MS, who = "the payer",
): Promise<PayerResolution> {
  const handle = input.handle === undefined ? null : normalizeHandle(input.handle);
  if (input.handle !== undefined && handle === null) return { ok: false, message: `${input.handle.slice(0, 20)} isn't an X handle (1 to 15 letters, digits or _). Nothing was created.` };
  let wallet = input.wallet ?? null;
  let sns: string | null = null;
  const lines: string[] = [];
  if (input.sns !== undefined) {
    if (!looksLikeSnsName(input.sns)) return { ok: false, message: `${input.sns.slice(0, 60)} isn't an SNS name (name.sns). Nothing was created.` };
    const named = await resolveName(input.sns, deps, budgetMs);
    if (!named.ok) return { ok: false, message: `${named.message} Nothing was created.` };
    if (wallet !== null && named.wallet !== wallet) {
      return { ok: false, message: `${named.name} points to ${shortAddress(named.wallet)}, not to the wallet given for ${who} (${shortAddress(wallet)}). Nothing was created; check with the user which is right.` };
    }
    wallet = named.wallet;
    sns = named.name;
  }
  if (wallet === null) {
    if (handle !== null) {
      return { ok: false, message: `To address the request to @${handle}, first call PayBox resolve_username with "@${handle}", show the user which wallet it resolved to, then pass payer {handle, wallet} with that wallet. Nothing was created.` };
    }
    return { ok: false, message: `payer needs a wallet, an SNS name, or an X handle with the wallet PayBox resolve_username returned for it. Nothing was created.` };
  }
  let onCurve = false;
  try {
    const key = new PublicKey(wallet);
    onCurve = key.toBase58() === wallet && PublicKey.isOnCurve(key.toBytes());
  } catch {
    onCurve = false;
  }
  if (!onCurve) return { ok: false, message: `The wallet given for ${who} isn't a wallet that can sign a payment (it may be a token account). Nothing was created.` };
  if (wallet === recipient) return { ok: false, message: `The wallet given for ${who} is the user's own wallet, which this request pays. Nothing was created.` };
  const payer: PayerInfo = { wallet, handle, sns };
  if (handle !== null) lines.push(`Addressed to @${handle} (wallet ${shortAddress(wallet)}, as PayBox resolved it; Owed doesn't verify handles).`);
  else if (sns !== null) lines.push(`Addressed to ${sns} (it points to ${shortAddress(wallet)} on Solana right now).`);
  else lines.push(`Addressed to wallet ${shortAddress(wallet)}.`);
  return { ok: true, body: { wallet, ...(handle !== null && { handle }), ...(sns !== null && { sns }) }, payer, lines };
}

/** The server stored the payer exactly as asked (the inbox lists the request by it). */
export function samePayer(stored: PayerInfo | null | undefined, asked: PayerInfo): boolean {
  return !!stored && stored.wallet === asked.wallet && (stored.handle ?? null) === asked.handle && (stored.sns ?? null) === asked.sns;
}

/** Who to name in text: "@sam_ok", "sam.sns" or a short wallet. */
export function payerLabel(p: Pick<PayerInfo, "wallet" | "handle" | "sns">): string {
  return p.handle ? `@${p.handle}` : p.sns ?? shortAddress(p.wallet);
}

export const ADDRESSED_LINE = (p: PayerInfo) =>
  `${payerLabel(p)} sees it in their own agent's inbox (what_do_i_owe) and can pay it there, or from the link.`;

export const OFFLINE_NOT_ADDRESSED = (p: PayerInfo) =>
  `Owed's server didn't answer, so this offline link isn't addressed to ${payerLabel(p)}: it won't show up in their inbox. Send them the link.`;

export const REFUSE_PAYER_NOT_STORED = (p: PayerInfo) =>
  `Owed's server didn't address the request to ${payerLabel(p)} as asked, so the link wasn't used. Try again, or ask without payer.`;

/**
 * The handle check pay_link and pay_all hand the payer's agent: Owed can't resolve handles, the agent can. The request
 * pays `recipient`; if the requester's handle now resolves elsewhere, the request is not from who it says.
 */
export function handleCheckLine(handle: string, recipient: string): string {
  return `Handle check: this request says it is from @${handle} (not verified by Owed). Before approving, call PayBox resolve_username('@${handle}'); if its Solana address isn't ${recipient}, tell the user and don't approve.`;
}

/**
 * F2: the same handle check, before a funding plan. A request that fails it must not be funded either, so the plan
 * puts it before every step.
 */
export function handleCheckBeforeFunding(handle: string, recipient: string, which = "this request"): string {
  return `First, before any step: ${which} says it is from @${handle} (not verified by Owed). Call PayBox resolve_username('@${handle}'); if its Solana address isn't ${recipient}, tell the user and stop: don't fund or pay it.`;
}
