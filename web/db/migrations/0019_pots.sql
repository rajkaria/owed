-- 0019_pots: chip-in pots (F7, sprint SP5). A pot collects contributions for one recipient: a gift, a team dinner,
-- a fundraiser. Numbered 0019 by decision D8. It is applied after 0020 and 0021 on production (they landed first;
-- the build applies whatever files are still pending, in name order), and before them on an empty database, so it
-- depends on nothing after 0017 (requests.payer_wallet) and only touches requests and its own table.
--
-- Decision D15: a contribution IS an ordinary request row (kind 'single', Solana, its id the usual hash of recipient,
-- token, amount and a fresh reference) with pot_id set. The Solana Pay reference scan, the Helius watch, x402
-- (/x/<id>), the card checkout, refunds, /proof and the frozen plugin bundle all work on contributions unchanged.
-- A contribution is minted per scan of the pot's QR (a Solana Pay transaction request, /api/v1/pay/<pot id>), per
-- click on the pot's board (never on render), per verified x402 preset payment (/x/pot/<pot id>/<amount>), and by
-- pay_link right before it proposes a payment. So one person scanning twice makes two rows, and only the one whose
-- reference lands on chain is paid; the board sums paid contributions.
--
-- pots.id: the last 14 base58 characters of sha256("owed-pot:v1\n" recipient "\n" asset "\n" nonce) (lib/ids.ts
--   potIdFor): it commits to the wallet and the token, so the plugin can check a pot before paying it. 14 characters
--   never collide with a 10- or 12-character request id.
-- pots.nonce: 32 random bytes (base58) minted by the server, returned with the pot so anyone can recompute the id.
-- pots.title / note / requester_name: requester-written, sanitized (lib/safety.ts) and always shown quoted.
--   requester_handle: an X handle label, same rule as 0017; never verified.
-- pots.target_atomic: optional goal; suggested_atomic: the default contribution; any_amount: whether a contributor
--   may choose any amount (false: only the suggested amount or a preset). presets_atomic: up to 4 fixed USDC amounts,
--   each paid over x402 at its own endpoint (/x/pot/<id>/<amount>), and offered as buttons on the board.
-- pots.deadline: every pot ends (default 30 days, at most 90 after creation). Past it, nothing new is minted, and a
--   contribution expires at least(deadline, minted + 24 hours) (requests.expires_at), so every request rail refuses
--   it too. A payment that lands anyway is still recorded (the chain is the truth) and counts on the board.
-- requests.pot_id: the pot a contribution belongs to. requests_expires_check is recreated under the same name and
--   loosened (not tightened) for contributions only: they may expire less than a day after they are minted.
--
-- Amounts are numeric(78,0) atomic units, never floats. Additive except requests_expires_check (loosened).

create table if not exists pots (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{14}$'),
  recipient text not null check (recipient ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),          -- a Solana wallet (no Base pots)
  token text not null check (token in ('USDC', 'SOL')),
  nonce text not null unique check (nonce ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  title text not null check (length(title) between 1 and 120),                       -- requester-written, sanitized
  note text check (note is null or length(note) between 1 and 140),                  -- requester-written, sanitized
  requester_name text check (requester_name is null or length(requester_name) between 1 and 40),
  requester_handle text check (requester_handle is null or requester_handle ~ '^[a-z0-9_]{1,15}$'),
  target_atomic numeric(78,0) check (target_atomic is null or target_atomic > 0),
  suggested_atomic numeric(78,0) check (suggested_atomic is null or suggested_atomic > 0),
  any_amount boolean not null default true,
  presets_atomic numeric(78,0)[] not null default '{}',
  deadline timestamptz not null,
  flags text[] not null default '{}',
  source text not null check (source in ('plugin', 'web')),
  created_at timestamptz not null default now(),
  constraint pots_presets_check check (
    cardinality(presets_atomic) <= 4
    and array_position(presets_atomic, null) is null
    and 0 < all (presets_atomic)
    and (cardinality(presets_atomic) = 0 or token = 'USDC')                          -- x402 pays USDC only
  ),
  constraint pots_deadline_check check (deadline > created_at and deadline <= created_at + interval '90 days'),
  -- A pot that takes only fixed amounts must name at least one.
  constraint pots_amount_rule_check check (any_amount or suggested_atomic is not null or cardinality(presets_atomic) > 0)
);
-- who_owes_me lists a recipient's open pots.
create index if not exists pots_recipient_deadline_idx on pots (recipient, deadline desc);

alter table requests add column if not exists pot_id text references pots (id);
-- The board reads a pot's contributions by status.
create index if not exists requests_pot_status_idx on requests (pot_id, status) where pot_id is not null;

-- A contribution is a plain Solana request that always ends: not a share, not an invoice, not addressed to anyone.
alter table requests drop constraint if exists requests_pot_check;
alter table requests add constraint requests_pot_check check (
  pot_id is null
  or (kind = 'single' and chain = 'solana' and group_id is null and invoice_id is null and payer_wallet is null and expires_at is not null)
);

-- Was (0007): whole days from 1 to 90 after creation. Contributions may end sooner (least(deadline, minted + 24 h)).
alter table requests drop constraint if exists requests_expires_check;
alter table requests add constraint requests_expires_check check (
  expires_at is null
  or (expires_at >= created_at + interval '1 day' and expires_at <= created_at + interval '90 days')
  or (pot_id is not null and expires_at > created_at and expires_at <= created_at + interval '1 day')
);

-- No policies: only the server's owner role reads or writes.
alter table pots enable row level security;
