-- 0001_core: payment requests and rate-limit events (Postgres on Neon).
-- Applied with web/scripts/migrate.sh, which runs each file in one transaction
-- and records it in schema_migrations.

create table requests (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{10}$'),   -- 10-char base58
  kind text not null default 'single' check (kind in ('single', 'split_share', 'invoice')),
  group_id text,
  invoice_id text,
  recipient text not null,
  chain text not null default 'solana',
  token text not null check (token in ('USDC', 'SOL')),
  mint text,                                                       -- null for SOL
  decimals int not null,
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  reference text not null unique,                                  -- 32 random bytes, base58
  payer_name text,
  for_text text,
  note text,
  requester_name text,
  flags text[] not null default '{}',                              -- e.g. {'brand_word:moonpay'}
  status text not null default 'open' check (status in ('open', 'paid', 'underpaid', 'cancelled')),
  paid_signature text,
  paid_payer text,
  paid_amount_atomic numeric(78,0),
  paid_at timestamptz,
  paid_rail text check (paid_rail in ('solana_pay', 'x402')),
  source text not null check (source in ('plugin', 'web')),
  is_team boolean not null default false,                          -- real payments made by the team's own wallets (proof page)
  created_at timestamptz not null default now()
);

create index requests_recipient_created_idx on requests (recipient, created_at desc);
-- One on-chain transaction can settle at most one request.
create unique index requests_paid_signature_key on requests (paid_signature) where paid_signature is not null;
create index requests_paid_idx on requests (paid_at desc) where status = 'paid';

create table rate_events (
  key text not null,
  at timestamptz not null default now()
);
create index rate_events_key_at_idx on rate_events (key, at);
create index rate_events_at_idx on rate_events (at);

-- No policies: only the server's owner role reads or writes.
alter table requests enable row level security;
alter table rate_events enable row level security;
