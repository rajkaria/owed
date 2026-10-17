-- 0014_moonpay: pay a USDC-on-Solana request by card through MoonPay's buy widget.
-- MoonPay delivers the USDC to the recipient in a plain transfer from its own wallet: no Solana Pay
-- reference, so the reference scan can't find it. The widget carries the request id as
-- externalTransactionId; MoonPay's webhook or its by-external-id API then names the Solana
-- transaction, and the request is marked paid (paid_rail = 'moonpay_card') only after the chain shows
-- that transaction credited the recipient's USDC (lib/moonpay/attribution.ts).
--
-- NOTE for merges: this redefines requests_paid_rail_check with every rail so far, including
-- 'matched' from 0012_matched_payments (match_payments, a sibling branch). A later migration that
-- adds a rail must list all of these too.

alter table requests drop constraint if exists requests_paid_rail_check;
alter table requests add constraint requests_paid_rail_check
  check (paid_rail in ('solana_pay', 'x402', 'base_transfer', 'matched', 'moonpay_card'));
-- requests_base_shape (0011) already keeps 'moonpay_card' off Base rows.

-- A payer opened the card checkout for this request: status checks then ask MoonPay about it
-- (GET /v1/transactions/ext/<request id>) for a day, at most every 15 s per request.
create table moonpay_checkouts (
  request_id text primary key references requests (id),
  first_started_at timestamptz not null default now(),
  last_started_at timestamptz not null default now(),
  starts int not null default 1 check (starts > 0),
  last_polled_at timestamptz
);

-- One row per MoonPay Buy transaction for a request.
create table moonpay_purchases (
  moonpay_id text primary key,                 -- MoonPay's transaction id
  request_id text not null references requests (id),
  -- pending:   MoonPay is processing; no Solana transaction yet
  -- failed:    MoonPay reports failure and named no transaction
  -- sent:      MoonPay named a Solana transaction, not yet confirmed on chain
  -- verified:  the chain shows it credited the recipient in full (request is paid)
  -- underpaid: the chain shows it credited the recipient less than owed (request is underpaid)
  -- mismatch:  the named transaction doesn't pay this request (never marks anything)
  state text not null check (state in ('pending', 'failed', 'sent', 'verified', 'underpaid', 'mismatch')),
  moonpay_status text not null,
  moonpay_updated_at timestamptz,
  wallet_address text not null,
  currency_code text,
  signature text,                              -- MoonPay's cryptoTransactionId
  payer text,                                  -- token authority on chain (MoonPay's wallet)
  credited_atomic numeric(78,0),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz
);

-- One Solana transaction is one purchase.
create unique index moonpay_purchases_signature_key on moonpay_purchases (signature) where signature is not null;
create index moonpay_purchases_open_idx on moonpay_purchases (request_id) where state in ('pending', 'sent');

-- No policies: only the server's owner role reads or writes.
alter table moonpay_checkouts enable row level security;
alter table moonpay_purchases enable row level security;
