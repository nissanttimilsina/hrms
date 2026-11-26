#!/usr/bin/env bash
# Creates the three HRMS database roles and the application database.
# Runs automatically in the postgres container (docker-entrypoint-initdb.d) and
# can be run manually against any Postgres 14+ as a superuser:
#   PGHOST=... PGUSER=postgres HRMS_DB=hrms HRMS_OWNER_PASSWORD=... HRMS_APP_PASSWORD=... \
#   HRMS_SYSTEM_PASSWORD=... ./00-roles.sh
set -euo pipefail
: "${HRMS_DB:=hrms}"
: "${HRMS_OWNER_PASSWORD:?HRMS_OWNER_PASSWORD required}"
: "${HRMS_APP_PASSWORD:?HRMS_APP_PASSWORD required}"
: "${HRMS_SYSTEM_PASSWORD:?HRMS_SYSTEM_PASSWORD required}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-${PGUSER:-postgres}}" --dbname postgres \
  -v db="$HRMS_DB" -v owner_pw="$HRMS_OWNER_PASSWORD" -v app_pw="$HRMS_APP_PASSWORD" -v sys_pw="$HRMS_SYSTEM_PASSWORD" <<'SQL'
-- hrms_owner: schema owner for migrations, backups and maintenance. BYPASSRLS so pg_dump
-- and data migrations see every row; it is never used by the running application.
SELECT format('CREATE ROLE hrms_owner LOGIN BYPASSRLS PASSWORD %L', :'owner_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrms_owner') \gexec
ALTER ROLE hrms_owner BYPASSRLS;
SELECT format('CREATE ROLE hrms_app LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrms_app') \gexec
SELECT format('CREATE ROLE hrms_system LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'sys_pw')
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hrms_system') \gexec
SELECT format('CREATE DATABASE %I OWNER hrms_owner', :'db')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SQL

# citext/pgcrypto need superuser on some managed Postgres; pre-create them here.
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-${PGUSER:-postgres}}" --dbname "$HRMS_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO hrms_owner;
SQL
echo "HRMS roles and database '$HRMS_DB' ready."
