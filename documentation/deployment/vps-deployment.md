# Deploying to a VPS (step by step)

This deploys the whole platform on one Ubuntu server with Docker Compose:

- the marketing website at `www.<domain>` (the bare `<domain>` redirects there);
- the Super Admin portal at `admin.<domain>`;
- the company app at `<company>.<domain>` and `app.<domain>`;
- the API, a background worker, PostgreSQL 16 and Redis, all on the internal Docker network.

Only ports 22, 80 and 443 are open.

Allow about an hour for the first deployment. Most of that is waiting for DNS.

## 0. What you need

| Item | Notes |
|---|---|
| VPS | Ubuntu 22.04 or 24.04, **2 vCPU / 4 GB RAM / 40 GB SSD minimum** (4 GB lets the images build on the server). A public IPv4 address. |
| Domain | You must be able to edit its DNS. Cloudflare DNS is the easiest option because certificate renewal is then fully automatic. |
| SMTP | Any transactional email provider: host, port, user and password. Set up SPF and DKIM for the sending domain, or verification emails will land in spam. |
| SSH key | Your public key on the server. The provision script switches off password login once a key is present. |
| Payment credentials (optional at launch) | Live eSewa merchant code and secret, and the Khalti live secret key. Until you have them, run with `PAYMENTS_ENABLED=BANK_TRANSFER`. |

## 1. DNS

Create these records pointing to the server's IP (if you use Cloudflare, set them to **DNS only / grey cloud** at first):

```
A   example.com        <server IP>
A   *.example.com      <server IP>      # covers www, admin, app and every company subdomain
```

## 2. Provision the server (once)

```bash
ssh root@<server IP>
git clone https://github.com/<org>/<repo>.git /opt/hrms
/opt/hrms/infrastructure/vps/provision.sh
```

The script does the following:

- installs Docker, ufw, fail2ban and unattended security upgrades;
- opens only 22, 80 and 443;
- sets the server timezone to Asia/Kathmandu;
- adds swap;
- creates `/etc/hrms`;
- generates the **backup passphrase** in `/etc/hrms/backup.passphrase`.

**Copy that passphrase into your password manager now.** Without it, backups cannot be restored.

## 3. TLS certificate (wildcard)

Company workspaces live on subdomains, so you need one certificate for `example.com` and `*.example.com`. Wildcards are issued only through a DNS challenge.

**Cloudflare (automatic renewal).**

1. Create an API token with the permission *Zone → DNS → Edit* for this zone only.
2. Save the settings for the renewal cron job:
   ```bash
   cat > /etc/hrms/cert.env <<'EOF'
   ROOT_DOMAIN=example.com
   EMAIL=ops@example.com
   CLOUDFLARE_API_TOKEN=xxxxxxxx
   EOF
   chmod 600 /etc/hrms/cert.env
   ```
3. Issue the certificate:
   ```bash
   set -a; . /etc/hrms/cert.env; /opt/hrms/infrastructure/vps/issue-cert.sh
   ```

**Any other DNS provider (manual).**

```bash
MANUAL=1 ROOT_DOMAIN=example.com EMAIL=ops@example.com /opt/hrms/infrastructure/vps/issue-cert.sh
```

Certbot asks you to create TXT records. Add them, wait a minute, then continue. Manual certificates expire after 90 days, so repeat this step about every 80 days and put a reminder in your calendar.

## 4. Configuration

```bash
cd /opt/hrms/infrastructure/docker
cp .env.example .env && chmod 600 .env
nano .env
```

Fill in every `CHANGE_ME`. Generate secrets with:

```bash
openssl rand -base64 48 | tr -d '/+=' | cut -c1-48   # passwords, JWT secret
openssl rand -base64 32                              # DATA_ENCRYPTION_KEY
```

- `ROOT_DOMAIN` is your domain without `www`. Every other host and URL is derived from it.
- `DATA_ENCRYPTION_KEY` encrypts employees' bank account numbers. Store a copy in your password manager. If it is lost, those fields cannot be decrypted, even from backups. Never change it after go-live.
- `SEED_SUPERADMIN_EMAIL` and `SEED_SUPERADMIN_PASSWORD` create the first Super Admin on the first start. Remove the password from `.env` after you have signed in.
- `PAYMENTS_ENABLED`: start with `BANK_TRANSFER`. Add `ESEWA` and/or `KHALTI` only with **live** credentials. The API refuses to start with sandbox settings in production.
- The API also refuses to start if `EMAIL_TRANSPORT` is not `smtp`, or if a secret is weak or missing. Read the log if it does not come up.

## 5. Deploy

```bash
/opt/hrms/infrastructure/vps/deploy.sh
```

The script does the following:

1. Builds both images, tagged with the git commit.
2. Starts Postgres and Redis.
3. Runs migrations and the reference seed (plans, permissions, tax rules, default website content, first Super Admin).
4. Starts two API containers, the worker, and Nginx with your certificate.
5. Checks that `https://www.<domain>` answers.

The first build takes 5–10 minutes.

## 6. Biometric devices (optional)

Terminals use the `*.<domain>` wildcard, so no extra DNS is needed. In the company app go to **Devices → Add device**, enter the serial number, then on the device:

- **Comm. → Cloud Server Setting (ADMS)**: server `devices.<domain>`, port **443** with HTTPS on, or port **80** if the device has no HTTPS option (only `/iclock/` is served over plain HTTP).
- Enrol employees on the device with the same ID entered as their **Biometric ID** in HRMS. Unmatched IDs appear under **Devices → Unmapped users** and can be linked later; their earlier punches are applied then.

The device appears **Online** within a minute. Check **Sync log** for its first upload.

## 7. Install the scheduled jobs

```bash
cp /opt/hrms/infrastructure/vps/crontab /etc/cron.d/hrms
```

This installs:

- a nightly encrypted backup (database and uploaded documents) at 01:30;
- a weekly **restore drill** that proves the latest backup restores (Sunday 03:00);
- a certificate renewal check (Cloudflare mode);
- a monthly Docker image cleanup.

Logs go to `/var/log/hrms-backup.log` and `/var/log/hrms-cert.log`.

**Off-site copies (strongly recommended).** Install `rclone` and configure a remote, for example Backblaze B2, S3 or Google Drive. Then add `RCLONE_REMOTE=myremote:hrms-backups` at the top of `/etc/cron.d/hrms`. The backups are encrypted before they leave the server.

Run the first backup and drill by hand now:

```bash
/opt/hrms/infrastructure/vps/backup.sh && /opt/hrms/infrastructure/vps/restore-drill.sh
```

## 8. Go-live checklist

- [ ] `https://www.<domain>` loads; the bare domain redirects to www; http redirects to https.
- [ ] Sign in at `https://admin.<domain>` with the seeded Super Admin, then change its password.
- [ ] Super Admin → Settings: set the company legal details, PAN/VAT number and bank accounts shown on invoices, plus the support email and phone.
- [ ] Super Admin → Website content: review the **draft** Terms, Privacy and Refund pages with your lawyer, then publish them.
- [ ] Super Admin → Plans: confirm prices (VAT is added at checkout at the rate in Settings).
- [ ] On the marketing site, sign up a test company with a real inbox: verification email → workspace at `<slug>.<domain>` → add an employee → clock in.
- [ ] Billing: pay a test invoice with bank transfer, then approve it under Super Admin → Billing. If eSewa or Khalti are enabled, make one small live payment and refund it.
- [ ] Payroll: compare one payslip against a manual calculation. Check the tax slabs for the current fiscal year under Payroll setup against the Finance Act. Statutory rates change every Shrawan.
- [ ] If you sell biometric integration: connect one real ZKTeco terminal and confirm punches appear in Attendance.
- [ ] Super Admin → Requests: send a test plan request from a company and approve it.
- [ ] Confirm the backup and restore drill ran: `tail /var/log/hrms-backup.log`.
- [ ] Optional: switch the Cloudflare records to proxied (orange cloud) with SSL mode **Full (strict)**.

## Updating

```bash
cd /opt/hrms && git pull && ./infrastructure/vps/deploy.sh
```

Migrations run automatically and are forward-only. Take a manual backup first for big releases: `./infrastructure/vps/backup.sh`.

**Rollback** (application code):

```bash
cat /etc/hrms/deploy-history                       # previous image tags
IMAGE_TAG=<tag> ./infrastructure/vps/deploy.sh --no-build
```

Migrations are additive, so older code runs against a newer schema. If a release ever needs a destructive migration, its notes will say so.

## Disaster recovery (full restore onto a new server)

1. Do steps 1–4 above on the new server: same `.env`, same `DATA_ENCRYPTION_KEY`, and `/etc/hrms/backup.passphrase` copied from your password manager.
2. Start only the database:
   ```bash
   cd /opt/hrms/infrastructure/docker && docker compose up -d postgres
   ```
3. Restore the newest backup (copy it from off-site storage first if the old server is gone):
   ```bash
   F=/var/backups/hrms/hrms-db-<stamp>.dump.gpg
   gpg --batch --decrypt --passphrase-file /etc/hrms/backup.passphrase "$F" \
     | docker compose exec -T postgres pg_restore -U postgres --clean --if-exists -d hrms
   gpg --batch --decrypt --passphrase-file /etc/hrms/backup.passphrase /var/backups/hrms/hrms-files-<stamp>.tgz.gpg \
     | docker compose run --rm --no-deps -T --entrypoint tar api -C /app/storage -xzf -
   ```
4. Deploy with `/opt/hrms/infrastructure/vps/deploy.sh`, then point DNS at the new IP.

## Day-to-day operations

| Task | Command (in `/opt/hrms/infrastructure/docker`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f --tail=200 api worker web` |
| Restart the API | `docker compose restart api` |
| Database shell | `docker compose exec postgres psql -U hrms_owner hrms` |
| Disk usage | `docker system df && df -h` |
| Reload Nginx | `docker compose exec web nginx -s reload` |

Signs that need attention:

- the API container restarts repeatedly (usually configuration: read `docker compose logs api`);
- failed jobs in the worker log (often SMTP credentials);
- `restore drill` errors in the backup log;
- the certificate expiry date in `/var/log/hrms-cert.log`.
