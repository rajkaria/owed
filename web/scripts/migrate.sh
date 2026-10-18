#!/usr/bin/env bash
# Apply web/db/migrations/*.sql in order, each in one transaction, recording
# applied versions in schema_migrations. Safe to re-run.
#
# Production and preview are migrated by the Vercel build now: `pnpm build` runs
# scripts/migrate-on-build.mjs before `next build`, with the same schema_migrations
# table and one transaction per file, so shipping a migration needs no manual step.
# This script still works by hand (a recovery, a Development-only database, --status);
# the two share the bookkeeping, so each skips the versions the other has recorded.
# It takes no advisory lock: don't run it while a deployment is building.
#
# Two databases (Neon, via the Vercel marketplace): `owed-db` serves Production,
# `owed-db-preview` serves Preview and Development. To apply by hand:
#
#   cd web
#   vercel env pull .env.local --environment=development
#   vercel env pull .env.production.local --environment=production
#   scripts/migrate.sh --env-file .env.local                 # preview/dev database
#   scripts/migrate.sh --env-file .env.production.local      # production database
#   scripts/migrate.sh --env-file .env.local --status        # list applied versions
#
# Uses DATABASE_URL_UNPOOLED (direct connection, preferred for DDL) or DATABASE_URL.
# Needs psql (brew install libpq; it lives in /opt/homebrew/opt/libpq/bin).
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=""
STATUS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --status) STATUS=1; shift ;;
    *) echo "usage: scripts/migrate.sh --env-file FILE [--status]" >&2; exit 2 ;;
  esac
done
if [[ -n "$ENV_FILE" ]]; then
  unset DATABASE_URL DATABASE_URL_UNPOOLED
  set -a; source "$ENV_FILE"; set +a
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

if [[ "$STATUS" == 1 ]]; then
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
