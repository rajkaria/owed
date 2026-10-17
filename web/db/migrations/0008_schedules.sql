-- 0008_schedules: recurring requests (W3-D, ask_every_month). A schedule asks the same payer for the same
-- amount on the same day of every month (UTC). Each month's request is an ordinary request row made by
-- lib/requests.ts createRequest, so /r/<id>, /api/v1/status, check_payments, pay_link and the ledger work on
-- it unchanged. schedule_requests ties one request to one (schedule, period): the primary key is what makes
-- the cron route idempotent. A row is claimed before its request is created and points at it once made.

create table schedules (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),
  recipient text not null check (recipient ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  token text not null check (token in ('USDC', 'SOL')),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  payer_name text,                                                  -- requester-written, sanitized
  for_text text,                                                    -- requester-written, sanitized
  requester_name text,                                              -- requester-written, sanitized
  flags text[] not null default '{}',                               -- brand-word flags, copied to each request
  day_of_month smallint not null check (day_of_month between 1 and 28),  -- 28 so every month has the day
  first_period text not null check (first_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),  -- 'YYYY-MM', UTC
  max_requests smallint check (max_requests between 1 and 120),    -- null: every month, no end date
  status text not null default 'active' check (status in ('active', 'ended', 'stopped')),
  source text not null check (source in ('plugin', 'web')),
  -- Verified payee (W2-H): checked at creation and again before each month's request; display only.
  from_domain text check (from_domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
                          and length(from_domain) <= 253),
  from_domain_verified_at timestamptz,
  last_error text,                                                  -- why the last due run opened nothing (DNS)
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  check ((from_domain is null) = (from_domain_verified_at is null)),
  check ((last_error is null) = (last_error_at is null))
);

create index schedules_recipient_created_idx on schedules (recipient, created_at desc);
-- The cron scans active schedules whose day has come.
create index schedules_due_idx on schedules (day_of_month, first_period) where status = 'active';

create table schedule_requests (
  schedule_id text not null references schedules (id),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  request_id text unique references requests (id),                 -- null while the claim is being worked
  claimed_at timestamptz not null default now(),
  primary key (schedule_id, period)
);

-- No policies: only the server's owner role reads or writes.
alter table schedules enable row level security;
alter table schedule_requests enable row level security;
