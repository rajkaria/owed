-- 0017_payer: the payer inbox (F1). A request may name who it is addressed to: the payer's Solana wallet, plus the
-- X handle or .sns name the requester used to find it. what_do_i_owe lists a payer's open requests after the payer's
-- wallet signs "Owed inbox access for <payer> at <ISO time>" (POST /api/v1/inbox), and pay_all pays several in one
-- transaction. Numbered 0017 by decision D8 (0016 is SP1's cta_events); it depends on nothing after 0015.
--
-- requests.payer_wallet: the payer's Solana wallet (base58). The requester's agent got it from PayBox
--   resolve_username (with payer_handle) or from an .sns name the server resolved on Solana (with payer_sns), or the
--   requester gave the wallet itself. Never part of the request id: ids still hash recipient, asset, amount and
--   reference only, so every id and fingerprint stays exactly as it was.
-- requests.payer_handle / requester_handle: X handles, lower case without "@". Labels only: Owed never verifies a
--   handle (the payer's agent checks requester_handle with PayBox resolve_username before paying).
-- requests.paid_instruction: which transfer instruction paid the request (its index in the transaction's
--   instructions, inner ones after the top-level ones; lib/validate.ts). pay_all pays several requests in one
--   transaction, so "one transaction settles one request" becomes "one transfer settles one request". Rows written
--   before 0017, and x402 / MoonPay / Base / matched payments, keep null: the whole transaction, exactly as before.
-- blocked_requesters: a payer hides every request from one requester wallet (the wallet the requests pay).
-- schedules carry the same payer columns, copied to each month's request.
--
-- Additive except the paid-signature index, which is recreated under the same name (so every existing
-- isUniqueViolation(e, "requests_paid_signature_key") still matches): (paid_signature, paid_instruction), with a null
-- instruction counted as one value, keeps today's rule for every row that has none.

alter table requests
  add column if not exists payer_wallet text,
  add column if not exists payer_handle text,
  add column if not exists payer_sns text,
  add column if not exists requester_handle text,
  add column if not exists paid_instruction smallint;

alter table requests drop constraint if exists requests_payer_check;
alter table requests add constraint requests_payer_check check (
  (payer_wallet is null and payer_handle is null and payer_sns is null)
  -- Every column is checked "is not null" first: a null in a comparison makes the check pass.
  or (payer_wallet is not null
      and payer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      and payer_wallet <> recipient
      and (payer_handle is null or payer_handle ~ '^[a-z0-9_]{1,15}$')
      and (payer_sns is null or (payer_sns ~ '^[^.\s]{1,63}(\.[^.\s]{1,63})?\.sns$' and payer_sns = lower(payer_sns) and length(payer_sns) <= 140)))
);

alter table requests drop constraint if exists requests_requester_handle_check;
alter table requests add constraint requests_requester_handle_check check (
  requester_handle is null or requester_handle ~ '^[a-z0-9_]{1,15}$'
);

alter table requests drop constraint if exists requests_paid_instruction_check;
alter table requests add constraint requests_paid_instruction_check check (
  paid_instruction is null or (paid_instruction >= 0 and paid_signature is not null)
);

-- The inbox reads open and underpaid requests by payer.
create index if not exists requests_payer_status_idx on requests (payer_wallet, status) where payer_wallet is not null;

-- One transfer settles one request (was: one transaction settles one request).
drop index if exists requests_paid_signature_key;
create unique index requests_paid_signature_key on requests (paid_signature, coalesce(paid_instruction, -1)) where paid_signature is not null;

create table if not exists blocked_requesters (
  payer_wallet text not null check (payer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- The wallet the blocked requests pay: base58 on Solana, 0x on Base.
  requester_wallet text not null check (requester_wallet ~ '^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$'),
  created_at timestamptz not null default now(),
  primary key (payer_wallet, requester_wallet)
);

alter table schedules
  add column if not exists payer_wallet text,
  add column if not exists payer_handle text,
  add column if not exists payer_sns text,
  add column if not exists requester_handle text;

alter table schedules drop constraint if exists schedules_payer_check;
alter table schedules add constraint schedules_payer_check check (
  (payer_wallet is null and payer_handle is null and payer_sns is null)
  or (payer_wallet is not null
      and payer_wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      and payer_wallet <> recipient
      and (payer_handle is null or payer_handle ~ '^[a-z0-9_]{1,15}$')
      and (payer_sns is null or (payer_sns ~ '^[^.\s]{1,63}(\.[^.\s]{1,63})?\.sns$' and payer_sns = lower(payer_sns) and length(payer_sns) <= 140)))
);
alter table schedules drop constraint if exists schedules_requester_handle_check;
alter table schedules add constraint schedules_requester_handle_check check (
  requester_handle is null or requester_handle ~ '^[a-z0-9_]{1,15}$'
);

-- No policies: only the server's owner role reads or writes.
alter table blocked_requesters enable row level security;
