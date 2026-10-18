import "server-only";
import { sql } from "./db";
import { parseEvmAddress } from "./evm/address";
import { ApiError } from "./http";
import { restCarried } from "./ledger";
import { fromAtomic, type Token } from "./money";
import { getRequests, isBaseRow, settleFromChain, type RequestRow } from "./requests";
import { RpcError } from "./solana";
import { isSolanaAddress } from "./solana-pay";
import type { FiatQuote } from "./fiat";

// F1: the payer inbox behind what_do_i_owe. A requester can address a request to a payer's wallet (lib/inbox-payer.ts);
// POST /api/v1/inbox lists the open and underpaid requests addressed to the wallet that signed
//   "Owed inbox access for <payer> at <ISO time>"
// (PayBox request_wallet_sign, op solanaMessage; W2-D's verifier: ed25519, at most 5 minutes old, single use), and never
// anyone else's. Like the ledger, its rows are whatever anyone asked, so every name, handle and reason is the
// requester's own, unverified; first-time requesters are marked and blocked requesters are hidden.

export const INBOX_PURPOSE = "inbox";
export const BLOCK_PURPOSE = "inbox_block";
/** Rows listed; totals still cover every row. */
export const INBOX_MAX_ROWS = 100;
/** Oldest open requests checked on chain before answering. */
export const INBOX_CHAIN_CHECK_ROWS = 20;
/** Leaves headroom under the plugin's API timeout. */
export const INBOX_CHAIN_BUDGET_MS = 2500;

/** Every inbox surface says this (plugin/src/tools/what_do_i_owe.ts keeps the same text; web/test/inbox-db.test.ts checks). */
export const INBOX_CAUTION =
  "Anyone can address a request to your wallet; Owed doesn't check who sent it. Names, handles and reasons are the requester's own words, and Owed hasn't verified any handle.";

export function inboxPrefix(payer: string): string {
  return `Owed inbox access for ${payer}`;
}

export type BlockAction = "block" | "unblock";

export function blockPrefix(action: BlockAction, requester: string, payer: string): string {
  return `Owed ${action} ${requester} for ${payer}`;
}

export interface InboxEntry {
  id: string;
  kind: RequestRow["kind"];
  /** Where the payer pays: /i/<id> for an invoice, /r/<id> otherwise. */
  link: string;
  status: "open" | "underpaid";
  amount: string;
  /** What is still owed: the amount, or the remainder of an underpaid request. */
  amount_due: string;
  token: Token;
  chain: "solana" | "base";
  /** The wallet the request pays (the requester's own); block takes it. */
  recipient: string;
  requester_name: string | null;
  requester_handle: string | null;
  for: string | null;
  /** DNS-verified when the request was made (display only: pay_link and pay_all check it again). */
  from_domain: string | null;
  /** Resolved on Solana when the request was made (display only: pay_link and pay_all check it again). */
  sns_name: string | null;
  created_at: string;
  expires_at: string | null;
  /** Invoices: the due date, YYYY-MM-DD. */
  due_date: string | null;
  invoice_number: string | null;
  /** Split shares: the bill's title. */
  group_title: string | null;
  /** How the requester found this payer: the X handle or .sns name they used (labels). */
  addressed_as: { handle: string | null; sns: string | null };
  /** No request from this recipient wallet was ever paid by this payer through Owed. */
  first_time: boolean;
  /** Safety flags such as `brand_word:irs`. */
  flags: string[];
  fiat?: FiatQuote;
}

export interface InboxTotal {
  token: Token;
  chain: "solana" | "base";
  amount_due: string;
  count: number;
}

export interface Inbox {
  payer: string;
  caution: string;
  generated_at: string;
  /** False when Solana couldn't be read in time: entries show the stored state. */
  chain_checked: boolean;
  /** Solana requests, oldest first. */
  owed: InboxEntry[];
  /** Base requests, listed apart (paid from a Base wallet, never in pay_all). */
  base: InboxEntry[];
  totals: InboxTotal[];
  /** Open requests from blocked requesters, not listed. */
  blocked_hidden: number;
  /** The requester wallets this payer blocked, newest first (at most 50). */
  blocked_requesters: string[];
  truncated: boolean;
}

interface Listed {
  firstTime: boolean;
  groupTitle: string | null;
  invoiceNumber: string | null;
  dueDate: string | null;
}

// Open and underpaid requests addressed to $1, not expired, not from a blocked requester, oldest first.
const OPEN_FOR = `r.payer_wallet = $1 and r.status in ('open', 'underpaid')
     and (r.status <> 'open' or r.expires_at is null or r.expires_at > now())`;
const BLOCKED = `exists (select 1 from blocked_requesters b where b.payer_wallet = $1 and b.requester_wallet = r.recipient)`;
const LIST = `
  select r.id, count(*) over () as total, g.title as group_title, i.invoice_number, to_char(i.due_date, 'YYYY-MM-DD') as due_date,
         not exists (select 1 from requests p where p.recipient = r.recipient and p.paid_payer = $1 and p.status in ('paid', 'underpaid')) as first_time
    from requests r
    left join groups g on g.id = r.group_id
    left join invoices i on i.id = r.invoice_id
   where ${OPEN_FOR} and not ${BLOCKED}
   order by r.created_at, r.id
   limit $2`;
// Totals for the rows a truncated listing left out (no chain check for them, stored state).
const REST_TOTALS = `
  select r.token, r.chain, coalesce(sum(r.amount_atomic - coalesce(r.paid_amount_atomic, 0)), 0)::text as due, count(*)::int as n
    from requests r
   where ${OPEN_FOR} and not ${BLOCKED} and not (r.id = any($2::text[]))
     and not exists (select 1 from requests c where c.rest_of = r.id)
   group by r.token, r.chain`;
const HIDDEN = `select count(*)::int as n from requests r where ${OPEN_FOR} and ${BLOCKED}`;
const BLOCKED_LIST = `select requester_wallet from blocked_requesters where payer_wallet = $1 order by created_at desc, requester_wallet limit 50`;

function due(row: RequestRow): bigint {
  if (row.status !== "underpaid") return row.amountAtomic;
  const paid = row.paidAmountAtomic ?? 0n;
  return row.amountAtomic > paid ? row.amountAtomic - paid : 0n;
}

function entry(row: RequestRow, listed: Listed, base: string): InboxEntry {
  const invoice = row.kind === "invoice";
  const share = row.kind === "split_share";
  return {
    id: row.id,
    kind: row.kind,
    link: `${base}/${invoice ? "i" : "r"}/${row.id}`,
    status: row.status as "open" | "underpaid",
    amount: fromAtomic(row.amountAtomic, row.token),
    amount_due: fromAtomic(due(row), row.token),
    token: row.token,
    chain: isBaseRow(row) ? "base" : "solana",
    recipient: row.recipient,
    requester_name: row.requesterName,
    requester_handle: row.requesterHandle ?? null,
    for: row.forText,
    from_domain: row.fromDomain ?? null,
    sns_name: row.snsName ?? null,
    created_at: row.createdAt,
    expires_at: row.expiresAt ?? null,
    due_date: invoice ? listed.dueDate : null,
    invoice_number: invoice ? listed.invoiceNumber : null,
    group_title: share ? listed.groupTitle : null,
    addressed_as: { handle: row.payer?.handle ?? null, sns: row.payer?.sns ?? null },
    first_time: listed.firstTime,
    flags: row.flags,
    ...(row.fiat && { fiat: row.fiat }),
  };
}

export interface InboxOptions {
  /** Public origin for /r/ and /i/ links. */
  base: string;
  now?: number;
  chainBudgetMs?: number;
}

export async function getInbox(payer: string, { base, now = Date.now(), chainBudgetMs = INBOX_CHAIN_BUDGET_MS }: InboxOptions): Promise<Inbox> {
  const [listedRows, hiddenRows, blockedRows] = await Promise.all([
    sql(LIST, [payer, INBOX_MAX_ROWS]),
    sql(HIDDEN, [payer]),
    sql(BLOCKED_LIST, [payer]),
  ]);
  const listed = new Map<string, Listed>(listedRows.map((r) => [r.id!, {
    firstTime: r.first_time === "t" || r.first_time === "true",
    groupTitle: r.group_title, invoiceNumber: r.invoice_number, dueDate: r.due_date,
  }]));
  const truncated = Number(listedRows[0]?.total ?? 0) > INBOX_MAX_ROWS;
  const byId = await getRequests([...listed.keys()]);
  let rows = [...listed.keys()].map((id) => byId.get(id)).filter((r): r is RequestRow => r !== undefined);

  // A payment that landed since the last status check must not show as owed (Base rows settle from Base).
  let chainChecked = true;
  const toCheck = rows.filter((r) => r.status === "open" || r.status === "underpaid").slice(0, INBOX_CHAIN_CHECK_ROWS);
  if (toCheck.length > 0) {
    try {
      const settled = new Map((await settleFromChain(toCheck, { deadline: Date.now() + chainBudgetMs, timeoutMs: chainBudgetMs })).map((r) => [r.id, r]));
      rows = rows.map((r) => settled.get(r.id) ?? r);
    } catch (e) {
      if (!(e instanceof RpcError) && !(e instanceof ApiError)) throw e;
      chainChecked = false;
    }
  }
  // Still owed: open or underpaid, and an underpaid one only while no follow-up asks for its rest (that one is listed).
  rows = rows.filter((r) => (r.status === "open" || r.status === "underpaid") && !restCarried(r) && due(r) > 0n);

  const entries = rows.map((r) => entry(r, listed.get(r.id)!, base));
  const sums = new Map<string, { token: Token; chain: "solana" | "base"; due: bigint; count: number }>();
  const add = (token: Token, chain: "solana" | "base", amount: bigint, count: number) => {
    const key = `${chain}:${token}`;
    const s = sums.get(key) ?? { token, chain, due: 0n, count: 0 };
    sums.set(key, { ...s, due: s.due + amount, count: s.count + count });
  };
  for (const r of rows) add(r.token, isBaseRow(r) ? "base" : "solana", due(r), 1);
  if (truncated) {
    for (const t of await sql(REST_TOTALS, [payer, [...listed.keys()]])) {
      add(t.token as Token, t.chain === "base" ? "base" : "solana", BigInt(t.due!), Number(t.n));
    }
  }
  const order = ["solana:USDC", "solana:SOL", "base:USDC"];
  const totals: InboxTotal[] = [...sums.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([, s]) => ({ token: s.token, chain: s.chain, amount_due: fromAtomic(s.due, s.token), count: s.count }));

  return {
    payer,
    caution: INBOX_CAUTION,
    generated_at: new Date(Math.floor(now / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    chain_checked: chainChecked,
    owed: entries.filter((e) => e.chain === "solana"),
    base: entries.filter((e) => e.chain === "base"),
    totals,
    blocked_hidden: Number(hiddenRows[0]?.n ?? 0),
    blocked_requesters: blockedRows.map((r) => r.requester_wallet!),
    truncated,
  };
}

/** The requester wallet as stored on requests: base58 on Solana, EIP-55 on Base. invalid_input otherwise. */
export function parseRequester(input: string): string {
  const s = input.trim();
  if (isSolanaAddress(s)) return s;
  const evm = parseEvmAddress(s);
  if (evm) return evm;
  throw new ApiError("invalid_input", "requester must be the wallet the requests pay: a Solana address, or a Base 0x address");
}

/** Block or unblock one requester wallet for one payer. `changed` is false when it already was so. */
export async function setBlocked(payer: string, requester: string, action: BlockAction): Promise<{ blocked: boolean; changed: boolean }> {
  if (requester === payer) throw new ApiError("invalid_input", "requester: that is your own wallet");
  if (action === "block") {
    const rows = await sql(
      `insert into blocked_requesters (payer_wallet, requester_wallet) values ($1, $2)
       on conflict (payer_wallet, requester_wallet) do nothing returning 1 as changed`,
      [payer, requester],
    );
    return { blocked: true, changed: rows.length === 1 };
  }
  const rows = await sql(`delete from blocked_requesters where payer_wallet = $1 and requester_wallet = $2 returning 1 as changed`, [payer, requester]);
  return { blocked: false, changed: rows.length === 1 };
}
