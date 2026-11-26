#!/usr/bin/env bash
# Restore a backup into a scratch database and verify it. Run weekly (CI or cron) so
# restores are proven, not assumed. Exit code != 0 means the backup is NOT usable.
#   ADMIN_URL=postgresql://postgres:...@host/postgres ./restore-verify.sh backups/hrms-....dump
set -euo pipefail
dump="${1:?usage: restore-verify.sh <dumpfile>}"
: "${ADMIN_URL:?ADMIN_URL (superuser connection to the postgres db) required}"
scratch="hrms_restore_verify_$(date +%s)"
base="${ADMIN_URL%/*}"

if [[ -f "$dump.sha256" ]]; then sha256sum -c "$dump.sha256"; fi
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $scratch OWNER hrms_owner"
trap 'psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $scratch WITH (FORCE)" >/dev/null' EXIT

pg_restore --exit-on-error --no-password --dbname="$base/$scratch" "$dump"

psql "$base/$scratch" -v ON_ERROR_STOP=1 -At <<'SQL'
\echo '--- verification ---'
SELECT 'migrations applied: ' || count(*) FROM schema_migrations;
SELECT 'tenants: ' || count(*) FROM tenants;
SELECT 'employees: ' || count(*) FROM employees;
SELECT 'audit rows: ' || count(*) FROM audit_logs;
-- RLS must survive the restore
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('employees','users','roles','subscriptions')
     AND c.relrowsecurity AND c.relforcerowsecurity;
  IF n <> 4 THEN RAISE EXCEPTION 'RLS missing after restore (% of 4 tables)', n; END IF;
END $$;
SELECT 'RLS policies: ' || count(*) FROM pg_policies WHERE schemaname = 'public';
SQL
echo "✓ restore verified ($dump)"
