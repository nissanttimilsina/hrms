#!/usr/bin/env bash
# Nightly encrypted backup: database (pg_dump custom format) + uploaded documents.
# Encrypted with AES-256 (gpg, passphrase in /etc/hrms/backup.passphrase), checksummed, kept RETENTION_DAYS days.
# Off-site copy (strongly recommended): install rclone, configure a remote, set RCLONE_REMOTE=remote:bucket/hrms.
set -euo pipefail
HRMS_DIR="${HRMS_DIR:-/opt/hrms}"; DEST="${BACKUP_DIR:-/var/backups/hrms}"; RETENTION_DAYS="${RETENTION_DAYS:-14}"
PASS=/etc/hrms/backup.passphrase
C=(docker compose -f "$HRMS_DIR/infrastructure/docker/docker-compose.yml")
stamp="$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$DEST"
enc(){ gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS" -o "$1"; }

"${C[@]}" exec -T postgres pg_dump -U hrms_owner -d hrms --format=custom --compress=9 | enc "$DEST/hrms-db-$stamp.dump.gpg"
"${C[@]}" run --rm --no-deps -T --entrypoint tar api -C /app/storage -czf - . | enc "$DEST/hrms-files-$stamp.tgz.gpg"
( cd "$DEST" && sha256sum "hrms-db-$stamp.dump.gpg" "hrms-files-$stamp.tgz.gpg" > "hrms-$stamp.sha256" )
echo "$(date -Is) backup ok: $(du -ch "$DEST"/hrms-*-"$stamp".* | tail -1 | cut -f1)"

if [[ -n "${RCLONE_REMOTE:-}" ]]; then rclone copy "$DEST" "$RCLONE_REMOTE" --include "*$stamp*" && echo "copied off-site to $RCLONE_REMOTE"; fi
find "$DEST" -name 'hrms-*' -mtime +"$RETENTION_DAYS" -delete
