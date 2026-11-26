#!/usr/bin/env bash
# One-time hardening and setup of a fresh Ubuntu 22.04/24.04 VPS for the HRMS platform. Run as root:
#   curl -fsSL <raw url>/infrastructure/vps/provision.sh | bash      (or copy the repo and run it)
# Idempotent: safe to run again.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "==> System packages and automatic security updates"
apt-get update -q
apt-get -yq upgrade
apt-get -yq install ca-certificates curl gnupg git ufw fail2ban unattended-upgrades jq gpg
dpkg-reconfigure -f noninteractive unattended-upgrades
timedatectl set-timezone Asia/Kathmandu || true

echo "==> Docker Engine + Compose plugin"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q && apt-get -yq install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" }, "live-restore": true }
JSON
systemctl enable --now docker && systemctl restart docker

echo "==> Firewall: SSH, HTTP, HTTPS only"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
# Docker publishes ports through iptables directly; only the web container publishes (80/443), Postgres and Redis are never published.

echo "==> fail2ban for SSH"
cat > /etc/fail2ban/jail.d/hrms.conf <<'JAIL'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
JAIL
systemctl enable --now fail2ban && systemctl restart fail2ban

echo "==> SSH hardening (key-only login when a key is installed)"
if [[ -s /root/.ssh/authorized_keys ]] || ls /home/*/.ssh/authorized_keys >/dev/null 2>&1; then
  cat > /etc/ssh/sshd_config.d/90-hrms.conf <<'SSH'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
SSH
  systemctl reload ssh || systemctl reload sshd || true
else
  echo "   ! No SSH key found: password login left enabled. Add a key, then re-run this script."
fi

echo "==> Swap (2 GB) if none"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Directories"
install -d -m 0750 /etc/hrms /etc/hrms/certs /var/backups/hrms
if [[ ! -f /etc/hrms/backup.passphrase ]]; then
  openssl rand -base64 48 > /etc/hrms/backup.passphrase && chmod 600 /etc/hrms/backup.passphrase
  echo "   Created /etc/hrms/backup.passphrase: COPY IT TO YOUR PASSWORD MANAGER. Backups cannot be restored without it."
fi
echo "==> Deployment user 'hrms' (runs git pull + deploy; root keeps certificates, backups and cron)"
if ! id hrms >/dev/null 2>&1; then adduser --disabled-password --gecos "" hrms; fi
usermod -aG docker hrms
if [[ -s /root/.ssh/authorized_keys && ! -s /home/hrms/.ssh/authorized_keys ]]; then
  install -d -m 700 -o hrms -g hrms /home/hrms/.ssh
  install -m 600 -o hrms -g hrms /root/.ssh/authorized_keys /home/hrms/.ssh/authorized_keys
fi
install -d -m 0755 -o hrms -g hrms /opt/hrms
[[ -d /opt/hrms/.git ]] && chown -R hrms:hrms /opt/hrms
chgrp hrms /etc/hrms /etc/hrms/certs && chmod 0750 /etc/hrms /etc/hrms/certs   # hrms may check certs; secrets stay root-only (600)
touch /etc/hrms/deploy-history && chown hrms:hrms /etc/hrms/deploy-history

echo "Done. Next: as hrms, clone the repository to /opt/hrms and follow documentation/deployment/vps-deployment.md (certificates, .env, deploy)."
