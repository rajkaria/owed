import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isoUtc, sql } from "./db";
import { ApiError } from "./http";
import { csvLine } from "./ledger-csv";
import { LEDGER_CAUTION, UNVERIFIED_LABEL } from "./ledger";
import { fromAtomic, formatUnits, TOKENS, type Token } from "./money";
import { getRequests, settleFromChain, type RequestRow } from "./requests";
import { refundsOf, confirmRefundsSoft, type RefundRow } from "./refunds";
import { sanitizeText } from "./safety";
import { isSolanaAddress } from "./solana-pay";
import type { RequestStatus } from "./public-api";

// F8 invoices: a monthly statement for one client. GET /api/v1/statements takes the recipient's signed ledger message
// (the same "Owed ledger access for <recipient> at <ISO time>" who_owes_me signs: reading your own records), and lists,
// for that client, every invoice to this wallet with what happened in the month: invoiced, cancelled, expired unpaid,
// paid, refunded, and the balance before and after. Its CSV and page links work for 10 minutes and are signed with
// CSV_LINK_SECRET, like the ledger's CSV link.
//
// A client is a payer wallet (the wallet an invoice was addressed to, or the wallet that paid it) or the client name
// written on the invoices (compared without case). Every line is one event of one request:
//   invoiced  +amount  when an invoice-kind request was made (a plan's later installments when they opened)
//   cancelled -amount  when it was cancelled (by the recipient's signature, or because the invoice's other price was paid)
//   expired   -amount  when it stopped taking payments unpaid
//   paid      -paid    when a payment landed (a follow-up for the rest counts toward its invoice)
//   refunded  +amount  when a refund to the payer was confirmed on chain
// The balance is what the client owes (negative: the client paid more than is owed, e.g. twice).

export const STATEMENT_MAX_INVOICES = 200;
export const STATEMENT_LINK_TTL_SECONDS = 10 * 60;
const SIG_CONTEXT = "owed-statement:v1";
const SECRET_MIN_CHARS = 32;
/** Chain reads before answering: open requests (newest first) and pending refunds. */
export const STATEMENT_CHAIN_ROWS = 20;
export const STATEMENT_CHAIN_BUDGET_MS = 2500;

export const STATEMENT_CAUTION = `${LEDGER_CAUTION} A statement lists the invoices whose client name or payer wallet matches, as their creator wrote them.`;

// ---------------------------------------------------------------- inputs (pure)

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function monthRange(month: string): { from: number; to: number } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new ApiError("invalid_input", "month must be written YYYY-MM");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return { from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1) };
}

export function currentMonth(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7);
}

export type Client = { kind: "wallet"; wallet: string; label: string } | { kind: "name"; name: string; label: string };

/** A base58 wallet, or a client name (sanitized like requester text, compared without case). */
export function parseClient(raw: string | null | undefined): Client {
  const text = (raw ?? "").trim();
  if (!text) throw new ApiError("invalid_input", "client is required: the client's name as written on the invoices, or their wallet");
  if (text.length > 64 * 4) throw new ApiError("invalid_input", "client is too long");
  if (isSolanaAddress(text)) return { kind: "wallet", wallet: text, label: text };
  const name = sanitizeText(text, 60);
  if (!name) throw new ApiError("invalid_input", "client is empty once links and control characters are removed");
  return { kind: "name", name: name.toLowerCase(), label: name };
}

// ---------------------------------------------------------------- the statement

export type StatementKind = "invoiced" | "cancelled" | "expired" | "paid" | "refunded";

export interface StatementEvent {
  at: string;
  kind: StatementKind;
  requestId: string;
  /** The invoice row it belongs to (null for a follow-up request for the rest). */
  invoiceId: string | null;
  invoiceNumber: string | null;
  description: string;
  token: Token;
  /** Positive: what the event adds to the balance or takes off it (see kind). */
  amountAtomic: bigint;
  signature: string | null;
  link: string;
}

export interface StatementTotal {
  token: Token;
  opening: bigint;
  invoiced: bigint;
  cancelled: bigint;
  paid: bigint;
  refunded: bigint;
  closing: bigint;
}

export interface StatementInvoice {
  id: string;
  invoice_number: string | null;
  issue_date: string;
  due_date: string;
  total: string;
  token: Token;
  status: RequestStatus;
  link: string;
}

export interface Statement {
  recipient: string;
  client: string;
  month: string;
  from: string;
  to: string;
  generated_at: string;
  caution: string;
  chain_checked: boolean;
  invoices: StatementInvoice[];
  lines: Array<{
    at: string; kind: StatementKind; request_id: string; invoice_id: string | null; invoice_number: string | null;
    description: string; token: Token; amount: string; signature: string | null; link: string;
  }>;
  totals: Array<{ token: Token; opening: string; invoiced: string; cancelled: string; paid: string; refunded: string; closing: string }>;
  truncated: boolean;
}

const SIGN: Record<StatementKind, 1n | -1n> = { invoiced: 1n, cancelled: -1n, expired: -1n, paid: -1n, refunded: 1n };

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

/** The events of one request, pure: what was invoiced, ended, paid and refunded, and when. */
export function requestEvents(
  r: RequestRow,
  meta: { invoiceId: string | null; invoiceNumber: string | null; description: string; link: string; countsAsInvoiced: boolean },
  refunds: readonly RefundRow[],
): StatementEvent[] {
  const base = { requestId: r.id, invoiceId: meta.invoiceId, invoiceNumber: meta.invoiceNumber, description: meta.description, token: r.token, link: meta.link };
  const out: StatementEvent[] = [];
  if (meta.countsAsInvoiced) out.push({ ...base, at: r.createdAt, kind: "invoiced", amountAtomic: r.amountAtomic, signature: null });
  if (meta.countsAsInvoiced && r.cancelledAt) out.push({ ...base, at: r.cancelledAt, kind: "cancelled", amountAtomic: r.amountAtomic, signature: null });
  else if (meta.countsAsInvoiced && r.status === "expired" && r.expiresAt) out.push({ ...base, at: r.expiresAt, kind: "expired", amountAtomic: r.amountAtomic, signature: null });
  const paid = r.status === "paid" || r.status === "underpaid" ? (r.paidAmountAtomic ?? 0n) : 0n;
  if (paid > 0n && r.paidAt) {
    // 0012: a matched rest is its own payment, at its own time.
    const rest = r.match?.covers === "rest" ? r.match : null;
    const first = rest ? paid - rest.amountAtomic : paid;
    if (first > 0n) out.push({ ...base, at: r.paidAt, kind: "paid", amountAtomic: first, signature: r.paidSignature });
    if (rest) out.push({ ...base, at: rest.paidAt, kind: "paid", amountAtomic: rest.amountAtomic, signature: rest.signature });
  }
  for (const f of refunds) {
    if (f.requestId === r.id && f.status === "confirmed" && f.confirmed) {
      out.push({ ...base, at: f.confirmed.at, kind: "refunded", amountAtomic: f.amountAtomic, signature: f.confirmed.signature });
    }
  }
  return out;
}

/** Opening balance (events before `from`), the month's events, and the closing balance, per token. Pure. */
export function fold(events: readonly StatementEvent[], from: number, to: number): { lines: StatementEvent[]; totals: StatementTotal[] } {
  const sums = new Map<Token, StatementTotal>();
  const total = (t: Token) => {
    let s = sums.get(t);
    if (!s) sums.set(t, (s = { token: t, opening: 0n, invoiced: 0n, cancelled: 0n, paid: 0n, refunded: 0n, closing: 0n }));
    return s;
  };
  const lines: StatementEvent[] = [];
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at) || a.requestId.localeCompare(b.requestId))) {
    const at = Date.parse(e.at);
    if (at >= to) continue;
    const s = total(e.token);
    const signed = SIGN[e.kind] * e.amountAtomic;
    if (at < from) {
      s.opening += signed;
      continue;
    }
    lines.push(e);
    if (e.kind === "invoiced") s.invoiced += e.amountAtomic;
    else if (e.kind === "paid") s.paid += e.amountAtomic;
    else if (e.kind === "refunded") s.refunded += e.amountAtomic;
    else s.cancelled += e.amountAtomic;
  }
  for (const s of sums.values()) s.closing = s.opening + s.invoiced - s.cancelled - s.paid + s.refunded;
  const totals = (["USDC", "SOL"] as const).filter((t) => sums.has(t)).map((t) => sums.get(t)!);
  return { lines, totals };
}

const signedAmount = (v: bigint, token: Token) => formatUnits(v, TOKENS[token].decimals);

export interface StatementOptions {
  base: string;
  now?: number;
  /** Chain reads before answering; null: stored state only (the CSV and the page, right after the signed call). */
  chainBudgetMs?: number | null;
}

export async function buildStatement(recipient: string, client: Client, month: string, { base, now = Date.now(), chainBudgetMs = STATEMENT_CHAIN_BUDGET_MS }: StatementOptions): Promise<Statement> {
  const { from, to } = monthRange(month);
  const match = client.kind === "wallet"
    ? `(r.payer_wallet = $3 or r.paid_payer = $3)`
    : `lower(i.client_name) = $3`;
  const rows = await sql(
    `select i.id, i.invoice_number, to_char(i.due_date, 'YYYY-MM-DD') as due_date, ${isoUtc("i.created_at")} as created_at,
            i.total_atomic::text as total_atomic, count(*) over () as total
       from invoices i join requests r on r.id = i.id
      where i.recipient = $1 and i.created_at < to_timestamp($2::double precision / 1000) and ${match}
      order by i.created_at, i.id
      limit $4`,
    [recipient, to, client.kind === "wallet" ? client.wallet : client.name, STATEMENT_MAX_INVOICES],
  );
  const truncated = Number(rows[0]?.total ?? 0) > rows.length;
  const invoiceIds = rows.map((r) => r.id!);
  const info = new Map(rows.map((r) => [r.id!, { number: r.invoice_number, due: r.due_date! }]));
  // Follow-up requests for the rest of an underpaid invoice pay toward it.
  const restRows = invoiceIds.length
    ? await sql(`select id, rest_of from requests where rest_of = any($1::text[])`, [invoiceIds])
    : [];
  const restOf = new Map(restRows.map((r) => [r.id!, r.rest_of!]));
  let requests = [...(await getRequests([...invoiceIds, ...restOf.keys()])).values()];
  let refunds = await refundsOf(requests.map((r) => r.id));
  let chainChecked = true;
  if (chainBudgetMs) {
    const rpc = { deadline: Date.now() + chainBudgetMs, timeoutMs: chainBudgetMs };
    const open = requests.filter((r) => r.status === "open" || r.status === "underpaid").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, STATEMENT_CHAIN_ROWS);
    if (open.length) {
      try {
        const fresh = new Map((await settleFromChain(open, rpc)).map((r) => [r.id, r]));
        requests = requests.map((r) => fresh.get(r.id) ?? r);
      } catch {
        chainChecked = false;
      }
    }
    const confirmed = await confirmRefundsSoft(refunds, rpc);
    refunds = confirmed.refunds;
    chainChecked &&= confirmed.chainChecked;
  }
  const byId = new Map(requests.map((r) => [r.id, r]));
  const events: StatementEvent[] = [];
  for (const r of requests) {
    const invoiceId = info.has(r.id) ? r.id : null;
    const parentId = invoiceId ?? restOf.get(r.id) ?? null;
    const meta = info.get(parentId ?? "");
    const number = meta?.number ?? null;
    const description = invoiceId
      ? `${number ? `Invoice ${number}` : `Invoice ${r.id}`}, due ${meta!.due}`
      : `Rest of invoice ${number ?? parentId}`;
    events.push(...requestEvents(r, {
      invoiceId: parentId, invoiceNumber: number, description,
      link: `${base}/${invoiceId ? "i" : "r"}/${r.id}`, countsAsInvoiced: invoiceId !== null,
    }, refunds));
  }
  const { lines, totals } = fold(events, from, to);
  const touched = new Set(lines.map((l) => l.invoiceId).filter((x): x is string => !!x));
  const invoices: StatementInvoice[] = rows
    .filter((r) => {
      if (touched.has(r.id!)) return true;
      const q = byId.get(r.id!);
      return q !== undefined && (q.status === "open" || q.status === "underpaid");
    })
    .map((r) => {
      const q = byId.get(r.id!)!;
      return {
        id: r.id!, invoice_number: r.invoice_number, issue_date: r.created_at!.slice(0, 10), due_date: r.due_date!,
        // The invoice's total (for a plan or an early price, the whole invoice; its lines show each request).
        total: fromAtomic(BigInt(r.total_atomic!), q.token), token: q.token, status: q.status, link: `${base}/i/${r.id}`,
      };
    });
  return {
    recipient,
    client: client.label,
    month,
    from: iso(from),
    to: iso(to),
    generated_at: iso(Math.floor(now / 1000) * 1000),
    caution: STATEMENT_CAUTION,
    chain_checked: chainChecked,
    invoices,
    lines: lines.map((l) => ({
      at: l.at, kind: l.kind, request_id: l.requestId, invoice_id: l.invoiceId, invoice_number: l.invoiceNumber,
      description: l.description, token: l.token, amount: fromAtomic(l.amountAtomic, l.token), signature: l.signature, link: l.link,
    })),
    totals: totals.map((t) => ({
      token: t.token, opening: signedAmount(t.opening, t.token), invoiced: fromAtomic(t.invoiced, t.token), cancelled: fromAtomic(t.cancelled, t.token),
      paid: fromAtomic(t.paid, t.token), refunded: fromAtomic(t.refunded, t.token), closing: signedAmount(t.closing, t.token),
    })),
    truncated,
  };
}

// ---------------------------------------------------------------- 10-minute links (CSV and page)

function secret(): string | null {
  const s = process.env.CSV_LINK_SECRET?.trim();
  return s && s.length >= SECRET_MIN_CHARS ? s : null;
}

function mac(key: string, recipient: string, client: string, month: string, expires: number): Buffer {
  return createHmac("sha256", key).update(`${SIG_CONTEXT}\n${recipient}\n${client}\n${month}\n${expires}`, "utf8").digest();
}

export interface StatementLink {
  url: string;
  expires_at: string;
}

/** The CSV and page links for this statement, valid 10 minutes; null each when CSV_LINK_SECRET isn't set. */
export function statementLinks(recipient: string, client: string, month: string, base: string, now: number = Date.now()): { csv: StatementLink | null; page: StatementLink | null } {
  const key = secret();
  if (!key) return { csv: null, page: null };
  const expires = Math.floor(now / 1000) + STATEMENT_LINK_TTL_SECONDS;
  const q = new URLSearchParams({ recipient, client, month, expires: String(expires), sig: mac(key, recipient, client, month, expires).toString("base64url") });
  const expires_at = iso(expires * 1000);
  return { csv: { url: `${base}/api/v1/statements/csv?${q}`, expires_at }, page: { url: `${base}/i/statement?${q}`, expires_at } };
}

export type StatementLinkCheck =
  | { ok: true; recipient: string; client: string; month: string }
  | { ok: false; status: 400 | 403 | 410 | 503; message: string };

export function checkStatementLink(params: URLSearchParams, now: number = Date.now()): StatementLinkCheck {
  const key = secret();
  if (!key) return { ok: false, status: 503, message: "statement links aren't configured on this server" };
  const recipient = params.get("recipient") ?? "";
  const client = params.get("client") ?? "";
  const month = params.get("month") ?? "";
  const expiresText = params.get("expires") ?? "";
  const sig = params.get("sig") ?? "";
  if (!isSolanaAddress(recipient) || !client || client.length > 256 || !MONTH_RE.test(month) || !/^[1-9][0-9]{0,11}$/.test(expiresText) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return { ok: false, status: 400, message: "this isn't a complete statement link; ask for a fresh statement" };
  }
  const expires = Number(expiresText);
  const given = Buffer.from(sig, "base64url");
  const want = mac(key, recipient, client, month, expires);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, status: 403, message: "this statement link wasn't issued by Owed" };
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds > expires) return { ok: false, status: 410, message: "this statement link has expired (links last 10 minutes); ask for a fresh statement" };
  if (expires - nowSeconds > STATEMENT_LINK_TTL_SECONDS + 60) return { ok: false, status: 403, message: "this statement link is valid for longer than Owed issues" };
  return { ok: true, recipient, client, month };
}

// ---------------------------------------------------------------- CSV

export const STATEMENT_CSV_COLUMNS = [
  "at", "kind", "request_id", "invoice_id", `invoice_number (${UNVERIFIED_LABEL})`, "description", "token", "amount", "balance_effect", "solscan_url", "link",
] as const;

/** The statement as CSV (UTF-8 with a BOM, CRLF): the caution, who and when, the lines, then one total row per token. */
export function statementCsv(s: Statement): string {
  const out = [
    csvLine([`# ${s.caution}`]),
    csvLine([`# Statement for client ${s.client} (${UNVERIFIED_LABEL}), wallet ${s.recipient}, ${s.month} (${s.from} to ${s.to}), generated ${s.generated_at}`]),
    csvLine(STATEMENT_CSV_COLUMNS),
  ];
  for (const l of s.lines) {
    const effect = SIGN[l.kind] > 0n ? `+${l.amount}` : `-${l.amount}`;
    out.push(csvLine([l.at, l.kind, l.request_id, l.invoice_id, l.invoice_number, l.description, l.token, l.amount, effect,
      l.signature ? `https://solscan.io/tx/${l.signature}` : null, l.link]));
  }
  out.push(csvLine(["token", "opening_balance", "invoiced", "cancelled_or_expired", "paid", "refunded", "closing_balance"]));
  for (const t of s.totals) out.push(csvLine([t.token, t.opening, t.invoiced, t.cancelled, t.paid, t.refunded, t.closing]));
  if (s.truncated) out.push(csvLine([`# Only the first ${STATEMENT_MAX_INVOICES} invoices for this client are included.`]));
  return `﻿${out.join("\r\n")}\r\n`;
}

export function statementFilename(recipient: string, month: string): string {
  return `owed-statement-${recipient.slice(0, 4)}-${recipient.slice(-4)}-${month}.csv`;
}
