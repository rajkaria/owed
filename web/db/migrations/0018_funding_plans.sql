-- 0018_funding_plans: funding plans offered by pay_link and pay_all (F2). When a payer's wallet can't cover a payment,
-- the plugin returns the exact PayBox calls that fix it (swap SOL for USDC, bridge USDC from Base, swap another token,
-- a MoonPay buy link, or x402 when only the network fee is short) instead of refusing, and asks Owed's server to
-- record that a plan was offered (POST /api/v1/plans). The final pay_link / pay_all echoes the plan_id when it proposes
-- the payment (POST /api/v1/plans/<id>/used), and a plan counts as paid once every request in it is paid by the plan's
-- sender after the plan was offered (lib/plans.ts attributePaidPlans, read from requests, never from a caller).
-- GET /api/v1/plans/stats shows offered / used / paid. Numbered 0018 by decision D8; it depends on nothing after 0001.
--
-- Stored: the sender wallet (base58, or 0x for a Base request), the request ids (none for a link that isn't an Owed
-- request; at least one for pay_all), the shortfall (token and atomic amount) and which kinds of option the plan listed.
-- Never a balance, a price, the plan's arguments, an IP address or any requester text.
-- Plan creation is rate limited per sender, per client IP and globally (rate_events keys plan:sender:*, plan:ip:*,
-- plan:all). Per kind:
--   select unnest(option_kinds) as kind, count(*), count(used_at), count(paid_at) from funding_plans group by kind;
-- Additive: one new table. Nothing else reads it, and the plugin works without it (a plan then has no plan_id).

create table if not exists funding_plans (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),
  created_at timestamptz not null default now(),
  tool text not null check (tool in ('pay_link', 'pay_all')),
  sender text not null check (sender ~ '^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$'),
  request_ids text[] not null default '{}' check (cardinality(request_ids) <= 20),
  shortfall_token text not null check (shortfall_token in ('USDC', 'SOL')),
  shortfall_atomic numeric(78,0) not null check (shortfall_atomic > 0),
  option_kinds text[] not null check (
    cardinality(option_kinds) between 1 and 8
    and option_kinds <@ array['swap_sol', 'bridge_base_usdc', 'swap_other', 'buy_usdc', 'x402', 'swap_usdc_for_sol', 'buy_sol']::text[]
  ),
  used_at timestamptz,
  paid_at timestamptz,
  constraint funding_plans_used_after_offer check (used_at is null or used_at >= created_at),
  constraint funding_plans_pay_all_names_requests check (tool <> 'pay_all' or cardinality(request_ids) >= 1)
);

create index if not exists funding_plans_sender_idx on funding_plans (sender, created_at desc);
-- "Which plans include this request": the paid check joins requests by id.
create index if not exists funding_plans_requests_idx on funding_plans using gin (request_ids);
create index if not exists funding_plans_unpaid_idx on funding_plans (created_at) where paid_at is null;

-- No policies: only the server's owner role reads or writes.
alter table funding_plans enable row level security;
