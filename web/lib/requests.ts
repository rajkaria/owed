import "server-only";
import { isoUtc, isUniqueViolation, sql, type Row } from "./db";
import { newReference, requestIdFor } from "./ids";
import { fromAtomic, TOKENS, type Token } from "./money";
import { buildTransferUrl } from "./solana-pay";
import { findPayments, type ClaimedUnit, type PaymentCheck } from "./validate";
import type { RpcOptions } from "./solana";
import type { PublicRequest, RequestStatus } from "./public-api";
import type { SnsSource } from "./sns"; // W3-S
import { x402UrlFor } from "./x402/url";
import { settlePendingX402 } from "./x402/settle";
import { isTeamSql, teamWallets } from "./team"; // W2-F is_team
import { watchSoon } from "./notify/helius"; // W3-A
import { settlePendingMoonpay } from "./moonpay/settle"; // pay by card (MoonPay)
// W3-B Base requests start
import { BASE_USDC, BASE_USDC_DECIMALS, eip681Transfer, type Chain } from "./evm/base";
import { settleBaseRequests } from "./evm/settle";
import { BaseRpcError } from "./evm/rpc";
import { ApiError } from "./http";
// W3-B Base requests end
import type { FiatQuote } from "./fiat"; // local-currency asks

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
  paidRail: "solana_pay" | "x402" | "base_transfer" | "matched" | "moonpay_card" | null; // 0012: + matched, moonpay_card
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
  // W3-B Base requests: absent means Solana. chainCursor = last Base block scanned for the payment.
  chain?: Chain;
  chainCursor?: bigint | null;
  // 0012 matched payments: the recipient's signed match (lib/match.ts), the request this one asks the rest of,
  // and the follow-up that asks for this one's rest. Optional for the same reason as above.
  match?: MatchRecord | null;
  restOf?: string | null;
  restRequest?: { id: string; status: RequestStatus } | null;
  /** Local-currency asks (0013): the quote that locked amountAtomic. Display only; null or absent for USDC/SOL asks. */
  fiat?: FiatQuote | null;
  // W3-S SNS name payee (0015). Optional for the same reason as the W2-H fields.
  snsName?: string | null;
  snsSource?: SnsSource | null;
  snsResolvedAt?: string | null;
  // F1 payer inbox (0017). Optional for the same reason as the W2-H fields.
  /** Who the request is addressed to: the payer's Solana wallet, and the X handle or .sns name used to find it. */
  payer?: PayerRecord | null;
  /** The requester's own X handle, lower case without "@". A label: never verified by Owed. */
  requesterHandle?: string | null;
  /** Which transfer instruction paid it (lib/validate.ts Credit.instruction); null = the whole transaction. */
  paidInstruction?: number | null;
  // F3 deposit link (0022): the requester's PayBox Open Deposit URL (lib/deposit-link.ts). Never part of the id.
  depositUrl?: string | null;
  depositUrlAddedAt?: string | null;
}

/** F1: who a request is addressed to. `handle` and `sns` are how the requester found `wallet`; labels, never proof. */
export interface PayerRecord {
  wallet: string;
  handle: string | null;
  sns: string | null;
}

/** A payment without the request's reference that the recipient's own wallet attributed to it (0012). */
export interface MatchRecord {
  signature: string;
  /** full: it paid an open request; rest: it paid the remainder of an underpaid one. */
  covers: "full" | "rest";
  payer: string;
  amountAtomic: bigint;
  paidAt: string;
  slot: bigint;
  confirmedBy: string;
  confirmMessage: string;
  confirmSignature: string;
  confirmedAt: string;
}

// W3-C: an open request past expires_at reads as 'expired' (computed by the database clock on every read).
export const EFFECTIVE_STATUS = `case when status = 'open' and expires_at <= now() then 'expired' else status end`;

// 0012: the match row and the rest-of links ride along with every request read (and every RETURNING).
const MATCH_COLUMNS = `rest_of,
  (select json_build_object('id', c.id, 'status', case when c.status = 'open' and c.expires_at <= now() then 'expired' else c.status end)::text
     from requests c where c.rest_of = requests.id) as rest_request,
  (select json_build_object('signature', m.signature, 'covers', m.covers, 'payer', m.payer, 'amount_atomic', m.amount_atomic::text,
          'paid_at', ${isoUtc("m.paid_at")}, 'slot', m.slot::text, 'confirmed_by', m.confirmed_by,
          'confirm_message', m.confirm_message, 'confirm_signature', m.confirm_signature, 'confirmed_at', ${isoUtc("m.confirmed_at")})::text
     from request_matches m where m.request_id = requests.id) as matched`;

export const COLUMNS = `id, kind, recipient, token, mint, decimals, amount_atomic::text as amount_atomic, reference,
  payer_name, for_text, note, requester_name, array_to_json(flags)::text as flags, ${EFFECTIVE_STATUS} as status,
  paid_signature, paid_payer, paid_amount_atomic::text as paid_amount_atomic, ${isoUtc("paid_at")} as paid_at,
  paid_rail, source, ${isoUtc("created_at")} as created_at,
  from_domain, ${isoUtc("from_domain_verified_at")} as from_domain_verified_at,
  ${isoUtc("expires_at")} as expires_at, ${isoUtc("cancelled_at")} as cancelled_at, cancel_message, cancel_signature,
  chain, chain_cursor::text as chain_cursor, ${MATCH_COLUMNS},
  fiat_currency, fiat_amount, fiat_rate, fiat_rate_source, ${isoUtc("fiat_quoted_at")} as fiat_quoted_at,
  sns_name, sns_source, ${isoUtc("sns_resolved_at")} as sns_resolved_at,
  deposit_url, ${isoUtc("deposit_url_added_at")} as deposit_url_added_at,
  payer_wallet, payer_handle, payer_sns, requester_handle, paid_instruction`; // W3-B: chain, chain_cursor; 0012: match; 0013: fiat_*; W3-S: sns_*; F1: payer_*

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
    chain: r.chain === "base" ? "base" : "solana", // W3-B
    chainCursor: r.chain_cursor == null ? null : BigInt(r.chain_cursor), // W3-B
    match: r.matched ? matchFromJson(r.matched) : null, // 0012
    restOf: r.rest_of ?? null,
    restRequest: r.rest_request ? (JSON.parse(r.rest_request) as { id: string; status: RequestStatus }) : null,
    fiat: fiatFromRow(r),
    snsName: r.sns_name ?? null, // W3-S
    snsSource: (r.sns_source as SnsSource | null) ?? null,
    snsResolvedAt: r.sns_resolved_at ?? null,
    payer: r.payer_wallet ? { wallet: r.payer_wallet, handle: r.payer_handle ?? null, sns: r.payer_sns ?? null } : null, // F1
    requesterHandle: r.requester_handle ?? null,
    paidInstruction: r.paid_instruction == null ? null : Number(r.paid_instruction),
    depositUrl: r.deposit_url ?? null, // F3 deposit link
    depositUrlAddedAt: r.deposit_url_added_at ?? null,
  };
}

function matchFromJson(text: string): MatchRecord {
  const m = JSON.parse(text) as Record<string, string>;
  return {
    signature: m.signature,
    covers: m.covers === "rest" ? "rest" : "full",
    payer: m.payer,
    amountAtomic: BigInt(m.amount_atomic),
    paidAt: m.paid_at,
    slot: BigInt(m.slot),
    confirmedBy: m.confirmed_by,
    confirmMessage: m.confirm_message,
    confirmSignature: m.confirm_signature,
    confirmedAt: m.confirmed_at,
  };
}

/** The stored quote of a local-currency ask (0013 keeps the five columns all set or all null). */
export function fiatFromRow(r: Row, amountColumn = "fiat_amount"): FiatQuote | null {
  const amount = r[amountColumn];
  if (!r.fiat_currency || !amount || !r.fiat_rate || !r.fiat_rate_source || !r.fiat_quoted_at) return null;
  return { currency: r.fiat_currency, amount, rate: r.fiat_rate, rate_source: r.fiat_rate_source, quoted_at: r.fiat_quoted_at };
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

// W3-B Base requests start
export function isBaseRow(row: Pick<RequestRow, "chain">): boolean {
  return row.chain === "base";
}

/** What a wallet opens to pay: the Solana Pay URL, or for Base the EIP-681 USDC transfer link. */
export function payUrl(row: RequestRow): string {
  return isBaseRow(row) ? eip681Transfer(row.recipient, row.amountAtomic) : solanaPayUrl(row);
}
// W3-B Base requests end

/** F1: the public shape plus who it is addressed to (only on requests that carry it). */
export type PublicRequestWithPayer = PublicRequest & {
  payer?: { wallet: string; handle: string | null; sns: string | null };
  requester_handle?: string;
  deposit_url?: string; // F3 deposit link
  deposit_url_added_at?: string;
};

/** `base` is the public origin for links; without it the x402 URL is left out. */
export function toPublic(row: RequestRow, base?: string): PublicRequestWithPayer {
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
    solana_pay_url: isBaseRow(row) ? null : solanaPayUrl(row), // W3-B: Base requests have no Solana Pay URL
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
    chain: row.chain ?? "solana", // W3-B
    pay_url: payUrl(row), // W3-B
    // 0012: matched by the recipient (no reference on the payment), and the rest-of links
    matched: row.match ? publicMatch(row.match, row.token) : null,
    rest_of: row.restOf ?? null,
    rest_request: row.restRequest ? { ...row.restRequest, ...(base && { link: `${base}/r/${row.restRequest.id}` }) } : null,
    ...(row.fiat && { fiat: row.fiat }), // local-currency asks: display only, never part of the id
    sns_name: row.snsName ?? null, // W3-S
    sns_source: row.snsSource ?? null,
    sns_resolved_at: row.snsResolvedAt ?? null,
    // F1: only on requests that carry them, so every older shape is unchanged.
    ...(row.payer && { payer: { wallet: row.payer.wallet, handle: row.payer.handle, sns: row.payer.sns } }),
    ...(row.requesterHandle && { requester_handle: row.requesterHandle }),
    // F3 deposit link: only on requests that carry one, so every older shape is unchanged.
    ...(row.depositUrl && row.depositUrlAddedAt && { deposit_url: row.depositUrl, deposit_url_added_at: row.depositUrlAddedAt }),
  };
}

export function publicMatch(m: MatchRecord, token: Token): NonNullable<PublicRequest["matched"]> {
  return {
    signature: m.signature,
    covers: m.covers,
    payer: m.payer,
    amount: fromAtomic(m.amountAtomic, token),
    at: m.paidAt,
    confirmed_by: m.confirmedBy,
    confirmed_at: m.confirmedAt,
    signed_message: m.confirmMessage,
    message_signature: m.confirmSignature,
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
  /** W3-B: "base" makes a USDC request on Base; the recipient must already be a checksummed 0x address. */
  chain?: Chain;
  /** 0012: this request asks for the rest of that underpaid request (lib/match.ts askForRest only). */
  restOf?: string | null;
  /** A local-currency ask's quote (lib/fx.ts); amountAtomic must be the USDC it locks. USDC on Solana only. */
  fiat?: FiatQuote | null;
  /** W3-S: only a value returned by requireSnsName (lib/sns.ts); stores sns_wallet = recipient and stamps sns_resolved_at. */
  sns?: { name: string; source: SnsSource } | null;
  /** F1: only a value returned by requirePayer (lib/inbox-payer.ts). Never part of the id. */
  payer?: PayerRecord | null;
  /** F1: a value returned by parseHandle (lib/inbox-payer.ts). */
  requesterHandle?: string | null;
}

export async function createRequest(input: CreateInput): Promise<RequestRow> {
  // W3-B: a Base request is USDC on Base (lib/evm/base.ts); the 0011 check constraint pins the same.
  const chain: Chain = input.chain ?? "solana";
  if (chain === "base" && input.token !== "USDC") throw new Error("Base requests are USDC only");
  const fiat = input.fiat ?? null;
  if (fiat && (input.token !== "USDC" || chain !== "solana")) throw new Error("local-currency asks are USDC on Solana only");
  const { mint, decimals } = chain === "base" ? { mint: BASE_USDC, decimals: BASE_USDC_DECIMALS } : TOKENS[input.token];
  for (let attempt = 0; ; attempt++) {
    // The id is derived from the terms (see lib/ids.ts), so it changes whenever the reference does.
    const reference = newReference();
    const id = requestIdFor({ recipient: input.recipient, token: input.token, amountAtomic: input.amountAtomic, reference, ...(chain === "base" && { chain }) });
    try {
      const rows = await sql(
        `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference,
           payer_name, for_text, note, requester_name, flags, source, from_domain, from_domain_verified_at, expires_at, chain, rest_of,
           fiat_currency, fiat_amount, fiat_rate, fiat_rate_source, fiat_quoted_at,
           sns_name, sns_wallet, sns_source, sns_resolved_at,
           payer_wallet, payer_handle, payer_sns, requester_handle)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[], $13,
           $14, case when $14::text is null then null else now() end,
           case when $15::int is null then null else now() + make_interval(days => $15::int) end, $16, $17,
           $18, $19, $20, $21, $22::timestamptz,
           $23, case when $23::text is null then null else $2::text end, $24, case when $23::text is null then null else now() end,
           $25, $26, $27, $28)
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
          chain,
          input.restOf ?? null, // 0012
          fiat?.currency ?? null,
          fiat?.amount ?? null,
          fiat?.rate ?? null,
          fiat?.rate_source ?? null,
          fiat?.quoted_at ?? null,
          input.sns?.name ?? null, // W3-S
          input.sns?.source ?? null,
          input.payer?.wallet ?? null, // F1: who it is addressed to (not in the id)
          input.payer?.handle ?? null,
          input.payer?.sns ?? null,
          input.requesterHandle ?? null,
        ],
      );
      watchSoon(); // W3-A: Helius watches the new request's reference key
      return fromRow(rows[0]);
    } catch (e) {
      // A 256-bit reference (and so a 70-bit id) collision is astronomically rare; retry with a fresh one.
      if (attempt < 2 && (isUniqueViolation(e, "requests_pkey") || isUniqueViolation(e, "requests_reference_key"))) continue;
      throw e;
    }
  }
}

/** Write what the chain says. Paid is written once; a transfer can settle only one request (F1: one transaction may pay several). */
async function recordPayment(row: RequestRow, check: PaymentCheck): Promise<RequestRow> {
  const p = check.payment;
  if (check.status === "open" || !p) return row;
  if (check.status === "underpaid" && row.status === "underpaid" && row.paidSignature === p.signature) return row;
  try {
    const rows = await sql(
      `update requests
          set status = $2, paid_signature = $3, paid_payer = $4, paid_amount_atomic = $5,
              paid_at = $6::timestamptz, paid_rail = 'solana_pay',
              paid_instruction = $8::smallint, -- F1: the transfer that paid it (null: the whole transaction)
              is_team = ${isTeamSql("$7", "$4::text")} -- W2-F is_team (lib/team.ts)
        where id = $1 and status in ('open', 'underpaid', 'cancelled') -- W3-C: a late payment to a cancelled request is recorded
        returning ${COLUMNS}`,
      [row.id, check.status, p.signature, p.payer, p.amountAtomic, p.at, teamWallets(), p.instruction ?? null],
    );
    if (rows.length && check.status === "paid") watchSoon(); // W3-A: a paid request leaves the Helius watch
    if (rows.length) return fromRow(rows[0]);
    return (await getRequest(row.id)) ?? row; // settled concurrently
  } catch (e) {
    if (isUniqueViolation(e, "requests_paid_signature_key")) {
      console.warn(`request ${row.id}: transaction ${p.signature}${p.instruction === undefined ? "" : ` (transfer ${p.instruction})`} already settles another request`);
      return row;
    }
    throw e;
  }
}

/**
 * Which of these transactions already settle stored requests, and with which transfer (F1). One transfer naming
 * two requests' references pays only one; the other must find its own (QA-03). A transaction that pays several
 * requests with separate transfers (pay_all) stays a candidate for each of them.
 */
async function claimedUnits(signatures: readonly string[]): Promise<Map<string, ClaimedUnit[]>> {
  const rows = await sql(`select paid_signature, id, paid_instruction from requests where paid_signature = any($1::text[])`, [signatures]);
  const out = new Map<string, ClaimedUnit[]>();
  for (const r of rows) {
    const list = out.get(r.paid_signature!) ?? [];
    list.push({ requestId: r.id!, instruction: r.paid_instruction == null ? null : Number(r.paid_instruction) });
    out.set(r.paid_signature!, list);
  }
  return out;
}

const RECHECK_MS = 3000;
const lastChecked = new Map<string, number>();

/**
 * Check open and underpaid requests against the chain (at most once per 3 s per id
 * per server instance) and persist any payment found. Throws RpcError if the chain
 * can't be reached within the budget.
 */
export async function settleFromChain(rows: readonly RequestRow[], rpc: RpcOptions = {}): Promise<RequestRow[]> {
  // W3-B Base requests start: Base rows settle from Base USDC Transfer logs, never from Solana.
  if (rows.some(isBaseRow)) {
    const solana = rows.filter((r) => !isBaseRow(r));
    const [solanaDone, basePaid] = await Promise.all([
      solana.length ? settleFromChain(solana, rpc) : Promise.resolve([]),
      settleBaseRequests(rows.filter(isBaseRow), { deadline: rpc.deadline, timeoutMs: rpc.timeoutMs }).catch((e: unknown) => {
        // Base unreachable: alone, that's an outage to report; next to Solana rows, Base rows keep their stored state.
        if (solana.length === 0) throw e instanceof BaseRpcError ? new ApiError("upstream_unavailable", "Base RPC is unavailable, try again shortly") : e;
        console.warn(`Base settle skipped: ${e instanceof Error ? e.message : String(e)}`);
        return new Set<string>();
      }),
    ]);
    const fresh = basePaid.size ? await getRequests([...basePaid]) : new Map<string, RequestRow>();
    const byId = new Map(solanaDone.map((r) => [r.id, r]));
    return rows.map((r) => fresh.get(r.id) ?? byId.get(r.id) ?? r);
  }
  // W3-B Base requests end
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

  // MoonPay card purchases carry no reference either: MoonPay names the transaction, the chain confirms it
  // (lib/moonpay/settle.ts). Does nothing, and queries nothing, unless MoonPay is configured.
  const viaCard = await settlePendingMoonpay(due, rpc);
  if (viaCard.size > 0) {
    const fresh = await getRequests([...viaCard]);
    rows = rows.map((r) => fresh.get(r.id) ?? r);
    due = due.filter((r) => !viaCard.has(r.id));
    if (due.length === 0) return [...rows];
  }

  const checks = await findPayments(
    due.map((r) => ({ reference: r.reference, recipient: r.recipient, token: r.token, amountAtomic: r.amountAtomic, requestId: r.id })),
    rpc,
    { claimedUnits },
  );
  if (lastChecked.size > 10_000) lastChecked.clear();
  for (const r of due) lastChecked.set(r.id, now);

  const updated = new Map<string, RequestRow>();
  await Promise.all(due.map(async (r, i) => updated.set(r.id, await recordPayment(r, checks[i]))));
  return rows.map((r) => updated.get(r.id) ?? r);
}
