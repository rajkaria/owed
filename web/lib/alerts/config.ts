import "server-only";
import { publicBase } from "../notify/config";

// S1 paid alerts: configuration from the environment (names only; Raj sets the values, docs in .ocean/notes/sp10-docs.md).
//   TELEGRAM_BOT_TOKEN       the bot's token from @BotFather ("123456:ABC..."); never logged, never in an error
//   TELEGRAM_BOT_USERNAME    the bot's username, with or without "@" (the /start deep link names it)
//   TELEGRAM_WEBHOOK_SECRET  the secret_token given to setWebhook; Telegram echoes it in X-Telegram-Bot-Api-Secret-Token
//   RESEND_API_KEY           Resend's API key (email alerts stay off without it)
//   OWED_ALERTS_FROM         the sender, e.g. "Owed alerts <alerts@getowed.xyz>" on a domain verified in Resend
// A channel is on only when every one of its variables is set and well formed. With none on, /alerts says alerts
// aren't switched on, POST /api/v1/alerts refuses, /api/hooks/telegram answers 404 and nothing is queried or sent.

const env = (name: string): string | null => process.env[name]?.trim() || null;

export interface TelegramConfig {
  token: string;
  /** Without "@". */
  username: string;
  secret: string;
}

export interface EmailConfig {
  apiKey: string;
  from: string;
}

const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
// Telegram's rule for secret_token: 1-256 characters, A-Z a-z 0-9 _ -.
const WEBHOOK_SECRET = /^[A-Za-z0-9_-]{1,256}$/;
// "alerts@getowed.xyz" or "Owed alerts <alerts@getowed.xyz>".
const FROM = /^(?:[^<>@\r\n]{1,60} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

export function telegramConfig(): TelegramConfig | null {
  const token = env("TELEGRAM_BOT_TOKEN");
  const username = env("TELEGRAM_BOT_USERNAME")?.replace(/^@/, "") ?? null;
  const secret = env("TELEGRAM_WEBHOOK_SECRET");
  if (!token || !username || !secret) return null;
  if (!BOT_TOKEN.test(token) || !BOT_USERNAME.test(username) || !WEBHOOK_SECRET.test(secret)) return null;
  return { token, username, secret };
}

export function emailConfig(): EmailConfig | null {
  const apiKey = env("RESEND_API_KEY");
  const from = env("OWED_ALERTS_FROM");
  if (!apiKey || !from || apiKey.length > 200 || !FROM.test(from)) return null;
  return { apiKey, from };
}

export type AlertChannel = "telegram" | "email";

export function alertChannels(): Record<AlertChannel, boolean> {
  return { telegram: telegramConfig() !== null, email: emailConfig() !== null };
}

export function alertsConfigured(): boolean {
  const c = alertChannels();
  return c.telegram || c.email;
}

/** Public origin for links inside alerts (they are sent outside any request): see lib/notify/config.ts publicBase. */
export function alertsBase(): string {
  return publicBase() ?? "https://www.getowed.xyz";
}
