# Project handover: Lishnu HRMS

Written 27 Nov 2026 (Nepal time) at commit `2e2bee8`, to hand the project to a new Claude session.
Read this file in full before changing anything. `CLAUDE.md` at the repository root is the short version.

Contents
1. What this is, and who it is for
2. How the owner works (read this first)
3. Where things stand right now
4. Requirements that drive the product
5. Architecture and technology
6. Repository map
7. Database
8. Authentication
9. Roles, permissions and data scopes
10. Plans, features and subscriptions
11. What is built, by application
12. Work management (most recent work, in detail)
13. Integrations
14. Production server
15. Development environment (Claude's sandbox)
16. Coding conventions
17. Bugs fixed and lessons learned
18. Known gaps, risks and open items
19. Suggested next steps
20. Starting a new session

---

## 1. What this is, and who it is for

**Lishnu HRMS** is a multi-tenant HR and payroll SaaS for Nepali businesses. It is built for **Lishnu Tech Pvt. Ltd.**; the owner is **Nisaant Timilsina**. Every company that signs up gets its own workspace at `<slug>.hrms.lishnutech.com`.

There are three applications and one API:

| Application | URL in production | Folder |
|---|---|---|
| Marketing website (public, prerendered) | https://hrms.lishnutech.com (`www.hrms.lishnutech.com` redirects to it) | `frontend/marketing` |
| Super Admin portal (Lishnu Tech staff) | https://admin.hrms.lishnutech.com | `frontend/admin` |
| Company HRMS (each customer; installable as a phone app) | https://`<slug>`.hrms.lishnutech.com and https://app.hrms.lishnutech.com | `frontend/company-app` |
| API | `/api/v1` on every host above; ZKTeco devices use `/iclock` | `backend` |

- **GitHub:** `nissanttimilsina/hrms`, branch `main`. The repository is **PUBLIC**. The owner chose this knowingly ("Push now, keep it public"), so never commit secrets.
- **Live server:** VPS at `163.61.41.51`, code in `/opt/hrms`. DNS is on Cloudflare.

## 2. How the owner works (read this first)

- He writes short messages, often with screenshots, and is not a developer by trade. Answer in plain language: say what you did, what he must do, and the exact commands.
- **Claude cannot reach the server.** He runs every server command himself, as `root`, and pastes the output back. Give one copy-paste block at a time, and give it in full.
- The server's settings file is **`/opt/hrms/infrastructure/docker/.env`**, owned by `hrms:hrms` with mode `600`. It is **not** `/opt/hrms/.env`; a past instruction got this wrong and was corrected. After root edits it, run `chown hrms:hrms .env && chmod 600 .env`.
- The `hrms` Linux user is not in sudoers. Root runs commands as that user with `sudo -u hrms ...`.
- **Secrets never go in chat.** He once pasted a Brevo SMTP key and was told to revoke it. Collect secrets on the server with `read -s`.
- He wants a product that is "complete, professional, market-ready". That means no mock data, no dead buttons, no fake testimonials, and no claims on the website for features that are not built. He reacts strongly to plain or "worst" UI. Keep the brand colours and the Inter font, which he likes.
- His standing instructions: finish work fully, test it, and push to GitHub excluding secrets and environment files. He asked for each push explicitly at the start; since then the routine has been build → test → commit → push → send him deploy commands.

## 3. Where things stand right now

- **All work is committed and pushed.** `main` is at `2e2bee8` ("Work management: tasks, daily reports, reviews, performance, new dashboard"). The working tree is clean.
- **Backend tests: 208 passing** (`cd backend && npm test`).
- **Production probably runs an older commit.** He has deployed several times, and the last confirmed deploy included `586c020`. Anything after it, including the delete-employee feature `8efdc0d` and work management `2e2bee8`, is live only once he runs the deploy. Ask him, or have him run `git -C /opt/hrms log --oneline -1`.

Deploy command (as root):
```
sudo -u hrms git -C /opt/hrms pull
sudo -u hrms /opt/hrms/infrastructure/vps/deploy.sh
```
The deploy builds the images, runs `migrate` (SQL migrations, then `seeds/run.js`), restarts api×2, worker and web, and waits for health checks.

**Production state as last seen:**
- Wildcard Let's Encrypt certificate issued through Cloudflare DNS. The token is in `/etc/hrms/cert.env` on the server.
- The server's own nginx proxies to the containers on `127.0.0.1:18080` and `127.0.0.1:18443` ("host-nginx mode"), because the server also runs other sites and pm2 apps.
- `.env` has `ROOT_DOMAIN=hrms.lishnutech.com`, `MARKETING_HOST=hrms.lishnutech.com` and `MARKETING_REDIRECT_HOST=www.hrms.lishnutech.com`.
- One real company exists: slug **`lishnu`**, Business plan, annual, status ACTIVE. Its owner is signed in as "Nisaant Timilsina". This owner login is **not linked to an employee record**, so he sees the Work section but not "My work".
- One employee, "Nishan Timilsina", was deleted and re-added with a login invitation. The re-add happened after the delete feature was built, so it was deployed by then.
- **Email works.** It is sent through Brevo SMTP from `no-reply@lishnutech.com`; the domain is authenticated with DKIM and DMARC. Brevo's "Authorized IPs" list includes `163.61.41.51`. To test: `docker compose exec api node src/scripts/send-test-email.js you@example.com`, run in `/opt/hrms/infrastructure/docker`.
- **Super Admin password reset:** `docker compose exec api node src/scripts/reset-platform-password.js <email>`, optionally with `NEW_PASSWORD=...` set.

**Stage 1 of employee self-service (§12a)** is on branch `stage-1-self-service` (pull request #1), not yet in `main`. The session that wrote it could not install npm packages, so it used GitHub CI on the pull request: all 222 backend tests pass (208 existing + 14 new) and the frontend build passes. The new pages have **not** been checked in a browser yet. The next session should do that at desktop size and 390 px, fix anything it finds, then merge into `main` and give the owner deploy commands.

**CI notes:** the nginx check failed on `main` because CI did not pass `REAL_IP_FROM`; the branch fixes that. The CI "Backup & restore drill" step also fails on `main` and on the branch: the runner's newer `pg_dump` writes `SET transaction_timeout`, which the PostgreSQL 16 service rejects. Production is not affected, because the server's backup and restore scripts run the tools inside the PostgreSQL 16 container. Fix it in CI by using version-16 client tools.

**Previously delivered:** the work-management module (§12). He was given deploy steps and setup advice: set each employee's Reporting manager, and give managers the Team Leader or Department Manager role. No reply on that yet.

## 4. Requirements that drive the product

1. **Original brief:** a production-ready multi-tenant HRMS SaaS with three apps. It must be complete and honest.
2. **"Market-ready" mandate:** finish everything, push to GitHub without secrets or environment files, then deploy to the VPS.
3. **"Complete System Requirements" document**, all implemented:
   - Four plans: Basic, Professional, Business, Enterprise.
   - Customers request a subscription and a Super Admin approves it.
   - Super Admin can switch individual features on or off per company.
   - Biometric device integration.
   - Working-day calendars.
   - Leave: casual leave, carry-forward and encashment.
   - Payroll: bonus, overtime, lateness and absence deductions, advances and loans.
   - Late and absence rules.
   - Reports with PDF and Excel export.
   - Notifications.
   - Security.
4. **Later requests, all done:**
   - Deploy at `hrms.lishnutech.com`.
   - Reset the Super Admin password.
   - Redesign the marketing site with animation (twice: home page, then menus and feature pages).
   - Better Add-employee form, with inline creation of departments and designations.
   - Fix "Workspace not found". It turned out to be transient and resolved itself.
   - Set up email.
   - Delete an employee and re-invite them.
   - **Work management:** task assignment, daily work reports, manager review with rating and feedback, performance monitoring, and a professional employee dashboard.

## 5. Architecture and technology

**Backend:**
- Node 22, Express 5, Sequelize 6, PostgreSQL 16 and Redis 7.
- BullMQ worker for background jobs.
- zod 4 for validation and pino for logs.
- argon2id for passwords and JWT for access tokens.
- pdfkit for PDFs and exceljs for Excel.

**Frontend:**
- npm workspaces with React 19, React Router 7 and Vite 6.
- Tailwind CSS v4; theme tokens live in `shared-ui/src/theme.css`.
- TanStack Query for data, recharts for charts and lucide-react for icons.
- Inter font.

**Marketing site:**
- Server-side rendered at build time: `src/entry-server.jsx` and `scripts/prerender.mjs` write 53 routes and `sitemap.xml`, with `_shell.html` as the fallback page.
- Icons come from an explicit registry (`marketing/src/components/icons.js`). Add any new icon name there.

**Multi-tenancy:**
- One database. Every tenant table has a `tenant_id` and forced row-level security (RLS).
- The API resolves the tenant from the **Host header**: `<slug>.<ROOT_DOMAIN>` is looked up in `tenant_domains`, with a 5-minute Redis cache.
- `app.<root>` is a generic host where the user picks the workspace at login.

**Production layout:**
- One `web` image: nginx serving all three apps, built from templates that use `${ROOT_DOMAIN}`, `${MARKETING_HOST}`, `${MARKETING_REDIRECT_HOST}` and `${REAL_IP_FROM}`.
- Two `api` replicas, one `worker`, `postgres` and `redis` containers.
- A one-shot `migrate` container runs the SQL migrations and the seed.

## 6. Repository map

```
backend/
  src/config/env.js            zod-validated env; derives APP/ADMIN/MARKETING hosts from ROOT_DOMAIN; refuses unsafe production values
  src/database/
    migrations/001…012_*.sql   SOURCE OF TRUTH for the schema (hand-written SQL, run in order)
    models.js                  Sequelize models + associations (mirrors the SQL; no sync())
    index.js                   appDb (hrms_app, RLS), systemDb (hrms_system), withTenant(), app.* / sys.* model sets
    migrate.js                 runs pending migrations
    seeds/catalog.js           FEATURES, PLANS, RESOURCES (permissions), DEFAULT_ROLES, platform roles
    seeds/run.js               idempotent seed: permissions, features, plans, backfills new grants into existing tenants' system roles; --demo seeds a demo tenant
    seeds/cms-content.js       website CMS defaults
  src/middleware/              tenant.js (host → tenant, auth, req.tx), authorize.js (requirePermission, feature + subscription gates), common.js (validate, rate limits, errors)
  src/modules/                 access admin attendance auth billing devices employees leave organization payroll public reports subscriptions support work workspace
  src/services/                auth, rbac, subscription(+requests, notices), billing, pricing, provisioning, signup, email, storage, audit, settings,
                               payments/providers.js, biometric/{adms,monitor}.js,
                               hr/{attendance,attendance-alerts,calendar,document-alerts,field-crypto,notify,payroll-calc}.js, work.service.js
  src/jobs/                    queues.js, worker.js (scheduled jobs, see §13)
  src/scripts/                 reset-platform-password.js, send-test-email.js
  tests/                       node:test + supertest; helpers/context.js (resetDatabase, makeTenant, makeUser, login, as(slug, token))
frontend/
  shared-ui/src/               theme.css, components/{primitives,overlays,data}.jsx, app-kit.jsx (useList, useAction, FormDialog, Filters, PageHeader…), api.js, format.js
  marketing/src/               pages/{Home,Product,Site,NotFound}.jsx, components/{core,commerce,scene,tour,icons}.jsx, content/{features,industries}.js
  admin/src/pages/             Core.jsx (dashboard, companies, plans…), Ops.jsx, Requests.jsx
  company-app/src/             main.jsx (routes + navigation), lib.jsx, pages/{Home,People,Time,Pay,Admin,Reports,Devices,Work,Auth}.jsx
  nginx/                       templates/hrms.conf.template, snippets/*.conf
  Dockerfile                   builds the three apps into one nginx image (ARG MARKETING_HOST etc.)
infrastructure/
  docker/docker-compose.yml, .env.example, postgres/00-roles.sh
  vps/ provision.sh (creates `hrms` user), issue-cert.sh, host-nginx.sh + host-nginx/hrms.conf.template, deploy.sh, backup.sh, restore-drill.sh, crontab
  deployment/ backup.sh, restore-verify.sh (used by CI)
documentation/  HANDOVER.md (this), PROGRESS.md (release status), architecture/overview.md, database/schema.md, deployment/{deployment-guide,vps-deployment}.md
.github/workflows/ci.yml       tests, builds, npm audit, nginx -t, images
```

## 7. Database

- **Postgres roles:**
  - `hrms_owner` owns the schema and runs migrations.
  - `hrms_app` is used for API requests and is subject to RLS.
  - `hrms_system` is used by the worker and system lookups, and bypasses tenant RLS where granted.
  - Policies: `tenant_isolation` for `hrms_app` (`tenant_id = current_tenant_id()`) and `owner_all`.
  - `withTenant(tenantId, fn)` sets the tenant inside a transaction. Routes use `req.tx(async (t) => …)`.
- **Production database connections** use `DB_SSL=disable`, because the bundled Postgres container has no TLS. The setting accepts `verify|require|disable`.
- **Migrations:**
  - 001 foundation: tenants, domains, users, roles, permissions, subscriptions, plans, features, audit, sessions.
  - 002 row-level security.
  - 003 auth action tokens (invites, resets, verification).
  - 004 commercial: pricing, invoices, payments, coupons, CRM, CMS, support.
  - 005 HR core: branches, departments, designations, employees and history, documents, attendance, shifts, leave, holidays, announcements, notifications.
  - 006 payroll: versioned tax rules, pay items, runs and items; approved runs locked by triggers.
  - 007 plan rename: STANDARD→PROFESSIONAL, PREMIUM→BUSINESS.
  - 008 `subscription_requests`, `tenant_feature_overrides`.
  - 009 biometric: `attendance_devices`, `device_punches`, `device_logs`, `employees.biometric_id`, `serial_taken()`.
  - 010 calendars, rules and loans: `branches.default_shift_id`, `shifts.day_hours`, `holidays.kind` (HOLIDAY|WORKING_DAY), `employee_loans`, `payroll_adjustments.code`.
  - 011 honest plan highlights.
  - 012 work management: `projects`, `tasks`, `task_activity`, `work_reports`, `work_report_items`, plus the core feature `tasks`.
  - 013 self-service: `expense_claims`, `letter_requests`; `files.owner_type` gains `EXPENSE_RECEIPT`.
- **Design rules:**
  - Composite tenant foreign keys: `(tenant_id, id)`.
  - Append-only history, ledger, audit and salary tables.
  - Soft delete through `deleted_at` where needed.
  - Every new tenant table gets RLS through the DO-block pattern in 010/012, plus grants to `hrms_app` and `hrms_system`.
- More detail: `documentation/database/schema.md`. It is older and may lag behind migrations 007–012; the SQL files are authoritative.

## 8. Authentication

**Two separate realms:**
- Platform staff: `/api/v1/admin/auth`.
- Company users: `/api/v1/auth`.

**Tokens and sessions:**
- Access token: a 15-minute JWT, `ACCESS_TOKEN_TTL_SECONDS=900`.
- Refresh token: a 30-day httpOnly cookie, rotated on every use, with reuse detection.
- Every request rechecks the user's status, so a DISABLED user is cut off immediately.
- Passwords use argon2id. After `LOGIN_MAX_FAILED_ATTEMPTS` failures the account locks for `LOGIN_LOCK_MINUTES`.
- MFA columns exist but MFA is **not implemented**.

**Flows:**
- Signup with email verification, which creates a workspace (`signup.service`, `provisioning.service`).
- Invitations: `/employees/:id/invite` gives an employee a login, and `/accept-invite` sets the password. The link is valid for 7 days.
- Forgot and reset password.
- Emails never contain passwords; they only carry set-password links.

**Reserved workspace slugs** include `www`, `app`, `admin`, `api`, `devices` and `iclock`; see `provisioning.service.js`.

## 9. Roles, permissions and data scopes

**Permissions** are `resource:action` strings defined in `RESOURCES` in `seeds/catalog.js`.

**Data scopes:**
- The scopes are `OWN`, `DIRECT_REPORTS`, `DEPARTMENT`, `BRANCH`, `SELECTED_BRANCHES` and `COMPANY`.
- A user's access is the OR of all their grants. For example, an employee can have OWN through the Employee role plus DEPARTMENT through Department Manager.
- `scopeWhere(scopes, principal)` builds the Sequelize WHERE; `recordInScope()` checks a single record.
- Resources in `UNSCOPED` (users, roles, settings, projects…) ignore scope.

**Company roles** (system roles, copied into every tenant):
- `company_owner` and `company_admin`: everything, COMPANY-wide.
- `hr_manager`, `payroll_manager`.
- `department_manager` (DEPARTMENT scope) and `branch_manager` (BRANCH scope).
- `team_leader` (DIRECT_REPORTS).
- `employee` (OWN).
- `auditor` (read-only).

**Platform roles:** super_admin, platform_admin, finance_admin, sales_admin, marketing_admin, support_admin, technical_admin.

**To add a permission:**
1. Add it to `RESOURCES` and to the right roles in `DEFAULT_ROLES`.
2. On deploy, `seeds/run.js` creates the permission and **backfills it into every existing tenant's system roles**. No migration is needed for permissions.
3. Protect routes with `requirePermission('x:y')`. That middleware also checks the module's feature is enabled and the subscription state.

**Frontend checks** (`useAuth()` in `company-app/src/lib.jsx`):
- `a.can('x:y')` checks a permission.
- `a.wide('x:y')` means the user holds a scope wider than OWN.
- `a.feature('key')` checks a feature is enabled.
- `a.employeeId` is the employee record linked to the login.

## 10. Plans, features and subscriptions

**Plans** (`PLANS` in catalog; prices are versioned in the database and editable in Super Admin):

| Plan | Employees | Branches | Storage |
|---|---|---|---|
| BASIC | 20 | 1 | 2 GB |
| PROFESSIONAL (shown as "Most chosen") | 50 | 2 | 10 GB |
| BUSINESS | 150 | 5 | 50 GB |
| ENTERPRISE | unlimited | unlimited | unlimited (price on request, `contactSales`) |

Prices are in NPR plus 13% VAT, billed monthly or annually.

**Features:**
- `FEATURES` in the catalog. Core features (`is_core`) are on for every plan; the others come from plan entitlements.
- Super Admin can force a feature on or off per company (`tenant_feature_overrides`).
- `tasks` (Tasks & Daily Work Reports) is a **core feature**.
- `biometric` is on Professional and above.
- `reports_advanced` gates report export.

**Subscription access states** (`evaluateAccess` in `subscription.service.js`):
- FULL: everything works.
- GRACE: everything works, with a warning.
- READ_ONLY: reads, sign-in and billing only.
- BLOCKED.

**Subscription requests:** a company requests a plan, and Super Admin approves it with an invoice or immediate activation (custom amount, limits and features allowed) or rejects it.

**Billing and payments:** invoices with proration and VAT, PDF invoices, credit notes and coupons. Payment by eSewa, Khalti or bank transfer, verified on the server.

## 11. What is built, by application

`documentation/PROGRESS.md` has the full list. In brief:

**Marketing site:**
- Home page with an animated hero (`components/scene.jsx`) and a product tour (`components/tour.jsx`, 6 tabs including Tasks).
- 21 feature pages, generated from `content/features.js`. Each has `status: 'available' | 'coming-soon'`, and unbuilt features show as "On the roadmap".
- 12 industry pages.
- Pricing with live prices, a calculator and a comparison table ("Coming soon" badges for unbuilt features).
- Signup, demo, contact, FAQ, blog, changelog, legal and status pages, all CMS-driven.
- Header mega-menus listing available versus roadmap features. Navy CTA bands. Tokens `night` #0b1a3f, `marigold` #f0a43a.
- Motion respects `prefers-reduced-motion`.

**Super Admin portal:**
- Dashboard (MRR, signups, plan mix, pending requests).
- Requests queue.
- Companies: detail, suspend or reactivate, plan change, limit overrides, feature switches, CSV export.
- Plans and pricing, billing (invoices, payment approval, credit notes, coupons), CRM leads, CMS, support desk, settings, staff and audit log.

**Company HRMS:**
- **Dashboard:** role-aware (§12).
- **Employees:**
  - Lifecycle and history, CSV import/export, encrypted bank details, documents with expiry alerts.
  - Login invites, and **delete for records added by mistake** (refused once the person has payroll records).
  - The Add/Edit form has sections, plus "+ New" for departments and designations.
- **Organization:** branches, departments, designations, shifts with per-weekday hours.
- **Attendance:**
  - Web and phone clock-in with an optional geofence, register and corrections.
  - ZKTeco devices.
  - Calendars and rules (grace periods, early leave, half days, deductions), with daily alerts.
- **Leave:** Labour Act 2074 defaults, ledger-based balances, accrual and carry-forward, encashment, multi-level approval, holidays (BS dates).
- **Payroll:**
  - Bikram Sambat months, versioned tax rules for FY 2082/83 and 2083/84, SSF/PF/CIT.
  - Unpaid-day breakdown, loans and advances, bonuses and adjustments.
  - Maker-checker approval with locked runs.
  - Payslip PDFs, bank sheet, TDS and SSF reports.
- **Reports:**
  - Employee performance, task register, headcount and turnover, attendance, punctuality, leave, balances, payroll, deductions, devices and subscription.
  - Export to PDF, Excel and CSV.
- **Also:** announcements, notifications (in-app plus email), users and roles, subscription and billing, support tickets, settings, audit log, PWA install.
- **Employee self-service:** My profile, My attendance, My leave, My payslips, plus My work (§12).

## 12. Work management (most recent work, in detail)

**Backend:**
- Code: `backend/src/modules/work/work.routes.js`, `backend/src/services/work.service.js`, migration 012.
- Tests: `tests/work.test.js` (10 tests).

**Permissions:**

| Permission | Actions |
|---|---|
| `tasks` | view, create, edit, delete, export (scoped by the **assignee's** employee record) |
| `work_reports` | view, create, approve (approve = review and rate), export |
| `projects` | unscoped |

**Grants by role:**

| Role | Grants |
|---|---|
| employee | tasks view/create/edit OWN; work_reports view/create OWN; projects view |
| team_leader | tasks view/create/edit/delete DIRECT_REPORTS; work_reports view/approve DIRECT_REPORTS; projects view/create |
| department_manager, branch_manager | tasks * (all actions); work_reports view/approve/export in their scope; projects view/create/edit |
| hr_manager, owner, admin | everything, COMPANY-wide |

**API** (all under `/api/v1`):
- **Tasks:**
  - `GET /tasks?view=all|mine|created|team&status=open|CSV&priority&assigneeId&projectId&due=overdue|today|week|none&search&sort&order&page&pageSize`
  - `GET /tasks/summary?view=mine|team|all`
  - `GET /tasks/assignees`: who you may assign to.
  - `POST /tasks`
  - `GET /tasks/:id`: includes the activity trail and `abilities`.
  - `PATCH /tasks/:id`
  - `POST /tasks/:id/comments`
  - `DELETE /tasks/:id`: soft delete.
- **Projects:** `GET/POST /projects`, `PATCH /projects/:id`, with task counts and percent done.
- **Daily reports:**
  - `GET /work-reports/mine?date=`: report, editable flag, my tasks, attendance that day, recent reports.
  - `PUT /work-reports/mine/:date`: body `{summary, challenges, planNext, items:[{taskId?, description, hours, progress?, completed}], submit}`.
  - `GET /work-reports?from&to&status&employeeId`: team list; drafts stay private.
  - `GET /work-reports/missing?date=`: people at work but with no report.
  - `GET /work-reports/:id`
  - `POST /work-reports/:id/review`: `{decision: APPROVE|REQUEST_CHANGES, rating 1–5, feedback}`.
- **Performance:** `GET /performance?from&to&departmentId&branchId` and `GET /performance/employees/:id?from&to` (the second adds an 8-week trend and recent feedback).
- **Reports module:** `performance` and `tasks` reports.

**Rules:**
- **Task numbering:** tasks are numbered per company (T-1, T-2…) under an advisory lock.
- **Assignees:** you may only assign to people inside your `tasks:create` scope. An employee can create personal tasks for themselves.
- **Task statuses:** TODO, IN_PROGRESS, BLOCKED (requires a reason), IN_REVIEW, DONE, CANCELLED.
- **What the assignee may do:** change status and progress and comment. Moving progress above 0 starts the task; reaching 100% finishes it, or sends it to IN_REVIEW when `requiresReview` is set.
- **What only the creator or a manager may do:** edit details, reassign, cancel, reopen, approve a review.
- **Daily reports:**
  - One per employee per day, writable for today and the last 14 days.
  - Status flow: DRAFT → SUBMITTED → APPROVED or CHANGES_REQUESTED (editable again, then resubmitted). APPROVED reports are locked.
  - Submitting copies progress and completion into the linked tasks, adds REPORT activity, recomputes the task's `logged_hours`, and notifies the reviewers. Reviewers are the employee's manager's login, or anyone with `work_reports:approve` when there is no manager.
- **Notifications:** assignment and reassignment (email), sent for review (email), blocked (email), completed, comments, a new due date, report submitted, report reviewed (email if there is feedback), changes requested (email).
- **Performance score (0–100):**
  - Weights: on-time completion 35%, reports on days present 25%, average rating 25%, punctuality 15%.
  - Shown **only when at least two indicators have data**.
- **Reminder jobs:** `work-reminders` at 09:30 (tasks due today or overdue; overdue ones by email) and `report-reminders` at 18:00 (present today, no report). Each fires at most once per item per day.
- **Dashboard attendance chart:** the 14-day trend is now limited to the viewer's attendance scope. Before this, team leaders saw company-wide counts.

**Frontend** (`company-app/src/pages/Work.jsx`, `Home.jsx`, navigation in `main.jsx`):
- **Routes:**
  - Employee: `/my-work/tasks`, `/my-work/report`, `/my-work/performance`.
  - Manager: `/tasks` (tabs Mine, Team, Assigned by me, All; list or drag-and-drop board; `?new=1` opens the create dialog; `?projectId=` filters), `/tasks/:id`, `/work-reports`, `/work-reports/:id`, `/performance`, `/performance/:id`, `/projects`.
- **Menu:** "My work" (for logins linked to an employee) and "Work" (managers).
- **Dashboard:**
  - Clock-in widget, today's report card, my task counts, "Up next" tasks, My performance (score ring), leave balance.
  - For managers, "Your team": reports to review, missing reports, overdue and blocked tasks, a needs-attention list and the review queue.
  - Then "Today at work", with company stats shown only to people who can see everyone.
- **Marketing:** the `task-management` feature page and a Tasks tab in the home tour.

## 12a. Employee self-service, stage 1 (branch `stage-1-self-service`)

Asked for by the owner: "something professional, long term, more than other systems" for employees. Missed-punch requests already existed (My attendance → Request correction); stage 1 improved them rather than rebuilding them.

**Performance-score fixes** (`services/work.service.js`):
- Punctuality counts a day as late when `late_minutes > 0`, even if the day ended as a half day. Before, clocking in late and out early turned LATE into HALF_DAY and the lateness disappeared (owner's screenshot: 438 minutes late, punctuality 100%).
- Report rate no longer counts today until today's report is in. A new employee no longer starts with a red score of 38.

**Expense claims** (feature `expenses`, Professional plan and above; `modules/expenses/expenses.routes.js`, `services/uploads.js`):
- Flow: SUBMITTED → MANAGER_APPROVED → APPROVED → SCHEDULED (added to a payroll month) → PAID, or APPROVED → PAID directly with a reference. REJECTED and CANCELLED are final.
- "Finance" = `expenses:approve` at COMPANY scope (owner, admin, payroll manager, accountant). Finance can approve at either stage and may approve less than claimed, with a note. A manager can approve only the first stage and cannot change the amount. Nobody approves or pays their own claim.
- The manager step is needed only if the employee's manager has a login holding `expenses:approve`; otherwise the claim goes straight to finance. Team leaders now get expenses view/approve/reject for DIRECT_REPORTS in the role template. **This only applies to new companies**: the seed backfills new permissions, not new grants of existing ones, so existing companies' Team Leader roles need it added under Users & roles if wanted.
- Paying with salary creates a non-taxable `REIMBURSEMENT` payroll adjustment for the chosen BS month (needs `payroll:edit` and the payroll feature); approving that month's payroll marks the claims PAID. It can be taken back while that payroll is not submitted.
- Policy in tenant setting `expenses.policy`: categories (code, name, per-claim limit, active), `receiptRequiredAbove` (default NPR 500), `maxAgeDays` (default 60). Claims above a limit are flagged, not blocked. Same employee + date + amount + category is refused as a duplicate.
- Receipts: JPEG, PNG or PDF, checked by their first bytes, stored privately as `files` with owner type `EXPENSE_RECEIPT`.
- API: `GET /expenses?view=mine|team|queue`, `GET /expenses/summary`, `GET/PUT /expenses/policy`, `GET /expenses/export` (CSV), `POST /expenses` (multipart, field `receipt`), `GET /expenses/:id`, `GET /expenses/:id/receipt`, `POST /expenses/:id/approve|reject|cancel|pay|unschedule`.
- UI: My expenses (`/me/expenses`, `/me/expenses/:id`), Expense claims (`/expenses`, tabs "Needs your action" and "All claims"), Categories and rules (`/expenses/settings`), a dashboard card and "Waiting for you" tiles.

**HR letters** (core, under `ess`; new permission resource `letters` with view, create, approve, configure; `modules/letters/letters.routes.js`, `services/letters.js`):
- Types: employment verification, salary certificate, experience letter, letter to a bank (needs the bank), no objection letter.
- Employee requests → HR (`letters:approve`: owner, admin, HR manager, HR officer) issues or rejects. Issuing freezes the data into `letter_requests.content`, so re-downloading always gives the same letter. Salary and bank letters need a salary on record.
- PDF on the letterhead (tenant setting `letters.letterhead`: registered name, address, contacts, PAN, default signatory, reference prefix), with reference `LTR/<BS year>/<number>`, AD and BS dates, a signature and stamp block, and a footer with a verification code.
- Anyone can check a letter at `https://<slug>.<domain>/verify/<code>` (API `GET /api/v1/verify/letters/:code`, public, on the company's own host only). It shows type, reference, name, role and date, never pay. HR can withdraw a letter; it then shows as withdrawn and the employee can no longer download it.
- No logo yet: `branding.logoFileId` exists but nothing uploads a logo. The letterhead uses the brand colour.
- UI: My letters (`/me/letters`), Letter requests (`/letters`) with the Letterhead dialog, public page `/verify/:code`.

**My tax** (payroll feature; `GET /payroll/tax-statement?fy=&employeeId=`, `GET /payroll/tax-statement/pdf`):
- From approved payroll; employees see published months only. Shows tax paid so far, the full-year estimate from the latest payslip's calculation, what is still to be deducted, next month's estimate, a month-by-month table and how the estimate is worked out. PDF "salary and tax statement", clearly labelled as not a tax clearance certificate.
- UI: `/me/tax`, linked from My payslips.

**Missed-punch requests:** the employee can cancel a pending request (`POST /attendance/corrections/:id/cancel`); with no manager login, everyone who approves attendance company-wide is notified (by email too); time pickers in the form; the list shows the requested times and the reviewer's note.

**Website:** Expense Management is now `available`; the Employee Self-Service page lists the new capabilities.

**Tests:** `tests/self-service.test.js` (14 tests) covers the score fixes, the whole expense flow including payroll, letters including public verification and withdrawal, the tax statement, and correction cancel. All pass in CI.

## 13. Integrations

- **Email:**
  - `EMAIL_TRANSPORT=smtp` through Brevo: `smtp-relay.brevo.com:587` with STARTTLS, `SMTP_USER=…@smtp-brevo.com`, and the SMTP key in `SMTP_PASS` on the server only.
  - Locally, `EMAIL_TRANSPORT=log` writes emails to the log.
  - Emails are queued by the worker (`enqueueEmail`).
  - `SALES_NOTIFY_EMAIL` may still be a placeholder; he was given a `sed` command to set it.
- **Payments:**
  - eSewa (form and status API) and Khalti (`KHALTI_BASE_URL`), verified on the server, plus bank transfer with manual approval in Super Admin.
  - `PAYMENTS_ENABLED`.
  - Never tested with a live transaction.
- **Biometric:**
  - ZKTeco ADMS push protocol at `/iclock` (`cdata`, `getrequest`, `devicecmd`).
  - Devices are registered under Devices in the company app, and employees map through `biometricId`.
  - Each punch is processed in its own savepoint: first in and last out, and a double tap within 2 minutes is ignored.
  - Offline alerts and log retention run in `biometric/monitor.js`.
  - Tested only with simulated terminals.
- **Storage:** `STORAGE_DRIVER` is local disk (`/app/storage` volume) or S3-compatible (`@aws-sdk/client-s3`).
- **DNS and TLS:** Cloudflare DNS. A wildcard certificate is issued by `infrastructure/vps/issue-cert.sh` using certbot's dns-cloudflare plugin.
- **Scheduled jobs** (`jobs/worker.js`, Asia/Kathmandu time):

| Time | Job |
|---|---|
| 02:15 | renewal invoices |
| 03:40 | device retention |
| 08:05 | document expiry |
| 08:30 | subscription notices |
| 09:15 | attendance alerts |
| 09:30 | work reminders |
| 18:00 | report reminders |

  The worker also runs the subscription lifecycle, payment reconciliation and the email queue.

## 14. Production server

- **Paths:** code in `/opt/hrms`, owned by the Linux user `hrms` (created by `vps/provision.sh`, a member of the docker group). Compose files are in `/opt/hrms/infrastructure/docker` and the environment file is `.env` there.
- **Host nginx:** `vps/host-nginx.sh` writes `/etc/nginx/sites-available/hrms.conf`, proxying to `127.0.0.1:18080` and `127.0.0.1:18443`. The `.env` has `WEB_HTTP_BIND`, `WEB_HTTPS_BIND` and `REAL_IP_FROM=172.16.0.0/12`.
- **deploy.sh safety checks:** it refuses to run while `CHANGE_ME` placeholders remain, or when `MARKETING_HOST` is not inside `ROOT_DOMAIN`.
- **Backups:** `vps/backup.sh` makes encrypted nightly backups, and `vps/restore-drill.sh` runs weekly (see `vps/crontab`).
- **Useful commands** (as root, in `/opt/hrms/infrastructure/docker`):
  ```
  docker compose ps
  docker compose logs --tail=100 api        # or worker / web
  docker compose exec -T postgres psql -U postgres -d hrms -c "…"
  docker compose exec api node src/scripts/send-test-email.js you@example.com
  docker compose exec api node src/scripts/reset-platform-password.js <email>
  ```
- **Full runbook:** `documentation/deployment/vps-deployment.md`.

## 15. Development environment (Claude's sandbox)

These notes describe the cloud workspace earlier sessions used. A new session may start in a fresh environment; if so, follow the README's "Run locally" section.

- **Repository:** `/home/claude/hrms-platform`, remote `origin` = `nissanttimilsina/hrms`. Push with `git push origin HEAD:main`.
- **Services stop between turns.** Restart them:
  ```
  service postgresql start; redis-server --daemonize yes
  cd backend && (node src/server.js > /tmp/api.log 2>&1 &)
  ```
- **Network quirks:**
  - Use `curl --noproxy '*'` for localhost.
  - There is no `envsubst`; render templates with Python.
  - Docker Hub is blocked, so images cannot be built here; CI and the server build them.
  - Local nginx is 1.24, which has no `http2 on;` and no IPv6.
- **Local settings:** `backend/.env` has `ROOT_DOMAIN=hrms.localhost` and connects with `DATABASE_URL_OWNER/APP/SYSTEM`. To call the API as a company, set the header `Host: demo.hrms.localhost`.
- **Demo logins** (local only, password `ChangeMe!2026`): `owner@demo.local` (owner), `ram@demo.local` (Team Leader + Employee, manages Sita) and `sita@demo.local` (Employee). Demo data contains duplicate test tasks from the browser test runs.
- **Preview ports:** after building, `npx vite preview --port 4173` serves marketing, 4174 admin and 4175 company-app.
- **Marketing build:** `VITE_ROOT_DOMAIN=hrms.lishnutech.com VITE_SITE_URL=https://hrms.lishnutech.com npm run build` in `frontend/marketing`. It should print "prerendered 53 routes".
- **Builds and tests:** `cd frontend && npm run build` builds all three apps; `cd backend && npm test` runs all tests. Tests use a separate test database and reset it.
- **Browser checks:** Playwright with `executable_path='/usr/bin/google-chrome'`. The pattern is to log in, click through, take screenshots, check console errors, and confirm `document.documentElement.scrollWidth <= 390` on a phone-sized viewport.

## 16. Coding conventions

**Backend:**
- **New schema:** add a numbered SQL migration (`0NN_name.sql`), never `sync()`. Include RLS, grants and composite tenant foreign keys. Mirror it in `models.js`, using `opts()`, `createdOnly()` or `noTs()`, and add the model to the returned object.
- **Route shape:**
  ```js
  router.post('/', requirePermission('x:create'), validate({ body: zodSchema }), asyncHandler(async (req, res) => {
    const out = await req.tx(async (t) => { …; await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'x.create', entityType: 'x', entityId, after, req }); return …; });
    return created(res, out);           // ok(res, data, meta) for reads
  }));
  ```
- **Errors:** use `BadRequest(msg, [{path, message}])` (returns 400; zod schema failures from `validate()` return 422 `VALIDATION_ERROR`), `NotFound('Thing')`, `Forbidden(msg, code)`, `Conflict(msg, code)` from `utils/errors.js`. Messages are plain sentences the user can act on.
- **Notifications:** `notifyUsers(t, userIds, { type, title, body, link, email })` from `services/hr/notify.js`; `usersWithPermission(t, 'perm')`; `userIdForEmployee(t, employeeId)`.
- **Validation:** zod 4. Use **`z.partialRecord`** for partial enum-keyed records. Do not build PATCH schemas with `.partial()` from a schema that has `.default()` values (see §17).
- **Dates:** use `localDate`, `addDays` and `weekday` from `services/hr/calendar.js`. The tenant time zone is `req.auth.ctx.tenant.timezone` (Asia/Kathmandu).
- **Tests:** every new feature gets a `tests/<area>.test.js` that covers permissions and scope as well as the happy path.

**Frontend:**
- **Building blocks:** use `@hrms/shared-ui` components and the app-kit hooks:
  - `useList(path, params)` for paged lists: `{rows, meta, params, set, page, loading}`.
  - `useAction(fn, { success, invalidate, onDone })` for changes.
  - `FormDialog` for forms. Fields support `section`, `sectionHint`, `span`, `create: {label, onCreate}` (inline "+ New") and `emptyHint`. Date fields come back as ISO strings, so `.slice(0,10)` them.
  - `PageHeader`, `DataTable`, `EmptyState`, `ConfirmDialog`, `Dialog`, `useToast()`.
- **API client:** `api.get`, `api.post`, `api.patch`, `api.put`, **`api.del`** (not `api.delete`), and `api.list` (returns `{data, meta}`).
- **Colours:** use only theme colour tokens that exist (`ink-400/500/700/900`, `brand-50…700`, `success-50/600/700`, `warning-50/600/700`, `danger-50/600/700`, `line`, `line-strong`, `subtle`, `canvas`). Tokens such as `ink-300`, `ink-600` and `warning-500` do not exist and render as nothing.
- **Class merging:** `cn()` is clsx, **not** tailwind-merge, so conflicting classes (`w-full` with `w-44`) do not override. Wrap the element, or avoid the conflict.
- **Grid layouts:** use `grid grid-cols-1 [&>*]:min-w-0 …`, or wide children overflow on phones.
- **Navigation:** add pages in `company-app/src/main.jsx` (routes and `nav` sections) and gate them with `can`, `wide` and `feature`.

**Copy and design:**
- Sentence case, plain words and active verbs.
- No all-caps labels on the marketing site. Admin table headers are still uppercase from the original kit.
- Only claim features that are built. When a module ships, set its `status: 'available'` in `marketing/src/content/features.js` and update `documentation/PROGRESS.md`.
- One orchestrated animation is better than animations everywhere. Respect reduced motion.

**Git:**
- Commit as `git -c user.name=Claude -c user.email=noreply@anthropic.com commit …`, and end every message with the attribution trailer the session's system instructions give (earlier sessions used a `Co-Authored-By: Claude …` line plus a `Claude-Session: …` line).
- Never commit `.env` files, keys, `dump.rdb` or `storage/`. The repository is public.
- Run the backend tests and the frontend build before every push.

## 17. Bugs fixed and lessons learned

1. **PATCH schemas and defaults:** a zod `.partial()` copy of a create schema keeps its `.default()` values, so a progress-only update looked like a details change and failed with "NOT_TASK_MANAGER". Fixed with a separate PATCH schema plus normalised change detection (numbers, tags, null).
2. **Half days:** the half-day threshold changed normal days too. It now applies only when the scheduled minutes are at most `halfDayMinutes`.
3. **Production migrations:** they failed because the database forced TLS; fixed with `DB_SSL=disable` for the bundled Postgres.
4. **Wrong host after deploy:** `hrms.lishnutech.com` showed the company sign-in because `.env` still had the placeholder `ROOT_DOMAIN` and `MARKETING_HOST`. deploy.sh now refuses that.
5. **"Workspace not found"** on `lishnu.hrms.lishnutech.com` (27 Nov, around 12:19) was transient. Five minutes later the database, cache and API were all correct and sign-in worked. Root cause unknown; if it recurs, check `docker compose logs api | grep '"statusCode":404'` for the host received.
6. **Brevo** returned "525 Unauthorized IP address" until the server IP was authorised under Brevo → Security → Authorized IPs.
7. **Small frontend traps:** the API client method is `api.del`; search placeholders use a real ellipsis character (`Search…`), which matters for Playwright; filter selects stretched full width because of the `cn` conflict noted above.
8. **The dashboard attendance trend ignored data scope.** It is now scoped.
9. **A one-rating performance score of 75 was misleading.** The score now needs at least two indicators.

## 18. Known gaps, risks and open items

**Not built:**
- SMS notifications.
- General data-retention settings for employee data.
- MFA.
- Custom domains for companies.
- Formal performance appraisals (goals and appraisal cycles). Day-to-day performance from tasks and reports *is* built.
- Recruitment, onboarding/offboarding, expenses, assets, training, workforce planning, helpdesk, engagement, AI assistant, custom workflows. These are marked "On the roadmap" on the site.

**Needs real-world confirmation:**
- One real ZKTeco terminal at go-live.
- One small live eSewa and one live Khalti payment.
- Legal pages are drafts that need review by Nepali counsel.
- Tax slabs and SSF rates must be checked every Shrawan.

**Stage 1 follow-ups:**
- Check the stage 1 pages in a browser at desktop size and 390 px, merge pull request #1 into `main`, then deploy.
- After deploy, the owner should fill in the letterhead (Letter requests → Letterhead) and review expense categories and limits (Expense claims → Categories and rules).
- Existing companies' Team Leader roles do not get expense approval automatically (see §12a).

**Production follow-ups for the owner:**
- Deploy `2e2bee8`.
- Set reporting managers and manager roles.
- Set `SALES_NOTIFY_EMAIL` and `CONTACT_EMAIL` in `/opt/hrms/infrastructure/docker/.env`.
- Delete the Brevo key that was pasted in chat, if not done yet.
- Optionally link his own owner login to an employee record so he gets "My work".

**Dated documentation:** `documentation/database/schema.md` and `architecture/overview.md` predate migrations 007–012.

**Possible improvements raised but not done:**
- File attachments on tasks.
- Recurring tasks.
- Sub-tasks or checklists.
- Gantt or calendar view.
- Team leaders seeing missing reports per day in a calendar.
- Exporting a single employee's performance as a PDF.

## 19. Suggested next steps

1. Confirm production is on `2e2bee8` and that sign-in, the dashboard, tasks and daily reports work live. Check the worker logs at 09:30 and 18:00 for the reminder jobs.
2. Help the owner set up reporting managers and roles in the `lishnu` workspace.
3. If he asks for more on work management, the natural additions are task attachments, recurring tasks and checklists.
4. MFA (TOTP) for Super Admin staff and company owners.
5. Expense claims linked to payroll pay items, then assets, then recruitment and onboarding, using the existing patterns. Update the website status when each ships.
6. Refresh `documentation/database/schema.md` from migrations 001–012.

## 20. Starting a new session

Suggested first message for the new session:

> This is the Lishnu HRMS project (GitHub `nissanttimilsina/hrms`, branch `main`). Read `CLAUDE.md` and `documentation/HANDOVER.md` in full, then `documentation/PROGRESS.md`. Confirm the latest commit you see and the test count, then wait for my next request. I run all server commands myself and paste the output.

The new session should then:
1. Clone or open the repository.
2. Read `CLAUDE.md`, this file and `PROGRESS.md`.
3. Run `git log --oneline -5` and compare with §3.
4. Install dependencies, run the backend tests and the frontend build, to confirm the environment before changing anything.
