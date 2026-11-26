# Development progress

_Last updated: 26 Nov 2026 — Phase 1 (Foundation) complete._

## Phase 1 — Foundation ✅

| Area | Delivered | Verified by |
|---|---|---|
| Architecture | Monorepo layout from the brief; three-role Postgres model; stateless API + BullMQ worker | `documentation/architecture/overview.md` |
| Database | 3 SQL migrations: 28 tables, composite tenant FKs, check constraints, partial unique indexes, `updated_at` triggers, versioned prices; checksum + advisory-locked migration runner | migrations run twice in CI (idempotent) |
| Tenant isolation | Host/JWT tenant resolution; `withTenant` transaction-local context; RLS enabled + forced on all 15 tenant tables + self-row policy on `tenants`; fail-closed default; composite FKs | **18** isolation tests (DB + API) |
| Authentication | Argon2id; JWT access (15 min) + rotating refresh with reuse detection; cookie (httpOnly/Strict) or mobile body transport; CSRF header; lockout; logout / logout-all / per-session revoke with immediate effect via Redis; password reset, change and invitation acceptance; platform-staff auth | **14** auth tests |
| RBAC | Global permission catalogue (141 permissions), 12 default tenant roles, custom roles, 6 data scopes incl. SELECTED_BRANCHES, anti-escalation, last-owner protection, 7 platform admin roles | **13** RBAC tests |
| Subscription engine | DB-driven plans, versioned prices, entitlements, overrides, add-ons; centralised enforcement (tenant status, subscription status, expiry, entitlement, employee/branch/user/storage limits, permissions); race-safe limits; lifecycle state machine + 15-min sweep; read-only mode preserving data; manual payment activation; full event history | **28** subscription tests |
| Provisioning | One-transaction tenant creation: subdomain, settings, 12 roles, HQ branch, owner (password or invitation), trial subscription, audit | provisioning tests |
| APIs | `/public/plans`, tenant auth, branches, departments, employees (scoped, paginated, searchable), roles/permissions/users/invitations, tenant audit log, my-subscription, Super Admin tenants/plans/prices/entitlements/subscriptions/audit | OpenAPI 3.1 at `/api/docs` |
| Audit | Append-only audit log (DB-enforced) for every privileged tenant and platform action | tests |
| Design system | `@hrms/shared-ui`: Tailwind v4 tokens, Button, Field/Input/Select/Textarea/Checkbox, Card, Badge, Stat, Skeleton, EmptyState, DataTable (sort, paging, loading, empty), Dialog/ConfirmDialog (focus trap), Toasts, UsageMeter, UpgradePrompt, SubscriptionBanner, AppShell (responsive), BrandProvider, NPR/date formatting, API-error mapper | built and visually checked at 1360 px and 390 px |
| DevOps | Dockerfile (non-root, tini, healthcheck), Compose (postgres, redis, migrate, api×2, worker, nginx), Nginx TLS/HSTS/rate limits, `.env.example` files, GitHub Actions CI (tests, backup drill, audit, image build), backup + restore-verify scripts | compose validated; backup → restore → verify run successfully |

**Test results:** `npm test` → **73 passed, 0 failed** (Postgres 16, Redis 7, ~8 s). `npm audit --omit=dev` → 0 vulnerabilities.

## Known issues / limitations

1. **Docker image not built in the dev sandbox** (no Docker daemon there). The Compose file validates and CI builds the image; do a first `docker compose up` on a real host.
2. **MFA** is modelled (`mfa_secret_enc` columns) but not implemented. Planned for Phase 2 alongside email verification UI.
3. **Email delivery** uses a `log` transport. The SMTP/API provider and DB-stored templates come with the notification engine.
4. **Concurrent refresh from two tabs** of the same session counts as reuse and signs the user out. The frontend must serialise refreshes (single-flight), or we add a short grace window.
5. **Plan change proration** is not applied yet. `changePlan` switches immediately; proration, invoices and downgrade-at-renewal billing arrive with Phase 2 billing.
6. **Custom-domain verification flow** (DNS TXT check) is modelled (`verification_token`) but has no endpoint yet.
7. Nginx config not syntax-checked locally (no nginx binary); it's checked on first container start.

## Next — Phase 2: Public website & commercial engine

- Marketing site (React + Router + TanStack Query) on `/public/*` endpoints; CMS tables and admin APIs
- Pricing page and calculator from `/public/plans` plus a pricing-rules endpoint
- Self-service registration → `provisionTenant`, with email verification
- Billing: invoices, invoice items, tax config, proration, credit notes; payment abstraction with eSewa / Khalti / bank transfer adapters and **server-side callback verification**
- Lead capture → CRM tables

Then Phase 3 (Super Admin UI + CRM + support), Phase 4 (core HRMS + ESS PWA), Phase 5 (payroll and Nepal compliance with versioned tax/contribution tables), Phase 6 (custom fields, workflow builder, AI), Phase 7 (hardening, load tests, monitoring, dedicated-DB router).
