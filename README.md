# Lishnu Tech HRMS Platform

Multi-tenant HRMS SaaS: marketing website, Super Admin portal and company HRMS application.
**Status: release candidate.** What ships, how it was verified and known limitations: [`documentation/PROGRESS.md`](documentation/PROGRESS.md).
**Deploying to a server:** [`documentation/deployment/vps-deployment.md`](documentation/deployment/vps-deployment.md).

```
hrms-platform/
├── backend/                 Node 22 · Express · Sequelize · PostgreSQL 16 (RLS) · Redis · BullMQ
│   ├── src/
│   │   ├── config/          environment validation (refuses unsafe production settings)
│   │   ├── database/        migrations/*.sql (source of truth), models, migrate runner, seeds
│   │   ├── middleware/      tenant resolution, auth, subscription guard, RBAC, errors, rate limits
│   │   ├── modules/         public · auth · admin · billing · support · organization · employees ·
│   │   │                    attendance · leave · payroll · reports · workspace
│   │   ├── services/        auth · rbac · subscription · billing · payments · email · storage · hr/*
│   │   ├── jobs/            queues + worker (lifecycle, renewals, reconciliation, reminders, email)
│   │   └── routes/          /api/v1 route map
│   └── tests/               node:test + supertest (157 tests)
├── frontend/                npm workspaces
│   ├── shared-ui/           design system + API client + app kit
│   ├── marketing/           public website (prerendered at build time)
│   ├── admin/               Super Admin portal
│   ├── company-app/         company HRMS (PWA)
│   ├── nginx/               production Nginx template + snippets
│   └── Dockerfile           builds all three apps into one Nginx image
├── infrastructure/
│   ├── docker/              production docker-compose.yml, .env.example, Postgres role bootstrap
│   ├── vps/                 provision · issue-cert · deploy · backup · restore-drill · crontab
│   └── deployment/          portable backup/restore-verify scripts (used by CI)
├── documentation/           architecture · database · deployment · progress
└── .github/workflows/ci.yml tests · builds · audits · nginx -t · images
```

## Run locally (without Docker)

Prerequisites: Node 22, PostgreSQL 14+, Redis 6+.

```bash
# 1. roles + database (superuser)
HRMS_DB=hrms HRMS_OWNER_PASSWORD=owner_pw HRMS_APP_PASSWORD=app_pw HRMS_SYSTEM_PASSWORD=system_pw \
  PGUSER=postgres ./infrastructure/docker/postgres/00-roles.sh

# 2. backend
cd backend
cp .env.example .env            # set passwords + JWT_ACCESS_SECRET; for local use ROOT_DOMAIN=hrms.localhost
npm install
npm run db:migrate
SEED_SUPERADMIN_EMAIL=you@lishnutech.com SEED_SUPERADMIN_PASSWORD='ChangeMe#2026' npm run db:seed -- --demo
npm run dev                     # API on :4000, docs at http://localhost:4000/api/docs
npm run worker                  # in another terminal

# 3. try it — tenant is resolved from the Host header (*.localhost resolves to 127.0.0.1)
curl -s -H 'Host: demo.hrms.localhost' -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.local","password":"ChangeMe!2026"}' localhost:4000/api/v1/auth/login
```

## Tests

```bash
# once: create a test DB with the same roles
HRMS_DB=hrms_test HRMS_OWNER_PASSWORD=owner_pw HRMS_APP_PASSWORD=app_pw HRMS_SYSTEM_PASSWORD=system_pw \
  PGUSER=postgres ./infrastructure/docker/postgres/00-roles.sh
cd backend && npm test
```

## Frontends

```bash
cd frontend && npm install
npm run dev -w marketing      # http://localhost:5173  (proxies /api to :4000)
npm run dev -w admin          # http://localhost:5174  (Host admin.hrms.localhost)
npm run dev -w company-app    # http://localhost:5175  (Host demo.hrms.localhost)
npm run build                 # all three apps; marketing is prerendered
```

Local sign-ins after `npm run db:seed -- --demo`:
- Super Admin: the `SEED_SUPERADMIN_*` you passed.
- Demo company: `owner@demo.local` / `ChangeMe!2026`.

## Production

Docker Compose on one VPS, with TLS, backups and hardening. Follow [`documentation/deployment/vps-deployment.md`](documentation/deployment/vps-deployment.md). Secrets live only in `infrastructure/docker/.env` on the server (git-ignored). The repository holds templates only.

## Docs

- [Architecture](documentation/architecture/overview.md): tenancy layers, request pipeline, subscription engine, auth, RBAC
- [Database](documentation/database/schema.md): ER diagram, tables, conventions for new tables
- [VPS deployment](documentation/deployment/vps-deployment.md): step by step, go-live checklist, updates, rollback, disaster recovery
- [Deployment & operations](documentation/deployment/deployment-guide.md): environments, migrations, backup design, runbook
- API: `backend/openapi.yaml` (Swagger UI at `/api/docs`)
