# Deployment, backup & operations guide

## Environments

| | development | staging | production |
|---|---|---|---|
| Config | `backend/.env` (from `.env.example`) | secret manager | secret manager |
| Data | seed + `--demo` | anonymised copy or fresh seed | real |
| `COOKIE_SECURE` | false | true | true |
| API docs | on | on | optional (`ENABLE_API_DOCS`) |

Never commit `.env` files. `JWT_ACCESS_SECRET` must be ≥ 32 random bytes and differ per environment.

## First deployment (Docker Compose, single host)

```bash
cd infrastructure/docker
cp .env.example .env              # fill every CHANGE_ME
mkdir -p ../nginx/certs           # fullchain.pem + privkey.pem: wildcard *.yourhrms.com
docker compose up -d --build
docker compose logs -f migrate    # migrations + idempotent seed; creates SEED_SUPERADMIN_* once
curl -k https://admin.yourhrms.com/api/v1/admin/auth/me   # expect 401 → API is up
```

DNS: `A`/`AAAA` records for `yourhrms.com`, `www`, `admin`, `app` and a wildcard `*.yourhrms.com`, all pointing at Nginx.

After the first login, rotate the bootstrap Super Admin password and clear `SEED_SUPERADMIN_PASSWORD` from the environment.

## Managed / Kubernetes deployment

Use the same image for `api` (`node src/server.js`) and `worker` (`node src/jobs/worker.js`). Run `node src/database/migrate.js` as a pre-deploy job using the **owner** credentials. Point Postgres at a managed instance with TLS; the API enforces `ssl.rejectUnauthorized` in production. Put a pooler such as PgBouncer in transaction mode in front if needed. This is safe because the tenant setting is transaction-local (`set_config(..., true)`).

Readiness: `GET /health/ready` (DB + Redis). Liveness: `GET /health/live`.

## Database migrations

```bash
DATABASE_URL_OWNER=... node src/database/migrate.js
```
* Each file runs in its own transaction and is recorded with a checksum; edited files are refused.
* An advisory lock prevents two deploys from migrating at once.
* Migrations must be **backward compatible** with the previous app version (expand → deploy → contract) so rollbacks need no down-migrations.

## Rollback strategy

1. Roll the `api`/`worker` image back to the previous tag (migrations are expand-only, so the old code still works).
2. If a migration itself is faulty, ship a new forward-fixing migration. Don't hand-edit.
3. For data corruption, restore point-in-time (managed PITR) or the latest verified dump into a new database, then switch `DATABASE_URL_*`.

## Backups & restore (tested)

```bash
# nightly (cron/k8s CronJob) — owner role, BYPASSRLS, sees every row
BACKUP_DATABASE_URL=postgresql://hrms_owner:...@db/hrms BACKUP_DIR=/var/backups/hrms \
BACKUP_S3_URI=s3://lishnu-hrms-backups/prod ./infrastructure/deployment/backup.sh

# weekly drill — restores into a scratch DB, checks counts and that RLS survived, drops it
ADMIN_URL=postgresql://postgres:...@db/postgres ./infrastructure/deployment/restore-verify.sh /var/backups/hrms/hrms-<stamp>.dump
```

CI runs the backup → restore → verify drill on every push. Recommended targets: nightly dumps kept 14 days on-host + 90 days off-site (encrypted), plus WAL archiving / managed PITR for an RPO under 15 minutes.

**Full restore into a new server:** run `00-roles.sh` (recreates the three roles), `createdb -O hrms_owner hrms`, then `pg_restore --dbname=... dump`, point the app at it, and check `/health/ready`.

## Operational runbook

| Symptom | Check | Action |
|---|---|---|
| `/health/ready` 503 | which check is `down` | DB: connections and pool size (`DB_POOL_MAX` × instances < `max_connections`). Redis: memory (`noeviction` policy), persistence. |
| Users logged out unexpectedly | `auth_sessions.revoke_reason` | `reuse_detected` = possible token theft or a client bug (two tabs refreshing at once); `tenant_suspended` / `password_reset` are expected. |
| Tenant says "read-only" | `GET /admin/tenants/:id` → `access`, `history` | Verify payment, then `POST /admin/tenants/:id/subscription/activate`. |
| Subscription states not moving | worker logs, `bull:subscriptions:*` in Redis | Restart worker; the sweep is idempotent. Access is still computed correctly from timestamps meanwhile. |
| Suspected cross-tenant access | `audit_logs` by `request_id` | Isolation is enforced by RLS. Run `npm test -- tests/tenant-isolation.test.js` against a restored copy to confirm policies. |
| Login brute force | Nginx `limit_req` logs, `users.locked_until` | Tighten `LOGIN_*` settings; block at the edge. |

Logs are structured JSON (pino) with `requestId`, and secrets are redacted. Ship stdout to your log stack (Loki/ELK/CloudWatch). Error tracking (Sentry) and metrics (Prometheus) hooks are scheduled for Phase 7.
