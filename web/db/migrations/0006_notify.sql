-- 0006_notify: paid-request webhooks (sprint W3-A, SPEC T3.1 without the email half).
-- One Helius webhook per deployment watches the Solana Pay reference key of every open request.
-- When a payment touches a watched key, Helius posts to /api/hooks/helius; the route re-checks the
-- chain through the normal settle path (the body is never trusted for money) and the request is
-- marked paid with nobody polling it. These tables are the webhook registry and the delivery log.

-- The Helius webhook each deployment registered, keyed by the public URL Helius posts to (without
-- any query string). Production and previews each register their own.
create table notify_webhooks (
  url text primary key,
  helius_id text not null unique,
  address_count int not null default 0 check (address_count >= 0),
  synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- One row per transaction Helius reported. It makes deliveries idempotent (Helius retries and may
-- deliver twice: a transaction already settled is not re-checked) and is the evidence of what the
-- webhook did: marked_paid lists the requests this delivery itself moved from open to paid.
create table helius_deliveries (
  signature text primary key check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  -- processing: being checked against the chain now
  -- paid:       every request the transaction references is paid
  -- open:       a referenced request is still open after the re-checks (the chain disagrees with the body)
  -- no_request: no Owed request has any of the transaction's keys
  outcome text not null check (outcome in ('processing', 'paid', 'open', 'no_request')),
  request_ids text[] not null default '{}',
  marked_paid text[] not null default '{}',
  deliveries int not null default 1 check (deliveries >= 1),
  -- The item Helius delivered for this transaction (first delivery, at most 64 KB): what the webhook saw.
  payload jsonb,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index helius_deliveries_received_idx on helius_deliveries (received_at desc);

-- No policies: only the server's owner role reads or writes.
alter table notify_webhooks enable row level security;
alter table helius_deliveries enable row level security;
