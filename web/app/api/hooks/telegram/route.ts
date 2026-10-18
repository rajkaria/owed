import { telegramConfig } from "@/lib/alerts/config";
import { escapeHtml } from "@/lib/alerts/messages";
import { telegramStart, telegramStop } from "@/lib/alerts/subscribe";
import { parseCommand, secretMatches, sendTelegram } from "@/lib/alerts/telegram";
import { errorResponse, json } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 64 * 1024;

/**
 * POST /api/hooks/telegram — S1 paid alerts: updates from Owed's Telegram bot (setWebhook with secret_token).
 * 404 unless TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET are all set; 401 unless the
 * X-Telegram-Bot-Api-Secret-Token header equals TELEGRAM_WEBHOOK_SECRET (constant time). In a private chat:
 *   "/start <code>"  links the chat to the wallet the code was issued for, and replies naming the wallet
 *   "/stop"          ends every subscription of the chat
 * Everything else (other text, groups, edits, other bots' commands) is ignored with a 200 and no reply.
 */
export async function POST(req: Request): Promise<Response> {
  const cfg = telegramConfig();
  if (!cfg) return errorResponse("not_found", "not found");
  if (!secretMatches(req.headers.get("x-telegram-bot-api-secret-token"), cfg.secret)) {
    return json({ error: { code: "unauthorized", message: "missing or wrong secret token" } }, { status: 401 });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return errorResponse("invalid_input", "body is too large");
  let update: unknown;
  try {
    update = JSON.parse(text);
  } catch {
    return errorResponse("invalid_input", "body must be JSON");
  }
  const command = parseCommand(update, cfg.username);
  if (!command) return json({ ok: true });
  let reply: string;
  try {
    reply = command.command === "start" ? await telegramStart(command.chatId, command.code) : await telegramStop(command.chatId);
  } catch (e) {
    // Storage is down: a non-2xx makes Telegram deliver the update again later (both commands are idempotent).
    console.warn(`alerts: telegram ${command.command} failed: ${e instanceof Error ? e.message : String(e)}`);
    return errorResponse("upstream_unavailable", "try again shortly");
  }
  try {
    await sendTelegram(cfg, command.chatId, escapeHtml(reply));
  } catch (e) {
    console.warn(`alerts: telegram reply failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return json({ ok: true });
}
