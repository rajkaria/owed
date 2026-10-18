import "server-only";
import { sql } from "./db";
import { ApiError } from "./http";
import { COLUMNS, fromRow, type RequestRow } from "./requests";

// F3 PayBox Open Deposit link (decision D17). A requester's agent can call PayBox get_deposit_link (amount_usd = the
// request's amount) and pass its deposit_url when it asks for money: a payer without a wallet then pays in their own
// browser on PayBox Deposit. The link goes to the requester's PayBox account, and Owed can't check where it pays, so:
// - it is accepted only as an https URL on paybox.sh or one of its subdomains (PayBox's own domain; PayBox's public docs
//   don't name the Deposit host, so nothing wider is allowed), at most 512 characters, no user name, password or port,
//   on USDC requests on Solana asked in USDC;
// - it is stored beside the request, never part of its id (the id hashes recipient, asset, amount and reference only);
// - the pay page offers it only with OWED_DEPOSIT_LINK=1 (off on production until a stranger's guest payment is tested)
//   and within 24 hours of being added (PayBox reuses an unpaid link for 24 hours);
// - nothing is marked paid from it: a payment counts once the chain shows it with the reference, or the requester
//   matches it with match_payments, exactly as before.

export const DEPOSIT_LINK_HOST = "paybox.sh";
export const DEPOSIT_URL_MAX_CHARS = 512;
/** PayBox: "Reuse the same unpaid link for 24 hours." */
export const DEPOSIT_LINK_WINDOW_MS = 24 * 3600_000;

const bad = (message: string) => new ApiError("invalid_input", message);

/** paybox.sh itself or any subdomain of it, nothing else (no lookalikes such as paybox.sh.example). */
export function isDepositHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === DEPOSIT_LINK_HOST || (h.endsWith(`.${DEPOSIT_LINK_HOST}`) && /^[a-z0-9.-]+$/.test(h) && !h.includes(".."));
}

export interface DepositContext {
  token: "USDC" | "SOL";
  chain: "solana" | "base";
  /** A local-currency ask's currency: refused (the link's amount must be the request's USDC amount). */
  currency?: string | null;
  /** "request" or "invoice", for the messages. */
  what?: string;
}

/** The URL to store (normalized), or null when none was given. invalid_input with the reason otherwise. */
export function parseDepositUrl(input: unknown, ctx: DepositContext): string | null {
  if (input == null) return null;
  if (typeof input !== "string" || input.trim() === "") throw bad("deposit_url: must be the deposit_url PayBox get_deposit_link returned");
  const raw = input.trim();
  if (raw.length > DEPOSIT_URL_MAX_CHARS) throw bad(`deposit_url: at most ${DEPOSIT_URL_MAX_CHARS} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad("deposit_url: must be an https URL (the deposit_url PayBox get_deposit_link returned)");
  }
  if (url.protocol !== "https:") throw bad("deposit_url: must be an https URL");
  if (url.username || url.password) throw bad("deposit_url: must not carry a user name or password");
  if (url.port !== "") throw bad("deposit_url: must not name a port");
  if (!isDepositHost(url.hostname)) throw bad(`deposit_url: must be a PayBox Deposit link on ${DEPOSIT_LINK_HOST} (from PayBox get_deposit_link)`);
  const href = url.href;
  if (href.length > DEPOSIT_URL_MAX_CHARS) throw bad(`deposit_url: at most ${DEPOSIT_URL_MAX_CHARS} characters`);
  const what = ctx.what ?? "request";
  if (ctx.chain !== "solana" || ctx.token !== "USDC") throw bad(`deposit_url: PayBox Deposit links are for USDC ${what}s on Solana only`);
  if (ctx.currency != null) throw bad(`deposit_url: ask in USDC (not a local currency) to add a PayBox Deposit link, so its amount is the ${what}'s amount`);
  return href;
}

/** Stores a checked deposit URL on a request just created (never replaces one). */
export async function storeDepositUrl(id: string, url: string): Promise<RequestRow> {
  const rows = await sql(
    `update requests set deposit_url = $2, deposit_url_added_at = now()
      where id = $1 and deposit_url is null and token = 'USDC' and chain = 'solana'
      returning ${COLUMNS}`,
    [id, url],
  );
  if (!rows[0]) throw new ApiError("upstream_unavailable", "the request was created but its deposit link couldn't be stored; get it with GET /api/v1/requests/<id>");
  return fromRow(rows[0]);
}

/** Pay page switch (like OWED_PAYBOX_CTA, decision D11): off unless OWED_DEPOSIT_LINK=1. */
export function depositLinkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OWED_DEPOSIT_LINK === "1";
}

export interface DepositOffer {
  url: string;
  /** The link's host, shown to the payer ("paybox.sh"). */
  host: string;
  addedAt: string;
  /** When the pay page stops offering it (24 hours after it was added). */
  until: string;
}

/** What the pay page shows, or null: switched on, open, USDC on Solana, a stored link, within its 24 hours. */
export function depositOffer(
  request: { status: string; token: string; chain?: string; deposit_url?: string | null; deposit_url_added_at?: string | null },
  now: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): DepositOffer | null {
  if (!depositLinkEnabled(env)) return null;
  if (request.status !== "open" || request.token !== "USDC" || (request.chain ?? "solana") !== "solana") return null;
  if (!request.deposit_url || !request.deposit_url_added_at) return null;
  const added = Date.parse(request.deposit_url_added_at);
  if (!Number.isFinite(added) || now < added - 60_000 || now >= added + DEPOSIT_LINK_WINDOW_MS) return null;
  let host: string;
  try {
    const url = new URL(request.deposit_url);
    if (url.protocol !== "https:" || !isDepositHost(url.hostname)) return null;
    host = url.hostname;
  } catch {
    return null;
  }
  return { url: request.deposit_url, host, addedAt: request.deposit_url_added_at, until: new Date(added + DEPOSIT_LINK_WINDOW_MS).toISOString().replace(".000Z", "Z") };
}
