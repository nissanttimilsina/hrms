#!/usr/bin/env bash
# Put HRMS behind a web server (nginx) that already runs on this host for other sites.
# Run as root after issue-cert.sh, with WEB_HTTP_BIND/WEB_HTTPS_BIND/REAL_IP_FROM set in infrastructure/docker/.env.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
HRMS_DIR="${HRMS_DIR:-/opt/hrms}"
ROOT_DOMAIN="${ROOT_DOMAIN:-$(grep -E '^ROOT_DOMAIN=' "$HRMS_DIR/infrastructure/docker/.env" | cut -d= -f2)}"
[[ -n "$ROOT_DOMAIN" ]] || { echo "ROOT_DOMAIN not found"; exit 1; }
v=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'); IFS=. read -r a b _ <<<"$v"
conf=$(sed "s/__ROOT__/$ROOT_DOMAIN/g" "$HRMS_DIR/infrastructure/vps/host-nginx/hrms.conf.template")
# nginx older than 1.25.1 has no "http2 on;" directive
if (( a == 1 && b < 25 )); then conf=$(printf '%s\n' "$conf" | sed -e '/^  http2 on;$/d' -e 's/listen 443 ssl;/listen 443 ssl http2;/'); fi
dest=/etc/nginx/sites-available/hrms.conf
[[ -d /etc/nginx/sites-available ]] || dest=/etc/nginx/conf.d/hrms.conf
printf '%s\n' "$conf" > "$dest"
[[ -d /etc/nginx/sites-enabled ]] && ln -sf "$dest" /etc/nginx/sites-enabled/hrms.conf
nginx -t && systemctl reload nginx
echo "Host nginx now serves $ROOT_DOMAIN and *.$ROOT_DOMAIN (config: $dest)"
