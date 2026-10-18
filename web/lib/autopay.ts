import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  AUTOPAY_ENDED_LISTED_DAYS, AUTOPAY_MESSAGE_MAX_CHARS, AUTOPAY_PURPOSE, AUTOPAY_REVOKE_PURPOSE, autopayPrefix, autopayVerdicts,
  candidateRecipients, endsAtFor, isoDate, limitProblem, monthOf, revokePrefix,
  type AutopayVerdict, type UsdcAccount, type VerdictLine, type VerdictRule,
} from "./autopay-core";
import type { AutopayCreateBody, AutopayRevokeBody, AutopayRule } from "./contract";
import { isoUtc, isUniqueViolation, sql, transaction, type Row } from "./db";
import { ApiError } from "./http";
import type { Inbox, InboxEntry } from "./inbox";
import { parseHandle } from "./inbox-payer";
import { AmountError, fromAtomic, toAtomic, USDC_MINT } from "./money";
import { parseSnsName, resolveSnsOnServer, sourceText, type SnsResult } from "./sns";
import { rpcBatch, RpcError } from "./solana";
import { isSolanaAddress } from "./solana-pay";
import {
  checkSignedMessage, isoSeconds, parseIsoUtc, signatureCandidates, spendOnce, verifyMessageSignature, SIGNATURE_MAX_AGE_MS,
  SIGNATURE_MAX_SKEW_MS, type VerifiedMessage,
} from "./verify-signature";

// F5 autopay within policy, the server side (rules and messages: lib/autopay-core.ts). POST /api/v1/autopay stores a
// payer's signed rule, POST /api/v1/autopay/revoke ends one, and the signed inbox (POST /api/v1/inbox) carries the payer's
// rules and a verdict per line (withAutopay). Owed never pays anything: what_do_i_owe hands the payer's agent the exact
// PayBox pay_x402 call for eligible lines, and PayBox's own grant limits stay the hard cap.

/** One chain read for every candidate requester's USDC account, inside the inbox's budget. */
export const AUTOPAY_ACCOUNT_BUDGET_MS = 1500;
/** Rules read per payer (live, and revoked or ended within a month). */
const RULES_READ = 50;

export function newRuleId(): string {
  return bs58.encode(randomBytes(16)).slice(-12);
}

const bad = (message: string) => new ApiError("invalid_input", message);

// ---------------------------------------------------------------------------------------------- signed messages

/**
 * The create message ends " (at <ISO time>)" rather than " at <ISO time>" and may run to 300 characters; otherwise the
 * same checks as lib/verify-signature.ts checkSignedMessage, in the same order: wording, freshness, signature.
 */
export function checkAutopaySigned(input: { message: string; signature: string; signer: string; prefix: string; now?: number }): VerifiedMessage {
  const { message, signature, signer, prefix, now = Date.now() } = input;
  if (typeof message !== "string" || message.length === 0 || message.length > AUTOPAY_MESSAGE_MAX_CHARS) {
    throw bad(`signed_message must be the exact message you signed (at most ${AUTOPAY_MESSAGE_MAX_CHARS} characters)`);
  }
  const lead = `${prefix} (at `;
  if (!message.startsWith(lead) || !message.endsWith(")")) {
    throw bad(`signed_message must read "${prefix} (at <time>)", exactly as it was given to you to sign`);
  }
  const signedAtMs = parseIsoUtc(message.slice(lead.length, -1));
  if (signedAtMs === null) throw bad(`signed_message must end with a UTC time like (at ${isoSeconds(now)})`);
  if (now - signedAtMs > SIGNATURE_MAX_AGE_MS) throw bad("this signed message is more than 5 minutes old; sign a fresh one");
  if (signedAtMs - now > SIGNATURE_MAX_SKEW_MS) throw bad("this signed message is dated in the future; sign a fresh one with the current time");
  if (signatureCandidates(signature).length === 0) {
    throw bad("signature must be the 64-byte signature as hex (what PayBox returns), base58 or base64");
  }
  if (!verifyMessageSignature(message, signature, signer)) {
    throw bad(`the signature doesn't match this message for wallet ${signer}; sign the exact message with that wallet`);
  }
  // Same single-use key as checkSignedMessage: sha256 of the exact text.
  return { signer, signedAtMs, messageHash: createHash("sha256").update(message, "utf8").digest("hex") };
}

// ---------------------------------------------------------------------------------------------- rows

interface RuleRow {
  id: string;
  payer: string;
  requester: string;
  handle: string | null;
  sns: string | null;
  maxPerRequestAtomic: bigint;
  maxPerMonthAtomic: bigint;
  endsAt: string;
  createdAt: string;
  signedMessage: string;
  signature: string;
  revokedAt: string | null;
  replacedBy: string | null;
}

const RULE_COLUMNS = `id, payer_wallet, requester_wallet, requester_handle, requester_sns,
  max_per_request_atomic::text as max_per_request_atomic, max_per_month_atomic::text as max_per_month_atomic,
  ${isoUtc("ends_at")} as ends_at, ${isoUtc("created_at")} as created_at, signed_message, signature,
  ${isoUtc("revoked_at")} as revoked_at, replaced_by`;

function ruleFromRow(r: Row): RuleRow {
  return {
    id: r.id!,
    payer: r.payer_wallet!,
    requester: r.requester_wallet!,
    handle: r.requester_handle ?? null,
    sns: r.requester_sns ?? null,
    maxPerRequestAtomic: BigInt(r.max_per_request_atomic!),
    maxPerMonthAtomic: BigInt(r.max_per_month_atomic!),
    endsAt: r.ends_at!,
    createdAt: r.created_at!,
    signedMessage: r.signed_message!,
    signature: r.signature!,
    revokedAt: r.revoked_at ?? null,
    replacedBy: r.replaced_by ?? null,
  };
}

/** What each rule's payer paid its requester this UTC month, since the rule was made (USDC on Solana, any rail). */
async function monthUse(ids: readonly string[]): Promise<Map<string, bigint>> {
  if (ids.length === 0) return new Map();
  const rows = await sql(
    `select a.id, coalesce(sum(r.paid_amount_atomic), 0)::text as used
       from autopay_rules a
       left join requests r
         on r.recipient = a.requester_wallet and r.paid_payer = a.payer_wallet
        and r.token = 'USDC' and r.chain = 'solana' and r.status in ('paid', 'underpaid') and r.paid_amount_atomic is not null
        and r.paid_at >= greatest(a.created_at, date_trunc('month', now() at time zone 'UTC') at time zone 'UTC')
      where a.id = any($1::text[])
      group by a.id`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id!, BigInt(r.used!)]));
}

export function publicRule(r: RuleRow, usedAtomic: bigint, nowMs: number = Date.now()): AutopayRule {
  const endsAtMs = Date.parse(r.endsAt);
  return {
    id: r.id,
    payer: r.payer,
    requester: { wallet: r.requester, handle: r.handle, sns: r.sns },
    token: "USDC",
    max_per_request: fromAtomic(r.maxPerRequestAtomic, "USDC"),
    max_per_month: fromAtomic(r.maxPerMonthAtomic, "USDC"),
    ends: isoDate(endsAtMs - 86_400_000),
    ends_at: r.endsAt,
    created_at: r.createdAt,
    status: r.revokedAt ? "revoked" : nowMs >= endsAtMs ? "ended" : "active",
    revoked_at: r.revokedAt,
    replaced_by: r.replacedBy,
    month: monthOf(nowMs).label,
    used_this_month: fromAtomic(usedAtomic, "USDC"),
    signed_message: r.signedMessage,
    signature: r.signature,
  };
}

// ---------------------------------------------------------------------------------------------- create

export interface CreateOptions {
  now?: number;
  /** Test seam: resolves an .sns name on Solana. */
  resolve?: (name: string) => Promise<SnsResult>;
}

/** Parses and checks a rule's fields: the same values the signed text names, normalized as the plugin writes them. */
export function ruleFields(body: AutopayCreateBody, nowMs: number) {
  const requester = body.requester.wallet.trim();
  if (!isSolanaAddress(requester)) throw bad("requester.wallet: must be the Solana wallet the requests pay (base58)");
  if (!PublicKey.isOnCurve(new PublicKey(requester).toBytes())) throw bad("requester.wallet: must be a wallet, not a token account or program address");
  if (requester === body.payer) throw bad("requester.wallet: that is the payer's own wallet");
  const handle = parseHandle(body.requester.handle, "requester.handle");
  let maxPerRequestAtomic: bigint;
  let maxPerMonthAtomic: bigint;
  try {
    maxPerRequestAtomic = toAtomic(body.max_per_request, "USDC");
  } catch (e) {
    if (e instanceof AmountError) throw bad(`max_per_request: ${e.message}`);
    throw e;
  }
  try {
    maxPerMonthAtomic = toAtomic(body.max_per_month, "USDC");
  } catch (e) {
    if (e instanceof AmountError) throw bad(`max_per_month: ${e.message}`);
    throw e;
  }
  const limits = limitProblem(maxPerRequestAtomic, maxPerMonthAtomic);
  if (limits) throw bad(limits);
  const ends = endsAtFor(body.ends, nowMs);
  if (!ends.ok) throw bad(ends.message);
  return { requester, handle, maxPerRequestAtomic, maxPerMonthAtomic, ends: body.ends, endsAtMs: ends.endsAtMs };
}

/**
 * Stores a payer's signed rule. Order: every field, the signature (pure), the .sns name on Solana, then the single-use
 * spend, so a refusal never burns the signature. The previous live rule for the same requester is retired in the same
 * transaction (replaced_by).
 */
export async function createAutopayRule(body: AutopayCreateBody, options: CreateOptions = {}): Promise<{ rule: AutopayRule; replaced: string | null }> {
  const now = options.now ?? Date.now();
  const f = ruleFields(body, now);
  const prefix = autopayPrefix({ payer: body.payer, requester: f.requester, maxPerRequestAtomic: f.maxPerRequestAtomic, maxPerMonthAtomic: f.maxPerMonthAtomic, ends: f.ends });
  const verified = checkAutopaySigned({ message: body.signed_message, signature: body.signature, signer: body.payer, prefix, now });
  // The requester's .sns name is a label, stored only if it names that wallet right now (read beside nothing else).
  let sns: string | null = null;
  if (body.requester.sns != null) {
    const parsed = parseSnsName(body.requester.sns);
    if (!parsed.ok) throw bad(`requester.sns: ${parsed.message}`);
    const r = await (options.resolve ?? resolveSnsOnServer)(parsed.name);
    if (!r.ok) throw new ApiError(r.code === "unavailable" ? "upstream_unavailable" : "invalid_input", `requester.sns: ${r.message}`);
    if (r.wallet !== f.requester) throw bad(`requester.sns: ${r.name} points to ${r.wallet} (${sourceText(r.source)}), not to the requester wallet ${f.requester}`);
    sns = r.name;
  }
  await spendOnce(AUTOPAY_PURPOSE, verified);
  const id = newRuleId();
  let results: Row[][];
  try {
    results = await transaction([
      {
        text: `update autopay_rules set revoked_at = now(), replaced_by = $3
                where payer_wallet = $1 and requester_wallet = $2 and revoked_at is null returning id`,
        params: [body.payer, f.requester, id],
      },
      {
        text: `insert into autopay_rules (id, payer_wallet, requester_wallet, requester_handle, requester_sns,
                 max_per_request_atomic, max_per_month_atomic, ends_at, signed_message, signature)
               values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10)
               returning ${RULE_COLUMNS}`,
        params: [id, body.payer, f.requester, f.handle, sns, f.maxPerRequestAtomic, f.maxPerMonthAtomic, new Date(f.endsAtMs).toISOString(), body.signed_message, body.signature.trim()],
      },
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw bad("another rule for this requester was saved at the same moment; sign a fresh message and try again");
    throw e;
  }
  const replaced = results[0]?.[0]?.id ?? null;
  const row = ruleFromRow(results[1]![0]!);
  const used = (await monthUse([row.id])).get(row.id) ?? 0n;
  return { rule: publicRule(row, used, now), replaced };
}

// ---------------------------------------------------------------------------------------------- revoke

/** Ends a rule with the payer's signed revoke. Revoking twice changes nothing (and doesn't spend the second signature). */
export async function revokeAutopayRule(body: AutopayRevokeBody, now: number = Date.now()): Promise<{ rule: AutopayRule; already_revoked: boolean }> {
  const verified = checkSignedMessage({ message: body.signed_message, signature: body.signature, signer: body.payer, prefix: revokePrefix(body.rule_id, body.payer), now });
  const [found] = await sql(`select ${RULE_COLUMNS} from autopay_rules where id = $1 and payer_wallet = $2`, [body.rule_id, body.payer]);
  if (!found) throw new ApiError("not_found", "no autopay rule with this id for this payer");
  const existing = ruleFromRow(found);
  if (existing.revokedAt) {
    const used = (await monthUse([existing.id])).get(existing.id) ?? 0n;
    return { rule: publicRule(existing, used, now), already_revoked: true };
  }
  await spendOnce(AUTOPAY_REVOKE_PURPOSE, verified);
  const rows = await sql(
    `update autopay_rules set revoked_at = now(), revoke_message = $3, revoke_signature = $4
      where id = $1 and payer_wallet = $2 and revoked_at is null returning ${RULE_COLUMNS}`,
    [body.rule_id, body.payer, body.signed_message, body.signature.trim()],
  );
  const row = rows[0] ? ruleFromRow(rows[0]) : ruleFromRow((await sql(`select ${RULE_COLUMNS} from autopay_rules where id = $1`, [body.rule_id]))[0]!);
  const used = (await monthUse([row.id])).get(row.id) ?? 0n;
  return { rule: publicRule(row, used, now), already_revoked: rows.length === 0 };
}

// ---------------------------------------------------------------------------------------------- the inbox

/** A payer's rules that matter now: live ones, and ones revoked or ended within the last month (newest first). */
async function rulesOf(payer: string): Promise<RuleRow[]> {
  const rows = await sql(
    `select ${RULE_COLUMNS} from autopay_rules
      where payer_wallet = $1
        and (revoked_at is null or revoked_at > now() - make_interval(days => $2::int))
        and ends_at > now() - make_interval(days => $2::int)
      order by created_at desc, id
      limit $3`,
    [payer, AUTOPAY_ENDED_LISTED_DAYS, RULES_READ],
  );
  return rows.map(ruleFromRow);
}

/**
 * Whether each owner's USDC account (its associated token account for the USDC mint) exists, in one getMultipleAccounts
 * call. Every owner is "unknown" when Solana can't be read within the budget.
 */
export async function usdcAccounts(owners: readonly string[], budgetMs: number = AUTOPAY_ACCOUNT_BUDGET_MS): Promise<Map<string, UsdcAccount>> {
  const out = new Map<string, UsdcAccount>(owners.map((o) => [o, "unknown"]));
  if (owners.length === 0) return out;
  const mint = new PublicKey(USDC_MINT);
  const atas = owners.map((o) => getAssociatedTokenAddressSync(mint, new PublicKey(o), true).toBase58());
  try {
    const [result] = await rpcBatch(
      [{ method: "getMultipleAccounts", params: [atas, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }] }],
      { deadline: Date.now() + budgetMs, timeoutMs: budgetMs },
    );
    const value = (result as { value?: unknown } | null)?.value;
    if (!Array.isArray(value) || value.length !== owners.length) return out;
    owners.forEach((o, i) => out.set(o, value[i] === null ? "missing" : typeof value[i] === "object" ? "exists" : "unknown"));
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
  }
  return out;
}

export interface AutopayInboxOptions {
  now?: number;
  accountBudgetMs?: number;
  /** Test seam: the USDC-account read. */
  accounts?: (owners: readonly string[]) => Promise<Map<string, UsdcAccount>>;
}

export type InboxEntryWithAutopay = InboxEntry & { autopay?: AutopayVerdict };
export type InboxWithAutopay = Omit<Inbox, "owed" | "base"> & {
  owed: InboxEntryWithAutopay[];
  base: InboxEntryWithAutopay[];
  autopay_rules?: AutopayRule[];
};

function verdictLine(e: InboxEntry): VerdictLine {
  return {
    id: e.id, chain: e.chain, token: e.token, status: e.status, recipient: e.recipient,
    // amount, not amount_due: an underpaid line is never eligible, and an open one owes its amount.
    amountAtomic: toAtomic(e.amount, e.token),
    flags: e.flags,
  };
}

/**
 * The inbox with the payer's autopay rules and a verdict on every line. A payer with no rule (live, or revoked or ended
 * within a month) gets the inbox exactly as before: no autopay fields at all.
 */
export async function withAutopay(inbox: Inbox, options: AutopayInboxOptions = {}): Promise<InboxWithAutopay> {
  const now = options.now ?? Date.now();
  const rows = await rulesOf(inbox.payer);
  if (rows.length === 0) return inbox;
  const live = rows.filter((r) => r.revokedAt === null);
  const use = await monthUse(live.map((r) => r.id));
  // Per requester: the live rule, else the most recently revoked one (rows are newest first).
  const byRequester = new Map<string, VerdictRule>();
  for (const r of [...live, ...rows.filter((x) => x.revokedAt !== null)]) {
    if (byRequester.has(r.requester)) continue;
    byRequester.set(r.requester, {
      id: r.id, requester: r.requester, maxPerRequestAtomic: r.maxPerRequestAtomic, maxPerMonthAtomic: r.maxPerMonthAtomic,
      endsAtMs: Date.parse(r.endsAt), revokedAtMs: r.revokedAt ? Date.parse(r.revokedAt) : null, usedThisMonthAtomic: use.get(r.id) ?? 0n,
    });
  }
  // Lines oldest first: the inbox lists Solana requests oldest first; Base ones never qualify.
  const lines = [...inbox.owed, ...inbox.base].map(verdictLine);
  const candidates = candidateRecipients(lines, byRequester, now);
  const accounts = candidates.length === 0
    ? new Map<string, UsdcAccount>()
    : await (options.accounts ?? ((o) => usdcAccounts(o, options.accountBudgetMs)))(candidates);
  const verdicts = autopayVerdicts(lines, byRequester, (recipient) => accounts.get(recipient) ?? "unknown", now);
  const byId = new Map(lines.map((l, i) => [l.id, verdicts[i]!]));
  const mark = (e: InboxEntry): InboxEntryWithAutopay => ({ ...e, autopay: byId.get(e.id)! });
  return {
    ...inbox,
    owed: inbox.owed.map(mark),
    base: inbox.base.map(mark),
    autopay_rules: live.slice(0, 20).map((r) => publicRule(r, use.get(r.id) ?? 0n, now)),
  };
}
