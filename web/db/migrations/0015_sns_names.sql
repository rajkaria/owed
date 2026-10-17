-- 0015_sns_names: SNS name payees (W3-S). A request may carry the SNS name ("bonfida.sns") its recipient was given
-- as. The server stores it only after resolving it on Solana (lib/sns.ts) to exactly the recipient, with the rule
-- that picked the wallet and when. Display only: the plugin re-resolves the name itself before paying, and the pay
-- page re-checks it on every render. Additive: three nullable columns and one check; existing rows pass (all null).
-- Numbered 0015 because 0010 and 0012-0014 may be taken by other wave-3 branches; it depends on nothing after 0001.

alter table requests
  add column if not exists sns_name text,
  add column if not exists sns_wallet text,
  add column if not exists sns_source text,
  add column if not exists sns_resolved_at timestamptz;

alter table requests drop constraint if exists requests_sns_check;
alter table requests add constraint requests_sns_check check (
  (sns_name is null and sns_wallet is null and sns_source is null and sns_resolved_at is null)
  -- Every column is checked "is not null" first: a null in a comparison makes the check pass.
  or (sns_name is not null and sns_wallet is not null and sns_source is not null and sns_resolved_at is not null
      and sns_name ~ '^[^.\s]{1,63}(\.[^.\s]{1,63})?\.sns$'
      and sns_name = lower(sns_name)
      and length(sns_name) <= 140
      -- the name resolved to exactly the wallet this request pays
      and sns_wallet = recipient
      and sns_source in ('sol_record_v2', 'sol_record_v1', 'owner'))
);
