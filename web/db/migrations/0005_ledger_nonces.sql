-- 0005_ledger_nonces: single use for signed wallet messages (lib/verify-signature.ts).
-- POST /api/v1/ledger accepts "Owed ledger access for <recipient> at <ISO time>" signed by the
-- recipient's wallet, at most 5 minutes old, once. A row here means that exact message was spent.
-- W3-C's cancel_request uses the same table with purpose 'cancel'.

create table signature_nonces (
  message_sha256 text primary key check (message_sha256 ~ '^[0-9a-f]{64}$'),  -- sha256 of the exact signed text
  purpose text not null check (purpose ~ '^[a-z_]{1,32}$'),                  -- 'ledger', later 'cancel'
  signer text not null check (signer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signed_at timestamptz not null,                                             -- the time written in the message
  used_at timestamptz not null default now()
);

-- Per-wallet hourly cap, and the purge of rows too old to pass the freshness check again.
create index signature_nonces_signer_used_idx on signature_nonces (purpose, signer, used_at);
create index signature_nonces_used_idx on signature_nonces (used_at);

-- No policies: only the server's owner role reads or writes.
alter table signature_nonces enable row level security;
