# Status & release readiness

_Last updated: 26 Nov 2026. Release candidate for the first production deployment._

## What ships

| Product | Scope |
|---|---|
| **Marketing website** (`www.`) | 51 prerendered, SEO-ready pages and a sitemap: home, 20 feature pages, 12 industry pages, pricing with a live calculator and comparison table, about, contact, demo request, customers, FAQ, help, status, blog, changelog, security and legal pages (from the CMS). Signup with email verification creates a live workspace. Demo and contact requests go to the CRM. Newsletter signup. Honest status flags: features not built yet are marked "Coming soon". |
| **Super Admin portal** (`admin.`) | Dashboard (MRR, signups, plan mix). Tenants: detail, suspend/reactivate, plan changes, limit overrides. Plans, prices and entitlements. Billing: invoices, payment approval, credit notes, coupons. Lead CRM with convert-to-tenant. Website CMS (FAQs, announcements, legal and blog pages). Support desk. Platform settings and staff roles. Audit log. |
| **Company HRMS** (`<company>.` / `app.`) | Dashboard. Employees: lifecycle, history, CSV import/export, encrypted bank details, documents with expiry reminders, login invites. Organization (branches, departments, designations, shifts). Attendance: web clock-in with optional geofence, register, corrections, policy. Leave: Labour Act 2074 defaults, ledger balances, multi-level approval, holidays, calendar. Nepal payroll: BS months, versioned tax rules for FY 2082/83 and 2083/84, SSF/PF/CIT, female rebate, maker-checker approval, locked runs, payslip PDFs, bank transfer, TDS and SSF reports. Reports with Excel/CSV export. Announcements and notifications. Users, roles and data scopes. Subscription and billing (eSewa, Khalti, bank transfer). Support tickets. Settings and audit log. Installable as a mobile app (PWA). |
| **Platform** | Multi-tenant PostgreSQL with forced row-level security and fail-closed tenant context. Argon2id passwords, rotating refresh tokens with reuse detection, RBAC with 151 permissions and 6 data scopes. Subscription states FULL / GRACE / READ_ONLY / BLOCKED enforced centrally. Background worker for the subscription lifecycle, renewal invoices, payment reconciliation, document expiry reminders and email. |

## Verification

| Check | Result |
|---|---|
| Backend tests (`npm test`) | **157 passed, 0 failed**: auth 15, tenant isolation 18, RBAC 13, subscriptions 28, commercial/billing 39, HR 24, payroll 12, reports 11 |
| Dependency audit (`npm audit --omit=dev`) | 0 vulnerabilities in backend and frontend |
| Browser end-to-end (Playwright, Chrome) | Marketing signup → email verification → active workspace. Demo request → CRM lead. Every admin portal page. Company app: sign-in, clock-in, employees, salary, payroll calculate with tax breakdown, billing, reports and Excel export, every page; mobile layout at 390 px. No console errors. |
| Production Nginx config | Rendered from the template and tested locally: host routing, apex→www, prerendered pages with shell fallback, `/api` proxy, CSP/HSTS headers, immutable asset caching, rate limits (verified 429). Correct HTTP status codes. |
| Production configuration | The filled `.env.example` passes the API's refuse-to-start checks; the unfilled template is rejected. |
| Backups | Backup → restore → verify drill tested (also runs in CI). The VPS kit adds encrypted nightly backups and a weekly restore drill. |
| Container images | **Not built in the development sandbox** (Docker Hub is blocked there). CI builds both images on every push, and the first VPS deploy builds them on the server. |

## Database

- 6 SQL migrations and 59 tables.
- 39 tenant tables use forced row-level security.
- Composite tenant foreign keys.
- Append-only audit, history, leave-ledger and salary tables.
- Approved payroll is locked by database triggers.

## Features marked "Coming soon" on the website (not built)

Recruitment, onboarding/offboarding, performance management, expense management, asset management, training, workforce planning, HR helpdesk, employee engagement, AI HR assistant and custom workflows.

The plan comparison table lists them as plan entitlements. Each one appears in the product only when it is built, and its website status changes at the same time.

## Known limitations

1. **Legal pages are drafts.** Terms, Privacy and Refund policy are seeded as drafts for review by Nepali counsel before publishing.
2. **Statutory figures need yearly review.** Tax slabs, SSF rates and leave entitlements are stored as versioned data, not code. Check them against each Finance Act (every Shrawan) under Super Admin and payroll setup.
3. **Live payments are untested against production gateways.** eSewa and Khalti are integrated and tested against the documented APIs with sandbox semantics. Make one small live transaction of each before announcing them. Launching with bank transfer only is supported.
4. **No MFA yet.** The database columns exist, but the login flow does not use them.
5. **Custom domains** (a company's own domain instead of a subdomain) are not offered. Workspaces use `<slug>.<domain>`.
6. **Attendance is web/PWA clock-in only.** No biometric device integration.
7. **Absence deduction is off by default.** Days with no attendance record are not docked from pay unless the company enables "Deduct absent days from pay" in its attendance policy.

## Next phase (suggested order)

1. Production deployment on the VPS (`documentation/deployment/vps-deployment.md`).
2. MFA (TOTP) for Super Admin staff and company owners.
3. Expense claims linked to payroll adjustments, then asset management (both on existing patterns).
4. Recruitment and onboarding.
5. Performance reviews.
