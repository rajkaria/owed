-- 0004_x402_receipts: payments that arrive over x402 at /x/<id> (sprint W2-B).
-- An x402 payment is a plain USDC transfer co-signed by the facilitator; it carries no
-- Solana Pay reference, so the reference scan can't find it. Each attempt is recorded
-- here, and the request is marked paid (paid_rail = 'x402') only after the chain shows
-- the settled transaction credited the recipient in full.

create table x402_receipts (
  id bigint generated always as identity primary key,
  request_id text not null references requests (id),
  -- settling: handed to the facilitator's /settle, no answer yet
  -- settled:  facilitator returned a transaction, not yet seen crediting the recipient on chain
  -- verified: the chain shows the transaction credited the recipient in full (request is paid)
  -- failed:   settlement refused; no money moved
  -- mismatch: the settled transaction did not credit the recipient in full
  -- unknown:  settlement timed out; whether it landed is unknown
  -- abandoned: a settling lock older than the payment's lifetime, released
  state text not null check (state in ('settling', 'settled', 'verified', 'failed', 'mismatch', 'unknown', 'abandoned')),
  x402_version int not null check (x402_version in (1, 2)),
  network text not null,
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  payer text,                     -- token authority in the signed transaction
  fee_payer text,                 -- the facilitator's signer
  signature text,                 -- the settlement transaction
  error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  verified_at timestamptz
);

-- One payment in flight or settled per request: a second agent paying at the same moment is
-- refused before its money moves. A settling/unknown lock is released once the payer's
-- transaction can no longer land (its blockhash has expired).
create unique index x402_receipts_active_key on x402_receipts (request_id)
  where state in ('settling', 'settled', 'verified', 'unknown');
-- One transaction is one receipt.
create unique index x402_receipts_signature_key on x402_receipts (signature) where signature is not null;
create index x402_receipts_pending_idx on x402_receipts (request_id) where state = 'settled';

-- No policies: only the server's owner role reads or writes.
alter table x402_receipts enable row level security;
