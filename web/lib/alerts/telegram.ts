import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { TelegramConfig } from "./config";

// S1 paid alerts over Telegram: the Bot API calls Owed makes (sendMessage only) and what /api/hooks/telegram reads.
// The token is part of every Bot API URL, so no URL ever reaches an error message or a log line.

export const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_TIMEOUT_MS = 5000;
/** Bot API limit after entity parsing; Owed's messages stay far below it. */
const MAX_TEXT = 4096;

export class TelegramError extends Error {
  status?: number;
  /** Telegram will never accept this message for this chat (blocked, chat gone, bad request): don't retry. */
  permanent = false;
  /** The user blocked the bot or the chat no longer exists: the subscription should end. */
  endsSubscription = false;
  /** Flood control: wait this long before the next try. */
  retryAfterSeconds?: number;
}

const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").slice(0, 160);

/**
 * sendMessage with HTML parse mode and no link previews. `html` must already be safe Telegram HTML: every piece of
 * requester text escaped (lib/alerts/messages.ts). Throws TelegramError, whose message never contains the token.
 */
export async function sendTelegram(cfg: TelegramConfig, chatId: string, html: string): Promise<void> {
  if (!/^-?\d{1,20}$/.test(chatId)) throw Object.assign(new TelegramError("not a Telegram chat id"), { permanent: true });
  let res: Response;
  try {
    res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html.slice(0, MAX_TEXT), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new TelegramError(`Telegram Bot API ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable"}`);
  }
  const text = await res.text().catch(() => "");
  let body: { ok?: boolean; description?: string; parameters?: { retry_after?: number } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // not JSON (a proxy error page)
  }
  if (res.ok && body.ok === true) return;
  const description = typeof body.description === "string" ? clean(body.description) : "";
  const err = new TelegramError(`Telegram Bot API answered HTTP ${res.status}${description ? `: ${description}` : ""}`);
  err.status = res.status;
  if (res.status === 429) {
    const wait = Number(body.parameters?.retry_after);
    err.retryAfterSeconds = Number.isFinite(wait) && wait > 0 ? Math.min(Math.ceil(wait), 3600) : 30;
  } else if (res.status === 403 || (res.status === 400 && /chat not found|user is deactivated|bot was kicked/i.test(description))) {
    // "Forbidden: bot was blocked by the user", "Forbidden: user is deactivated", "Bad Request: chat not found".
    err.permanent = true;
    err.endsSubscription = true;
  } else if (res.status >= 400 && res.status < 500 && res.status !== 408) {
    err.permanent = true;
  }
  throw err;
}

/** Constant-time check of X-Telegram-Bot-Api-Secret-Token against the configured secret. */
export function secretMatches(header: string | null, secret: string | null): boolean {
  if (!header || !secret) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(header), digest(secret));
}

/** https://t.me/<bot>?start=<code>: Telegram opens the chat and sends "/start <code>" when the user presses Start. */
export function deepLink(username: string, code: string): string {
  return `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(code)}`;
}

/** A one-time /start code: Telegram allows A-Z a-z 0-9 _ - and at most 64 characters. */
export const START_CODE = /^[A-Za-z0-9_-]{16,64}$/;

export type BotCommand =
  | { command: "start"; chatId: string; code: string | null }
  | { command: "stop"; chatId: string };

/**
 * The command in a Telegram update, or null for everything Owed ignores: anything that isn't a new text message in a
 * private chat, any text that isn't /start or /stop, and commands addressed to another bot ("/start@OtherBot").
 */
export function parseCommand(update: unknown, botUsername: string): BotCommand | null {
  if (!update || typeof update !== "object") return null;
  const message = (update as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const { chat, text } = message as { chat?: { id?: unknown; type?: unknown }; text?: unknown };
  if (!chat || chat.type !== "private" || typeof text !== "string") return null;
  const id = chat.id;
  const chatId = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : typeof id === "string" && /^-?\d{1,20}$/.test(id) ? id : null;
  if (!chatId) return null;
  const m = /^\/(start|stop)(?:@([A-Za-z0-9_]{1,64}))?(?:[ \t]+(\S+))?[ \t]*$/i.exec(text.trim());
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  if (m[1].toLowerCase() === "stop") return { command: "stop", chatId };
  return { command: "start", chatId, code: m[3] ?? null };
}
