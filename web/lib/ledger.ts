import "server-only";
import { sql } from "./db";
import { fromAtomic, type Token } from "./money";
import { getRequests, settleFromChain, type RequestRow } from "./requests";
import { RpcError } from "./solana";
import type { FiatQuote } from "./fiat"; // local-currency asks

// who_owes_me: a recipient's open requests and what they were paid in the last 30 days. Only
// POST /api/v1/ledger calls this, after a fresh signature from the recipient's wallet.

export const PAID_WINDOW_DAYS = 30;
/** Rows listed per section; totals still cover every row. */
export const LEDGER_MAX_ROWS = 100;
/** Newest open requests checked on chain before answering (findPayments caps the work as well). */
export const CHAIN_CHECK_ROWS = 20;
/** Leaves headroom under the plugin's 4 s API timeout. */
export const CHAIN_BUDGET_MS = 2500;

/**
 * QA-20. Creating a request needs no proof from the recipient (asking on someone's behalf only ever pays
 * them), so a wallet's ledger can hold rows a stranger made, names and amounts included. Every ledger
 * surface says so in these words: the API response, who_owes_me (plugin/src/tools/who_owes_me.ts keeps
 * the same text; web/test/ledger.test.ts checks it) and the CSV export (W3-D).
 */
export const LEDGER_CAUTION =
  "Anyone can create a request that pays your wallet; Owed can't tell which ones you made. Check names and amounts before chasing anyone.";
export const LEDGER_TOTALS_NOTE = "Totals include requests anyone could have made.";
/** Label for requester-written text (payer names, reasons, titles, invoice numbers) on ledger surfaces. */
export const UNVERIFIED_LABEL = "unverified";

/** Brand words a row mentions (`brand_word:<w>` flags): scams use them to look official, so nobody gets chased for these. */
export function brandWords(flags: readonly string[]): string[] {
  return flags.filter((f) => f.startsWith("brand_word:")).map((f) => f.slice("brand_word:".length));
}

export type LedgerStatus = "open" | "underpaid" | "paid";

export interface LedgerEntry {
  id: string;
  kind: RequestRow["kind"];
  /** Where the payer pays: /i/<id> for an invoice, /r/<id> for a request or one share of a split bill. */
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
  /** Split shares: the bill's title and its board (/g/<group_id>). The share's own name is payer_name. */
  group_title: string | null;
  group_link: string | null;
  /** Invoices: the invoice number (null when the invoice shows its id) and the due date, YYYY-MM-DD. */
  invoice_number: string | null;
  due_date: string | null;
  /** W2-H verified payee: the domain checked at creation (display only; the plugin checks DNS itself). */
  from_domain: string | null;
  /** Safety flags such as `brand_word:irs` (SPEC §6). */
  flags: string[];
  // 0012: how it was paid; a payment the recipient matched (it carried no reference); the rest-of links.
  rail?: NonNullable<RequestRow["paidRail"]>;
  matched?: { signature: string; covers: "full" | "rest"; amount: string; confirmed_at: string };
  rest_of?: string;
  rest_request?: string;
  /** Local-currency asks: the quote that locked `amount` (display only). */
  fiat?: FiatQuote;
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
  /** LEDGER_CAUTION: the rows are whatever anyone asked this wallet to be paid. */
  caution: string;
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
  groupTitle: string | null;
  invoiceNumber: string | null;
  dueDate: string | null;
}

// Split shares (0002) and invoices (0003) are request rows; their group or invoice adds the title and number.
const LISTED_COLUMNS = `r.id, count(*) over () as total, r.group_id, g.title as group_title,
         i.invoice_number, to_char(i.due_date, 'YYYY-MM-DD') as due_date
     from requests r
     left join groups g on g.id = r.group_id
     left join invoices i on i.id = r.invoice_id`;
const LIST = `
  (select true as is_open, ${LISTED_COLUMNS}
    where r.recipient = $1 and r.status in ('open', 'underpaid')
      and (r.status <> 'open' or r.expires_at is null or r.expires_at > now()) -- W3-C: an expired request is no longer owed
      and r.pot_id is null -- F7 pots: nobody owes a pot; an unpaid contribution is a scan or a click, not a debt
    order by r.created_at desc, r.id
    limit $2)
  union all
  (select false as is_open, ${LISTED_COLUMNS}
    where r.recipient = $1 and r.status = 'paid' and r.paid_at > now() - make_interval(days => $3)
    order by r.paid_at desc, r.id
    limit $2)`;

// 0012: an underpaid request whose rest is asked in a live follow-up request (requests.rest_of): the follow-up
// carries the remainder, so the parent is neither listed as open nor counted as outstanding (no double count).
const RESTED = `exists (select 1 from requests c where c.rest_of = requests.id
    and (c.status in ('underpaid', 'paid') or (c.status = 'open' and (c.expires_at is null or c.expires_at > now()))))`;

// Totals for the rows a truncated listing left out, by the same rules as contribution().
const REST_TOTALS = `
  select token,
         coalesce(sum(amount_atomic - coalesce(paid_amount_atomic, 0)) filter (where status in ('open', 'underpaid') and not ${RESTED} and pot_id is null), 0)::text as outstanding,
         coalesce(sum(paid_amount_atomic) filter (where status in ('paid', 'underpaid') and paid_at > now() - make_interval(days => $3)
           and not (pot_id is not null and status = 'underpaid')), 0)::text as received, -- F7: partly paid contributions are added by POT_PARTIAL
         count(*) filter (where status in ('open', 'underpaid') and not ${RESTED} and pot_id is null)::int as open_count,
         count(*) filter (where status = 'paid' and paid_at > now() - make_interval(days => $3))::int as paid_count
    from requests
   where recipient = $1 and not (id = any($2::text[]))
     and (status in ('open', 'underpaid') or (status = 'paid' and paid_at > now() - make_interval(days => $3)))
     and (status <> 'open' or expires_at is null or expires_at > now()) -- W3-C: an expired request is no longer owed
   group by token`;

// F7 pots: a partly paid contribution is listed nowhere (nobody owes a pot the rest), but what arrived was received.
const POT_PARTIAL = `
  select token, coalesce(sum(paid_amount_atomic), 0)::text as received
    from requests
   where recipient = $1 and pot_id is not null and status = 'underpaid' and paid_at > now() - make_interval(days => $2)
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

/** 0012: an underpaid request whose remainder a live follow-up request (rest_of) now asks for. */
export function restCarried(row: Pick<RequestRow, "status" | "restRequest">): boolean {
  const child = row.restRequest;
  return row.status === "underpaid" && !!child && (child.status === "open" || child.status === "underpaid" || child.status === "paid");
}

function contribution(row: RequestRow, now: number): Contribution {
  const paid = row.paidAmountAtomic ?? 0n;
  const recent = withinWindow(row.paidAt, now);
  if (row.status === "open") return { outstanding: row.amountAtomic, received: 0n, open: 1, paid: 0 };
  if (restCarried(row)) return { outstanding: 0n, received: recent ? paid : 0n, open: 0, paid: 0 }; // 0012
  if (row.status === "underpaid") {
    const due = row.amountAtomic > paid ? row.amountAtomic - paid : 0n;
    return { outstanding: due, received: recent ? paid : 0n, open: 1, paid: 0 };
  }
  if (row.status === "paid" && recent) return { outstanding: 0n, received: paid, open: 0, paid: 1 };
  return { outstanding: 0n, received: 0n, open: 0, paid: 0 };
}

function entry(row: RequestRow, listed: Listed, base: string): LedgerEntry {
  const status = row.status as LedgerStatus;
  const share = row.kind === "split_share" && listed.groupId !== null;
  const invoice = row.kind === "invoice";
  const out: LedgerEntry = {
    id: row.id,
    kind: row.kind,
    link: `${base}/${invoice ? "i" : "r"}/${row.id}`,
    amount: fromAtomic(row.amountAtomic, row.token),
    token: row.token,
    status,
    payer_name: row.payerName,
    for: row.forText,
    created_at: row.createdAt,
    group_id: listed.groupId,
    group_title: share ? listed.groupTitle : null,
    group_link: share ? `${base}/g/${listed.groupId}` : null,
    invoice_number: invoice ? listed.invoiceNumber : null,
    due_date: invoice ? listed.dueDate : null,
    from_domain: row.fromDomain ?? null,
    flags: row.flags,
    ...(row.fiat && { fiat: row.fiat }),
  };
  const paid = row.paidAmountAtomic ?? 0n;
  if (status === "open") out.amount_due = out.amount;
  if (status === "underpaid") out.amount_due = fromAtomic(row.amountAtomic > paid ? row.amountAtomic - paid : 0n, row.token);
  if ((status === "paid" || status === "underpaid") && row.paidSignature && row.paidAmountAtomic != null) {
    out.amount_paid = fromAtomic(row.paidAmountAtomic, row.token);
    out.payer = row.paidPayer ?? undefined;
    out.signature = row.paidSignature;
    out.paid_at = row.paidAt ?? undefined;
    if (row.paidRail) out.rail = row.paidRail; // 0012
  }
  if (row.match) out.matched = { signature: row.match.signature, covers: row.match.covers, amount: fromAtomic(row.match.amountAtomic, row.token), confirmed_at: row.match.confirmedAt };
  if (row.restOf) out.rest_of = row.restOf;
  if (row.restRequest) out.rest_request = row.restRequest.id;
  return out;
}

export interface LedgerOptions {
  /** Public origin for /r/, /i/ and /g/ links (OWED_BASE_URL in production). */
  base: string;
  now?: number;
  chainBudgetMs?: number;
}

export async function getLedger(recipient: string, { base, now = Date.now(), chainBudgetMs = CHAIN_BUDGET_MS }: LedgerOptions): Promise<Ledger> {
  const listedRows = await sql(LIST, [recipient, LEDGER_MAX_ROWS, PAID_WINDOW_DAYS]);
  const listed = new Map<string, Listed>(listedRows.map((r) => [r.id!, {
    id: r.id!, open: r.is_open === "t", total: Number(r.total), groupId: r.group_id, groupTitle: r.group_title,
    invoiceNumber: r.invoice_number, dueDate: r.due_date,
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
  for (const t of await sql(POT_PARTIAL, [recipient, PAID_WINDOW_DAYS])) { // F7 pots
    if (BigInt(t.received!) > 0n) add(t.token as Token, { outstanding: 0n, received: BigInt(t.received!), open: 0, paid: 0 });
  }

  const open = rows.filter((r) => (r.status === "open" || r.status === "underpaid") && !restCarried(r)); // 0012
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
    caution: LEDGER_CAUTION,
    generated_at: new Date(Math.floor(now / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    chain_checked: chainChecked,
    open: open.map((r) => entry(r, listed.get(r.id)!, base)),
    paid_recently: paid.map((r) => entry(r, listed.get(r.id)!, base)),
    totals,
    truncated,
  };
}
