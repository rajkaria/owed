-- 0021_invoice_terms: merchant-grade invoices (F8, sprint SP7). Numbered 0021 by decision D8; it depends on nothing
-- after 0017 and can land before or after 0018-0020.
--
-- The rule: a request id commits to its exact amount (lib/ids.ts), so a term that changes what is owed never edits a
-- request. It opens a new one, linked to the invoice here.
--
-- refunds: the recipient sends all or part of a paid request back to the wallet that paid it. The recipient's wallet
--   signs "Owed refund <amount> <token> of <request id> to <payer> for <recipient> at <ISO time>" (purpose 'refund' in
--   signature_nonces, 5 minutes, once); the server then picks a fresh 32-byte reference and the plugin proposes one
--   unsigned transfer recipient -> payer carrying it (memo owed-refund:<id>). Owed holds nothing and signs nothing.
--   A refund is 'pending' until the chain shows that transfer (lib/validate.ts findPayments, the paid-detection rule:
--   confirmed, successful, carries the reference, credits the payer at least the amount, sent by the recipient);
--   only then 'confirmed'. A pending refund older than 30 minutes no longer holds back part of the refundable amount
--   (its blockhash is long dead), but the chain is still read for it. lib/refunds.ts keeps confirmed + live pending
--   refunds at or under what the request was paid, under a row lock on the request.
-- invoice_terms: one row per invoice that has terms (installments, an early-pay discount, a late fee, or a chase
--   schedule other than the default). Invoices without a row chase on days 3/7/14 after their due date.
--   Amounts here are in the invoice's item units: the token's atomic units, or a local currency's minor units.
-- invoice_term_requests: every request a term plan opens, with its amount, due date and the day it opens. The
--   invoice's own request (same id as the invoice) is installment 1, or the early price. The daily cron
--   (/api/cron/schedules, lib/invoice-terms.ts runDueInvoiceTerms) opens later installments OPEN_LEAD_DAYS before their
--   due date, the full price the day after the early price ends (unless the early price was paid), and the late fee
--   once, the day after the due date, only when the invoice wasn't paid on time. A claimed_at older than 10 minutes is
--   a dead run and may be retried; (invoice_id, role, seq) is what makes the cron idempotent. Each opened request is a
--   whole invoice of its own (an invoices row plus a kind 'invoice' request, made in one transaction), so its page,
--   /status, check_payments, pay_link, who_owes_me and write_reminder all work on it unchanged.
-- requests.superseded_by: the early and full price are two prices for one invoice. When one of them is paid (or
--   partly paid), the trigger below cancels the other in the same transaction that records the payment, whichever
--   path recorded it (Solana Pay, x402, card, a matched payment), and a full price that hasn't opened yet never opens.
--   Such a cancellation carries no signed message: superseded_by names the request whose payment cancelled it.
--   requests_cancel_check is recreated (same name) to allow exactly that; every existing row already satisfies it, and
--   code that doesn't know the column reads such a request as plainly cancelled.
-- invoices.extras: set on an invoice with terms, one a plan opened, and one with a refund on its requests (and on the
--   plan's invoice), so the invoice API and page read the extra rows only when there are some.
--
-- Additive except requests_cancel_check, which is loosened, not tightened: code already deployed keeps working.

create table refunds (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),              -- derived from the terms (lib/refunds.ts)
  request_id text not null references requests (id) on delete cascade,      -- the paid request being refunded
  recipient text not null check (recipient ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'), -- who refunds: the request's recipient
  payer text not null check (payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),         -- where it goes: the request's paid_payer
  token text not null check (token in ('USDC', 'SOL')),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  reference text not null unique check (reference ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signed_message text not null check (length(signed_message) <= 200),       -- the recipient's signed refund message
  signature text not null check (length(signature) <= 200),
  status text not null default 'pending' check (status in ('pending', 'confirmed')),
  confirmed_signature text check (confirmed_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  confirmed_instruction smallint check (confirmed_instruction >= 0),          -- the transfer that carried the reference
  confirmed_amount_atomic numeric(78,0) check (confirmed_amount_atomic > 0),  -- what it credited the payer
  confirmed_at timestamptz,                                                   -- its block time
  confirmed_slot bigint check (confirmed_slot > 0),
  created_at timestamptz not null default now(),
  check (payer <> recipient),
  check ((status = 'confirmed') = (confirmed_signature is not null)),
  check ((confirmed_signature is null) = (confirmed_at is null)
     and (confirmed_signature is null) = (confirmed_amount_atomic is null)
     and (confirmed_signature is null) = (confirmed_slot is null))
);

create index refunds_request_idx on refunds (request_id, created_at);
create index refunds_pending_idx on refunds (created_at) where status = 'pending';
-- One transfer confirms one refund.
create unique index refunds_confirmed_signature_key on refunds (confirmed_signature, coalesce(confirmed_instruction, -1))
  where confirmed_signature is not null;

create table invoice_terms (
  invoice_id text primary key references invoices (id) on delete cascade,
  installment_count smallint check (installment_count between 2 and 12),
  installment_interval text check (installment_interval ~ '^(monthly|[1-9][0-9]{0,2})$'),  -- 'monthly' or days
  early_units numeric(78,0) check (early_units > 0),               -- the early price
  early_discount_units numeric(78,0) check (early_discount_units > 0),
  early_bps smallint check (early_bps between 1 and 9999),          -- when the discount was given as a percent
  early_until date,                                                 -- the last day the early price is payable (UTC)
  late_fee_units numeric(78,0) check (late_fee_units > 0),         -- printed on the invoice at issue
  late_fee_bps smallint check (late_fee_bps between 1 and 10000),
  chase_days smallint[] default '{3,7,14}',                        -- days after due for polite/firm/formal; null = off
  created_at timestamptz not null default now(),
  check (installment_count is null or early_until is null),         -- installments or an early price, not both
  check ((installment_count is null) = (installment_interval is null)),
  check ((early_until is null) = (early_units is null) and (early_until is null) = (early_discount_units is null)),
  check (early_bps is null or early_until is not null),
  check (late_fee_bps is null or late_fee_units is not null),
  check (chase_days is null or (array_length(chase_days, 1) between 1 and 3 and 1 <= all (chase_days) and 90 >= all (chase_days)))
);

-- invoices.extras: this invoice has terms, was opened by a plan, or has refunds on its requests, so readers load those;
-- every other invoice is read exactly as before (no extra queries).
alter table invoices add column if not exists extras boolean not null default false;

create table invoice_term_requests (
  invoice_id text not null references invoices (id) on delete cascade,
  role text not null check (role in ('installment', 'early_price', 'full_price', 'late_fee')),
  seq smallint not null check (seq between 1 and 12),                -- installment number; 1 for the other roles
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),   -- what its request asks, in USDC or SOL atomic units
  units numeric(78,0) not null check (units > 0),                   -- the same in the invoice's item units
  -- installment / early_price / full_price: the request's due date. late_fee: the due date it applies after.
  due_date date not null,
  opens_on date not null,
  state text not null default 'scheduled' check (state in ('scheduled', 'opened', 'skipped')),
  request_id text unique references requests (id) on delete cascade,
  skip_reason text check (length(skip_reason) <= 200),
  claimed_at timestamptz,
  last_error text check (length(last_error) <= 300),                 -- why the last due run opened nothing (DNS), retried
  created_at timestamptz not null default now(),
  primary key (invoice_id, role, seq),
  check ((state = 'opened') = (request_id is not null)),
  check ((state = 'skipped') = (skip_reason is not null)),
  check (role = 'installment' or seq = 1)
);

create index invoice_term_requests_due_idx on invoice_term_requests (opens_on) where state = 'scheduled';

alter table requests add column if not exists superseded_by text references requests (id);
alter table requests drop constraint if exists requests_superseded_check;
alter table requests add constraint requests_superseded_check check (superseded_by is distinct from id);

-- Was (0007): a cancellation always carries the recipient's signed proof. Now: either that proof, or superseded_by.
alter table requests drop constraint if exists requests_cancel_check;
alter table requests add constraint requests_cancel_check check (
  (cancel_message is null) = (cancel_signature is null)
  and (cancelled_at is null) = (cancel_message is null and superseded_by is null)
  and (cancel_message is null or superseded_by is null)
  and (cancel_message is null or length(cancel_message) <= 200)
  and (cancel_signature is null or length(cancel_signature) <= 200)
);

-- One of an invoice's two prices was paid: cancel the other, and never open a full price the early price already settled.
create or replace function owed_term_pair_paid() returns trigger language plpgsql as $$
begin
  update requests r
     set status = 'cancelled', cancelled_at = now(), superseded_by = new.id
   where r.status = 'open'
     and r.id <> new.id
     and r.id in (
       select o.request_id
         from invoice_term_requests me
         join invoice_term_requests o
           on o.invoice_id = me.invoice_id and o.role <> me.role
          and o.role in ('early_price', 'full_price') and o.request_id is not null
        where me.request_id = new.id and me.role in ('early_price', 'full_price'));
  update invoice_term_requests t
     set state = 'skipped', skip_reason = 'the early price was paid', claimed_at = null
   where t.role = 'full_price' and t.state = 'scheduled'
     and t.invoice_id in (select me.invoice_id from invoice_term_requests me where me.request_id = new.id and me.role = 'early_price');
  return new;
end
$$;

drop trigger if exists requests_term_pair_paid on requests;
create trigger requests_term_pair_paid
  after update of status on requests
  for each row
  when (new.status in ('paid', 'underpaid') and old.status is distinct from new.status)
  execute function owed_term_pair_paid();

-- No policies: only the server's owner role reads or writes.
alter table refunds enable row level security;
alter table invoice_terms enable row level security;
alter table invoice_term_requests enable row level security;
