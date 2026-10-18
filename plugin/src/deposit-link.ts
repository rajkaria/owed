import * as z from "zod/v4";

// F3 PayBox Open Deposit link, the plugin's side (Owed's server checks the same: web/lib/deposit-link.ts). The user's
// agent can call PayBox get_deposit_link with amount_usd = the request's amount and pass its deposit_url to
// ask_for_money or create_invoice, so a payer without a wallet can pay in their own browser on PayBox Deposit. The link
// goes to the user's PayBox account; Owed can't see where it pays, so a payment through it counts only once the chain
// shows it with the request's reference or the user matches it with match_payments. Never part of the request id.

export const DEPOSIT_LINK_HOST = "paybox.sh";
export const DEPOSIT_URL_MAX_CHARS = 512;

export const DEPOSIT_URL_DESCRIPTION =
  "Optional: a PayBox Open Deposit link, for payers without a wallet. Only if the user wants people without a wallet to pay through PayBox Deposit: " +
  "call PayBox get_deposit_link (credential_id of the user's receiving wallet, amount_usd = the request's USDC amount) and pass its deposit_url here. " +
  "USDC on Solana only. The link pays the user's PayBox account, which Owed can't check, so such a payment counts only after match_payments matches it.";

export const depositUrlInput = z.string().min(1).max(2048).describe(DEPOSIT_URL_DESCRIPTION);

export function isDepositHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === DEPOSIT_LINK_HOST || (h.endsWith(`.${DEPOSIT_LINK_HOST}`) && /^[a-z0-9.-]+$/.test(h) && !h.includes(".."));
}

/** The normalized URL, or why it can't be used (shown to the user as-is). */
export function checkDepositUrl(input: string, ctx: { token: "USDC" | "SOL"; chain?: "solana" | "base"; currency?: string; what?: string }): { ok: true; url: string } | { ok: false; message: string } {
  const what = ctx.what ?? "request";
  const no = (message: string) => ({ ok: false as const, message: `${message} Nothing was created.` });
  const raw = input.trim();
  if (raw.length > DEPOSIT_URL_MAX_CHARS) return no(`deposit_url is longer than ${DEPOSIT_URL_MAX_CHARS} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return no("deposit_url must be the https link PayBox get_deposit_link returned.");
  }
  if (url.protocol !== "https:") return no("deposit_url must be an https link.");
  if (url.username || url.password) return no("deposit_url must not carry a user name or password.");
  if (url.port !== "") return no("deposit_url must not name a port.");
  if (!isDepositHost(url.hostname)) return no(`deposit_url must be a PayBox Deposit link on ${DEPOSIT_LINK_HOST} (from PayBox get_deposit_link).`);
  if (url.href.length > DEPOSIT_URL_MAX_CHARS) return no(`deposit_url is longer than ${DEPOSIT_URL_MAX_CHARS} characters.`);
  if (ctx.token !== "USDC" || (ctx.chain ?? "solana") !== "solana") return no(`A PayBox Deposit link works on USDC ${what}s on Solana only.`);
  if (ctx.currency !== undefined) return no(`Ask in USDC (not a local currency) to add a PayBox Deposit link, so its amount is the ${what}'s amount.`);
  return { ok: true, url: url.href };
}

/** What the user is told once the link is stored. */
export function depositLines(what = "request"): string[] {
  return [
    `PayBox Deposit link stored with the ${what}: Owed shows it on the pay page for 24 hours where Owed has PayBox Deposit switched on (it's off until tested).`,
    "That link pays your PayBox account, which Owed can't check, so a payment through it isn't counted on its own: once they pay, run match_payments to match it.",
  ];
}

export const REFUSE_DEPOSIT_NOT_STORED =
  "Owed's server didn't store the PayBox Deposit link with the request, so the link wasn't used. Try again, or ask without deposit_url.";

/** check_payments / who_owes_me: an open request that carries a deposit link. */
export const DEPOSIT_HINT = "If they paid with the PayBox deposit link, it isn't counted on its own: run match_payments to match it.";
