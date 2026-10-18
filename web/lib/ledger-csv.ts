import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isoUtc, sql } from "./db";
import { LEDGER_CAUTION, UNVERIFIED_LABEL } from "./ledger";
import { fromAtomic, type Token } from "./money";

// CSV export of a recipient's ledger (W3-D). who_owes_me asks for it after the same wallet-signature gate as
// the ledger itself (POST /api/v1/ledger with csv: true); the reply carries a link that works for 10 minutes:
// GET /api/v1/ledger/csv?recipient=…&expires=…&sig=…, sig = HMAC-SHA256(CSV_LINK_SECRET, recipient + expiry).
// The link is the only credential, so it is short-lived, never cached and never sent as a referrer.

export const CSV_LINK_TTL_SECONDS = 10 * 60;
/** A secret shorter than this is treated as unset: links can't be minted or checked. */
export const CSV_SECRET_MIN_CHARS = 32;
/** Rows in one export, newest first. */
export const CSV_MAX_ROWS = 10_000;

const SIG_CONTEXT = "owed-ledger-csv:v1";

function secret(): string | null {
  const s = process.env.CSV_LINK_SECRET?.trim();
  return s && s.length >= CSV_SECRET_MIN_CHARS ? s : null;
}

export function csvExportEnabled(): boolean {
  return secret() !== null;
}

function mac(key: string, recipient: string, expires: number): Buffer {
  return createHmac("sha256", key).update(`${SIG_CONTEXT}\n${recipient}\n${expires}`, "utf8").digest();
}

export interface CsvLink {
  url: string;
  /** ISO time, whole seconds. */
  expires_at: string;
}

/** A link to `recipient`'s CSV valid for 10 minutes from `now`, or null when CSV_LINK_SECRET isn't set. */
export function csvLink(recipient: string, base: string, now: number = Date.now()): CsvLink | null {
  const key = secret();
  if (!key) return null;
  const expires = Math.floor(now / 1000) + CSV_LINK_TTL_SECONDS;
  const sig = mac(key, recipient, expires).toString("base64url");
  const q = new URLSearchParams({ recipient, expires: String(expires), sig });
  return { url: `${base}/api/v1/ledger/csv?${q}`, expires_at: new Date(expires * 1000).toISOString().replace(".000Z", "Z") };
}

export type CsvLinkCheck =
  | { ok: true; recipient: string; expires: number }
  | { ok: false; status: 400 | 403 | 410 | 503; message: string };

/** Checks a link's query: well-formed, signed by this server, not expired, never longer than 10 minutes. */
export function checkCsvLink(params: URLSearchParams, now: number = Date.now()): CsvLinkCheck {
  const key = secret();
  if (!key) return { ok: false, status: 503, message: "CSV export isn't configured on this server" };
  const recipient = params.get("recipient") ?? "";
  const expiresText = params.get("expires") ?? "";
  const sig = params.get("sig") ?? "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient) || !/^[1-9][0-9]{0,11}$/.test(expiresText) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return { ok: false, status: 400, message: "this isn't a complete CSV link; ask who_owes_me for a fresh one" };
  }
  const expires = Number(expiresText);
  const given = Buffer.from(sig, "base64url");
  const want = mac(key, recipient, expires);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, status: 403, message: "this CSV link wasn't issued by Owed for this wallet" };
  }
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds > expires) {
    return { ok: false, status: 410, message: "this CSV link has expired (links last 10 minutes); ask who_owes_me for a fresh one" };
  }
  // Signed by us, so this only guards against a future change minting longer links by mistake.
  if (expires - nowSeconds > CSV_LINK_TTL_SECONDS + 60) {
    return { ok: false, status: 403, message: "this CSV link is valid for longer than Owed issues; ask who_owes_me for a fresh one" };
  }
  return { ok: true, recipient, expires };
}

// ---------------------------------------------------------------- the file

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One CSV cell: always quoted (RFC 4180), quotes doubled, and a leading = + - @ tab or CR prefixed with
 * an apostrophe so a spreadsheet shows the text instead of running it as a formula.
 */
export function csvCell(value: string | null | undefined): string {
  let s = value ?? "";
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(values: ReadonlyArray<string | null | undefined>): string {
  return values.map(csvCell).join(",");
}

/**
 * QA-20: creating a request needs no proof of the recipient, so anyone can add rows that pay your wallet.
 * The export's first row says so in the ledger's own words (W2-D's LEDGER_CAUTION), before the header,
 * as one quoted cell so every spreadsheet keeps it whole whatever its separator.
 */
export const CSV_CAUTION = `# ${LEDGER_CAUTION} Columns marked (${UNVERIFIED_LABEL}) are as each request's creator wrote them.`;

export const CSV_COLUMNS = [
  "request_id",
  "kind",
  "status",
  "amount",
  "token",
  "amount_paid",
  "payer_wallet",
  "solscan_url",
  "created_at",
  "paid_at",
  `payer_name (${UNVERIFIED_LABEL})`,
  `for (${UNVERIFIED_LABEL})`,
  `invoice_number (${UNVERIFIED_LABEL})`,
  "link",
  "from_domain",
  "schedule_id",
  "period",
  // Local-currency asks: the quote that locked `amount` (USDC). Empty for USDC/SOL asks.
  "quote_currency",
  "quote_amount",
  "quote_rate_per_usdc",
  "quote_locked_at",
] as const;

/**
 * Every open, underpaid and paid request for `recipient`, newest first, as CSV text (UTF-8 with a BOM so
 * spreadsheet apps read non-ASCII names correctly; CRLF line ends): the caution line, the header, the rows.
 * Stored state: the ledger call that minted the link has just checked open requests on chain.
 */
export async function ledgerCsv(recipient: string, base: string): Promise<{ text: string; rows: number; truncated: boolean }> {
  const rows = await sql(
    `select r.id, r.kind, r.status, r.token, r.amount_atomic::text as amount_atomic,
            r.paid_amount_atomic::text as paid_amount_atomic, r.paid_payer, r.paid_signature,
            ${isoUtc("r.created_at")} as created_at, ${isoUtc("r.paid_at")} as paid_at,
            r.payer_name, r.for_text, i.invoice_number, r.from_domain, sr.schedule_id, sr.period,
            r.fiat_currency, r.fiat_amount, r.fiat_rate, ${isoUtc("r.fiat_quoted_at")} as fiat_quoted_at,
            count(*) over () as total
       from requests r
       left join invoices i on i.id = r.invoice_id
       left join schedule_requests sr on sr.request_id = r.id
      where r.recipient = $1 and r.status in ('open', 'underpaid', 'paid')
        and (r.pot_id is null or r.status <> 'open') -- F7 pots: an unpaid contribution is a scan or a click, not a debt
      order by r.created_at desc, r.id
      limit $2`,
    [recipient, CSV_MAX_ROWS],
  );
  const lines = [csvLine([CSV_CAUTION]), csvLine(CSV_COLUMNS)];
  for (const r of rows) {
    const token = r.token as Token;
    const paid = r.paid_amount_atomic != null && r.paid_signature ? fromAtomic(BigInt(r.paid_amount_atomic), token) : null;
    lines.push(csvLine([
      r.id,
      r.kind,
      r.status,
      fromAtomic(BigInt(r.amount_atomic!), token),
      token,
      paid,
      paid ? r.paid_payer : null,
      paid ? `https://solscan.io/tx/${r.paid_signature}` : null,
      r.created_at,
      paid ? r.paid_at : null,
      r.payer_name,
      r.for_text,
      r.kind === "invoice" ? r.invoice_number : null,
      `${base}/${r.kind === "invoice" ? "i" : "r"}/${r.id}`,
      r.from_domain,
      r.schedule_id,
      r.period,
      r.fiat_currency,
      r.fiat_amount,
      r.fiat_rate,
      r.fiat_currency ? r.fiat_quoted_at : null,
    ]));
  }
  const total = Number(rows[0]?.total ?? 0);
  return { text: `﻿${lines.join("\r\n")}\r\n`, rows: rows.length, truncated: total > rows.length };
}

/** "owed-FN6G-cbvs-2026-10-17.csv": ASCII only, for Content-Disposition. */
export function csvFilename(recipient: string, now: number = Date.now()): string {
  return `owed-${recipient.slice(0, 4)}-${recipient.slice(-4)}-${new Date(now).toISOString().slice(0, 10)}.csv`;
}
