import { fromAtomic, type Token } from "../money";
import type { RequestRow } from "../requests";
import { quoteText, sanitizeText, TEXT_LIMITS } from "../safety";
import { explorerTx, shortAddress } from "../view/format";
import { groupDigits } from "../view/money";
import { brandWordsFromFlags } from "../view/request-view";

// S1 paid alerts: what an alert says. Pure (no I/O) so tests pin every line.
// Requester text (`for`) is untrusted: it is cleaned again here (links, control and invisible characters, markup and
// double quotes stripped, capped at 80), quoted, labelled as the requester's own words, and escaped for the channel.
// In Telegram it sits inside <code>, where Telegram makes no links or @mentions; the subject line of an email never
// carries it at all.

export interface AlertFacts {
  wallet: string;
  requestId: string;
  token: Token;
  /** What the request asks, as a decimal string. */
  asked: string;
  /** What the chain shows arrived (paid or part paid). */
  arrived: string | null;
  partial: boolean;
  /** Cleaned and capped, without quotes; null when there is none. */
  forText: string | null;
  /** Brand words the request was flagged for (impersonation caution). */
  brandWords: string[];
  payer: string | null;
  rail: string;
  requestUrl: string;
  txUrl: string | null;
  txName: string;
}

const RAILS: Record<string, string> = {
  solana_pay: "Solana Pay",
  x402: "x402",
  base_transfer: "USDC on Base",
  matched: "matched by you (no reference on the payment)",
  moonpay_card: "card, via MoonPay",
};

/** A rail Owed doesn't know yet (a concurrent sprint's) still reads as words, never as raw markup. */
export function railLabel(rail: string | null | undefined): string {
  if (!rail) return RAILS.solana_pay;
  return RAILS[rail] ?? rail.replace(/[^a-z0-9]+/gi, " ").trim().slice(0, 40);
}

const amount = (atomic: bigint, token: Token) => groupDigits(fromAtomic(atomic, token));

export function alertFacts(row: RequestRow, wallet: string, base: string): AlertFacts {
  const partial = row.status === "underpaid";
  const tx = row.paidSignature ? explorerTx(row.paidSignature) : null;
  const verifiedDomain = row.fromDomain && row.fromDomainVerifiedAt ? row.fromDomain : null;
  return {
    wallet,
    requestId: row.id,
    token: row.token,
    asked: amount(row.amountAtomic, row.token),
    arrived: row.paidAmountAtomic == null ? null : amount(row.paidAmountAtomic, row.token),
    partial,
    forText: sanitizeText(row.forText, TEXT_LIMITS.for),
    brandWords: brandWordsFromFlags(row.flags, verifiedDomain),
    payer: row.paidPayer,
    rail: railLabel(row.paidRail),
    requestUrl: `${base.replace(/\/+$/, "")}/r/${encodeURIComponent(row.id)}`,
    txUrl: tx?.href ?? null,
    txName: tx?.name ?? "Solscan",
  };
}

/** Telegram's HTML mode needs only these escaped (it knows &lt; &gt; &amp; &quot;). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "Paid: 12.5 USDC", "Paid: 13 USDC (asked 12.5)", "Part paid: 5 of 12.5 USDC". */
export function headline(f: AlertFacts): string {
  if (f.partial) return `Part paid: ${f.arrived ?? "some"} of ${f.asked} ${f.token}`;
  if (f.arrived && f.arrived !== f.asked) return `Paid: ${f.arrived} ${f.token} (asked ${f.asked})`;
  return `Paid: ${f.asked} ${f.token}`;
}

export const UNVERIFIED_LABEL = "the requester's words, not checked by Owed";

function cautionLine(f: AlertFacts): string | null {
  if (f.brandWords.length === 0) return null;
  return `Caution: the text mentions ${f.brandWords.map((w) => `"${w}"`).join(", ")}; Owed hasn't verified who made this request.`;
}

/** The Telegram alert, as Telegram HTML. Every dynamic piece is escaped. */
export function telegramAlert(f: AlertFacts): string {
  const lines = [
    `<b>${escapeHtml(headline(f))}</b>`,
    `To wallet <code>${escapeHtml(shortAddress(f.wallet))}</code>`,
  ];
  if (f.forText) lines.push(`For: <code>${escapeHtml(quoteText(f.forText))}</code> (${UNVERIFIED_LABEL})`);
  const caution = cautionLine(f);
  if (caution) lines.push(escapeHtml(caution));
  lines.push(`From ${f.payer ? `<code>${escapeHtml(shortAddress(f.payer))}</code>` : "an unknown wallet"} · ${escapeHtml(f.rail)}`);
  const links = [`<a href="${escapeHtml(f.requestUrl)}">Request</a>`];
  if (f.txUrl) links.push(`<a href="${escapeHtml(f.txUrl)}">${escapeHtml(f.txName)}</a>`);
  lines.push(links.join(" · "), "", "Send /stop to turn off these alerts.");
  return lines.join("\n");
}

export interface EmailMessage {
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

/**
 * The email alert. The subject has only Owed's own words and numbers. `unsubscribePage` is the human page with a
 * confirm button; `oneClickUrl` takes RFC 8058's POST (List-Unsubscribe-Post) and nothing else changes state.
 */
export function emailAlert(f: AlertFacts, unsubscribePage: string, oneClickUrl: string): EmailMessage {
  const head = headline(f);
  const caution = cautionLine(f);
  const from = `${f.payer ? shortAddress(f.payer) : "an unknown wallet"}, ${f.rail}`;
  const text = [
    `${head} to wallet ${f.wallet}`,
    "",
    ...(f.forText ? [`For: ${quoteText(f.forText)} (${UNVERIFIED_LABEL})`] : []),
    ...(caution ? [caution] : []),
    `From: ${from}`,
    `Request: ${f.requestUrl}`,
    ...(f.txUrl ? [`Transaction: ${f.txUrl}`] : []),
    "",
    `You get this because wallet ${f.wallet} turned on Owed paid alerts for this address.`,
    `Turn them off: ${unsubscribePage}`,
  ].join("\n");
  const p = (inner: string) => `<p style="margin:0 0 12px">${inner}</p>`;
  const a = (href: string, label: string) => `<a href="${escapeHtml(href)}" style="color:#0f7b5f">${escapeHtml(label)}</a>`;
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0e0f14">`,
    p(`<strong>${escapeHtml(head)}</strong><br>to wallet <code>${escapeHtml(f.wallet)}</code>`),
    ...(f.forText ? [p(`For: <q>${escapeHtml(f.forText)}</q> <span style="color:#5b5e6b">(${escapeHtml(UNVERIFIED_LABEL)})</span>`)] : []),
    ...(caution ? [p(escapeHtml(caution))] : []),
    p(`From: ${escapeHtml(from)}`),
    p([a(f.requestUrl, "View the request"), ...(f.txUrl ? [a(f.txUrl, `Transaction on ${f.txName}`)] : [])].join(" · ")),
    `<p style="margin:24px 0 0;font-size:13px;color:#5b5e6b">You get this because wallet ${escapeHtml(f.wallet)} turned on Owed paid alerts for this address. ${a(unsubscribePage, "Turn them off")}.</p>`,
    `</div>`,
  ].join("\n");
  return {
    subject: `${head} to ${shortAddress(f.wallet)}`,
    text,
    html,
    headers: { "List-Unsubscribe": `<${oneClickUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

/** The confirmation email for a new email subscription (it carries no requester text at all). */
export function confirmEmail(wallet: string, confirmUrl: string): { subject: string; text: string; html: string } {
  const text = [
    `Wallet ${wallet} asked Owed to send paid alerts to this address: one email each time a request paying this wallet is marked paid.`,
    "",
    `Confirm (this link works for 24 hours): ${confirmUrl}`,
    "",
    "If you didn't ask for this, ignore this email: nothing is sent unless the link is confirmed.",
  ].join("\n");
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#0e0f14">`,
    `<p style="margin:0 0 12px">Wallet <code>${escapeHtml(wallet)}</code> asked Owed to send paid alerts to this address: one email each time a request paying this wallet is marked paid.</p>`,
    `<p style="margin:0 0 12px"><a href="${escapeHtml(confirmUrl)}" style="color:#0f7b5f">Confirm paid alerts</a> (this link works for 24 hours).</p>`,
    `<p style="margin:24px 0 0;font-size:13px;color:#5b5e6b">If you didn't ask for this, ignore this email: nothing is sent unless the link is confirmed.</p>`,
    `</div>`,
  ].join("\n");
  return { subject: `Confirm Owed paid alerts for ${shortAddress(wallet)}`, text, html };
}

/** What the bot says. Plain sentences, no requester text. */
export const BOT = {
  linked: (wallet: string, base: string) =>
    `Owed paid alerts are on for wallet ${wallet}. You'll get one message here when a request paying this wallet is marked paid. Send /stop to turn them off, or link another wallet at ${base}/alerts.`,
  alreadyLinked: (wallet: string) => `Owed paid alerts are already on in this chat for wallet ${wallet}. Send /stop to turn them off.`,
  expired: (base: string) => `That link has expired (links work for 15 minutes). Get a new one at ${base}/alerts.`,
  used: (base: string) => `That link was already used. Get a new one at ${base}/alerts.`,
  unknown: (base: string) => `That link isn't valid. Get one at ${base}/alerts after your wallet signs.`,
  noCode: (base: string) => `To get Owed paid alerts here, open ${base}/alerts, sign with your wallet and use the Telegram link it gives you.`,
  full: (base: string) => `That wallet already has the most alert links Owed allows. Send /stop in one of its chats first, then get a new link at ${base}/alerts.`,
  stopped: (n: number, base: string) =>
    `Owed paid alerts are off in this chat (${n} ${n === 1 ? "wallet" : "wallets"}). Turn them on again at ${base}/alerts.`,
  nothingToStop: (base: string) => `No Owed paid alerts were on in this chat. Turn them on at ${base}/alerts.`,
};
