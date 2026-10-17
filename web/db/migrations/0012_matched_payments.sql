-- 0012_matched_payments: payments that arrived without the request's Solana Pay reference, matched by the
-- recipient (match_payments), and follow-up requests for the rest of an underpaid one (ask_for_rest).
--
-- request_matches: one row per request the recipient matched by hand. Exchanges and some wallets drop the
--   reference, so the reference scan never sees the payment. The recipient's own wallet signs
--   "Owed match <transaction> to <id> for <recipient> at <ISO time>" (single use, purpose 'match' in
--   signature_nonces); the server re-reads the transaction on chain (confirmed, successful, credits exactly the
--   amount still due to that recipient, made after the request, names no Owed reference, settles nothing else)
--   before it writes this row and marks the request paid. The signed text and signature stay here as the proof
--   that the recipient, not Owed, attributed the payment. lib/match.ts is the only writer.
--   covers = 'full': the request was open; its paid_* columns name this transaction and paid_rail = 'matched'.
--   covers = 'rest': the request was underpaid; paid_* keep the referenced partial payment, paid_amount_atomic
--   becomes the total of both, and the status becomes paid.
-- requests.rest_of: this request asks for the rest of an underpaid request (POST /api/v1/requests/<id>/rest).
--   At most one per underpaid request; its amount is exactly what was still owed when it was made.

create table request_matches (
  request_id text primary key references requests (id),                       -- one match per request
  signature text not null unique check (signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  covers text not null check (covers in ('full', 'rest')),
  payer text not null check (payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),               -- what this transaction credited
  paid_at timestamptz not null,                                                 -- the transaction's block time
  slot bigint not null check (slot > 0),
  confirmed_by text not null check (confirmed_by ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'), -- the recipient's wallet
  confirm_message text not null check (length(confirm_message) <= 200),
  confirm_signature text not null check (length(confirm_signature) <= 200),
  confirmed_at timestamptz not null default now()
);

alter table requests drop constraint if exists requests_paid_rail_check;
alter table requests add constraint requests_paid_rail_check
  check (paid_rail in ('solana_pay', 'x402', 'base_transfer', 'matched'));
-- (requests_base_shape from 0011 already keeps 'matched' off Base rows: Base payments are found by amount.)

alter table requests add column rest_of text references requests (id);
alter table requests add constraint requests_rest_of_check check (rest_of is distinct from id);
create unique index requests_rest_of_key on requests (rest_of) where rest_of is not null;

-- No policies: only the server's owner role reads or writes.
alter table request_matches enable row level security;
