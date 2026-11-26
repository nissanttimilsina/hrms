/**
 * Initial marketing content, inserted once (never overwrites admin edits).
 * Testimonials and customer logos are intentionally NOT seeded: they must be
 * real, permissioned customer statements added via the Super Admin CMS.
 * Legal pages are starting drafts and must be reviewed by Lishnu Tech's legal counsel.
 */
const faq = (slug, title, body, category) => ({ type: 'FAQ', slug, title, body, data: { category } });

export const CMS_DEFAULTS = [
  faq('free-trial', 'Is there a free trial?', 'Yes. Every self-service plan starts with a free trial. No payment details are needed to start. You can upgrade, change plans or cancel at any time from the Billing page.', 'Pricing'),
  faq('how-billing-works', 'How does billing work?', 'Plans are billed monthly or annually in NPR. Annual billing costs less than paying monthly for 12 months. Invoices include 13% VAT and can be downloaded as PDF. You can pay with eSewa, Khalti or bank transfer.', 'Pricing'),
  faq('upgrade-downgrade', 'Can I change my plan later?', 'Yes. Upgrades take effect immediately and you only pay the prorated difference for the rest of your billing period. Downgrades take effect at your next renewal, so you keep what you paid for.', 'Pricing'),
  faq('employee-limit', 'What happens when I reach my employee limit?', 'Your existing data keeps working. When you try to add more employees than your plan allows, you will be prompted to upgrade. Terminated employees do not count toward the limit.', 'Pricing'),
  faq('subscription-expires', 'What happens if my subscription expires?', 'You get a grace period with full access. After that your workspace becomes read-only: your data is never deleted, and you can renew at any time to continue.', 'Pricing'),
  faq('nepal-payroll', 'Does it support Nepal payroll rules?', 'Yes. Payroll supports Nepal income tax slabs, Social Security Fund (SSF), Provident Fund, Citizen Investment Trust and TDS. Rates are stored as versioned configuration, so a new fiscal year\'s rules can be applied without software changes. Always confirm statutory figures with your tax advisor.', 'Product'),
  faq('bikram-sambat', 'Can we use the Bikram Sambat calendar?', 'Yes. Dates can be displayed in Bikram Sambat (BS) or Gregorian (AD), and the financial year defaults to Shrawan–Ashadh.', 'Product'),
  faq('mobile', 'Can employees use it on their phones?', 'Yes. The employee self-service portal works on any phone and can be installed like an app. Employees can clock in and out, apply for leave, download payslips and see announcements.', 'Product'),
  faq('data-security', 'Is our data secure and private?', 'Each company\'s data is isolated at the database level, all traffic is encrypted with HTTPS, passwords are hashed with Argon2id, and every sensitive action is recorded in an audit log. See our Security page for details.', 'Security'),
  faq('data-ownership', 'Who owns our data? Can we export it?', 'You do. Administrators can export employee, attendance, leave and payroll data at any time. If you leave, we keep your data available for export for a retention period before deletion, as described in our Terms.', 'Security'),
  faq('migration', 'Can you help us move from spreadsheets or another system?', 'Yes. You can bulk-import employees from Excel/CSV, and our team assists Business and Enterprise customers with data migration.', 'Onboarding'),
  faq('custom-needs', 'We have special requirements. Can you customise it?', 'Many requirements are covered by configuration: custom fields, approval workflows, leave policies, shifts and roles. For larger needs, our Enterprise plan includes custom modules, integrations and dedicated deployments.', 'Onboarding'),

  {
    type: 'ANNOUNCEMENT', slug: 'launch', title: 'Now available: Lishnu HRMS for Nepali businesses',
    summary: 'Run payroll, attendance and leave from one place, with Nepal compliance built in.', data: { link: '/pricing', linkLabel: 'See plans' },
  },

  {
    type: 'PAGE', slug: 'privacy-policy', title: 'Privacy Policy',
    summary: 'How Lishnu Tech Pvt. Ltd. collects, uses and protects personal information.',
    data: { draft_notice: 'Draft — to be reviewed by legal counsel before publication.' },
    body: `**Last updated:** [date]

Lishnu Tech Pvt. Ltd. ("we", "us") operates Lishnu HRMS. This policy explains how we handle personal information.

## Two roles we play
- **For our customers' HR data** (employees, payroll, attendance), the customer company is the data controller and we process data on its instructions as a processor.
- **For our own customers and website visitors** (account owners, people who contact us), we are the controller.

## Information we collect
- Account and billing details: name, work email, phone, company name, PAN, billing address.
- HR data that customers enter into their workspace.
- Website enquiries: details you submit in contact, demo or quotation forms.
- Technical data: IP address, browser type and security logs.

## How we use it
To provide and secure the service, process payments, provide support, send service notices, and (only with consent) send product news. We do not sell personal information.

## Payments
Payments are processed by eSewa, Khalti or your bank. We do not store card or wallet credentials.

## Security
Data is encrypted in transit, isolated per company at the database level, access is role-based and audited, and backups are encrypted. See our Security page.

## Retention
Workspace data is kept while your subscription is active. After cancellation, data stays available for export for [90] days and is then deleted, except where the law requires us to keep records.

## Your rights
You may request access to, correction of or deletion of your personal information by writing to [privacy@yourhrms.com]. Employees of our customers should contact their employer first.

## Contact
Lishnu Tech Pvt. Ltd., Kathmandu, Nepal — [privacy@yourhrms.com]`,
  },
  {
    type: 'PAGE', slug: 'terms-of-service', title: 'Terms of Service',
    summary: 'The agreement between Lishnu Tech Pvt. Ltd. and customers using Lishnu HRMS.',
    data: { draft_notice: 'Draft — to be reviewed by legal counsel before publication.' },
    body: `**Last updated:** [date]

## 1. The service
Lishnu HRMS is a subscription software service provided by Lishnu Tech Pvt. Ltd.

## 2. Accounts
The person who registers a workspace confirms they are authorised to accept these terms for their company, and is responsible for keeping credentials secure and for the users they invite.

## 3. Subscriptions and payment
Plans, limits and prices are shown on our Pricing page. Fees are payable in advance, monthly or annually, and are exclusive of VAT unless stated. Upgrades are prorated. Downgrades apply at renewal. Unpaid subscriptions enter a grace period and then become read-only. Data is not deleted for non-payment during the retention period.

## 4. Customer data
You own your data. You are responsible for having a lawful basis to process your employees' personal information. We process it only to provide the service.

## 5. Acceptable use
You may not misuse the service, attempt to access other customers' data, or use it for unlawful purposes.

## 6. Payroll and compliance
The software calculates figures from the configuration you choose. You remain responsible for verifying statutory filings and payments with the relevant authorities.

## 7. Availability and support
We aim for high availability and provide support through the in-app help desk. Planned maintenance is announced in advance where possible.

## 8. Termination
You can cancel at any time; access continues until the end of the paid period. We may suspend accounts that breach these terms.

## 9. Liability
To the extent permitted by law, our total liability is limited to the fees paid in the 12 months before the claim.

## 10. Governing law
These terms are governed by the laws of Nepal. Courts of Kathmandu have jurisdiction.`,
  },
  {
    type: 'PAGE', slug: 'security', title: 'Security at Lishnu HRMS',
    summary: 'How we protect your company and employee data.',
    body: `## Isolation by design
Every company's records are separated by database-level row security, not just application checks. Automated tests verify that no workspace can read another's data.

## Encryption
All traffic uses HTTPS (TLS 1.2+), with HSTS enabled. Backups are encrypted.

## Access control
Twelve ready-made roles and custom roles, each with data scopes (own records, team, department, branch or company). Users cannot grant permissions they do not hold.

## Account protection
Passwords are hashed with Argon2id. Sessions use short-lived tokens with automatic rotation and theft detection. Accounts lock after repeated failed sign-ins.

## Audit trail
Sensitive actions such as payroll approvals, role changes and billing changes are recorded in an audit log that cannot be edited.

## Backups and recovery
Nightly encrypted backups, with restore drills run automatically to prove backups work.

## Payments
Online payments are confirmed directly with eSewa or Khalti servers before an invoice is marked paid.

## Report a vulnerability
Email [security@yourhrms.com]. We respond within two business days.`,
  },
];
