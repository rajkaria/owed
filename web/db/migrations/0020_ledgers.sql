-- 0020_ledgers: group ledgers and settle-up (F6). A ledger is a running tab for a trip or a house: who is in it, what
-- each of them paid and how each expense is split. settle_up turns the balances into at most n - 1 ordinary Owed
-- requests (largest debtor pays largest creditor, lib/ledgers-math.ts planSettlement), each payable to the creditor's
-- wallet and addressed to the debtor's (so it lands in their what_do_i_owe inbox). Owed holds no money: a settle-up
-- request is paid like any other request, payer to recipient in one transaction, and the chain decides when it is paid.
-- Numbered 0020 by decision D8; it depends on nothing after 0017 (payer columns on requests).
--
-- ledgers: random 12-character base58 id (it commits to nothing: every money term lives in a settle-up request, whose
--   id hashes its own terms). owner_wallet is member 0's wallet. version counts writes (each expense, each settle-up),
--   and a settle-up's signed message names the version it settles, so a stale signature can't settle a changed ledger.
-- ledger_members: position 0 is the owner. wallet / handle / sns are the F1 payer identity (handle and sns are labels
--   for how the owner found the wallet; Owed never verifies a handle). A member without a wallet can owe money (their
--   settle-up request is a plain link) but can't be paid until they have one.
-- ledger_expenses: recorder-written text is cleaned (lib/ledgers-math.ts ledgerText) and shown quoted. currency null
--   means USDC and every *_units column is USDC atomic units (6 decimals); otherwise an ISO 4217 code, *_units are its
--   minor units, and fiat_rate (units per 1 USDC, the two-source rule of lib/fx.ts) locked each member's share to USDC
--   once, rounded up (lib/fiat.ts). amount_atomic is the USDC the payer is credited: the sum of the shares'. Every
--   expense carries the signed message and signature of the wallet that recorded it (the owner's or a member's), over
--   a digest of exactly what is stored, so anyone can recompute the digest and check the signature.
-- ledger_expense_items: a receipt's lines (split 'items'), each split evenly among its members; tax and tip on the
--   expense row follow each member's item subtotal.
-- ledger_expense_shares: what each member owes for one expense, in its currency (units) and in USDC (amount_atomic);
--   weight is the member's shares for split 'shares'. A row per member in the expense; members with no row owe nothing.
-- ledger_settlements / ledger_transfers: one row per settle-up (round = the version it settled) with its signature, and
--   one per request it created. Balances read each request's live status: paid moves its amount, underpaid what
--   arrived, open stays pending, cancelled or expired puts the debt back.
--
-- Amounts are numeric(78,0) integer units, never floats. Additive only: new tables, no change to existing ones.

create table if not exists ledgers (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),
  title text not null check (length(title) between 1 and 240),                    -- requester-written, sanitized
  owner_wallet text not null check (owner_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  member_count smallint not null check (member_count between 2 and 20),
  expense_count smallint not null default 0 check (expense_count between 0 and 100),
  version int not null default 0 check (version >= 0),
  flags text[] not null default '{}',
  source text not null check (source in ('plugin', 'web')),
  created_at timestamptz not null default now()
);
create index if not exists ledgers_owner_created_idx on ledgers (owner_wallet, created_at desc);

create table if not exists ledger_members (
  ledger_id text not null references ledgers (id),
  position smallint not null check (position between 0 and 19),
  name text not null check (length(name) between 1 and 160),                       -- requester-written, sanitized
  wallet text,
  handle text,
  sns text,
  primary key (ledger_id, position),
  constraint ledger_members_payer_check check (
    (wallet is null and handle is null and sns is null)
    -- Every column is checked "is not null" first: a null in a comparison makes the check pass.
    or (wallet is not null
        and wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        and (handle is null or handle ~ '^[a-z0-9_]{1,15}$')
        and (sns is null or (sns ~ '^[^.\s]{1,63}(\.[^.\s]{1,63})?\.sns$' and sns = lower(sns) and length(sns) <= 140)))
  ),
  constraint ledger_members_owner_check check (position <> 0 or wallet is not null)
);
create unique index if not exists ledger_members_wallet_key on ledger_members (ledger_id, wallet) where wallet is not null;
create unique index if not exists ledger_members_name_key on ledger_members (ledger_id, lower(name));

create table if not exists ledger_expenses (
  ledger_id text not null references ledgers (id),
  position smallint not null check (position between 0 and 99),
  description text check (description is null or length(description) between 1 and 320),  -- recorder-written, cleaned
  paid_by smallint not null,
  split text not null check (split in ('even', 'shares', 'exact', 'items')),
  currency text,
  total_units numeric(78,0) not null check (total_units > 0),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  tax_units numeric(78,0) check (tax_units > 0),
  tip_units numeric(78,0) check (tip_units > 0),
  fiat_rate text,
  fiat_rate_source text,
  fiat_quoted_at timestamptz,
  flags text[] not null default '{}',
  recorded_by text not null check (recorded_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signed_message text not null check (length(signed_message) between 1 and 200),
  signature text not null check (length(signature) between 64 and 200),
  created_at timestamptz not null default now(),
  primary key (ledger_id, position),
  foreign key (ledger_id, paid_by) references ledger_members (ledger_id, position),
  constraint ledger_expenses_currency_check check (
    (currency is null and num_nonnulls(fiat_rate, fiat_rate_source, fiat_quoted_at) = 0 and total_units = amount_atomic)
    or (currency is not null
        and currency ~ '^[A-Z]{3}$' and currency <> 'USD'
        and num_nonnulls(fiat_rate, fiat_rate_source, fiat_quoted_at) = 3
        and fiat_rate ~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$' and length(fiat_rate) <= 40 and fiat_rate !~ '^0(\.0*)?$'
        and length(fiat_rate_source) between 1 and 120)
  ),
  constraint ledger_expenses_extras_check check (split = 'items' or (tax_units is null and tip_units is null))
);

create table if not exists ledger_expense_items (
  ledger_id text not null,
  expense_position smallint not null,
  position smallint not null check (position between 0 and 29),
  description text check (description is null or length(description) between 1 and 240),  -- recorder-written, cleaned
  units numeric(78,0) not null check (units > 0),
  members smallint[] not null check (cardinality(members) between 1 and 20),
  primary key (ledger_id, expense_position, position),
  foreign key (ledger_id, expense_position) references ledger_expenses (ledger_id, position)
);

create table if not exists ledger_expense_shares (
  ledger_id text not null,
  expense_position smallint not null,
  member_position smallint not null,
  weight numeric(78,0) check (weight is null or weight > 0),                        -- split 'shares': 1/10,000ths of a share
  units numeric(78,0) not null check (units >= 0),
  amount_atomic numeric(78,0) not null check (amount_atomic >= 0),
  primary key (ledger_id, expense_position, member_position),
  foreign key (ledger_id, expense_position) references ledger_expenses (ledger_id, position),
  foreign key (ledger_id, member_position) references ledger_members (ledger_id, position)
);

create table if not exists ledger_settlements (
  ledger_id text not null references ledgers (id),
  round int not null check (round >= 0),
  recorded_by text not null check (recorded_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signed_message text not null check (length(signed_message) between 1 and 200),
  signature text not null check (length(signature) between 64 and 200),
  created_at timestamptz not null default now(),
  primary key (ledger_id, round)
);

create table if not exists ledger_transfers (
  ledger_id text not null,
  round int not null,
  position smallint not null check (position between 0 and 18),
  from_member smallint not null,
  to_member smallint not null,
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  request_id text not null references requests (id),
  primary key (ledger_id, round, position),
  foreign key (ledger_id, round) references ledger_settlements (ledger_id, round),
  foreign key (ledger_id, from_member) references ledger_members (ledger_id, position),
  foreign key (ledger_id, to_member) references ledger_members (ledger_id, position),
  constraint ledger_transfers_members_check check (from_member <> to_member)
);
create unique index if not exists ledger_transfers_request_key on ledger_transfers (request_id);

-- No policies: only the server's owner role reads or writes.
alter table ledgers enable row level security;
alter table ledger_members enable row level security;
alter table ledger_expenses enable row level security;
alter table ledger_expense_items enable row level security;
alter table ledger_expense_shares enable row level security;
alter table ledger_settlements enable row level security;
alter table ledger_transfers enable row level security;
