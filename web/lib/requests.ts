import "server-only";
import { isoUtc, isUniqueViolation, sql, type Row } from "./db";
import { newReference, requestIdFor } from "./ids";
import { fromAtomic, TOKENS, type Token } from "./money";
import { buildTransferUrl } from "./solana-pay";
import { findPayments, type PaymentCheck } from "./validate";
import type { RpcOptions } from "./solana";
import type { PublicRequest, RequestStatus } from "./public-api";
import { x402UrlFor } from "./x402/url";
import { settlePendingX402 } from "./x402/settle";
import { isTeamSql, teamWallets } from "./team"; // W2-F is_team

// Requests: storage, the public shape, and settling them against the chain.

export interface RequestRow {
  id: string;
  kind: PublicRequest["kind"];
  recipient: string;
  token: Token;
  mint: string | null;
  decimals: number;
  amountAtomic: bigint;
  reference: string;
  payerName: string | null;
  forText: string | null;
  note: string | null;
  requesterName: string | null;
  flags: string[];
  status: RequestStatus;
  paidSignature: string | null;
  paidPayer: string | null;
  paidAmountAtomic: bigint | null;
  paidAt: string | null;
  paidRail: "solana_pay" | "x402" | null;
  source: "plugin" | "web";
  createdAt: string;
  // W2-H verified payee. Optional so code that builds rows by hand (W2-A's shares, test doubles) needn't set them.
  fromDomain?: string | null;
  fromDomainVerifiedAt?: string | null;
  // W3-C expiry + cancel (0007). Optional for the same reason. `status` is "expired" once expires_at has passed.
  expiresAt?: string | null;
  cancelledAt?: string | null;
  /** The recipient's signed "Owed cancel <id> for <recipient> at <ISO>" and its signature: the proof. */
  cancelMessage?: string | null;
  cancelSignature?: string | null;
}

// W3-C: an open request past expires_at reads as 'expired' (computed by the database clock on every read).
export const EFFECTIVE_STATUS = `case when status = 'open' and expires_at <= now() then 'expired' else status end`;

export const COLUMNS = `id, kind, recipient, token, mint, decimals, amount_atomic::text as amount_atomic, reference,
  payer_name, for_text, note, requester_name, array_to_json(flags)::text as flags, ${EFFECTIVE_STATUS} as status,
  paid_signature, paid_payer, paid_amount_atomic::text as paid_amount_atomic, ${isoUtc("paid_at")} as paid_at,
  paid_rail, source, ${isoUtc("created_at")} as created_at,
  from_domain, ${isoUtc("from_domain_verified_at")} as from_domain_verified_at,
  ${isoUtc("expires_at")} as expires_at, ${isoUtc("cancelled_at")} as cancelled_at, cancel_message, cancel_signature`;

export function fromRow(r: Row): RequestRow {
  return {
    id: r.id!,
    kind: r.kind as RequestRow["kind"],
    recipient: r.recipient!,
    token: r.token as Token,
    mint: r.mint,
    decimals: Number(r.decimals),
    amountAtomic: BigInt(r.amount_atomic!),
    reference: r.reference!,
    payerName: r.payer_name,
    forText: r.for_text,
    note: r.note,
    requesterName: r.requester_name,
    flags: JSON.parse(r.flags ?? "[]") as string[],
    status: r.status as RequestStatus,
    paidSignature: r.paid_signature,
    paidPayer: r.paid_payer,
    paidAmountAtomic: r.paid_amount_atomic == null ? null : BigInt(r.paid_amount_atomic),
    paidAt: r.paid_at,
    paidRail: r.paid_rail as RequestRow["paidRail"],
    source: r.source as RequestRow["source"],
    createdAt: r.created_at!,
    fromDomain: r.from_domain ?? null,
    fromDomainVerifiedAt: r.from_domain_verified_at ?? null,
    expiresAt: r.expires_at ?? null,
    cancelledAt: r.cancelled_at ?? null,
    cancelMessage: r.cancel_message ?? null,
    cancelSignature: r.cancel_signature ?? null,
  };
}

/**
 * W3-C: statuses whose request can still turn out paid on chain, so reads check the chain first. Expired and
 * cancelled requests are included: a payment that lands after expiry or cancellation (from a solana: link
 * someone kept) moved real money, and it shows as paid rather than hiding behind "expired".
 */
export function chainCheckable(status: RequestStatus): boolean {
  return status === "open" || status === "underpaid" || status === "expired" || status === "cancelled";
}

/** Deterministic from the row, so the URL handed out at creation is always reproduced exactly. */
export function solanaPayUrl(row: RequestRow): string {
  return buildTransferUrl({
    recipient: row.recipient,
    amount: fromAtomic(row.amountAtomic, row.token),
    splToken: row.mint ?? undefined,
    references: [row.reference],
    label: row.requesterName ?? undefined,
    message: row.forText ?? undefined,
    memo: `owed:${row.id}`,
  });
}

/** `base` is the public origin for links; without it the x402 URL is left out. */
export function toPublic(row: RequestRow, base?: string): PublicRequest {
  const settled = (row.status === "paid" || row.status === "underpaid") && row.paidSignature && row.paidAmountAtomic != null;
  return {
    id: row.id,
    kind: row.kind,
    recipient: row.recipient,
    amount: fromAtomic(row.amountAtomic, row.token),
    token: row.token,
    payer_name: row.payerName,
    for: row.forText,
    note: row.note,
    requester_name: row.requesterName,
    status: row.status,
    solana_pay_url: solanaPayUrl(row),
    reference: row.reference,
    x402_url: base ? x402UrlFor(base, row) : null,
    created_at: row.createdAt,
    paid: settled
      ? {
          signature: row.paidSignature!,
          payer: row.paidPayer!,
          amount: fromAtomic(row.paidAmountAtomic!, row.token),
          at: row.paidAt!,
          rail: row.paidRail ?? "solana_pay",
        }
      : null,
    flags: row.flags,
    from_domain: row.fromDomain ?? null,
    from_domain_verified_at: row.fromDomainVerifiedAt ?? null,
    // W3-C expiry + cancel
    expires_at: row.expiresAt ?? null,
    cancelled: row.cancelledAt && row.cancelMessage && row.cancelSignature
      ? { at: row.cancelledAt, signed_message: row.cancelMessage, signature: row.cancelSignature }
      : null,
  };
}

export async function getRequest(id: string): Promise<RequestRow | null> {
  const rows = await sql(`select ${COLUMNS} from requests where id = $1`, [id]);
  return rows.length ? fromRow(rows[0]) : null;
}

export async function getRequests(ids: readonly string[]): Promise<Map<string, RequestRow>> {
  if (ids.length === 0) return new Map();
  const rows = await sql(`select ${COLUMNS} from requests where id = any($1::text[])`, [ids]);
  return new Map(rows.map((r) => [r.id!, fromRow(r)]));
}

export interface CreateInput {
  recipient: string;
  token: Token;
  amountAtomic: bigint;
  payerName: string | null;
  forText: string | null;
  note: string | null;
  requesterName: string | null;
  flags: string[];
  source: "plugin" | "web";
  /** W2-H: only a value returned by requireVerifiedDomain (lib/payee.ts); stamps from_domain_verified_at. */
  fromDomain?: string | null;
  /** W3-C: whole days (1-90, checked by the route); the database sets expires_at = now() + this. */
  expiresInDays?: number | null;
}

export async function createRequest(input: CreateInput): Promise<RequestRow> {
  const { mint, decimals } = TOKENS[input.token];
  for (let attempt = 0; ; attempt++) {
    // The id is derived from the terms (see lib/ids.ts), so it changes whenever the reference does.
    const reference = newReference();
    const id = requestIdFor({ recipient: input.recipient, token: input.token, amountAtomic: input.amountAtomic, reference });
    try {
      const rows = await sql(
        `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference,
           payer_name, for_text, note, requester_name, flags, source, from_domain, from_domain_verified_at, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13,
           $14, case when $14::text is null then null else now() end,
           case when $15::int is null then null else now() + make_interval(days => $15::int) end)
         returning ${COLUMNS}`,
        [
          id,
          input.recipient,
          input.token,
          mint,
          decimals,
          input.amountAtomic,
          reference,
          input.payerName,
          input.forText,
          input.note,
          input.requesterName,
          input.flags,
          input.source,
          input.fromDomain ?? null,
          input.expiresInDays ?? null,
        ],
      );
      return fromRow(rows[0]);
    } catch (e) {
      // A 256-bit reference (and so a 70-bit id) collision is astronomically rare; retry with a fresh one.
      if (attempt < 2 && (isUniqueViolation(e, "requests_pkey") || isUniqueViolation(e, "requests_reference_key"))) continue;
      throw e;
    }
  }
}

/** Write what the chain says. Paid is written once; a transaction can settle only one request. */
async function recordPayment(row: RequestRow, check: PaymentCheck): Promise<RequestRow> {
  const p = check.payment;
  if (check.status === "open" || !p) return row;
  if (check.status === "underpaid" && row.status === "underpaid" && row.paidSignature === p.signature) return row;
  try {
    const rows = await sql(
      `update requests
          set status = $2, paid_signature = $3, paid_payer = $4, paid_amount_atomic = $5,
              paid_at = $6::timestamptz, paid_rail = 'solana_pay',
              is_team = ${isTeamSql("$7", "$4::text")} -- W2-F is_team (lib/team.ts)
        where id = $1 and status in ('open', 'underpaid', 'cancelled') -- W3-C: a late payment to a cancelled request is recorded
        returning ${COLUMNS}`,
      [row.id, check.status, p.signature, p.payer, p.amountAtomic, p.at, teamWallets()],
    );
    if (rows.length) return fromRow(rows[0]);
    return (await getRequest(row.id)) ?? row; // settled concurrently
  } catch (e) {
    if (isUniqueViolation(e, "requests_paid_signature_key")) {
      console.warn(`request ${row.id}: transaction ${p.signature} already settles another request`);
      return row;
    }
    throw e;
  }
}

const RECHECK_MS = 3000;
const lastChecked = new Map<string, number>();

/**
 * Check open and underpaid requests against the chain (at most once per 3 s per id
 * per server instance) and persist any payment found. Throws RpcError if the chain
 * can't be reached within the budget.
 */
export async function settleFromChain(rows: readonly RequestRow[], rpc: RpcOptions = {}): Promise<RequestRow[]> {
  const now = Date.now();
  let due = rows.filter(
    (r) => chainCheckable(r.status) && now - (lastChecked.get(r.id) ?? 0) >= RECHECK_MS,
  );
  if (due.length === 0) return [...rows];

  // x402 payments carry no reference: confirm any settled ones the chain now shows (lib/x402/settle.ts).
  const viaX402 = await settlePendingX402(due, rpc);
  if (viaX402.size > 0) {
    const fresh = await getRequests([...viaX402]);
    rows = rows.map((r) => fresh.get(r.id) ?? r);
    due = due.filter((r) => !viaX402.has(r.id));
    if (due.length === 0) return [...rows];
  }

  const checks = await findPayments(
    due.map((r) => ({ reference: r.reference, recipient: r.recipient, token: r.token, amountAtomic: r.amountAtomic })),
    rpc,
  );
  if (lastChecked.size > 10_000) lastChecked.clear();
  for (const r of due) lastChecked.set(r.id, now);

  const updated = new Map<string, RequestRow>();
  await Promise.all(due.map(async (r, i) => updated.set(r.id, await recordPayment(r, checks[i]))));
  return rows.map((r) => updated.get(r.id) ?? r);
}
