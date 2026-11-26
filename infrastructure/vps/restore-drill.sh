#!/usr/bin/env bash
# Prove the latest backup restores: decrypt, restore into a scratch database, check row counts, drop it.
# Weekly from cron. Non-zero exit = backup NOT usable. To restore for real, see DEPLOYMENT.md → Disaster recovery.
set -euo pipefail
HRMS_DIR="${HRMS_DIR:-/opt/hrms}"; DEST="${BACKUP_DIR:-/var/backups/hrms}"
C=(docker compose -f "$HRMS_DIR/infrastructure/docker/docker-compose.yml")
f="${1:-$(ls -1t "$DEST"/hrms-db-*.dump.gpg | head -1)}"
stamp="$(basename "$f" | sed -E 's/hrms-db-(.*)\.dump\.gpg/\1/')"
( cd "$DEST" && sha256sum -c --ignore-missing "hrms-$stamp.sha256" )
db="restore_drill_$(date +%s)"
"${C[@]}" exec -T postgres psql -U postgres -qc "CREATE DATABASE $db OWNER hrms_owner"
trap '"${C[@]}" exec -T postgres psql -U postgres -qc "DROP DATABASE IF EXISTS $db WITH (FORCE)"' EXIT
gpg --batch --decrypt --passphrase-file /etc/hrms/backup.passphrase "$f" 2>/dev/null | "${C[@]}" exec -T postgres pg_restore -U postgres --exit-on-error -d "$db"
"${C[@]}" exec -T postgres psql -U postgres -d "$db" -At -c "SELECT 'tenants=' || count(*) FROM tenants" -c "SELECT 'employees=' || count(*) FROM employees" -c "SELECT 'migrations=' || count(*) FROM schema_migrations"
echo "$(date -Is) restore drill OK for $f"
