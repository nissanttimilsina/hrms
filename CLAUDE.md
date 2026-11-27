# CLAUDE.md: Lishnu HRMS

Multi-tenant HR and payroll SaaS for Nepal, built for Lishnu Tech Pvt. Ltd. Live at https://hrms.lishnutech.com.
**Before doing anything, read `documentation/HANDOVER.md` in full.** It holds the complete context: current state, decisions, production server, conventions and open items. `documentation/PROGRESS.md` lists everything that ships.

## Must-know rules
- **The repository is PUBLIC** (`nissanttimilsina/hrms`, branch `main`). Never commit `.env`, keys, tokens, `dump.rdb` or `storage/`. Never ask the owner to paste secrets in chat; collect them on the server with `read -s`.
- **You cannot reach the production server.** The owner runs every command as root and pastes the output. Give complete, copy-paste-ready blocks. The settings file is `/opt/hrms/infrastructure/docker/.env` (owned by `hrms:hrms`, mode 600). To deploy:
  `sudo -u hrms git -C /opt/hrms pull && sudo -u hrms /opt/hrms/infrastructure/vps/deploy.sh`
- **Honesty is a product requirement.** No mock data, no dead buttons, no fake testimonials, and no website claims for unbuilt features (see `status` in `frontend/marketing/src/content/features.js`).
- **The owner wants a professional, polished UI.** Keep the brand blue, the Inter font, sentence-case copy and plain language.
- **Before every push:** `cd backend && npm test` (208 tests at handover) and `cd frontend && npm run build`. Check UI changes in a real browser at desktop size and at 390 px.
- **Commits:** use `git -c user.name=Claude -c user.email=noreply@anthropic.com commit` and end the message with the attribution lines your system instructions specify. Push with `git push origin HEAD:main`.

## Stack and layout
- `backend/`: Node 22, Express 5, Sequelize, PostgreSQL 16 with forced row-level security, Redis and a BullMQ worker. The schema comes from hand-written SQL in `src/database/migrations/0NN_*.sql`, mirrored in `models.js`. Permissions, roles, plans and features live in `src/database/seeds/catalog.js`; the seed backfills new permissions into existing tenants on deploy.
- `frontend/`: npm workspaces (`shared-ui`, `marketing` prerendered with SSR, `admin`, `company-app` PWA). React 19, Tailwind v4 (tokens in `shared-ui/src/theme.css`) and TanStack Query.
- `infrastructure/`: docker-compose, VPS scripts (provision, issue-cert, host-nginx, deploy, backup) and CI.

## Conventions (details in HANDOVER §16)
- **Routes:**
  - Structure: `requirePermission('res:action')` → `validate({ body: zod })` → `asyncHandler` → `req.tx(async (t) => …)` → `ok`/`created`.
  - Audit every change with `audit(...)`.
  - Respect data scope with `scopeWhere` and `recordInScope`.
- **New tenant tables:** add a numbered migration with RLS (DO-block pattern in 010/012), composite `(tenant_id, id)` foreign keys and grants to `hrms_app`/`hrms_system`, then the model and tests.
- **Frontend helpers:**
  - `useList`, `useAction`, `FormDialog` (supports `section`, `create`, `emptyHint`), `PageHeader`, `DataTable`.
  - The API client has `api.get/post/patch/put/del/list`; there is **no** `api.delete`.
- **Frontend traps:**
  - `cn()` is clsx, not tailwind-merge.
  - Use only theme colours that exist; for example `ink-300`, `ink-600` and `warning-500` do not.
  - Use `grid grid-cols-1 [&>*]:min-w-0` on grids so content cannot overflow on phones.
- **PATCH schemas:** never derive them with `.partial()` from a schema that has `.default()` values.

## Where things stand
Latest work: employee self-service stage 1 (expense claims, HR letters with verification, My tax, missed-punch improvements, performance-score fixes), on branch `stage-1-self-service`. It was written in a workspace that could not install packages, so its tests and build had not been run when it was pushed: run them, check the pages in a browser, then merge into `main`. Details: HANDOVER §12a. Before that: work management, `2e2bee8`. Open items and suggested next steps: HANDOVER §18–19.
