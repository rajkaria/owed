-- 0025_alerts: paid alerts (S1, decision D19). On /alerts a recipient links a Telegram chat or an email address to their
-- wallet after the wallet signs "Owed alerts for <wallet> at <ISO time>" (lib/verify-signature.ts: ed25519, at most
-- 5 minutes old, each signed message once). When a request paying that wallet moves to paid or part paid, on any rail,
-- every active subscription for the wallet gets exactly one alert. Telegram is live once TELEGRAM_BOT_TOKEN,
-- TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET are set; email stays dormant (not offered, refused by the API) until
-- RESEND_API_KEY and OWED_ALERTS_FROM are set (lib/alerts/config.ts). Numbered 0025 by decision D8; it depends on
-- nothing after 0007 (requests and its statuses).
--
-- alert_subscriptions: one row per link of a wallet to a chat or an address. Random 12-character base58 id.
--   pending      created by POST /api/v1/alerts. confirm_hash is the sha256 of the one-time secret handed out: the
--                Telegram /start code (15 minutes) or the email confirm token (24 hours). The raw secret is never stored.
--   active       the chat sent "/start <code>" (telegram_chat_id set) or the address owner confirmed the link.
--   unsubscribed /stop in the chat, an unsubscribe link, or the channel refused delivery for good (the bot was blocked).
--                The chat id and the address are scrubbed then; ended_by says why.
--   proof_message / proof_signature: the wallet's signed request, kept as the evidence the wallet asked for alerts.
--   At most a few active subscriptions per wallet (lib/alerts/subscribe.ts), never two for the same wallet and chat or
--   the same wallet and address.
-- alert_unsubscribe_tokens: every email Owed sends carries its own one-click unsubscribe link (also in the
--   List-Unsubscribe header). Only the token's sha256 is stored; a token never expires.
-- alert_deliveries: the outbox. The trigger below inserts one row per (active subscription, request) in the same
--   transaction that records the payment, so no rail can skip it and the unique key makes it one alert per request.
--   lib/alerts/deliver.ts claims due rows (pending -> sending), sends after the response that settled the request (and on
--   the daily cron), and finishes them sent, failed (gave up after a bounded number of attempts, or the channel refused
--   for good), or skipped (unsubscribed before it went out).
--
-- Additive only: three new tables and one trigger on requests that writes to alert_deliveries and nothing else. Any error
-- inside it is caught and logged as a warning: an alert can never fail or roll back a settle.

create table if not exists alert_subscriptions (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  channel text not null check (channel in ('telegram', 'email')),
  status text not null default 'pending' check (status in ('pending', 'active', 'unsubscribed')),
  telegram_chat_id bigint,
  email text check (email is null or (length(email) between 3 and 254 and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  confirm_hash text not null unique check (confirm_hash ~ '^[0-9a-f]{64}$'),
  confirm_expires_at timestamptz not null,
  proof_message text not null check (length(proof_message) between 1 and 200),
  proof_signature text not null check (length(proof_signature) between 1 and 200),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  unsubscribed_at timestamptz,
  ended_by text check (ended_by in ('telegram_stop', 'unsubscribe_link', 'bot_blocked', 'undeliverable')),
  constraint alert_subscriptions_contact_check check (
    (channel = 'telegram' and email is null) or (channel = 'email' and telegram_chat_id is null)
  ),
  -- Every column is checked "is not null" first where it matters: a null in a comparison makes a check pass.
  constraint alert_subscriptions_state_check check (
    (status = 'pending' and activated_at is null and unsubscribed_at is null and ended_by is null)
    or (status = 'active' and activated_at is not null and unsubscribed_at is null and ended_by is null
        and (channel <> 'telegram' or telegram_chat_id is not null) and (channel <> 'email' or email is not null))
    or (status = 'unsubscribed' and unsubscribed_at is not null and ended_by is not null
        and telegram_chat_id is null and email is null)
  ),
  constraint alert_subscriptions_pending_contact_check check (status <> 'pending' or channel <> 'email' or email is not null)
);

-- The trigger's lookup: active subscriptions of a recipient wallet.
create index if not exists alert_subscriptions_active_wallet_idx on alert_subscriptions (wallet) where status = 'active';
-- /stop: every active subscription of a chat.
create index if not exists alert_subscriptions_active_chat_idx on alert_subscriptions (telegram_chat_id) where status = 'active';
-- Caps per wallet (active and unexpired pending).
create index if not exists alert_subscriptions_wallet_created_idx on alert_subscriptions (wallet, created_at desc);
create unique index if not exists alert_subscriptions_one_per_chat on alert_subscriptions (wallet, telegram_chat_id)
  where status = 'active' and channel = 'telegram';
create unique index if not exists alert_subscriptions_one_per_address on alert_subscriptions (wallet, email)
  where status = 'active' and channel = 'email';

create table if not exists alert_unsubscribe_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  subscription_id text not null references alert_subscriptions (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists alert_unsubscribe_tokens_subscription_idx on alert_unsubscribe_tokens (subscription_id);

create table if not exists alert_deliveries (
  id bigint generated always as identity primary key,
  subscription_id text not null references alert_subscriptions (id) on delete cascade,
  request_id text not null references requests (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts smallint not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  error text check (length(error) <= 300),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint alert_deliveries_one_per_request unique (subscription_id, request_id),
  constraint alert_deliveries_sent_check check ((status = 'sent') = (sent_at is not null)),
  constraint alert_deliveries_claim_check check ((status = 'sending') = (claimed_at is not null))
);
create index if not exists alert_deliveries_due_idx on alert_deliveries (next_attempt_at) where status in ('pending', 'sending');
create index if not exists alert_deliveries_request_idx on alert_deliveries (request_id);

-- A request moved to paid or part paid (from open, cancelled, or any status that wasn't already settled): queue one alert
-- per active subscription of its recipient. Underpaid -> paid queues nothing new (one alert per request). Errors are
-- swallowed into a warning so that recording a payment never fails because of an alert.
create or replace function owed_alert_paid() returns trigger language plpgsql as $$
begin
  begin
    insert into alert_deliveries (subscription_id, request_id)
    select s.id, new.id
      from alert_subscriptions s
     where s.wallet = new.recipient and s.status = 'active'
    on conflict (subscription_id, request_id) do nothing;
  exception when others then
    raise warning 'owed_alert_paid %: %', new.id, sqlerrm;
  end;
  return new;
end
$$;

drop trigger if exists requests_alert_paid on requests;
create trigger requests_alert_paid
  after update of status on requests
  for each row
  when (new.status in ('paid', 'underpaid') and old.status not in ('paid', 'underpaid'))
  execute function owed_alert_paid();

-- No policies: only the server's owner role reads or writes.
alter table alert_subscriptions enable row level security;
alter table alert_unsubscribe_tokens enable row level security;
alter table alert_deliveries enable row level security;
