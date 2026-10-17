-- 0002_groups: split bills. A group is one bill split into shares. Each share is an
-- ordinary request row (kind 'split_share') pointing at its group, so /r/<share>,
-- /api/v1/status, check_payments and pay_link work on shares unchanged.
-- The group id is derived from its share ids in order (lib/groups.ts `groupIdFor`).

create table groups (
  id text primary key check (id ~ '^[1-9A-HJ-NP-Za-km-z]{12}$'),
  title text,                                                      -- requester-written, sanitized
  recipient text not null,
  token text not null check (token in ('USDC', 'SOL')),
  total_atomic numeric(78,0) not null check (total_atomic > 0),    -- sum of the shares' amount_atomic
  requester_name text,
  flags text[] not null default '{}',
  source text not null check (source in ('plugin', 'web')),
  -- Verified payee (W2-H): the domain whose _owed TXT record publishes `recipient`, re-checked at creation.
  -- Display only; the plugin always checks DNS itself.
  from_domain text check (from_domain ~ '^[a-z0-9.-]{1,253}$'),
  from_domain_verified_at timestamptz,
  created_at timestamptz not null default now(),
  check ((from_domain is null) = (from_domain_verified_at is null))
);

create index groups_recipient_created_idx on groups (recipient, created_at desc);

-- Where a share sits on its group's board (0-based; leftover atomic units go to the first shares).
alter table requests add column group_position smallint check (group_position between 0 and 19);
alter table requests add constraint requests_group_fk foreign key (group_id) references groups (id);
-- A split share always has a group and a position; nothing else has either.
alter table requests add constraint requests_group_shape check (
  (kind = 'split_share') = (group_id is not null) and (group_id is null) = (group_position is null)
);
create unique index requests_group_position_key on requests (group_id, group_position) where group_id is not null;

-- No policies: only the server's owner role reads or writes.
alter table groups enable row level security;
