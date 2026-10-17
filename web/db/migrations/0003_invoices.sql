-- 0003_invoices: printable invoices. An invoice is one ordinary request row (kind 'invoice') for the
-- invoice total plus this row with the same id, so /r/<id>, /api/v1/status, check_payments and pay_link
-- work on invoices unchanged. The shared id is derived from the payment terms (lib/ids.ts), so it commits
-- to the recipient, token, total and reference. Both rows are written in one transaction (lib/invoices.ts).

create table invoices (
  id text primary key references requests (id) check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),
  recipient text not null,
  token text not null check (token in ('USDC', 'SOL')),
  total_atomic numeric(78,0) not null check (total_atomic > 0),  -- equals the request's amount_atomic
  business_name text not null,                                  -- requester-written, sanitized
  client_name text not null,                                    -- requester-written, sanitized
  invoice_number text,                                          -- requester-written, sanitized; null = show the id
  notes text,                                                   -- requester-written, sanitized
  due_date date not null,
  -- [{"description": text, "quantity": "1.5", "unit_price_atomic": "40000000", "amount_atomic": "60000000"}]
  -- Amounts are strings of atomic units: no JSON numbers, so no floats.
  items jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 20),
  flags text[] not null default '{}',
  source text not null check (source in ('plugin', 'web')),
  -- Verified payee (W2-H, SPEC §5.2 T2.8): the domain whose _owed TXT record published `recipient` when the
  -- server re-checked it at creation. Display only; the plugin always checks DNS itself. Same rule as 0009.
  from_domain text,
  from_domain_verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invoices_from_domain_check check (
    from_domain is null
    or (from_domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
        and length(from_domain) <= 253
        and from_domain_verified_at is not null)
  )
);

create index invoices_recipient_created_idx on invoices (recipient, created_at desc);

-- An invoice's request points at itself: kind 'invoice' exactly when invoice_id is set, and then it is the row's id.
alter table requests add constraint requests_invoice_shape check (
  (kind = 'invoice') = (invoice_id is not null) and (invoice_id is null or invoice_id = id)
);

-- No policies: only the server's owner role reads or writes.
alter table invoices enable row level security;
