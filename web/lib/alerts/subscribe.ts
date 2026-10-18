import "server-only";
import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import type { AlertTokenBody, ConfirmAlertResponse, CreateAlertBody, CreateAlertResponse, UnsubscribeAlertResponse } from "../contract";
import { isoUtc, isUniqueViolation, sql, transaction } from "../db";
import { ApiError } from "../http";
import { take, type RateRule } from "../ratelimit";
import { checkSignedMessage, spendOnce } from "../verify-signature";
import { alertsBase, emailConfig, telegramConfig } from "./config";
import { alertsPrefix } from "./grammar";
import { normalizeEmail, sendEmail } from "./email";
import { BOT, confirmEmail } from "./messages";
import { deepLink, START_CODE } from "./telegram";

// S1 paid alerts: linking a wallet to a Telegram chat or an email address, and ending that link (migration 0025).
//
// 1. POST /api/v1/alerts: the wallet signs "Owed alerts for <wallet> at <ISO time>" (PayBox request_wallet_sign
//    {op:"solanaMessage"} or a browser wallet's signMessage; at most 5 minutes old, each message once). Owed stores a
//    pending subscription with the sha256 of a fresh secret and hands the secret out once:
//      telegram  a /start code inside https://t.me/<bot>?start=<code>, good for 15 minutes
//      email     a confirm link sent to the address, good for 24 hours (only when email is configured)
// 2. The secret comes back: "/start <code>" in a private chat with the bot (POST /api/hooks/telegram), or the address
//    owner presses Confirm on /alerts/confirm (POST /api/v1/alerts/confirm). The subscription turns active.
// 3. It ends with /stop in the chat, a one-click unsubscribe link from any alert email, or when the channel refuses
//    delivery for good (the user blocked the bot). The chat id and address are scrubbed then.
// No raw secret or token is ever stored; nothing here sends anything unless a channel is configured.

export const ALERTS_PURPOSE = "alerts";
export const TELEGRAM_CODE_MINUTES = 15;
export const EMAIL_CONFIRM_HOURS = 24;
export const ALERT_LIMITS = {
  /** Active subscriptions one wallet may have (chats and addresses together). */
  activePerWallet: 5,
  /** Unused, unexpired links one wallet may have waiting. */
  pendingPerWallet: 5,
  /** Wallets one Telegram chat may follow. */
  activePerChat: 20,
  createPerIpPerHour: 20,
  createPerWalletPerHour: 10,
  /** Confirmation emails one address can be sent a day, whoever asks. */
  confirmEmailsPerAddressPerDay: 5,
  /** Confirm and unsubscribe calls per client IP per 10 minutes. */
  tokenCallsPerIp: 60,
} as const;

export { alertsPrefix };

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** 128-bit /start code (22 characters) or 256-bit email token (43 characters), base64url. */
const newSecret = (bytes: 16 | 32) => randomBytes(bytes).toString("base64url");
const newSubscriptionId = () => bs58.encode(randomBytes(16)).slice(-12);
/** Email confirm and unsubscribe tokens. */
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const HOUR = 3600;

async function requireSlot(rules: RateRule[], refusals: Record<string, string>): Promise<void> {
  const slot = await take(rules);
  if (!slot.allowed) {
    throw new ApiError("rate_limited", refusals[slot.scope ?? ""] ?? "too many requests, try again later", {
      "Retry-After": String(slot.retryAfterSeconds ?? 60),
    });
  }
}

/** One wallet's subscriptions change one at a time (caps and duplicates are checked under this lock). */
const walletLock = (wallet: string) => ({ text: `select pg_advisory_xact_lock(hashtextextended('alerts:' || $1, 0))`, params: [wallet] });

const SUBSCRIPTION = `id, wallet, channel, status, telegram_chat_id::text as chat_id, email,
  ${isoUtc("created_at")} as created_at, ${isoUtc("confirm_expires_at")} as expires_at,
  ${isoUtc("activated_at")} as activated_at, ${isoUtc("unsubscribed_at")} as unsubscribed_at,
  (confirm_expires_at > now())::text as fresh`;

// ---------------------------------------------------------------------------------------------- create

/**
 * POST /api/v1/alerts. Checks, in this order, so a refused call never spends the signature: the channel is
 * configured, the client IP's allowance, the address, the signed message (wording, freshness, signature), the wallet's
 * and the address's allowances, the caps; then the signature is spent and the pending subscription stored.
 */
export async function createSubscription(body: CreateAlertBody, ip: string, base: string): Promise<CreateAlertResponse> {
  const telegram = body.channel === "telegram" ? telegramConfig() : null;
  const mail = body.channel === "email" ? emailConfig() : null;
  if (body.channel === "telegram" && !telegram) throw new ApiError("upstream_unavailable", "Telegram alerts aren't switched on on this deployment yet");
  if (body.channel === "email" && !mail) throw new ApiError("upstream_unavailable", "email alerts aren't switched on on this deployment");
  await requireSlot(
    [{ key: `alerts:create:ip:${ip}`, max: ALERT_LIMITS.createPerIpPerHour, windowSeconds: HOUR, scope: "ip" }],
    { ip: "too many alert sign-ups from this client in the last hour, try again later" },
  );
  const email = body.channel === "email" ? normalizeEmail(body.email) : null;
  if (body.channel === "email" && !email) throw new ApiError("invalid_input", "email: must be an email address like you@example.com");

  const verified = checkSignedMessage({ message: body.signed_message, signature: body.signature, signer: body.wallet, prefix: alertsPrefix(body.wallet) });
  // After the proof, so nobody can use up another wallet's allowance by naming it.
  await requireSlot(
    [
      { key: `alerts:create:wallet:${body.wallet}`, max: ALERT_LIMITS.createPerWalletPerHour, windowSeconds: HOUR, scope: "wallet" },
      ...(email ? [{ key: `alerts:email:${sha256Hex(email)}`, max: ALERT_LIMITS.confirmEmailsPerAddressPerDay, windowSeconds: 24 * HOUR, scope: "email" }] : []),
    ],
    {
      wallet: "too many alert sign-ups for this wallet in the last hour, try again later",
      email: "this address was sent enough confirmation emails today, try again tomorrow",
    },
  );
  const [caps] = await sql(
    `select count(*) filter (where status = 'active')::int as active,
            count(*) filter (where status = 'pending' and confirm_expires_at > now())::int as pending,
            coalesce(bool_or(status = 'active' and channel = 'email' and email = $2::text), false)::text as same_email
       from alert_subscriptions where wallet = $1`,
    [body.wallet, email],
  );
  if (Number(caps?.active ?? 0) >= ALERT_LIMITS.activePerWallet) {
    throw new ApiError("invalid_input", `wallet ${body.wallet} already has ${ALERT_LIMITS.activePerWallet} active alert links; send /stop in one of its Telegram chats or use an alert email's unsubscribe link first`);
  }
  if (Number(caps?.pending ?? 0) >= ALERT_LIMITS.pendingPerWallet) {
    throw new ApiError("rate_limited", `wallet ${body.wallet} already has ${ALERT_LIMITS.pendingPerWallet} unused alert links waiting; use one or wait for them to expire`, { "Retry-After": "900" });
  }
  if (caps?.same_email === "true") throw new ApiError("invalid_input", "alerts for this wallet already go to this address");
  await spendOnce(ALERTS_PURPOSE, verified);

  const secret = newSecret(body.channel === "telegram" ? 16 : 32);
  const ttl = body.channel === "telegram" ? `make_interval(mins => ${TELEGRAM_CODE_MINUTES})` : `make_interval(hours => ${EMAIL_CONFIRM_HOURS})`;
  let row: Record<string, string | null> | undefined;
  for (let attempt = 0; !row; attempt++) {
    try {
      [row] = await sql(
        `insert into alert_subscriptions (id, wallet, channel, email, confirm_hash, confirm_expires_at, proof_message, proof_signature)
         values ($1, $2, $3, $4, $5, now() + ${ttl}, $6, $7)
         returning ${SUBSCRIPTION}`,
        [newSubscriptionId(), body.wallet, body.channel, email, sha256Hex(secret), body.signed_message, body.signature.trim()],
      );
    } catch (e) {
      if (attempt === 0 && isUniqueViolation(e, "alert_subscriptions_pkey")) continue; // a 70-bit id collided: once more
      throw e;
    }
  }
  const head = { id: row.id!, wallet: row.wallet! };
  const times = { status: "pending" as const, created_at: row.created_at!, expires_at: row.expires_at! };
  if (telegram) {
    return {
      ...head,
      channel: "telegram",
      ...times,
      telegram: { bot: telegram.username, code: secret, link: deepLink(telegram.username, secret) },
      next: `Open the link in Telegram and press Start within ${TELEGRAM_CODE_MINUTES} minutes; the bot replies to confirm. The link works once.`,
    };
  }
  const confirmUrl = `${base}/alerts/confirm?token=${secret}`;
  try {
    await sendEmail(mail!, { to: email!, ...confirmEmail(body.wallet, confirmUrl), idempotencyKey: `owed-alert-confirm-${row.id}` });
  } catch (e) {
    console.warn(`alerts: confirmation email for ${row.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    await sql(`update alert_subscriptions set confirm_expires_at = now() where id = $1 and status = 'pending'`, [row.id]).catch(() => undefined);
    throw new ApiError("upstream_unavailable", "the confirmation email couldn't be sent just now; sign a fresh message and try again in a minute");
  }
  return {
    ...head,
    channel: "email",
    ...times,
    email: { address: email! },
    next: `Check ${email} for a confirmation link; it works for ${EMAIL_CONFIRM_HOURS} hours. Nothing is sent until it is confirmed.`,
  };
}

// ---------------------------------------------------------------------------------------------- email confirm

async function requireTokenSlot(ip: string): Promise<void> {
  await requireSlot(
    [{ key: `alerts:token:ip:${ip}`, max: ALERT_LIMITS.tokenCallsPerIp, windowSeconds: 600, scope: "ip" }],
    { ip: "too many alert links opened from this client in the last 10 minutes, try again shortly" },
  );
}

/** POST /api/v1/alerts/confirm: the address owner confirms. Idempotent: a second confirm says already_active. */
export async function confirmEmailSubscription(body: AlertTokenBody, ip: string): Promise<ConfirmAlertResponse> {
  if (!emailConfig()) throw new ApiError("upstream_unavailable", "email alerts aren't switched on on this deployment");
  await requireTokenSlot(ip);
  const [row] = await sql(`select ${SUBSCRIPTION} from alert_subscriptions where confirm_hash = $1 and channel = 'email'`, [sha256Hex(body.token)]);
  if (!row) throw new ApiError("not_found", "this confirmation link isn't valid");
  const done = (r: Record<string, string | null>, already: boolean): ConfirmAlertResponse => ({
    id: r.id!, wallet: r.wallet!, channel: "email", status: "active", activated_at: r.activated_at!, already_active: already,
  });
  if (row.status === "active") return done(row, true);
  if (row.status === "unsubscribed") throw new ApiError("invalid_input", "these alerts were turned off; sign up again on /alerts");
  if (row.fresh !== "true") throw new ApiError("invalid_input", `this confirmation link expired (links work for ${EMAIL_CONFIRM_HOURS} hours); sign up again on /alerts`);
  const [, updated] = await transaction([
    walletLock(row.wallet!),
    {
      text: `update alert_subscriptions s set status = 'active', activated_at = now()
              where s.id = $1 and s.status = 'pending' and s.confirm_expires_at > now()
                and (select count(*) from alert_subscriptions a where a.wallet = s.wallet and a.status = 'active') < $2::int
                and not exists (select 1 from alert_subscriptions a where a.wallet = s.wallet and a.status = 'active' and a.channel = 'email' and a.email = s.email)
             returning ${SUBSCRIPTION}`,
      params: [row.id!, String(ALERT_LIMITS.activePerWallet)],
    },
  ]);
  if (updated.length) return done(updated[0], false);
  // Lost a race, or the same address already gets this wallet's alerts, or the wallet is full.
  const [same] = await sql(
    `select ${SUBSCRIPTION} from alert_subscriptions where wallet = $1 and status = 'active' and channel = 'email' and email = $2`,
    [row.wallet!, row.email],
  );
  if (same) return done(same, true);
  throw new ApiError("invalid_input", `wallet ${row.wallet} already has ${ALERT_LIMITS.activePerWallet} active alert links; turn one off first`);
}

// ---------------------------------------------------------------------------------------------- unsubscribe

/** POST /api/v1/alerts/unsubscribe (also RFC 8058 one-click). Works whether or not a channel is still configured. */
export async function unsubscribeByToken(body: AlertTokenBody, ip: string): Promise<UnsubscribeAlertResponse> {
  await requireTokenSlot(ip);
  const [hit] = await sql(`select subscription_id from alert_unsubscribe_tokens where token_hash = $1`, [sha256Hex(body.token)]);
  if (!hit) throw new ApiError("not_found", "this unsubscribe link isn't valid");
  const [ended] = await sql(
    `update alert_subscriptions
        set status = 'unsubscribed', unsubscribed_at = now(), ended_by = 'unsubscribe_link', email = null, telegram_chat_id = null
      where id = $1 and status <> 'unsubscribed'
     returning ${SUBSCRIPTION}`,
    [hit.subscription_id],
  );
  const row = ended ?? (await sql(`select ${SUBSCRIPTION} from alert_subscriptions where id = $1`, [hit.subscription_id]))[0];
  if (!row) throw new ApiError("not_found", "this unsubscribe link isn't valid");
  return {
    id: row.id!, wallet: row.wallet!, channel: row.channel as "telegram" | "email", status: "unsubscribed",
    unsubscribed_at: row.unsubscribed_at!, already_unsubscribed: !ended,
  };
}

/** For the /alerts/confirm and /alerts/unsubscribe pages: what a token points at, read only. */
export interface TokenView {
  wallet: string;
  channel: "telegram" | "email";
  status: "pending" | "active" | "unsubscribed";
  email: string | null;
  expired: boolean;
}

export async function viewToken(kind: "confirm" | "unsubscribe", token: string): Promise<TokenView | null> {
  if (!TOKEN.test(token)) return null;
  const rows = kind === "confirm"
    ? await sql(`select ${SUBSCRIPTION} from alert_subscriptions where confirm_hash = $1 and channel = 'email'`, [sha256Hex(token)])
    : await sql(
      `select ${SUBSCRIPTION} from alert_subscriptions where id = (select subscription_id from alert_unsubscribe_tokens where token_hash = $1)`,
      [sha256Hex(token)],
    );
  const row = rows[0];
  if (!row) return null;
  return {
    wallet: row.wallet!,
    channel: row.channel as TokenView["channel"],
    status: row.status as TokenView["status"],
    email: row.email,
    expired: row.status === "pending" && row.fresh !== "true",
  };
}

/** A fresh unsubscribe token for one outgoing email: the raw token goes in the email, only its hash is kept. */
export async function mintUnsubscribeToken(subscriptionId: string): Promise<{ token: string; hash: string }> {
  const token = newSecret(32);
  const hash = sha256Hex(token);
  await sql(`insert into alert_unsubscribe_tokens (token_hash, subscription_id) values ($1, $2)`, [hash, subscriptionId]);
  return { token, hash };
}

/** The channel refused delivery for good (the user blocked the bot, the address bounced): stop sending to it. */
export async function endSubscription(id: string, endedBy: "bot_blocked" | "undeliverable"): Promise<void> {
  await sql(
    `update alert_subscriptions
        set status = 'unsubscribed', unsubscribed_at = now(), ended_by = $2, email = null, telegram_chat_id = null
      where id = $1 and status = 'active'`,
    [id, endedBy],
  );
}

/** Pending links that expired a week ago or more: they hold an address or a proof and will never be used. */
export async function purgeExpiredPending(): Promise<number> {
  const rows = await sql(`delete from alert_subscriptions where status = 'pending' and confirm_expires_at < now() - interval '7 days' returning id`);
  return rows.length;
}

// ---------------------------------------------------------------------------------------------- the Telegram bot

/** "/start <code>" in a private chat: activate the subscription the code belongs to. Returns the bot's reply. */
export async function telegramStart(chatId: string, code: string | null): Promise<string> {
  const base = alertsBase();
  if (!code) return BOT.noCode(base);
  if (!START_CODE.test(code)) return BOT.unknown(base);
  const [row] = await sql(`select ${SUBSCRIPTION} from alert_subscriptions where confirm_hash = $1 and channel = 'telegram'`, [sha256Hex(code)]);
  if (!row) return BOT.unknown(base);
  // Telegram redelivers an update it didn't get a 200 for: the same chat sending the same code again is told it's on.
  if (row.status === "active") return row.chat_id === chatId ? BOT.alreadyLinked(row.wallet!) : BOT.used(base);
  if (row.status === "unsubscribed") return BOT.used(base);
  if (row.fresh !== "true") return BOT.expired(base);
  const [, updated] = await transaction([
    walletLock(row.wallet!),
    {
      text: `update alert_subscriptions s set status = 'active', activated_at = now(), telegram_chat_id = $2::bigint
              where s.id = $1 and s.status = 'pending' and s.confirm_expires_at > now()
                and (select count(*) from alert_subscriptions a where a.wallet = s.wallet and a.status = 'active') < $3::int
                and (select count(*) from alert_subscriptions a where a.telegram_chat_id = $2::bigint and a.status = 'active') < $4::int
                and not exists (select 1 from alert_subscriptions a where a.wallet = s.wallet and a.status = 'active' and a.channel = 'telegram' and a.telegram_chat_id = $2::bigint)
             returning wallet`,
      params: [row.id!, chatId, String(ALERT_LIMITS.activePerWallet), String(ALERT_LIMITS.activePerChat)],
    },
  ]);
  if (updated.length) return BOT.linked(updated[0].wallet!, base);
  const [already] = await sql(
    `select wallet from alert_subscriptions where wallet = $1 and status = 'active' and channel = 'telegram' and telegram_chat_id = $2::bigint`,
    [row.wallet!, chatId],
  );
  if (already) return BOT.alreadyLinked(row.wallet!);
  const [now] = await sql(`select status from alert_subscriptions where id = $1`, [row.id!]);
  if (now?.status !== "pending") return BOT.used(base);
  return BOT.full(base);
}

/** "/stop": every active subscription of this chat ends. */
export async function telegramStop(chatId: string): Promise<string> {
  const base = alertsBase();
  const rows = await sql(
    `update alert_subscriptions
        set status = 'unsubscribed', unsubscribed_at = now(), ended_by = 'telegram_stop', telegram_chat_id = null
      where channel = 'telegram' and status = 'active' and telegram_chat_id = $1::bigint
     returning id`,
    [chatId],
  );
  return rows.length ? BOT.stopped(rows.length, base) : BOT.nothingToStop(base);
}
