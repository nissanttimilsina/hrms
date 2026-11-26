#!/usr/bin/env bash
# Build and (re)start the platform from the current checkout. Zero-config rollbacks: images are tagged with the git commit.
#   cd /opt/hrms && git pull && ./infrastructure/vps/deploy.sh
#   Roll back:  IMAGE_TAG=<older commit> ./infrastructure/vps/deploy.sh --no-build
set -euo pipefail
cd "$(dirname "$0")/../docker"
[[ -f .env ]] || { echo "Missing infrastructure/docker/.env (copy .env.example and fill it in)"; exit 1; }
[[ "$(stat -c %a .env)" == "600" ]] || { chmod 600 .env; echo "Fixed .env permissions to 600"; }
if grep -qE '=CHANGE_ME' .env; then echo "Refusing to deploy: .env still contains CHANGE_ME values:"; grep -nE '=CHANGE_ME' .env | cut -d= -f1; exit 1; fi
source <(grep -E '^(ROOT_DOMAIN|CERTS_DIR|MARKETING_HOST)=' .env)
MARKETING_HOST="${MARKETING_HOST:-www.$ROOT_DOMAIN}"
case "$MARKETING_HOST" in
  "$ROOT_DOMAIN"|*."$ROOT_DOMAIN") ;;
  *) echo "Refusing to deploy: MARKETING_HOST ($MARKETING_HOST) is not $ROOT_DOMAIN or a subdomain of it. Fix MARKETING_HOST / MARKETING_REDIRECT_HOST in .env"; exit 1 ;;
esac
CERTS_DIR="${CERTS_DIR:-/etc/hrms/certs}"
[[ -s "$CERTS_DIR/fullchain.pem" && -s "$CERTS_DIR/privkey.pem" ]] || { echo "No certificate in $CERTS_DIR: run issue-cert.sh first"; exit 1; }

export IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
echo "==> Deploying $IMAGE_TAG for $ROOT_DOMAIN"
if [[ "${1:-}" != "--no-build" ]]; then docker compose build --pull; fi
docker compose up -d --remove-orphans
echo "==> Waiting for the API to become healthy"
for i in $(seq 1 60); do
  if docker compose ps api --format json | jq -se 'flatten | all(.Health == "healthy")' >/dev/null 2>&1; then break; fi
  sleep 2
done
docker compose ps
curl -fsS --resolve "$MARKETING_HOST:443:127.0.0.1" "https://$MARKETING_HOST/api/v1/public/features" -o /dev/null && echo "==> https://$MARKETING_HOST is serving" || { echo "!! Public check failed: docker compose logs --tail=100 api web"; exit 1; }
echo "$IMAGE_TAG" >> /etc/hrms/deploy-history 2>/dev/null || true
