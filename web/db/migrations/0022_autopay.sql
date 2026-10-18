-- 0022_autopay: autopay within policy (F5) and the PayBox Open Deposit link (F3), sprint SP8. Numbered 0022 by
-- decision D8; it depends on nothing after 0017 and can land before or after 0019-0021 and 0023-0025.
--
-- autopay_rules: a payer's standing rule, "pay <requester wallet>'s requests up to <max> USDC each and <max_month> USDC
--   a month until <date>". The payer's wallet signs
--     "Owed autopay for <payer>: pay <requester> up to <max> USDC per request and <max_month> USDC per month until <YYYY-MM-DD> (at <ISO time>)"
--   with PayBox request_wallet_sign (purpose 'autopay' in signature_nonces: at most 5 minutes old, once), and the server
--   rebuilds that exact text from the fields before it stores them (lib/autopay-core.ts autopayPrefix). The rule is data:
--   Owed never pays anything. The payer's signed inbox (POST /api/v1/inbox, what_do_i_owe) marks each open request
--   eligible / over_limit / not_covered by the rule, and what_do_i_owe hands the payer's agent the exact PayBox pay_x402
--   call for eligible ones. PayBox's own grant and limits stay the hard cap (it may still ask the payer to approve).
--   A rule matches the requester's WALLET only (the wallet the requests pay, requests.recipient). requester_handle and
--   requester_sns are labels the payer's agent resolved (PayBox resolve_username; an .sns name the server re-resolved to
--   that wallet when the rule was made), never matched on (decision D16). One rule per (payer, requester) is live at a
--   time: a new rule revokes the previous one in the same transaction (replaced_by names the new rule). A revoke is
--   signed too: "Owed autopay revoke <rule id> for <payer> at <ISO time>" (purpose 'autopay_revoke').
--   ends_at is the start of the UTC day after the rule's last day, at most a year after the rule was made.
-- requests.deposit_url: a PayBox Open Deposit link the requester's agent made with PayBox get_deposit_link (amount_usd =
--   the request's amount), for payers without a wallet. https on paybox.sh or one of its subdomains, at most 512
--   characters, USDC requests on Solana only, and never part of the request id. The pay page offers it only with
--   OWED_DEPOSIT_LINK=1 and within 24 hours of deposit_url_added_at (PayBox reuses an unpaid link for 24 hours).
--   Nothing is ever marked paid from a deposit link: the chain and match_payments count payments, as before.
--
-- Additive: one new table, two nullable columns and their check. No paid rail is added, so requests_paid_rail_check
-- is unchanged.

alter table requests
  add column if not exists deposit_url text,
  add column if not exists deposit_url_added_at timestamptz;

alter table requests drop constraint if exists requests_deposit_url_check;
alter table requests add constraint requests_deposit_url_check check (
  (deposit_url is null and deposit_url_added_at is null)
  -- Every column is checked "is not null" first: a null in a comparison makes the check pass.
  or (deposit_url is not null and deposit_url_added_at is not null
      and length(deposit_url) <= 512
      and deposit_url ~ '^https://([a-z0-9-]+\.)*paybox\.sh/'
      and token = 'USDC' and chain = 'solana')
);

create table if not exists autopay_rules (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),                     -- random (lib/autopay.ts newRuleId)
  payer_wallet text not null check (payer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),  -- who signed the rule
  requester_wallet text not null check (requester_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'), -- matched against requests.recipient
  requester_handle text check (requester_handle ~ '^[a-z0-9_]{1,15}$'),              -- label only
  requester_sns text check (requester_sns ~ '^[^.\s]{1,63}(\.[^.\s]{1,63})?\.sns$' and requester_sns = lower(requester_sns) and length(requester_sns) <= 140), -- label only
  token text not null default 'USDC' check (token = 'USDC'),                         -- x402 pays USDC only
  max_per_request_atomic numeric(78,0) not null check (max_per_request_atomic > 0),
  max_per_month_atomic numeric(78,0) not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  signed_message text not null check (length(signed_message) <= 300),               -- the payer's signed rule, verbatim
  signature text not null check (length(signature) <= 200),
  revoked_at timestamptz,
  revoke_message text check (length(revoke_message) <= 200),                         -- the payer's signed revoke
  revoke_signature text check (length(revoke_signature) <= 200),
  -- Or the newer rule that replaced it. Deferred: the old rule is retired before the new one is inserted (one live rule
  -- per pair), in the same transaction.
  replaced_by text references autopay_rules (id) deferrable initially deferred,
  check (payer_wallet <> requester_wallet),
  check (max_per_month_atomic >= max_per_request_atomic),
  check (ends_at > created_at and ends_at <= created_at + interval '1 year 2 days'),
  check ((revoke_message is null) = (revoke_signature is null)),
  check (revoked_at is not null or (revoke_message is null and replaced_by is null)),
  check (revoked_at is null or revoke_message is not null or replaced_by is not null)
);

-- One live rule per (payer, requester wallet).
create unique index if not exists autopay_rules_live_key on autopay_rules (payer_wallet, requester_wallet) where revoked_at is null;
-- The inbox reads a payer's rules.
create index if not exists autopay_rules_payer_idx on autopay_rules (payer_wallet, created_at desc);
-- Month-to-date use: requests a payer paid to a requester (lib/autopay.ts monthUse).
create index if not exists requests_recipient_paid_payer_idx on requests (recipient, paid_payer, paid_at) where paid_payer is not null;

-- No policies: only the server's owner role reads or writes.
alter table autopay_rules enable row level security;
