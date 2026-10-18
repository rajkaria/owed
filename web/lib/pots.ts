import "server-only";
import { DbError, isoUtc, isUniqueViolation, sql, type Row } from "./db";
import { ApiError } from "./http";
import { isPotId, newPotNonce, newReference, potIdFor, requestIdFor } from "./ids";
import { AmountError, fromAtomic, toAtomic, TOKENS, type Token } from "./money";
import { watchSoon } from "./notify/helius";
import { clientIp, take } from "./ratelimit";
import { COLUMNS, fromRow, settleFromChain, type RequestRow } from "./requests";
import { RpcError } from "./solana";

// F7 chip-in pots (migration 0019, decision D15). A pot collects contributions for one wallet; each contribution
// is an ordinary request row with pot_id set, minted on demand (a scan of the pot's QR, a click on its board, a
// verified x402 preset payment, or pay_link right before it proposes), so every request rail works on it unchanged.
// The board's total is the sum of what the chain says arrived on paid (and partly paid) contributions.

export const POT_LIMITS = {
  /** A contribution carries the pot's title as its `for` (TEXT_LIMITS.for), so a title is at most 80 characters. */
  title: 80,
  note: 140,
  requesterName: 40,
  presets: 4,
  deadlineDefaultDays: 30,
  deadlineMaxDays: 90,
  /** An ISO deadline must be at least this far ahead. */
  deadlineMinMinutes: 10,
  /** A contribution expires at least(deadline, minted + this). */
  contributionHours: 24,
  /** Contributions listed on the board (the totals count every one). */
  boardRows: 100,
  /** Newest unsettled contributions checked on chain before a board is answered. */
  settleRows: 25,
  settleBudgetMs: 1500,
} as const;

/** Pot creation: per recipient and per client IP, per hour. */
export const POT_CREATE_LIMITS = { perRecipientPerHour: 20, perIpPerHour: 60 } as const;
/**
 * Contribution mints (each is a request row): per client IP per pot, per paying account per pot (transaction
 * requests name the account), per pot and globally per hour, and per pot per day counted from the rows themselves.
 * Generous for a QR on a table at a party; small enough that nobody can flood the requests table.
 */
export const CONTRIBUTION_LIMITS = { perIpPerPotPerHour: 60, perAccountPerPotPerHour: 20, perPotPerHour: 600, globalPerHour: 6000, perPotPerDay: 3000 } as const;
const HOUR = 3600;

export type PotStatus = "open" | "ended";

export interface PotRow {
  id: string;
  recipient: string;
  token: Token;
  nonce: string;
  title: string;
  note: string | null;
  requesterName: string | null;
  requesterHandle: string | null;
  targetAtomic: bigint | null;
  suggestedAtomic: bigint | null;
  anyAmount: boolean;
  presetsAtomic: bigint[];
  deadline: string;
  /** Read with the database clock: the deadline has passed. */
  ended: boolean;
  flags: string[];
  source: "plugin" | "web";
  createdAt: string;
}

const POT_COLUMNS = `id, recipient, token, nonce, title, note, requester_name, requester_handle,
  target_atomic::text as target_atomic, suggested_atomic::text as suggested_atomic, any_amount,
  array_to_json(presets_atomic::text[])::text as presets_atomic, ${isoUtc("deadline")} as deadline, (deadline <= now()) as ended,
  array_to_json(flags)::text as flags, source, ${isoUtc("created_at")} as created_at`;

const truthy = (v: string | null | undefined) => v === "t" || v === "true";

export function potFromRow(r: Row): PotRow {
  return {
    id: r.id!,
    recipient: r.recipient!,
    token: r.token as Token,
    nonce: r.nonce!,
    title: r.title!,
    note: r.note ?? null,
    requesterName: r.requester_name ?? null,
    requesterHandle: r.requester_handle ?? null,
    targetAtomic: r.target_atomic == null ? null : BigInt(r.target_atomic),
    suggestedAtomic: r.suggested_atomic == null ? null : BigInt(r.suggested_atomic),
    anyAmount: truthy(r.any_amount),
    presetsAtomic: (JSON.parse(r.presets_atomic ?? "[]") as string[]).map((s) => BigInt(s)),
    deadline: r.deadline!,
    ended: truthy(r.ended),
    flags: JSON.parse(r.flags ?? "[]") as string[],
    source: r.source as PotRow["source"],
    createdAt: r.created_at!,
  };
}

export async function getPot(id: string): Promise<PotRow | null> {
  if (!isPotId(id)) return null;
  const rows = await sql(`select ${POT_COLUMNS} from pots where id = $1`, [id]);
  return rows.length ? potFromRow(rows[0]) : null;
}

// ---------------------------------------------------------------- amounts

/** "12.5" → atomic units of the pot's token, or invalid_input naming `field`. */
export function potAmount(text: string, token: Token, field: string): bigint {
  try {
    return toAtomic(text, token);
  } catch (e) {
    if (e instanceof AmountError) throw new ApiError("invalid_input", `${field}: ${e.message}`);
    throw e;
  }
}

/** The amounts a contributor may pick when the pot doesn't take any amount: the suggested one, then the presets. */
export function fixedAmounts(pot: Pick<PotRow, "suggestedAtomic" | "presetsAtomic">): bigint[] {
  const out: bigint[] = [];
  for (const a of [...(pot.suggestedAtomic === null ? [] : [pot.suggestedAtomic]), ...pot.presetsAtomic]) if (!out.includes(a)) out.push(a);
  return out;
}

/**
 * The contribution amount for an ask: the amount asked, else the pot's suggested amount. Refuses (invalid_input) when
 * there is neither, or when the pot takes only fixed amounts and this isn't one of them.
 */
export function contributionAmount(pot: PotRow, asked: bigint | null, base: string): bigint {
  const amount = asked ?? pot.suggestedAtomic;
  if (amount === null) {
    throw new ApiError("invalid_input", `amount: this pot has no suggested amount, so say how much to give; pick an amount on the pot page: ${base}/pot/${pot.id}`);
  }
  if (!pot.anyAmount && !fixedAmounts(pot).includes(amount)) {
    const list = fixedAmounts(pot).map((a) => `${fromAtomic(a, pot.token)} ${pot.token}`).join(", ");
    throw new ApiError("invalid_input", `amount: this pot takes ${list} only`);
  }
  return amount;
}

/** Refuses a pot past its deadline (by the database clock) with the words every rail uses. */
export function requireOpen(pot: PotRow): void {
  if (pot.ended) throw new ApiError("invalid_input", potEndedText(pot));
}

export function potEndedText(pot: Pick<PotRow, "deadline">): string {
  return `This pot ended at ${pot.deadline} and no longer takes contributions. Nothing was charged.`;
}

// ---------------------------------------------------------------- create

export interface CreatePotInput {
  recipient: string;
  token: Token;
  title: string;
  note: string | null;
  requesterName: string | null;
  requesterHandle: string | null;
  targetAtomic: bigint | null;
  suggestedAtomic: bigint | null;
  anyAmount: boolean;
  presetsAtomic: bigint[];
  /** Exactly one of these: an exact deadline (already checked by the route), or whole days from now (database clock). */
  deadline: string | null;
  deadlineDays: number | null;
  flags: string[];
  source: "plugin" | "web";
}

export async function createPot(input: CreatePotInput): Promise<PotRow> {
  for (let attempt = 0; ; attempt++) {
    // The id is derived from the terms and a fresh nonce (lib/ids.ts potIdFor).
    const nonce = newPotNonce();
    const id = potIdFor({ recipient: input.recipient, token: input.token, nonce });
    try {
      const rows = await sql(
        `insert into pots (id, recipient, token, nonce, title, note, requester_name, requester_handle,
           target_atomic, suggested_atomic, any_amount, presets_atomic, deadline, flags, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::boolean, $12::numeric[],
           coalesce($13::timestamptz, now() + make_interval(days => $14::int)), $15::text[], $16)
         returning ${POT_COLUMNS}`,
        [
          id, input.recipient, input.token, nonce, input.title, input.note, input.requesterName, input.requesterHandle,
          input.targetAtomic === null ? null : input.targetAtomic.toString(),
          input.suggestedAtomic === null ? null : input.suggestedAtomic.toString(),
          input.anyAmount, input.presetsAtomic.map(String),
          input.deadline, input.deadlineDays ?? POT_LIMITS.deadlineDefaultDays, input.flags, input.source,
        ],
      );
      return potFromRow(rows[0]);
    } catch (e) {
      // 256-bit nonces (and 82-bit ids) never collide in practice; retry with a fresh one if they do.
      if (attempt < 2 && (isUniqueViolation(e, "pots_pkey") || isUniqueViolation(e, "pots_nonce_key"))) continue;
      throw e;
    }
  }
}

/** Per recipient and per client IP. Throws rate_limited. */
export async function requirePotCreateSlot(req: Request, recipient: string): Promise<void> {
  const slot = await take([
    { key: `pot-create:recipient:${recipient}`, max: POT_CREATE_LIMITS.perRecipientPerHour, windowSeconds: HOUR, scope: "recipient" },
    { key: `pot-create:ip:${clientIp(req)}`, max: POT_CREATE_LIMITS.perIpPerHour, windowSeconds: HOUR, scope: "ip" },
  ]);
  if (!slot.allowed) {
    throw new ApiError(
      "rate_limited",
      slot.scope === "recipient" ? "too many new pots for this recipient in the last hour, try again later" : "too many new pots from this client in the last hour, try again later",
      { "Retry-After": String(slot.retryAfterSeconds ?? 60) },
    );
  }
}

// ---------------------------------------------------------------- contributions

/**
 * Before a contribution is minted: per client IP per pot, per paying account per pot (when known), per pot and
 * globally per hour, then the pot's rows in the last 24 hours. Throws rate_limited.
 */
export async function requireContributionSlot(req: Request, potId: string, account?: string | null): Promise<void> {
  const rules = [
    { key: `pot-mint:ip:${potId}:${clientIp(req)}`, max: CONTRIBUTION_LIMITS.perIpPerPotPerHour, windowSeconds: HOUR, scope: "ip" },
    ...(account ? [{ key: `pot-mint:account:${potId}:${account}`, max: CONTRIBUTION_LIMITS.perAccountPerPotPerHour, windowSeconds: HOUR, scope: "account" }] : []),
    { key: `pot-mint:pot:${potId}`, max: CONTRIBUTION_LIMITS.perPotPerHour, windowSeconds: HOUR, scope: "pot" },
    { key: "pot-mint:all", max: CONTRIBUTION_LIMITS.globalPerHour, windowSeconds: HOUR, scope: "global" },
  ];
  const slot = await take(rules);
  const retry = { "Retry-After": String(slot.retryAfterSeconds ?? 60) };
  if (!slot.allowed) {
    const why: Record<string, string> = {
      ip: "too many contributions to this pot from this client in the last hour, try again later",
      account: "too many contributions to this pot from this wallet in the last hour, try again later",
      pot: "this pot is taking too many new contributions right now, try again in a few minutes",
      global: "Owed is handling too many contributions right now, try again in a few minutes",
    };
    throw new ApiError("rate_limited", why[slot.scope ?? "global"] ?? why.global, retry);
  }
  const [day] = await sql(`select count(*)::int as n from requests where pot_id = $1 and created_at > now() - interval '1 day'`, [potId]);
  if (Number(day?.n ?? 0) >= CONTRIBUTION_LIMITS.perPotPerDay) {
    throw new ApiError("rate_limited", "this pot has taken as many contributions as it can today, try again tomorrow", { "Retry-After": "3600" });
  }
}

/**
 * Mint one contribution: an ordinary request (kind 'single') paying the pot's recipient `amountAtomic` of its token,
 * with a fresh reference (so its id is the usual hash of its terms), the pot's title as `for`, its note, name, handle
 * and flags, and expires_at = least(deadline, now + 24 h). One statement: the row is written only while the pot is
 * open by the database clock, with the recipient and token read from the pot row itself. Throws invalid_input when
 * the pot has ended (or doesn't hold these terms).
 */
export async function mintContribution(pot: PotRow, amountAtomic: bigint, source: "plugin" | "web"): Promise<RequestRow> {
  const { mint, decimals } = TOKENS[pot.token];
  for (let attempt = 0; ; attempt++) {
    const reference = newReference();
    const id = requestIdFor({ recipient: pot.recipient, token: pot.token, amountAtomic, reference });
    try {
      const rows = await sql(
        `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference,
           payer_name, for_text, note, requester_name, flags, source, expires_at, requester_handle, pot_id)
         select $1, p.recipient, p.token, $2, $3, $4::numeric, $5,
                null, left(p.title, ${POT_LIMITS.title}), p.note, p.requester_name, p.flags, $6,
                least(p.deadline, now() + make_interval(hours => ${POT_LIMITS.contributionHours})), p.requester_handle, p.id
           from pots p
          where p.id = $7 and p.recipient = $8 and p.token = $9 and p.deadline > now()
         returning ${COLUMNS}`,
        [id, mint, decimals, amountAtomic.toString(), reference, source, pot.id, pot.recipient, pot.token],
      );
      if (rows.length === 0) throw new ApiError("invalid_input", potEndedText(pot));
      watchSoon(); // W3-A: Helius watches the new contribution's reference key
      return fromRow(rows[0]);
    } catch (e) {
      if (attempt < 2 && (isUniqueViolation(e, "requests_pkey") || isUniqueViolation(e, "requests_reference_key"))) continue;
      // The deadline passed between the read and the write (expires_at would not be after created_at).
      if (e instanceof DbError && e.code === "23514") throw new ApiError("invalid_input", potEndedText(pot));
      throw e;
    }
  }
}

// ---------------------------------------------------------------- board

export interface PotContribution {
  id: string;
  /** What arrived on chain (the paid amount), in the pot's token. */
  amountAtomic: bigint;
  payer: string;
  signature: string;
  at: string;
  rail: NonNullable<RequestRow["paidRail"]>;
}

export interface PotBoard {
  pot: PotRow;
  raisedAtomic: bigint;
  count: number;
  /** Newest first, at most POT_LIMITS.boardRows. */
  contributions: PotContribution[];
  /** False when the chain couldn't be read for the newest unsettled contributions; the stored state is shown. */
  chainChecked: boolean;
}

/**
 * The pot and what it raised. First the newest unsettled contributions (minted in the last 2 days, at most
 * POT_LIMITS.settleRows, within `budgetMs`) are settled from the chain like any request read, so a payment that just
 * landed counts. Expired contributions are included: a kept link may still be paid, and the chain is the truth.
 */
export async function loadPotBoard(id: string, { budgetMs = POT_LIMITS.settleBudgetMs, settle = true }: { budgetMs?: number; settle?: boolean } = {}): Promise<PotBoard | null> {
  const pot = await getPot(id);
  if (!pot) return null;
  let chainChecked = true;
  if (settle) {
    const due = (await sql(
      `select ${COLUMNS} from requests
        where pot_id = $1 and status in ('open', 'underpaid') and created_at > now() - interval '2 days'
        order by created_at desc, id limit $2`,
      [id, POT_LIMITS.settleRows],
    )).map(fromRow);
    if (due.length > 0) {
      try {
        await settleFromChain(due, { deadline: Date.now() + budgetMs, timeoutMs: budgetMs });
      } catch (e) {
        if (!(e instanceof RpcError || e instanceof ApiError)) throw e;
        chainChecked = false;
      }
    }
  }
  const [[totals], listed] = await Promise.all([
    sql(
      `select count(*)::int as n, coalesce(sum(paid_amount_atomic), 0)::text as raised
         from requests where pot_id = $1 and status in ('paid', 'underpaid') and paid_amount_atomic is not null`,
      [id],
    ),
    sql(
      `select id, paid_amount_atomic::text as paid_amount_atomic, paid_payer, paid_signature, ${isoUtc("paid_at")} as paid_at,
              coalesce(paid_rail, 'solana_pay') as paid_rail
         from requests
        where pot_id = $1 and status in ('paid', 'underpaid') and paid_amount_atomic is not null and paid_signature is not null
        order by paid_at desc nulls last, id
        limit $2`,
      [id, POT_LIMITS.boardRows],
    ),
  ]);
  return {
    pot,
    raisedAtomic: BigInt(totals?.raised ?? "0"),
    count: Number(totals?.n ?? 0),
    contributions: listed.map((r) => ({
      id: r.id!,
      amountAtomic: BigInt(r.paid_amount_atomic!),
      payer: r.paid_payer ?? "",
      signature: r.paid_signature!,
      at: r.paid_at ?? "",
      rail: r.paid_rail as PotContribution["rail"],
    })),
    chainChecked,
  };
}

// ---------------------------------------------------------------- public shape

export interface PublicPot {
  id: string;
  link: string;
  recipient: string;
  token: Token;
  /** potIdFor(recipient, token, nonce) === id: anyone can check the pot pays this wallet in this token. */
  nonce: string;
  /** Requester-written (sanitized): show quoted, never as a verified identity. */
  title: string;
  note: string | null;
  requester_name: string | null;
  requester_handle: string | null;
  target: string | null;
  suggested: string | null;
  any_amount: boolean;
  presets: string[];
  deadline: string;
  status: PotStatus;
  created_at: string;
  flags: string[];
  totals: { raised: string; count: number };
  contributions: Array<{ id: string; amount: string; payer: string; signature: string; at: string; rail: PotContribution["rail"] }>;
  chain_checked: boolean;
  links: {
    board: string;
    /** Solana Pay transaction requests (QR codes): one per fixed amount; each scan mints a fresh contribution. */
    transaction_request: Array<{ amount: string; url: string }>;
    /** x402 preset endpoints (USDC pots): GET/POST /x/pot/<id>/<amount>. */
    x402: Array<{ amount: string; url: string }>;
  };
}

/** solana:<https link> per the Solana Pay spec: the link is URL-encoded because it carries ?amount=. */
export function potTransactionRequestUrl(base: string, potId: string, amount: string): string {
  return `solana:${encodeURIComponent(`${base}/api/v1/pay/${potId}?amount=${amount}`)}`;
}

export function potX402Url(base: string, potId: string, amount: string): string {
  return `${base}/x/pot/${potId}/${amount}`;
}

export function toPublicPot(pot: PotRow, base: string, board?: Omit<PotBoard, "pot">): PublicPot {
  const amount = (a: bigint) => fromAtomic(a, pot.token);
  const fixed = fixedAmounts(pot).map(amount);
  return {
    id: pot.id,
    link: `${base}/pot/${pot.id}`,
    recipient: pot.recipient,
    token: pot.token,
    nonce: pot.nonce,
    title: pot.title,
    note: pot.note,
    requester_name: pot.requesterName,
    requester_handle: pot.requesterHandle,
    target: pot.targetAtomic === null ? null : amount(pot.targetAtomic),
    suggested: pot.suggestedAtomic === null ? null : amount(pot.suggestedAtomic),
    any_amount: pot.anyAmount,
    presets: pot.presetsAtomic.map(amount),
    deadline: pot.deadline,
    status: pot.ended ? "ended" : "open",
    created_at: pot.createdAt,
    flags: pot.flags,
    totals: { raised: amount(board?.raisedAtomic ?? 0n), count: board?.count ?? 0 },
    contributions: (board?.contributions ?? []).map((c) => ({ id: c.id, amount: amount(c.amountAtomic), payer: c.payer, signature: c.signature, at: c.at, rail: c.rail })),
    chain_checked: board?.chainChecked ?? true,
    links: {
      board: `${base}/pot/${pot.id}`,
      transaction_request: pot.ended ? [] : fixed.map((a) => ({ amount: a, url: potTransactionRequestUrl(base, pot.id, a) })),
      x402: pot.ended || pot.token !== "USDC" ? [] : pot.presetsAtomic.map(amount).map((a) => ({ amount: a, url: potX402Url(base, pot.id, a) })),
    },
  };
}

// ---------------------------------------------------------------- who_owes_me and stats

export interface PotSummary {
  id: string;
  link: string;
  title: string;
  token: Token;
  raised: string;
  count: number;
  target: string | null;
  deadline: string;
  flags: string[];
}

/** POST /api/v1/ledger (who_owes_me): `pots` lists the recipient's open pots; left out when there are none. */
export async function withPots<T extends { recipient: string }>(ledger: T, { base }: { base: string }): Promise<T & { pots?: PotSummary[] }> {
  const pots = await openPotsFor(ledger.recipient, base);
  return pots.length > 0 ? { ...ledger, pots } : ledger;
}

/** GET /api/v1/stats: pots started, and contributions paid (each also counted in paid_count, as the real payment it is). */
export async function potStats(): Promise<{ count: number; paid_contributions: number } | null> {
  try {
    const [row] = await sql(
      `select (select count(*) from pots)::int as pots,
              (select count(*) from requests where pot_id is not null and status = 'paid')::int as paid`,
    );
    return { count: Number(row?.pots ?? 0), paid_contributions: Number(row?.paid ?? 0) };
  } catch (e) {
    if (e instanceof DbError) return null; // the paid numbers never wait on this
    throw e;
  }
}

/** A recipient's open pots, newest first (at most 20), with what each raised so far (stored state). */
export async function openPotsFor(recipient: string, base: string): Promise<PotSummary[]> {
  const rows = await sql(
    `select p.id, p.title, p.token, p.target_atomic::text as target_atomic, ${isoUtc("p.deadline")} as deadline,
            array_to_json(p.flags)::text as flags,
            coalesce((select sum(r.paid_amount_atomic) from requests r where r.pot_id = p.id and r.status in ('paid', 'underpaid')), 0)::text as raised,
            (select count(*) from requests r where r.pot_id = p.id and r.status in ('paid', 'underpaid'))::int as n
       from pots p
      where p.recipient = $1 and p.deadline > now()
      order by p.created_at desc, p.id
      limit 20`,
    [recipient],
  );
  return rows.map((r) => {
    const token = r.token as Token;
    return {
      id: r.id!, link: `${base}/pot/${r.id}`, title: r.title!, token,
      raised: fromAtomic(BigInt(r.raised ?? "0"), token), count: Number(r.n ?? 0),
      target: r.target_atomic == null ? null : fromAtomic(BigInt(r.target_atomic), token),
      deadline: r.deadline!, flags: JSON.parse(r.flags ?? "[]") as string[],
    };
  });
}
