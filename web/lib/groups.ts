import "server-only";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { isoUtc, isUniqueViolation, sql, transaction, type Query, type Row } from "./db";
import { newReference, requestIdFor } from "./ids";
import { AmountError, fromAtomic, TOKENS, USDC_MINT, type Token } from "./money";
import { chainCheckable, fiatFromRow, getRequests, settleFromChain, solanaPayUrl, toPublic, type RequestRow } from "./requests";
import type { RpcOptions } from "./solana";
import type { PublicRequest, RequestStatus } from "./public-api";
import { watchSoon } from "./notify/helius"; // W3-A
import type { FiatQuote } from "./fiat"; // local-currency splits

// Split bills. A group is one bill split into shares; each share is an ordinary request
// row (kind 'split_share'), so its pay page, /status, check_payments and pay_link all work
// unchanged. A group and its shares are written in one transaction: all or nothing.

export const MIN_PEOPLE = 2;
export const MAX_PEOPLE = 20;
export const GROUP_TEXT_LIMITS = { title: 60, name: 40, requester_name: 40 } as const;

const GROUP_ID = /^[1-9A-HJ-NP-Za-km-z]{12}$/;

export function isGroupId(s: unknown): s is string {
  return typeof s === "string" && GROUP_ID.test(s);
}

export interface GroupTerms {
  recipient: string;
  token: Token;
  totalAtomic: bigint;
  /** Share request ids in board order. Each one already commits to its own recipient, amount and reference. */
  shareIds: readonly string[];
}

/** The group id commits to its shares in order, so a board can't silently gain, lose or reorder a share. */
export function groupIdFor(terms: GroupTerms): string {
  const asset = terms.token === "SOL" ? "SOL" : USDC_MINT;
  const digest = createHash("sha256")
    .update(`owed-group:v1\n${terms.recipient}\n${asset}\n${terms.totalAtomic}\n${terms.shareIds.join("\n")}`, "utf8")
    .digest();
  return bs58.encode(digest).slice(-12);
}

/**
 * Each person's share in atomic units. People with an amount keep it; the rest split what is
 * left evenly, and leftover atomic units go to the first of them. Throws AmountError (user-facing).
 */
export function planShares(totalAtomic: bigint, amounts: ReadonlyArray<bigint | null>): bigint[] {
  if (amounts.length < MIN_PEOPLE || amounts.length > MAX_PEOPLE) {
    throw new AmountError(`a split needs between ${MIN_PEOPLE} and ${MAX_PEOPLE} people`);
  }
  if (totalAtomic <= 0n) throw new AmountError("total must be more than zero");
  let fixed = 0n;
  for (const a of amounts) {
    if (a === null) continue;
    if (a <= 0n) throw new AmountError("every share must be more than zero");
    fixed += a;
  }
  const open = amounts.filter((a) => a === null).length;
  const rest = totalAtomic - fixed;
  if (open === 0) {
    if (rest !== 0n) throw new AmountError("the people's amounts must add up to the total");
    return [...amounts] as bigint[];
  }
  if (rest < BigInt(open)) {
    throw new AmountError(
      rest <= 0n ? "the given amounts already reach the total, so nothing is left for the others" : "total is too small to split this many ways",
    );
  }
  const each = rest / BigInt(open);
  let leftover = rest % BigInt(open);
  return amounts.map((a) => {
    if (a !== null) return a;
    if (leftover > 0n) {
      leftover -= 1n;
      return each + 1n;
    }
    return each;
  });
}

export interface GroupRow {
  id: string;
  title: string | null;
  recipient: string;
  token: Token;
  totalAtomic: bigint;
  requesterName: string | null;
  flags: string[];
  source: "plugin" | "web";
  /** Verified payee domain (display only), with when the server last confirmed it. */
  fromDomain: string | null;
  fromDomainVerifiedAt: string | null;
  createdAt: string;
  shareIds: string[];
  /** Local-currency split (0013): the bill's total in its currency and the one rate every share was locked at. */
  fiat?: FiatQuote | null;
}

const GROUP_COLUMNS = `g.id, g.title, g.recipient, g.token, g.total_atomic::text as total_atomic, g.requester_name,
  array_to_json(g.flags)::text as flags, g.source, g.from_domain, ${isoUtc("g.from_domain_verified_at")} as from_domain_verified_at,
  ${isoUtc("g.created_at")} as created_at,
  g.fiat_currency, g.fiat_total, g.fiat_rate, g.fiat_rate_source, ${isoUtc("g.fiat_quoted_at")} as fiat_quoted_at,
  coalesce((select array_to_json(array_agg(r.id order by r.group_position)) from requests r where r.group_id = g.id), '[]')::text as share_ids`;

function groupFromRow(r: Row): GroupRow {
  return {
    id: r.id!,
    title: r.title,
    recipient: r.recipient!,
    token: r.token as Token,
    totalAtomic: BigInt(r.total_atomic!),
    requesterName: r.requester_name,
    flags: JSON.parse(r.flags ?? "[]") as string[],
    source: r.source as GroupRow["source"],
    fromDomain: r.from_domain,
    fromDomainVerifiedAt: r.from_domain_verified_at,
    createdAt: r.created_at!,
    shareIds: JSON.parse(r.share_ids ?? "[]") as string[],
    fiat: fiatFromRow(r, "fiat_total"),
  };
}

export interface ShareInput {
  name: string | null;
  amountAtomic: bigint;
  flags: string[];
  /** Local-currency split: this share's quote; amountAtomic must be the USDC it locks. */
  fiat?: FiatQuote | null;
}

export interface CreateGroupInput {
  recipient: string;
  token: Token;
  title: string | null;
  requesterName: string | null;
  flags: string[];
  shares: readonly ShareInput[];
  source: "plugin" | "web";
  /** A domain already verified by web/lib/payee.ts `requireVerifiedDomain` (W2-H), or null. */
  fromDomain?: string | null;
  /** W3-C: whole days (1-90, checked by the route); every share gets expires_at = now() + this. */
  expiresInDays?: number | null;
  /** Local-currency split: the bill's total in its currency and the shared rate (amount = the fiat total). */
  fiat?: FiatQuote | null;
}

export interface GroupWithShares {
  group: GroupRow;
  /** In board order. */
  shares: RequestRow[];
}

/** Inserts the group and every share in one transaction. Share ids are derived from their terms (lib/ids.ts). */
export async function createGroup(input: CreateGroupInput): Promise<GroupWithShares> {
  const { mint, decimals } = TOKENS[input.token];
  const totalAtomic = input.shares.reduce((sum, s) => sum + s.amountAtomic, 0n);
  const fromDomain = input.fromDomain ?? null;
  // Shares carry the domain too, so pay_link on a single share checks it (requests.from_domain is W2-H's 0009).
  const shareDomain = fromDomain === null ? ["", ""] : [", from_domain, from_domain_verified_at", ", g.from_domain, g.from_domain_verified_at"];
  for (let attempt = 0; ; attempt++) {
    const shares = input.shares.map((s) => {
      const reference = newReference();
      const id = requestIdFor({ recipient: input.recipient, token: input.token, amountAtomic: s.amountAtomic, reference });
      return { ...s, reference, id };
    });
    const id = groupIdFor({ recipient: input.recipient, token: input.token, totalAtomic, shareIds: shares.map((s) => s.id) });
    const queries: Query[] = [
      {
        text: `insert into groups (id, title, recipient, token, total_atomic, requester_name, flags, source, from_domain, from_domain_verified_at,
                 fiat_currency, fiat_total, fiat_rate, fiat_rate_source, fiat_quoted_at)
               values ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9::text, case when $9::text is null then null else now() end,
                 $10, $11, $12, $13, $14::timestamptz)
               returning ${isoUtc("created_at")} as created_at, ${isoUtc("from_domain_verified_at")} as from_domain_verified_at`,
        params: [
          id, input.title, input.recipient, input.token, totalAtomic, input.requesterName, input.flags, input.source, fromDomain,
          input.fiat?.currency ?? null, input.fiat?.amount ?? null, input.fiat?.rate ?? null, input.fiat?.rate_source ?? null, input.fiat?.quoted_at ?? null,
        ],
      },
      ...shares.map(
        (s, position): Query => ({
          // created_at is copied from the group so the board and its shares share one timestamp.
          text: `insert into requests (id, kind, group_id, group_position, recipient, token, mint, decimals, amount_atomic,
                   reference, payer_name, for_text, requester_name, flags, source, created_at${shareDomain[0]},
                   fiat_currency, fiat_amount, fiat_rate, fiat_rate_source, fiat_quoted_at)
                 select $1, 'split_share', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::text[], $14, g.created_at${shareDomain[1]},
                   $15, $16, $17, $18, $19::timestamptz
                   from groups g where g.id = $2`,
          params: [
            s.id,
            id,
            position,
            input.recipient,
            input.token,
            mint,
            decimals,
            s.amountAtomic,
            s.reference,
            s.name,
            input.title,
            input.requesterName,
            s.flags,
            input.source,
            s.fiat?.currency ?? null,
            s.fiat?.amount ?? null,
            s.fiat?.rate ?? null,
            s.fiat?.rate_source ?? null,
            s.fiat?.quoted_at ?? null,
          ],
        }),
      ),
      // W3-C: the shares expire together, at the transaction's now() + N days (the same instant as created_at).
      ...(input.expiresInDays
        ? [{
            text: `update requests set expires_at = now() + make_interval(days => $2::int) where group_id = $1
                   returning ${isoUtc("expires_at")} as expires_at`,
            params: [id, input.expiresInDays],
          }]
        : []),
    ];
    try {
      const results = await transaction(queries);
      watchSoon(); // W3-A: Helius watches every share's reference key
      const createdAt = results[0][0].created_at!;
      const fromDomainVerifiedAt = results[0][0].from_domain_verified_at;
      const expiresAt = input.expiresInDays ? (results[results.length - 1][0]?.expires_at ?? null) : null; // W3-C
      const group: GroupRow = {
        id,
        title: input.title,
        recipient: input.recipient,
        token: input.token,
        totalAtomic,
        requesterName: input.requesterName,
        flags: input.flags,
        source: input.source,
        fromDomain,
        fromDomainVerifiedAt,
        createdAt,
        shareIds: shares.map((s) => s.id),
        fiat: input.fiat ?? null,
      };
      // Exactly the rows just written (same columns lib/requests.ts reads back).
      const rows: RequestRow[] = shares.map((s) => ({
        id: s.id,
        kind: "split_share",
        recipient: input.recipient,
        token: input.token,
        mint,
        decimals,
        amountAtomic: s.amountAtomic,
        reference: s.reference,
        payerName: s.name,
        forText: input.title,
        note: null,
        requesterName: input.requesterName,
        flags: s.flags,
        status: "open",
        paidSignature: null,
        paidPayer: null,
        paidAmountAtomic: null,
        paidAt: null,
        paidRail: null,
        source: input.source,
        createdAt,
        fromDomain,
        fromDomainVerifiedAt,
        expiresAt, // W3-C
        fiat: s.fiat ?? null,
      }));
      return { group, shares: rows };
    } catch (e) {
      // A collision needs two equal 256-bit references (or a 70-bit id clash); retry with fresh references.
      const collision =
        isUniqueViolation(e, "groups_pkey") || isUniqueViolation(e, "requests_pkey") || isUniqueViolation(e, "requests_reference_key");
      if (attempt < 2 && collision) continue;
      throw e;
    }
  }
}

export async function getGroup(id: string): Promise<GroupRow | null> {
  const rows = await sql(`select ${GROUP_COLUMNS} from groups g where g.id = $1`, [id]);
  return rows.length ? groupFromRow(rows[0]) : null;
}

/**
 * A group and its shares in board order. With `rpc`, open and underpaid shares are checked
 * on chain first (one batched lookup); if the chain can't be read in time the stored state is used.
 */
export async function loadGroup(id: string, rpc: RpcOptions | null = null): Promise<GroupWithShares | null> {
  if (!isGroupId(id)) return null;
  const group = await getGroup(id);
  if (!group) return null;
  const byId = await getRequests(group.shareIds);
  let shares = group.shareIds.map((shareId) => byId.get(shareId)).filter((r): r is RequestRow => r !== undefined);
  if (rpc && shares.some((r) => chainCheckable(r.status))) { // W3-C: expired/cancelled shares may still have been paid
    try {
      shares = await settleFromChain(shares, rpc);
    } catch {
      // Serve the stored state; the board's status polling settles it.
    }
  }
  return { group, shares };
}

export interface PublicShare {
  id: string;
  /** Requester-written, sanitized. Render quoted. */
  name: string | null;
  amount: string;
  status: RequestStatus;
  link: string;
  solana_pay_url: string;
  reference: string;
  paid: PublicRequest["paid"];
  /** Verified payee domain this share carries (W2-H), or null; equals the group's. */
  from_domain: string | null;
  /** Local-currency split: this share in the bill's currency (display only). */
  fiat?: FiatQuote;
}

export interface PublicGroup {
  id: string;
  link: string;
  /** Requester-written, sanitized. Render quoted. */
  title: string | null;
  recipient: string;
  token: Token;
  total: string;
  requester_name: string | null;
  created_at: string;
  flags: string[];
  /** Verified payee domain (display only; W2-H's badge shows it), or null. */
  from_domain: string | null;
  from_domain_verified_at: string | null;
  share_count: number;
  paid_count: number;
  /** What has arrived on chain across all shares, including partial payments. */
  amount_received: string;
  shares: PublicShare[];
  /** W3-C: when the shares stop taking payments (they share one expiry); absent when they never expire. */
  expires_at?: string;
  /** Local-currency split: the bill's total in its currency (display only); `total` is the shares' USDC sum. */
  fiat?: FiatQuote;
}

/** W3-C: the shares' common expiry, only when they have one (so groups without one keep their exact shape). */
function expiryOf(shares: readonly RequestRow[]): { expires_at?: string } {
  const at = shares.find((r) => r.expiresAt)?.expiresAt;
  return at ? { expires_at: at } : {};
}

export function toPublicGroup({ group, shares }: GroupWithShares, base: string): PublicGroup {
  let received = 0n;
  let paidCount = 0;
  const out = shares.map((row): PublicShare => {
    const pub = toPublic(row);
    if (row.status === "paid") paidCount += 1;
    if ((row.status === "paid" || row.status === "underpaid") && row.paidAmountAtomic != null) received += row.paidAmountAtomic;
    return {
      id: row.id,
      name: row.payerName,
      amount: pub.amount,
      status: row.status,
      link: `${base}/r/${row.id}`,
      solana_pay_url: solanaPayUrl(row),
      reference: row.reference,
      paid: pub.paid,
      from_domain: row.fromDomain ?? null,
      ...(row.fiat && { fiat: row.fiat }),
    };
  });
  return {
    id: group.id,
    link: `${base}/g/${group.id}`,
    title: group.title,
    recipient: group.recipient,
    token: group.token,
    total: fromAtomic(group.totalAtomic, group.token),
    requester_name: group.requesterName,
    created_at: group.createdAt,
    flags: group.flags,
    from_domain: group.fromDomain,
    from_domain_verified_at: group.fromDomainVerifiedAt,
    share_count: out.length,
    paid_count: paidCount,
    amount_received: fromAtomic(received, group.token),
    shares: out,
    ...expiryOf(shares), // W3-C
    ...(group.fiat && { fiat: group.fiat }),
  };
}
