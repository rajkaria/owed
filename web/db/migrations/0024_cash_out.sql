-- 0024_cash_out: cash out what you're owed (F4). The recipient sells USDC to MoonPay and MoonPay pays their bank. Owed
-- holds nothing: the user's own wallet sends one USDC transfer, approved with their passkey in PayBox, to an address
-- that only ever comes from MoonPay. Off unless OWED_MOONPAY_SELL=1 (sell widget) or OWED_MOONPAY_ENTERPRISE=1
-- (liquidation address); with both off nothing reads or writes these tables.
-- Numbered 0024 by decision D8; it depends on nothing after 0001 (request ids are kept as text, not foreign keys).
--
-- cash_outs: random 12-character base58 id, sent to MoonPay as the sell widget's externalTransactionId, so the sale
--   can be found again (GET /v3/sell_transactions/ext/<id>, https://dev.moonpay.com/api-reference/widget/
--   getselltransactionbyexternalid.md). amount_atomic is the exact USDC to sell (6 decimals); request_ids are the
--   paid requests it was summed from (empty when the user named an amount). deposit_address is written only from
--   MoonPay's own data: the depositWallet.walletAddress of a sell webhook whose Moonpay-Signature-V2 verified
--   (https://dev.moonpay.com/api-reference/widget/webhooks/sell-transaction-updated.md) for a sale whose currency,
--   amount and refund wallet match this row, or (mode 'enterprise') the liquidation address MoonPay Enterprise returns
--   for the user's registered offramp. Never from a caller. transfer_signature is MoonPay's depositHash.
--   last_event keeps MoonPay's last status report (small, no personal data). A cash-out never touches a request's
--   status: it moves the recipient's own money out after it was paid.
-- cash_out_accounts: the Enterprise path. id = the user's MoonPay Enterprise offramp autoramp id; liquidation_address
--   is its Solana deposit rail. The wallet signs "Owed cash-out account <autoramp> to <liquidation address> for
--   <wallet> at <ISO>"; before every transfer the server re-reads the autoramp from MoonPay and checks that address
--   against this signed record (lib/moonpay/accounts.ts), and the plugin checks the wallet's signature itself.

create table if not exists cash_out_accounts (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  provider text not null default 'moonpay_enterprise' check (provider = 'moonpay_enterprise'),
  provider_customer_id text not null check (provider_customer_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  liquidation_address text not null check (liquidation_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  currency text not null check (currency in ('EUR', 'USD', 'GBP')),
  payout_rail text not null check (payout_rail in ('SEPA', 'ACH', 'Wire', 'RTP', 'FEDNOW', 'SWIFT', 'CHAPS', 'FPS')),
  signed_message text not null check (length(signed_message) between 1 and 200),
  signature text not null check (length(signature) between 64 and 200),
  status text not null check (status in ('active', 'closed')),
  created_at timestamptz not null default now()
);
-- One active cash-out account per wallet: there is never a choice of where the money goes.
create unique index if not exists cash_out_accounts_active_key on cash_out_accounts (wallet) where status = 'active';

create table if not exists cash_outs (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  request_ids text[] not null default '{}' check (cardinality(request_ids) <= 20),
  fiat_currency text check (fiat_currency is null or fiat_currency ~ '^[a-z]{3}$'),
  mode text not null check (mode in ('sell_widget', 'enterprise')),
  account_id text references cash_out_accounts (id),
  -- created:             the widget link was issued; MoonPay has no sale for it yet
  -- waiting_for_deposit: MoonPay's sale waits for the USDC (deposit_address set once MoonPay named it)
  -- pending:             MoonPay received the deposit and is paying out
  -- completed / failed:  MoonPay's final word (failure_reason from MoonPay, e.g. "Deposit timeout")
  -- requote_required:    the price moved before the deposit arrived; the user accepts a new quote in MoonPay
  status text not null check (status in ('created', 'waiting_for_deposit', 'pending', 'completed', 'failed', 'requote_required')),
  moonpay_transaction_id text check (moonpay_transaction_id is null or length(moonpay_transaction_id) between 1 and 100),
  moonpay_updated_at timestamptz,
  deposit_address text check (deposit_address is null or deposit_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  transfer_signature text check (transfer_signature is null or length(transfer_signature) between 1 and 120),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 300),
  last_event jsonb check (last_event is null or (jsonb_typeof(last_event) = 'object' and pg_column_size(last_event) <= 2048)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (mode <> 'enterprise' or account_id is not null),
  check (deposit_address is null or deposit_address <> wallet)
);
create index if not exists cash_outs_wallet_idx on cash_outs (wallet, created_at desc);
-- One MoonPay sale is one cash-out.
create unique index if not exists cash_outs_moonpay_key on cash_outs (moonpay_transaction_id) where moonpay_transaction_id is not null;

-- No policies: only the server's owner role reads or writes.
alter table cash_out_accounts enable row level security;
alter table cash_outs enable row level security;
