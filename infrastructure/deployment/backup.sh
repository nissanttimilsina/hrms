#!/usr/bin/env bash
# Nightly logical backup of the HRMS database.
#   BACKUP_DATABASE_URL=postgresql://hrms_owner:...@host/hrms  BACKUP_DIR=/var/backups/hrms  ./backup.sh
# Optional off-site copy: set BACKUP_S3_URI=s3://bucket/hrms (needs aws CLI; works with any S3-compatible store
# via AWS_ENDPOINT_URL). Combine with WAL archiving / managed PITR for RPO < 24h.
set -euo pipefail
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/hrms-$stamp.dump"

# Custom format: compressed, supports parallel and selective restore. Roles are cluster-level and
# recreated by 00-roles.sh, so ownership/ACLs are restored by name.
pg_dump --format=custom --compress=9 --no-password --file="$file" "$BACKUP_DATABASE_URL"
sha256sum "$file" > "$file.sha256"
echo "backup written: $file ($(du -h "$file" | cut -f1))"

if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  aws s3 cp "$file" "$BACKUP_S3_URI/" --sse AES256
  aws s3 cp "$file.sha256" "$BACKUP_S3_URI/"
fi
find "$BACKUP_DIR" -name 'hrms-*.dump*' -mtime +"$RETENTION_DAYS" -delete
