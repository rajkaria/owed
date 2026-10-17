#!/usr/bin/env bash
# Apply web/db/migrations/*.sql in order, each in one transaction, recording
# applied versions in schema_migrations. Safe to re-run.
#
#   cd web && vercel env pull .env.local && scripts/migrate.sh          # apply pending
#   cd web && scripts/migrate.sh --status                               # list applied
#
# Uses DATABASE_URL_UNPOOLED (direct connection, preferred for DDL) or DATABASE_URL.
# Needs psql (brew install libpq; it lives in /opt/homebrew/opt/libpq/bin).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL_UNPOOLED:-}${DATABASE_URL:-}" && -f .env.local ]]; then
  set -a; source .env.local; set +a
fi
DB_URL="${DATABASE_URL_UNPOOLED:-${DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "DATABASE_URL_UNPOOLED or DATABASE_URL is not set (run: vercel env pull .env.local)" >&2
  exit 1
fi

PSQL="$(command -v psql || true)"
[[ -z "$PSQL" && -x /opt/homebrew/opt/libpq/bin/psql ]] && PSQL=/opt/homebrew/opt/libpq/bin/psql
if [[ -z "$PSQL" ]]; then
  echo "psql not found (brew install libpq)" >&2
  exit 1
fi

q() { "$PSQL" "$DB_URL" -v ON_ERROR_STOP=1 -X -q -t -A "$@"; }

q -c "set client_min_messages = warning; create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())"

if [[ "${1:-}" == "--status" ]]; then
  q -c "select version || '  ' || to_char(applied_at at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') || 'Z' from schema_migrations order by version"
  exit 0
fi

applied=0
for file in db/migrations/*.sql; do
  version="$(basename "$file" .sql)"
  if [[ "$(q -c "select 1 from schema_migrations where version = '$version'")" == "1" ]]; then
    continue
  fi
  echo "applying $version"
  q --single-transaction -f "$file" -c "insert into schema_migrations (version) values ('$version')"
  applied=$((applied + 1))
done
echo "done: $applied applied"
