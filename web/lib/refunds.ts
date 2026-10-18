import "server-only";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { DbError, isoUtc, isUniqueViolation, sql, transaction, type Row } from "./db";
import { ApiError } from "./http";
import { newReference } from "./ids";
import { AmountError, fromAtomic, toAtomic, USDC_MINT, type Token } from "./money";
import { chainCheckable, getRequest, settleFromChain, type RequestRow } from "./requests";
import type { RpcOptions } from "./solana";
import { findPayments, type ClaimedUnit } from "./validate";
import { checkSignedMessage, spendOnce } from "./verify-signature";

// F8 invoices: refunds (0021). The wallet a paid request paid sends all or part of it back to the wallet that paid.
// Owed holds nothing: the recipient signs a message naming the amount, the request and the payer; the server picks a
// fresh reference and stores the refund as pending; the plugin proposes ONE unsigned transfer recipient -> payer that
// carries the reference (refund_payment). The refund is confirmed only when the chain shows that transfer, by the same
// rule that marks a request paid (lib/validate.ts findPayments): confirmed, successful, carries the reference, credits
// the payer at least the amount; and here also sent by the recipient. Refunds can never add up to more than was paid:
// confirmed + live pending refunds are capped by the request's paid amount under a row lock on the request.

export const REFUND_PURPOSE = "refund";
/** A pending refund stops holding back part of the refundable amount after this (its transaction can't land any more). */
export const REFUND_PENDING_MINUTES = 30;
/** Chain read before a refund is stored (is the request paid?), under the plugin's API timeout. */
export const REFUND_CHAIN_BUDGET_MS = 3000;
export const REFUND_MEMO_PREFIX = "owed-refund:";
/** Pending refunds the daily cron re-reads, newest first, and how far back. */
export const REFUND_CRON_BATCH = 50;
export const REFUND_CRON_DAYS = 7;

const REFUND_ID = /^[1-9A-HJ-NP-Za-km-z]{12}$/;

export function isRefundId(s: unknown): s is string {
  return typeof s === "string" && REFUND_ID.test(s);
}

/** The signed text, without " at <ISO time>". `amount` is the canonical decimal (fromAtomic). */
export function refundPrefix(amount: string, token: Token, requestId: string, payer: string, recipient: string): string {
  return `Owed refund ${amount} ${token} of ${requestId} to ${payer} for ${recipient}`;
}

export interface RefundTerms {
  requestId: string;
  payer: string;
  token: Token;
  amountAtomic: bigint;
  reference: string;
}

/** A refund id commits to what it refunds, to whom, how much and its reference (plugin/src/refund.ts computes the same). */
export function refundIdFor(t: RefundTerms): string {
  const asset = t.token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256")
    .update(`owed-refund:v1\n${t.requestId}\n${t.payer}\n${asset}\n${t.amountAtomic}\n${t.reference}`, "utf8")
    .digest();
  return bs58.encode(digest).slice(-12);
}

export type RefundStatus = "pending" | "confirmed" | "lapsed";

export interface RefundRow {
  id: string;
  requestId: string;
  recipient: string;
  payer: string;
  token: Token;
  amountAtomic: bigint;
  reference: string;
  signedMessage: string;
  signature: string;
  /** "lapsed": pending for more than REFUND_PENDING_MINUTES (computed by the database clock). */
  status: RefundStatus;
  confirmed: { signature: string; instruction: number | null; amountAtomic: bigint; at: string; slot: bigint } | null;
  createdAt: string;
}

const EFFECTIVE = `case when status = 'pending' and created_at <= now() - make_interval(mins => ${REFUND_PENDING_MINUTES}) then 'lapsed' else status end`;

export const REFUND_COLUMNS = `id, request_id, recipient, payer, token, amount_atomic::text as amount_atomic, reference, signed_message, signature,
  ${EFFECTIVE} as status, confirmed_signature, confirmed_instruction, confirmed_amount_atomic::text as confirmed_amount_atomic,
  ${isoUtc("confirmed_at")} as confirmed_at, confirmed_slot::text as confirmed_slot, ${isoUtc("created_at")} as created_at`;

export function refundFromRow(r: Row): RefundRow {
  return {
    id: r.id!,
    requestId: r.request_id!,
    recipient: r.recipient!,
    payer: r.payer!,
    token: r.token as Token,
    amountAtomic: BigInt(r.amount_atomic!),
    reference: r.reference!,
    signedMessage: r.signed_message!,
    signature: r.signature!,
    status: r.status as RefundStatus,
    confirmed: r.confirmed_signature
      ? {
          signature: r.confirmed_signature,
          instruction: r.confirmed_instruction == null ? null : Number(r.confirmed_instruction),
          amountAtomic: BigInt(r.confirmed_amount_atomic!),
          at: r.confirmed_at!,
          slot: BigInt(r.confirmed_slot!),
        }
      : null,
    createdAt: r.created_at!,
  };
}

export async function getRefund(id: string): Promise<RefundRow | null> {
  const rows = await sql(`select ${REFUND_COLUMNS} from refunds where id = $1`, [id]);
  return rows.length ? refundFromRow(rows[0]) : null;
}

export async function refundsOf(requestIds: readonly string[]): Promise<RefundRow[]> {
  if (requestIds.length === 0) return [];
  return (await sql(`select ${REFUND_COLUMNS} from refunds where request_id = any($1::text[]) order by created_at, id`, [requestIds])).map(refundFromRow);
}

// ---------------------------------------------------------------- what can be refunded

export type Refundability =
  | { ok: true; paidAtomic: bigint; payer: string }
  | { ok: false; message: string };

/** Whether this request's payment can go back to the wallet that paid it, and how much was paid. Pure. */
export function refundability(row: RequestRow): Refundability {
  const no = (message: string): Refundability => ({ ok: false, message });
  if (row.chain === "base") return no("this request was paid on Base; Owed refunds Solana payments only");
  if (row.status !== "paid" && row.status !== "underpaid") return no(`this request isn't paid (it is ${row.status}), so there is nothing to refund`);
  if (row.paidRail === "moonpay_card") {
    return no("this request was paid by card through MoonPay, which delivered the USDC from its own wallet; refund the card payment through MoonPay, or ask the payer for a wallet");
  }
  if (row.paidRail === "matched" || row.match?.covers === "full") {
    return no("this payment was matched by you and carried no reference, so it may have come from an exchange's wallet that wouldn't credit the payer; ask the payer for their own wallet and send it yourself");
  }
  if (!row.paidPayer || row.paidAmountAtomic == null || row.paidAmountAtomic <= 0n) return no("this request has no recorded payment to refund");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.paidPayer)) return no("the paying wallet isn't a Solana wallet");
  if (row.paidPayer === row.recipient) return no("this request was paid from its own wallet; there is nobody to refund");
  return { ok: true, paidAtomic: row.paidAmountAtomic, payer: row.paidPayer };
}

/** What a request's refunds hold: confirmed ones, and pending ones younger than REFUND_PENDING_MINUTES. */
export function refundTotals(refunds: readonly RefundRow[]): { refundedAtomic: bigint; pendingAtomic: bigint } {
  let refundedAtomic = 0n;
  let pendingAtomic = 0n;
  for (const r of refunds) {
    if (r.status === "confirmed") refundedAtomic += r.amountAtomic;
    else if (r.status === "pending") pendingAtomic += r.amountAtomic;
  }
  return { refundedAtomic, pendingAtomic };
}

// ---------------------------------------------------------------- confirming refunds on chain

/** Transfers that already confirm a refund (one transfer confirms one refund). */
async function refundClaims(signatures: readonly string[]): Promise<Map<string, ClaimedUnit[]>> {
  const rows = await sql(`select confirmed_signature, id, confirmed_instruction from refunds where confirmed_signature = any($1::text[])`, [signatures]);
  const out = new Map<string, ClaimedUnit[]>();
  for (const r of rows) {
    const list = out.get(r.confirmed_signature!) ?? [];
    list.push({ requestId: r.id!, instruction: r.confirmed_instruction == null ? null : Number(r.confirmed_instruction) });
    out.set(r.confirmed_signature!, list);
  }
  return out;
}

/**
 * Read the chain for pending (and lapsed) refunds and confirm each one whose transfer landed. Throws RpcError when
 * the chain can't be read in time; the refunds keep their stored state then.
 */
export async function confirmRefunds(refunds: readonly RefundRow[], rpc: RpcOptions = {}): Promise<RefundRow[]> {
  const due = refunds.filter((r) => r.status !== "confirmed");
  if (due.length === 0) return [...refunds];
  const checks = await findPayments(
    due.map((r) => ({ reference: r.reference, recipient: r.payer, token: r.token, amountAtomic: r.amountAtomic, requestId: r.id })),
    rpc,
    { claimedUnits: refundClaims },
  );
  const updated = new Map<string, RefundRow>();
  await Promise.all(due.map(async (r, i) => {
    const check = checks[i];
    const p = check.payment;
    // Only a transfer the refunding wallet sent counts: anyone can put a public reference on their own transfer.
    if (check.status !== "paid" || !p || p.payer !== r.recipient) return;
    try {
      const rows = await sql(
        `update refunds set status = 'confirmed', confirmed_signature = $2, confirmed_instruction = $3::smallint,
                confirmed_amount_atomic = $4, confirmed_at = $5::timestamptz, confirmed_slot = $6
          where id = $1 and status = 'pending'
          returning ${REFUND_COLUMNS}`,
        [r.id, p.signature, p.instruction ?? null, p.amountAtomic, p.at, BigInt(p.slot)],
      );
      if (rows.length) updated.set(r.id, refundFromRow(rows[0]));
    } catch (e) {
      if (isUniqueViolation(e, "refunds_confirmed_signature_key")) {
        console.warn(`refund ${r.id}: transaction ${p.signature} already confirms another refund`);
        return;
      }
      throw e;
    }
  }));
  return refunds.map((r) => updated.get(r.id) ?? r);
}

/** confirmRefunds, but a chain that can't be read leaves the stored state (pages and lists still answer). */
export async function confirmRefundsSoft(refunds: readonly RefundRow[], rpc: RpcOptions): Promise<{ refunds: RefundRow[]; chainChecked: boolean }> {
  if (!refunds.some((r) => r.status !== "confirmed")) return { refunds: [...refunds], chainChecked: true };
  try {
    return { refunds: await confirmRefunds(refunds, rpc), chainChecked: true };
  } catch (e) {
    if (e instanceof DbError) throw e;
    return { refunds: [...refunds], chainChecked: false };
  }
}

// ---------------------------------------------------------------- creating a refund

export interface CreateRefundInput {
  requestId: string;
  recipient: string;
  /** Decimal string in the request's token. */
  amount: string;
  signedMessage: string;
  signature: string;
  now?: number;
}

export interface CreateRefundOutcome {
  refund: RefundRow;
  request: RequestRow;
  paidAtomic: bigint;
  refundedAtomic: bigint;
  pendingAtomic: bigint;
}

const refuse = (message: string) => new ApiError("invalid_input", message);

export async function createRefund(input: CreateRefundInput, rpc: RpcOptions = { deadline: Date.now() + REFUND_CHAIN_BUDGET_MS }): Promise<CreateRefundOutcome> {
  let row = await getRequest(input.requestId);
  if (!row) throw new ApiError("not_found", "no request with this id");
  if (row.recipient !== input.recipient) throw refuse("only the wallet this request pays can refund it, and that is not this recipient");
  // A payment may have landed since the last status read: the chain decides whether there is anything to refund.
  if (row.status !== "paid" && chainCheckable(row.status)) {
    try {
      [row] = await settleFromChain([row], rpc);
    } catch {
      if (row.status !== "underpaid") {
        throw new ApiError("upstream_unavailable", "Solana couldn't be read to confirm this request was paid; sign a fresh message and try again shortly");
      }
    }
  }
  const can = refundability(row);
  if (!can.ok) throw refuse(can.message);
  let amountAtomic: bigint;
  try {
    amountAtomic = toAtomic(input.amount, row.token);
  } catch (e) {
    if (e instanceof AmountError) throw refuse(`amount: ${e.message}`);
    throw e;
  }
  const amount = fromAtomic(amountAtomic, row.token);
  const verified = checkSignedMessage({
    message: input.signedMessage,
    signature: input.signature,
    signer: row.recipient,
    prefix: refundPrefix(amount, row.token, row.id, can.payer, row.recipient),
    now: input.now,
  });
  // Refusals that need no lock come before the signature is spent, so the user can sign again for a smaller amount.
  const before = refundTotals(await refundsOf([row.id]));
  const room = can.paidAtomic - before.refundedAtomic - before.pendingAtomic;
  if (amountAtomic > room) throw refuse(overCap(can.paidAtomic, before.refundedAtomic, before.pendingAtomic, row.token));
  await spendOnce(REFUND_PURPOSE, verified);

  for (let attempt = 0; ; attempt++) {
    const reference = newReference();
    const id = refundIdFor({ requestId: row.id, payer: can.payer, token: row.token, amountAtomic, reference });
    let results: Row[][];
    try {
      // Lock the request (x402, cancel and match take the same lock), then insert only while confirmed + live pending
      // refunds plus this one stay within what was paid, and the payment is still exactly the one checked.
      results = await transaction([
        { text: `select id from requests where id = $1 for update`, params: [row.id] },
        {
          text: `insert into refunds (id, request_id, recipient, payer, token, amount_atomic, reference, signed_message, signature)
                 select $1, $2, $3, $4, $5, $6, $7, $8, $9
                  where exists (select 1 from requests where id = $2 and status in ('paid', 'underpaid')
                                  and paid_payer = $4 and paid_amount_atomic = $10::numeric)
                    and (select coalesce(sum(amount_atomic), 0) from refunds
                          where request_id = $2
                            and (status = 'confirmed' or (status = 'pending' and created_at > now() - make_interval(mins => ${REFUND_PENDING_MINUTES}))))
                        + $6::numeric <= $10::numeric
                 returning ${REFUND_COLUMNS}`,
          params: [id, row.id, row.recipient, can.payer, row.token, amountAtomic, reference, input.signedMessage, input.signature.trim(), can.paidAtomic],
        },
        { text: `select ${REFUND_COLUMNS} from refunds where request_id = $1 order by created_at, id`, params: [row.id] },
        // F8: the invoice this request is (or belongs to through a plan) now has something extra to show.
        { text: `update invoices set extras = true
                  where id = $1 or id in (select invoice_id from invoice_term_requests where request_id = $1)`, params: [row.id] },
      ]);
    } catch (e) {
      if (attempt < 2 && (isUniqueViolation(e, "refunds_pkey") || isUniqueViolation(e, "refunds_reference_key"))) continue;
      throw e;
    }
    const all = results[2].map(refundFromRow);
    const { refundedAtomic, pendingAtomic } = refundTotals(all);
    if (results[1].length === 0) {
      const fresh = await getRequest(row.id);
      if (fresh && (fresh.paidPayer !== can.payer || fresh.paidAmountAtomic !== can.paidAtomic)) {
        throw refuse("this request's payment changed while the refund was being checked; check it again and sign a fresh message");
      }
      throw refuse(overCap(can.paidAtomic, refundedAtomic, pendingAtomic, row.token));
    }
    return { refund: refundFromRow(results[1][0]), request: row, paidAtomic: can.paidAtomic, refundedAtomic, pendingAtomic };
  }
}

function overCap(paid: bigint, refunded: bigint, pending: bigint, token: Token): string {
  const left = paid - refunded - pending;
  const show = (v: bigint) => `${fromAtomic(v > 0n ? v : 0n, token)} ${token}`;
  if (refunded === 0n && pending === 0n) return `a refund can't be more than was paid (${show(paid)})`;
  return `refunds can't add up to more than was paid (${show(paid)}): ${show(refunded)} is refunded and ${show(pending)} is waiting to land, ` +
    `so at most ${show(left)} can be refunded now`;
}

// ---------------------------------------------------------------- summaries (pages, check_payments, statements)

export interface RefundSummary {
  requestId: string;
  token: Token;
  /** What the request was paid, or null when it isn't paid (or can't be refunded: card, matched, Base). */
  paidAtomic: bigint | null;
  refundedAtomic: bigint;
  pendingAtomic: bigint;
  refunds: RefundRow[];
}

export function summarize(row: RequestRow, refunds: readonly RefundRow[]): RefundSummary {
  const can = refundability(row);
  const mine = refunds.filter((r) => r.requestId === row.id);
  return { requestId: row.id, token: row.token, paidAtomic: can.ok ? can.paidAtomic : null, ...refundTotals(mine), refunds: mine };
}

/** "refunded 0.5 USDC" / "refunded 1 USDC in full" / null when nothing is refunded. */
export function refundedText(s: Pick<RefundSummary, "refundedAtomic" | "paidAtomic" | "token">): string | null {
  if (s.refundedAtomic <= 0n) return null;
  const full = s.paidAtomic !== null && s.refundedAtomic >= s.paidAtomic;
  return `refunded ${fromAtomic(s.refundedAtomic, s.token)} ${s.token}${full ? " in full" : ""}`;
}

// ---------------------------------------------------------------- public shapes (contract: refund*.json)

export interface PublicRefund {
  id: string;
  request_id: string;
  request_link: string;
  recipient: string;
  payer: string;
  token: Token;
  amount: string;
  reference: string;
  /** The memo the refund transfer carries. */
  memo: string;
  status: RefundStatus;
  created_at: string;
  /** The recipient's signed refund message and its signature: the proof the refund came from the wallet that was paid. */
  signed_message: string;
  signature: string;
  confirmed: { signature: string; amount: string; at: string } | null;
}

export function toPublicRefund(r: RefundRow, base: string): PublicRefund {
  return {
    id: r.id,
    request_id: r.requestId,
    request_link: `${base}/r/${r.requestId}`,
    recipient: r.recipient,
    payer: r.payer,
    token: r.token,
    amount: fromAtomic(r.amountAtomic, r.token),
    reference: r.reference,
    memo: `${REFUND_MEMO_PREFIX}${r.id}`,
    status: r.status,
    created_at: r.createdAt,
    signed_message: r.signedMessage,
    signature: r.signature,
    confirmed: r.confirmed ? { signature: r.confirmed.signature, amount: fromAtomic(r.confirmed.amountAtomic, r.token), at: r.confirmed.at } : null,
  };
}

export interface PublicRefundSummary {
  request_id: string;
  token: Token;
  /** What was paid and can be refunded; null when the request isn't paid or its payment can't be refunded here. */
  paid: string | null;
  refunded: string;
  pending: string;
  refundable: string;
  refunds: Array<Pick<PublicRefund, "id" | "amount" | "status" | "created_at" | "confirmed">>;
}

export function toPublicSummary(s: RefundSummary): PublicRefundSummary {
  const left = s.paidAtomic === null ? 0n : s.paidAtomic - s.refundedAtomic - s.pendingAtomic;
  return {
    request_id: s.requestId,
    token: s.token,
    paid: s.paidAtomic === null ? null : fromAtomic(s.paidAtomic, s.token),
    refunded: fromAtomic(s.refundedAtomic, s.token),
    pending: fromAtomic(s.pendingAtomic, s.token),
    refundable: fromAtomic(left > 0n ? left : 0n, s.token),
    refunds: s.refunds.map((r) => ({
      id: r.id,
      amount: fromAtomic(r.amountAtomic, r.token),
      status: r.status,
      created_at: r.createdAt,
      confirmed: r.confirmed ? { signature: r.confirmed.signature, amount: fromAtomic(r.confirmed.amountAtomic, r.token), at: r.confirmed.at } : null,
    })),
  };
}

/** The refunds of these requests, chain-checked when pending (within `rpc`), for GET /refunds?requests= and pages. */
export async function refundSummaries(rows: readonly RequestRow[], rpc: RpcOptions | null): Promise<{ summaries: RefundSummary[]; chainChecked: boolean }> {
  let refunds = await refundsOf(rows.map((r) => r.id));
  let chainChecked = true;
  if (rpc) ({ refunds, chainChecked } = await confirmRefundsSoft(refunds, rpc));
  return { summaries: rows.map((row) => summarize(row, refunds)), chainChecked };
}

/** The daily cron: re-read pending refunds of the last REFUND_CRON_DAYS days, newest first. */
export async function confirmPendingRefunds(rpc: RpcOptions): Promise<{ checked: number; confirmed: string[] }> {
  const rows = (await sql(
    `select ${REFUND_COLUMNS} from refunds where status = 'pending' and created_at > now() - make_interval(days => $1)
      order by created_at desc limit $2`,
    [REFUND_CRON_DAYS, REFUND_CRON_BATCH],
  )).map(refundFromRow);
  if (rows.length === 0) return { checked: 0, confirmed: [] };
  const after = await confirmRefunds(rows, rpc);
  return { checked: rows.length, confirmed: after.filter((r, i) => r.status === "confirmed" && rows[i].status !== "confirmed").map((r) => r.id) };
}
