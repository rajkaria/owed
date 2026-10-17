import "server-only";
import { sql } from "./db";
import { fromAtomic, type Token } from "./money";
import { getRequests, settleFromChain, type RequestRow } from "./requests";
import { RpcError } from "./solana";

// who_owes_me: a recipient's open requests and what they were paid in the last 30 days. Only
// POST /api/v1/ledger calls this, after a fresh signature from the recipient's wallet.

export const PAID_WINDOW_DAYS = 30;
/** Rows listed per section; totals still cover every row. */
export const LEDGER_MAX_ROWS = 100;
/** Newest open requests checked on chain before answering (findPayments caps the work as well). */
export const CHAIN_CHECK_ROWS = 20;
/** Leaves headroom under the plugin's 4 s API timeout. */
export const CHAIN_BUDGET_MS = 2500;

export type LedgerStatus = "open" | "underpaid" | "paid";

export interface LedgerEntry {
  id: string;
  kind: RequestRow["kind"];
  link: string;
  amount: string;
  token: Token;
  status: LedgerStatus;
  payer_name: string | null;
  for: string | null;
  created_at: string;
  /** What is still owed: the amount, or the remainder of an underpaid request. Open entries only. */
  amount_due?: string;
  amount_paid?: string;
  payer?: string;
  signature?: string;
  paid_at?: string;
  group_id: string | null;
  /** W2-H verified payee: the domain checked at creation (display only). */
  from_domain: string | null;
}

export interface LedgerTotal {
  token: Token;
  outstanding: string;
  received_30d: string;
  open_count: number;
  paid_count: number;
}

export interface Ledger {
  recipient: string;
  generated_at: string;
  /** False when the chain couldn't be read in time: open entries show the stored state. */
  chain_checked: boolean;
  open: LedgerEntry[];
  paid_recently: LedgerEntry[];
  totals: LedgerTotal[];
  truncated: boolean;
}

interface Listed {
  id: string;
  open: boolean;
  total: number;
  groupId: string | null;
  fromDomain: string | null;
}

// from_domain arrives with W2-H's 0009; read through to_jsonb so this works before and after it.
const LIST = `
  (select id, true as is_open, count(*) over () as total, group_id, to_jsonb(r) ->> 'from_domain' as from_domain
     from requests r
    where recipient = $1 and status in ('open', 'underpaid')
    order by created_at desc, id
    limit $2)
  union all
  (select id, false as is_open, count(*) over () as total, group_id, to_jsonb(r) ->> 'from_domain' as from_domain
     from requests r
    where recipient = $1 and status = 'paid' and paid_at > now() - make_interval(days => $3)
    order by paid_at desc, id
    limit $2)`;

// Totals for the rows a truncated listing left out, by the same rules as contribution().
const REST_TOTALS = `
  select token,
         coalesce(sum(amount_atomic - coalesce(paid_amount_atomic, 0)) filter (where status in ('open', 'underpaid')), 0)::text as outstanding,
         coalesce(sum(paid_amount_atomic) filter (where status in ('paid', 'underpaid') and paid_at > now() - make_interval(days => $3)), 0)::text as received,
         count(*) filter (where status in ('open', 'underpaid'))::int as open_count,
         count(*) filter (where status = 'paid' and paid_at > now() - make_interval(days => $3))::int as paid_count
    from requests
   where recipient = $1 and not (id = any($2::text[]))
     and (status in ('open', 'underpaid') or (status = 'paid' and paid_at > now() - make_interval(days => $3)))
   group by token`;

interface Contribution {
  outstanding: bigint;
  received: bigint;
  open: number;
  paid: number;
}

function withinWindow(iso: string | null, now: number): boolean {
  return iso !== null && now - Date.parse(iso) < PAID_WINDOW_DAYS * 86_400_000;
}

function contribution(row: RequestRow, now: number): Contribution {
  const paid = row.paidAmountAtomic ?? 0n;
  const recent = withinWindow(row.paidAt, now);
  if (row.status === "open") return { outstanding: row.amountAtomic, received: 0n, open: 1, paid: 0 };
  if (row.status === "underpaid") {
    const due = row.amountAtomic > paid ? row.amountAtomic - paid : 0n;
    return { outstanding: due, received: recent ? paid : 0n, open: 1, paid: 0 };
  }
  if (row.status === "paid" && recent) return { outstanding: 0n, received: paid, open: 0, paid: 1 };
  return { outstanding: 0n, received: 0n, open: 0, paid: 0 };
}

function entry(row: RequestRow, listed: Listed, base: string): LedgerEntry {
  const status = row.status as LedgerStatus;
  const out: LedgerEntry = {
    id: row.id,
    kind: row.kind,
    link: `${base}/r/${row.id}`,
    amount: fromAtomic(row.amountAtomic, row.token),
    token: row.token,
    status,
    payer_name: row.payerName,
    for: row.forText,
    created_at: row.createdAt,
    group_id: listed.groupId,
    from_domain: listed.fromDomain,
  };
  const paid = row.paidAmountAtomic ?? 0n;
  if (status === "open") out.amount_due = out.amount;
  if (status === "underpaid") out.amount_due = fromAtomic(row.amountAtomic > paid ? row.amountAtomic - paid : 0n, row.token);
  if ((status === "paid" || status === "underpaid") && row.paidSignature && row.paidAmountAtomic != null) {
    out.amount_paid = fromAtomic(row.paidAmountAtomic, row.token);
    out.payer = row.paidPayer ?? undefined;
    out.signature = row.paidSignature;
    out.paid_at = row.paidAt ?? undefined;
  }
  return out;
}

export interface LedgerOptions {
  /** Public origin for /r/<id> links. */
  base: string;
  now?: number;
  chainBudgetMs?: number;
}

export async function getLedger(recipient: string, { base, now = Date.now(), chainBudgetMs = CHAIN_BUDGET_MS }: LedgerOptions): Promise<Ledger> {
  const listedRows = await sql(LIST, [recipient, LEDGER_MAX_ROWS, PAID_WINDOW_DAYS]);
  const listed = new Map<string, Listed>(listedRows.map((r) => [r.id!, {
    id: r.id!, open: r.is_open === "t", total: Number(r.total), groupId: r.group_id, fromDomain: r.from_domain,
  }]));
  const totalOpen = listedRows.find((r) => r.is_open === "t")?.total;
  const totalPaid = listedRows.find((r) => r.is_open !== "t")?.total;
  const truncated = Number(totalOpen ?? 0) > LEDGER_MAX_ROWS || Number(totalPaid ?? 0) > LEDGER_MAX_ROWS;

  const byId = await getRequests([...listed.keys()]);
  let rows = [...listed.keys()].map((id) => byId.get(id)).filter((r): r is RequestRow => r !== undefined);

  // A payment that landed since the last status check must not show as owed.
  let chainChecked = true;
  const toCheck = rows.filter((r) => r.status === "open" || r.status === "underpaid").slice(0, CHAIN_CHECK_ROWS);
  if (toCheck.length > 0) {
    try {
      const settled = new Map((await settleFromChain(toCheck, { deadline: Date.now() + chainBudgetMs, timeoutMs: chainBudgetMs })).map((r) => [r.id, r]));
      rows = rows.map((r) => settled.get(r.id) ?? r);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      chainChecked = false;
    }
  }

  const sums = new Map<Token, Contribution>();
  const add = (token: Token, c: Contribution) => {
    const s = sums.get(token) ?? { outstanding: 0n, received: 0n, open: 0, paid: 0 };
    sums.set(token, { outstanding: s.outstanding + c.outstanding, received: s.received + c.received, open: s.open + c.open, paid: s.paid + c.paid });
  };
  for (const r of rows) add(r.token, contribution(r, now));
  if (truncated) {
    for (const t of await sql(REST_TOTALS, [recipient, rows.map((r) => r.id), PAID_WINDOW_DAYS])) {
      add(t.token as Token, { outstanding: BigInt(t.outstanding!), received: BigInt(t.received!), open: Number(t.open_count), paid: Number(t.paid_count) });
    }
  }

  const open = rows.filter((r) => r.status === "open" || r.status === "underpaid");
  const paid = rows
    .filter((r) => r.status === "paid" && withinWindow(r.paidAt, now))
    .sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? "") || a.id.localeCompare(b.id));
  const totals: LedgerTotal[] = (["USDC", "SOL"] as const)
    .filter((token) => sums.has(token))
    .map((token) => {
      const s = sums.get(token)!;
      return { token, outstanding: fromAtomic(s.outstanding, token), received_30d: fromAtomic(s.received, token), open_count: s.open, paid_count: s.paid };
    });

  return {
    recipient,
    generated_at: new Date(Math.floor(now / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    chain_checked: chainChecked,
    open: open.map((r) => entry(r, listed.get(r.id)!, base)),
    paid_recently: paid.map((r) => entry(r, listed.get(r.id)!, base)),
    totals,
    truncated,
  };
}
