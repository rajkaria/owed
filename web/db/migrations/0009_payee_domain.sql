-- 0009_payee_domain: verified payee (SPEC §5.2 T2.8). A request may name the domain it comes from;
-- the server stores it only after reading `_owed.<domain>` TXT `owed-pay=<recipient>` over DNS-over-HTTPS
-- (lib/payee.ts). Display only: the plugin re-checks DNS itself before paying and never trusts this copy.
-- Numbered 0009 so wave 2 keeps 0002-0008; it applies cleanly before or after 0003_invoices.

alter table requests
  add column if not exists from_domain text,
  add column if not exists from_domain_verified_at timestamptz;

alter table requests drop constraint if exists requests_from_domain_check;
alter table requests add constraint requests_from_domain_check check (
  from_domain is null
  or (from_domain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
      and length(from_domain) <= 253
      and from_domain_verified_at is not null)
);

-- Invoices (W2-C, 0003) carry the same pair when that table exists; W2-C may also add them itself.
alter table if exists invoices
  add column if not exists from_domain text,
  add column if not exists from_domain_verified_at timestamptz;
