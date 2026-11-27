# Status & release readiness

_Last updated: 26 Nov 2026. Release candidate for the first production deployment. Includes the November requirements (four plans, subscription approval, biometric devices, working calendars, attendance-based payroll rules, loans, reports, notifications)._

## What ships

| Product | Scope |
|---|---|
| **Marketing website** (`www.`) | 53 prerendered, SEO-ready pages and a sitemap: home, 21 feature pages, 12 industry pages, pricing with a live calculator and comparison table, about, contact, demo request, customers, FAQ, help, status, blog, changelog, security and legal pages (from the CMS). Signup with email verification creates a live workspace. Demo and contact requests go to the CRM. Newsletter signup. Honest status flags: features not built yet are marked "Coming soon". |
| **Super Admin portal** (`admin.`) | Dashboard (MRR, signups, plan mix, requests to review). **Subscription requests queue**: approve with an invoice or immediate activation, negotiated Enterprise price, limit overrides and per-feature switches; or reject with a reason. Companies: detail, suspend/reactivate, plan changes, limit overrides, **force individual features on or off**, companies CSV export. Plans, prices and entitlements. Billing: invoices, payment approval, credit notes, coupons. Lead CRM with convert-to-tenant. Website CMS (FAQs, announcements, legal and blog pages). Support desk. Platform settings and staff roles. Audit log. |
| **Company HRMS** (`<company>.` / `app.`) | Role-aware dashboard (my day: clock-in, today's report, tasks by due date, performance score, feedback, leave; team: reports to review, missing reports, overdue and blocked tasks). **Work management** (all plans): projects; tasks with priority, due date, estimate, optional manager sign-off, list and board views, progress, comments and full activity trail; **daily work reports** linked to tasks (hours, progress, completion, challenges, next-day plan) that update the tasks on submit; manager **review with 1–5 rating, feedback or request for changes**; **performance** per employee (on-time delivery, report rate, average rating, punctuality, weekly trend); reminders for due/overdue tasks and missing reports. **Employee self-service extras**: expense claims with receipt photos (manager then finance approval, approve less with a reason, paid with salary as a non-taxable reimbursement or directly, category limits, duplicate check, CSV export); HR letters on request (employment, salary, experience, bank, no objection) as PDFs on the letterhead with a reference number and a public verification page; My tax (tax paid so far, full-year estimate, still to pay, monthly table, PDF statement); missed-punch requests the employee can cancel. Employees: lifecycle, history, CSV import/export, encrypted bank details, documents with expiry reminders, login invites. Organization (branches, departments, designations, shifts). Attendance: web/mobile clock-in with optional geofence, **biometric terminals** (ZKTeco ADMS push: device registry, employee ID mapping, sync and error logs, offline alerts), register, corrections. **Working calendars**: branch default schedules, different hours per weekday, special working days, branch holidays. **Attendance rules**: grace, early leave, half-day on short days, optional lateness and absence deductions. **Daily alerts** for late arrival, missing punches and repeated lateness. Leave: Labour Act 2074 defaults, ledger balances, multi-level approval, holidays, calendar. Nepal payroll: BS months, versioned tax rules for FY 2082/83 and 2083/84, SSF/PF/CIT, female rebate, **unpaid-day breakdown** (unpaid leave, absences, lateness rule), **salary advances and loans** recovered in instalments, **bonus, incentive, arrears, reimbursement and fine** items, **leave encashment**, maker-checker approval, locked runs, payslip PDFs, bank transfer, TDS and SSF reports. Reports: employee performance, task register, headcount and turnover, attendance, late & absences, leave use and balances, payroll cost, overtime & deductions, device activity, subscription usage; **PDF**, Excel and CSV export. Announcements and notifications. Users, roles and data scopes. Subscription and billing (eSewa, Khalti, bank transfer). Support tickets. Settings and audit log. Installable as a mobile app (PWA). |
| **Platform** | Multi-tenant PostgreSQL with forced row-level security and fail-closed tenant context. Argon2id passwords, rotating refresh tokens with reuse detection, RBAC with 151 permissions and 6 data scopes. Subscription states FULL / GRACE / READ_ONLY / BLOCKED enforced centrally. Background worker for the subscription lifecycle, task and daily-report reminders, renewal invoices, payment reconciliation, document expiry reminders, attendance alerts, device monitoring, trial/renewal and employee-limit notices, and email. |

## Verification

| Check | Result |
|---|---|
| Backend tests (`npm test`) | **208 passed, 0 failed** at `2e2bee8`. Stage 1 adds 14 tests in `self-service.test.js` that had not been run when the branch was pushed (see HANDOVER §3). Areas: auth, tenant isolation, RBAC, subscriptions, commercial/billing, subscription requests, HR, payroll, biometric devices, working calendar and attendance rules, reports and notices, employee deletion, tasks, daily reports, reviews and performance |
| Dependency audit (`npm audit --omit=dev`) | 0 vulnerabilities in backend and frontend |
| Browser end-to-end (Playwright, Chrome) | Marketing signup → email verification → active workspace. Demo request → CRM lead. Every admin portal page. Company app: sign-in, clock-in, employees, salary, payroll calculate with tax breakdown, billing, reports and Excel export, every page; mobile layout at 390 px. No console errors. |
| Production Nginx config | Rendered from the template and tested locally: host routing, apex→www, prerendered pages with shell fallback, `/api` proxy, CSP/HSTS headers, immutable asset caching, rate limits (verified 429). Correct HTTP status codes. |
| Production configuration | The filled `.env.example` passes the API's refuse-to-start checks; the unfilled template is rejected. |
| Backups | Backup → restore → verify drill tested (also runs in CI). The VPS kit adds encrypted nightly backups and a weekly restore drill. |
| Container images | **Not built in the development sandbox** (Docker Hub is blocked there). CI builds both images on every push, and the first VPS deploy builds them on the server. |

## Database

- 13 SQL migrations.
- Every tenant table uses forced row-level security.
- Composite tenant foreign keys.
- Append-only audit, history, leave-ledger and salary tables.
- Approved payroll is locked by database triggers.

## Features marked "Coming soon" on the website (not built)

Recruitment, onboarding/offboarding, formal performance appraisals (goals, appraisal cycles; day-to-day performance tracking from tasks and daily reports is built), asset management, training, workforce planning, HR helpdesk, employee engagement, AI HR assistant and custom workflows.

The plan comparison table lists them as plan entitlements. Each one appears in the product only when it is built, and its website status changes at the same time.

## Known limitations

1. **Legal pages are drafts.** Terms, Privacy and Refund policy are seeded as drafts for review by Nepali counsel before publishing.
2. **Statutory figures need yearly review.** Tax slabs, SSF rates and leave entitlements are stored as versioned data, not code. Check them against each Finance Act (every Shrawan) under Super Admin and payroll setup.
3. **Live payments are untested against production gateways.** eSewa and Khalti are integrated and tested against the documented APIs with sandbox semantics. Make one small live transaction of each before announcing them. Launching with bank transfer only is supported.
4. **No MFA yet.** The database columns exist, but the login flow does not use them.
5. **Custom domains** (a company's own domain instead of a subdomain) are not offered. Workspaces use `<slug>.<domain>`.
6. **Biometric devices: confirm with one real terminal at go-live.** The ADMS receiver is built to the published protocol and tested with simulated terminals. Older firmwares vary slightly, so register one real device first and check its sync log. Devices from vendors without ADMS push (pull-only SDKs) are not supported.
7. **Absence deduction is off by default.** Days with no attendance record are not docked from pay unless the company enables "Deduct absent days from pay" in its attendance policy.

## Next phase (suggested order)

1. Production deployment on the VPS (`documentation/deployment/vps-deployment.md`).
2. MFA (TOTP) for Super Admin staff and company owners.
3. Expense claims linked to payroll pay items, then asset management (both on existing patterns).
4. Recruitment and onboarding.
5. Performance reviews.
