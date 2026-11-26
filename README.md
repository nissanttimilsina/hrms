# Lishnu Tech HRMS Platform

Multi-tenant HRMS SaaS: marketing website, Super Admin portal and company HRMS application.
**Status: Phase 1 (Foundation) complete.** See [`documentation/PROGRESS.md`](documentation/PROGRESS.md).

```
hrms-platform/
├── backend/                 Node 22 · Express · Sequelize · PostgreSQL 16 · Redis · BullMQ
│   ├── src/
│   │   ├── config/          env validation (zod)
│   │   ├── database/        migrations/*.sql (source of truth), models, migrate runner, seeds
│   │   ├── middleware/      tenant resolution, auth, subscription guard, RBAC, errors, rate limits
│   │   ├── modules/         auth · organization · employees · access · subscriptions · admin
│   │   ├── services/        auth · rbac · subscription engine · provisioning · audit · cache
│   │   ├── jobs/            queues + worker (subscription lifecycle, email)
│   │   └── routes/          /api/v1 route map
│   ├── tests/               node:test + supertest (73 tests)
│   └── openapi.yaml         served at /api/docs
├── frontend/shared-ui/      design system (Tailwind v4 tokens + React components + gallery)
├── infrastructure/          docker compose · postgres role bootstrap · nginx · backup/restore
├── documentation/           architecture · database · deployment · progress
└── .github/workflows/ci.yml
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

## Design system

```bash
cd frontend/shared-ui && npm install
npm run dev          # component gallery
npm run build        # library → dist/
```
Apps import `@hrms/shared-ui/theme.css` once and the components from `@hrms/shared-ui`.

## Docs

- [Architecture](documentation/architecture/overview.md): tenancy layers, request pipeline, subscription engine, auth, RBAC
- [Database](documentation/database/schema.md): ER diagram, tables, conventions for new tables
- [Deployment & operations](documentation/deployment/deployment-guide.md): environments, Compose, migrations, rollback, backups, runbook
- API: `backend/openapi.yaml` (Swagger UI at `/api/docs`)
