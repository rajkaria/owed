-- 0016_cta_events: counts for the pay page's "New to crypto? Pay with PayBox" section (SP1).
-- One row per (event kind, request, UTC day) holding a running count, enough to answer "how many PayBox
-- clicks and prompt copies, per day and in total" and nothing more: no IP address, no user agent, no
-- cookie, no time finer than the day. Only the server writes it:
--   paybox_click  GET /api/v1/cta/paybox?r=<id>, the "Create a PayBox account" link (then 302 to app.paybox.sh)
--   prompt_copy   POST /api/v1/cta, the copy button for "Pay this: <link>"
-- Both are capped per request and per hour by lib/ratelimit.ts, with keys that hold no IP (lib/cta.ts).
-- GET /api/v1/stats shows the totals as `cta`. Per day:
--   select day, kind, sum(events) from cta_events group by day, kind order by day, kind;
-- Additive: one new table. Code that reads it works without it (stats leaves `cta` out, the link still redirects).

create table cta_events (
  kind text not null check (kind in ('paybox_click', 'prompt_copy')),
  request_id text not null references requests (id),
  day date not null default ((now() at time zone 'UTC')::date),
  events int not null default 1 check (events > 0),
  primary key (kind, request_id, day)
);

-- No policies: only the server's owner role reads or writes.
alter table cta_events enable row level security;
