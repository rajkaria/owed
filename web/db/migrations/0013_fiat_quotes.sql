-- 0013_fiat_quotes: local-currency asks ("ask Priya for ₹1,200"). The request is still a USDC request:
-- amount_atomic is the USDC locked when it was created, the id still commits to it (lib/ids.ts), and it
-- never changes. These columns keep the quote that produced it, for display only:
--   fiat_currency     ISO 4217 code from lib/fiat.ts's allowlist (never USD: that is a plain USDC ask)
--   fiat_amount       the amount asked in that currency, a decimal string ("1200", "1200.5")
--   fiat_rate         units of fiat_currency per 1 USDC, a decimal string (at most 12 places)
--   fiat_rate_source  which source(s) the rate came from (lib/fx.ts)
--   fiat_quoted_at    when the rate was locked
-- amount_atomic = ceil(fiat_amount / fiat_rate × 10^6): every reader can recompute it (lib/fiat.ts
-- quoteProblem), and pay surfaces refuse a request whose quote doesn't give its amount.
-- Split shares each carry their own fiat_amount at the group's rate; groups keep the bill's fiat total.
-- An invoice's items are priced in invoices.fiat_currency (minor units in items' *_atomic fields);
-- its request row carries the quote for the invoice total.
-- Applies after 0011 (Base); 0010 and 0012 are left to other branches.

alter table requests
  add column if not exists fiat_currency text,
  add column if not exists fiat_amount text,
  add column if not exists fiat_rate text,
  add column if not exists fiat_rate_source text,
  add column if not exists fiat_quoted_at timestamptz;

alter table requests drop constraint if exists requests_fiat_shape;
alter table requests add constraint requests_fiat_shape check (
  -- All five or none. (A null inside the second branch would make the whole check null, which Postgres accepts.)
  num_nonnulls(fiat_currency, fiat_amount, fiat_rate, fiat_rate_source, fiat_quoted_at) = 0
  or (num_nonnulls(fiat_currency, fiat_amount, fiat_rate, fiat_rate_source, fiat_quoted_at) = 5
      and fiat_currency ~ '^[A-Z]{3}$' and fiat_currency <> 'USD'
      and fiat_amount ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' and length(fiat_amount) <= 40
      and fiat_rate ~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$' and length(fiat_rate) <= 40 and fiat_rate !~ '^0(\.0*)?$'
      and length(fiat_rate_source) between 1 and 120
      and token = 'USDC')
);

alter table groups
  add column if not exists fiat_currency text,
  add column if not exists fiat_total text,
  add column if not exists fiat_rate text,
  add column if not exists fiat_rate_source text,
  add column if not exists fiat_quoted_at timestamptz;

alter table groups drop constraint if exists groups_fiat_shape;
alter table groups add constraint groups_fiat_shape check (
  num_nonnulls(fiat_currency, fiat_total, fiat_rate, fiat_rate_source, fiat_quoted_at) = 0
  or (num_nonnulls(fiat_currency, fiat_total, fiat_rate, fiat_rate_source, fiat_quoted_at) = 5
      and fiat_currency ~ '^[A-Z]{3}$' and fiat_currency <> 'USD'
      and fiat_total ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$' and length(fiat_total) <= 40
      and fiat_rate ~ '^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$' and length(fiat_rate) <= 40 and fiat_rate !~ '^0(\.0*)?$'
      and length(fiat_rate_source) between 1 and 120
      and token = 'USDC')
);

alter table invoices add column if not exists fiat_currency text;
alter table invoices drop constraint if exists invoices_fiat_shape;
alter table invoices add constraint invoices_fiat_shape check (
  fiat_currency is null or (fiat_currency ~ '^[A-Z]{3}$' and fiat_currency <> 'USD' and token = 'USDC')
);
