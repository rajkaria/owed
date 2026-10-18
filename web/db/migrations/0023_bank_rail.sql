-- 0023_bank_rail: pay an invoice by bank transfer to the recipient's own MoonPay Enterprise virtual account (F3, bank
-- row). Off unless OWED_BANK_RAIL=1 (plus the Enterprise keys, lib/moonpay/enterprise.ts): with the flag off nothing
-- reads or writes these tables and no request can carry paid_rail 'bank_transfer'.
--
-- A virtual account is a MoonPay Enterprise onramp autoramp (https://dev.enterprise.moonpay.com/onramp.md): a named
-- EUR, USD or GBP bank account in the recipient's name whose deposits MoonPay converts to USDC and delivers to the
-- recipient's Solana wallet. Bank transfers carry no payment reference, so a payment is attributed from MoonPay's signed
-- webhook (the transaction's fiat amount and time, read back from GET /api/autoramp-transactions/ids) plus the chain:
-- exactly one open invoice for that recipient with that fiat amount is marked paid (paid_rail 'bank_transfer') only
-- after Solana shows MoonPay's USDC delivery to the recipient's wallet; two or more open invoices sharing the amount
-- are left for the recipient (match_payments); a smaller amount marks the only open invoice underpaid. A webhook alone
-- never marks anything (lib/moonpay/bank.ts).
-- Numbered 0023 by decision D8; it depends on nothing after 0014 (the rail list below includes 'moonpay_card').
--
-- NOTE for merges: this redefines requests_paid_rail_check with every rail so far. 0015 to 0021 added no rail. A later
-- migration that adds a rail must list all of these too. requests_base_shape (0011) already keeps 'bank_transfer'
-- off Base rows.
--
-- virtual_accounts: one row per registered onramp autoramp (id = MoonPay's autoramp id). account_details holds only
--   what a payer needs to send money (lib/moonpay/accounts.ts payerDetails: IBAN and BIC; routing and account number;
--   sort code and account number; account holder and bank names), never a MoonPay customer's KYC data. The recipient's
--   wallet signs "Owed bank account <autoramp> details <hash> for <wallet> at <ISO>", where <hash> is the first 16 hex
--   digits of sha256 over the canonical account_details: pages check that signature before showing the details, so
--   nothing but what the recipient signed is ever shown to a payer.
-- bank_transfers: one row per MoonPay autoramp transaction reported for a virtual account, and what it did.

alter table requests drop constraint if exists requests_paid_rail_check;
alter table requests add constraint requests_paid_rail_check
  check (paid_rail in ('solana_pay', 'x402', 'base_transfer', 'matched', 'moonpay_card', 'bank_transfer'));

create table if not exists virtual_accounts (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  provider text not null default 'moonpay_enterprise' check (provider = 'moonpay_enterprise'),
  provider_customer_id text not null check (provider_customer_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  currency text not null check (currency in ('EUR', 'USD', 'GBP')),
  rails text[] not null check (
    cardinality(rails) between 1 and 6 and rails <@ array['SEPA', 'ACH', 'Wire', 'RTP', 'FedNow', 'CHAPS', 'FPS']::text[]
  ),
  account_details jsonb not null check (jsonb_typeof(account_details) = 'object' and pg_column_size(account_details) <= 4096),
  details_hash text not null check (details_hash ~ '^[0-9a-f]{16}$'),
  status text not null check (status in ('active', 'closed')),
  signed_message text not null check (length(signed_message) between 1 and 200),
  signature text not null check (length(signature) between 64 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One active account per recipient and currency: the invoice page shows exactly one set of details.
create unique index if not exists virtual_accounts_active_key on virtual_accounts (wallet, currency) where status = 'active';

create table if not exists bank_transfers (
  provider_tx_id text primary key check (provider_tx_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  virtual_account_id text not null references virtual_accounts (id),
  -- pending:    MoonPay is still converting or delivering (no Solana transaction yet)
  -- sent:       MoonPay named its Solana delivery; not yet confirmed on chain
  -- verified:   the chain confirmed it and it paid exactly one open invoice (request_id is set, request is paid)
  -- underpaid:  the chain confirmed it; less than the only open invoice in that currency (request is underpaid)
  -- ambiguous:  two or more open invoices share the amount: nothing marked, the recipient uses match_payments
  -- unmatched:  confirmed, but no open invoice has that amount: nothing marked
  -- mismatch:   MoonPay's report or the chain doesn't fit this account (never marks anything)
  -- failed:     MoonPay reports a terminal failure (Failed, RejectedAml, RejectedFraud, RejectedMinAmount)
  state text not null check (state in ('pending', 'sent', 'verified', 'underpaid', 'ambiguous', 'unmatched', 'mismatch', 'failed')),
  provider_status text not null check (length(provider_status) between 1 and 40),
  fiat_currency text not null check (fiat_currency in ('EUR', 'USD', 'GBP')),
  fiat_amount text not null check (fiat_amount ~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$'),
  usdc_amount text check (usdc_amount is null or usdc_amount ~ '^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$'), -- MoonPay's figure: display only
  signature text check (signature is null or signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$'), -- payout_crypto_transaction.transaction_hash
  request_id text references requests (id),
  payer text,                                  -- token authority on chain (MoonPay's wallet)
  credited_atomic numeric(78,0),
  error text check (error is null or length(error) <= 300),
  received_at timestamptz,                     -- MoonPay's created_at for the transaction
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz
);
-- One Solana transaction is one bank transfer.
create unique index if not exists bank_transfers_signature_key on bank_transfers (signature) where signature is not null;
create index if not exists bank_transfers_open_idx on bank_transfers (virtual_account_id) where state in ('pending', 'sent');

-- No policies: only the server's owner role reads or writes.
alter table virtual_accounts enable row level security;
alter table bank_transfers enable row level security;
