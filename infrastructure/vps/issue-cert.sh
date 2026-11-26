#!/usr/bin/env bash
# Issue (or renew) one Let's Encrypt certificate for <ROOT_DOMAIN> and *.<ROOT_DOMAIN> (every company subdomain).
# Wildcards require a DNS-01 challenge:
#   Cloudflare DNS (automatic, renews unattended):
#     CLOUDFLARE_API_TOKEN=... ROOT_DOMAIN=example.com EMAIL=ops@example.com ./issue-cert.sh
#     (token permissions: Zone → DNS → Edit, for this zone only)
#   Any other DNS provider (manual: you add a TXT record when asked; must be repeated every ~80 days):
#     MANUAL=1 ROOT_DOMAIN=example.com EMAIL=ops@example.com ./issue-cert.sh
set -euo pipefail
: "${ROOT_DOMAIN:?ROOT_DOMAIN required}" "${EMAIL:?EMAIL required}"
CERTS_DIR="${CERTS_DIR:-/etc/hrms/certs}"
LE=/etc/letsencrypt
mkdir -p "$LE" "$CERTS_DIR"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  install -m 600 /dev/null "$LE/cloudflare.ini"
  echo "dns_cloudflare_api_token = $CLOUDFLARE_API_TOKEN" > "$LE/cloudflare.ini"
  docker run --rm -v "$LE:/etc/letsencrypt" certbot/dns-cloudflare certonly --non-interactive --agree-tos -m "$EMAIL" \
    --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini --dns-cloudflare-propagation-seconds 30 \
    --cert-name "$ROOT_DOMAIN" -d "$ROOT_DOMAIN" -d "*.$ROOT_DOMAIN" --keep-until-expiring
elif [[ -n "${MANUAL:-}" ]]; then
  docker run --rm -it -v "$LE:/etc/letsencrypt" certbot/certbot certonly --manual --preferred-challenges dns --agree-tos -m "$EMAIL" \
    --cert-name "$ROOT_DOMAIN" -d "$ROOT_DOMAIN" -d "*.$ROOT_DOMAIN"
else
  echo "Set CLOUDFLARE_API_TOKEN (automatic) or MANUAL=1"; exit 1
fi
install -m 644 "$LE/live/$ROOT_DOMAIN/fullchain.pem" "$CERTS_DIR/fullchain.pem"
install -m 600 "$LE/live/$ROOT_DOMAIN/privkey.pem"   "$CERTS_DIR/privkey.pem"
echo "Certificate installed in $CERTS_DIR (expires $(openssl x509 -enddate -noout -in "$CERTS_DIR/fullchain.pem" | cut -d= -f2))"
# Reload the host nginx when HRMS runs behind it, and the HRMS web container
if systemctl is-active --quiet nginx 2>/dev/null && [[ -e /etc/nginx/sites-enabled/hrms.conf || -e /etc/nginx/conf.d/hrms.conf ]]; then systemctl reload nginx && echo "host nginx reloaded"; fi
if docker compose -f "${HRMS_DIR:-/opt/hrms}/infrastructure/docker/docker-compose.yml" ps web --status running -q 2>/dev/null | grep -q .; then
  docker compose -f "${HRMS_DIR:-/opt/hrms}/infrastructure/docker/docker-compose.yml" exec -T web nginx -s reload && echo "nginx reloaded"
fi
