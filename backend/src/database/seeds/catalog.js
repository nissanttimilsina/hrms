/**
 * Reference catalogue seeded into the database.
 *
 * IMPORTANT: Nothing here is read by request-handling code. The API reads
 * plans, prices, entitlements and permissions from the DATABASE. These values
 * are only the initial defaults; the seed never overwrites rows that already
 * exist, so Super Admin edits are preserved across deploys.
 */

// --------------------------------------------------------------------------- features (modules)
export const FEATURES = [
  // key, name, category, isCore
  ['organization', 'Organization Management', 'Core HR', true],
  ['employees', 'Employee Management', 'Core HR', true],
  ['ess', 'Employee Self-Service', 'Core HR', true],
  ['documents', 'Document Records', 'Core HR', true],
  ['reports', 'Basic Reports', 'Analytics', true],
  ['tasks', 'Tasks & Daily Work Reports', 'Core HR', true],
  ['attendance', 'Attendance Management', 'Time', false],
  ['leave', 'Leave Management', 'Time', false],
  ['shifts', 'Shift Scheduling', 'Time', false],
  ['biometric', 'Biometric Device Integration', 'Time', false],
  ['payroll', 'Payroll Management', 'Payroll', false],
  ['payroll_advanced', 'Advanced Payroll', 'Payroll', false],
  ['expenses', 'Expense Management', 'Finance', false],
  ['recruitment', 'Recruitment', 'Talent', false],
  ['onboarding', 'Onboarding & Offboarding', 'Talent', false],
  ['performance', 'Performance Tracking', 'Talent', false],
  ['kpi_appraisal', 'KPI & Performance Appraisal', 'Talent', false],
  ['training', 'Training & Development', 'Talent', false],
  ['assets', 'Asset Management', 'Operations', false],
  ['helpdesk', 'Employee Helpdesk', 'Operations', false],
  ['engagement', 'Employee Engagement', 'Operations', false],
  ['reports_advanced', 'Advanced Reports', 'Analytics', false],
  ['analytics_advanced', 'Advanced HR Analytics', 'Analytics', false],
  ['workforce_planning', 'Workforce Planning', 'Analytics', false],
  ['document_expiry_alerts', 'Document Expiry Notifications', 'Core HR', false],
  ['multi_branch', 'Multi-branch Workforce Management', 'Organization', false],
  ['custom_fields', 'Custom Fields', 'Customization', false],
  ['workflows', 'Custom Approval Workflows', 'Customization', false],
  ['workflows_advanced', 'Advanced Workflows', 'Customization', false],
  ['api_integrations', 'API Integrations', 'Platform', false],
  ['ai_assistant', 'AI HR Assistant', 'Platform', false],
];

// --------------------------------------------------------------------------- plans (initial defaults)
const BASIC = ['attendance', 'leave'];
const PROFESSIONAL = [...BASIC, 'payroll', 'shifts', 'biometric', 'recruitment', 'expenses', 'performance',
  'reports_advanced', 'document_expiry_alerts', 'workflows', 'onboarding'];
const BUSINESS = [...PROFESSIONAL, 'payroll_advanced', 'kpi_appraisal', 'training', 'assets',
  'analytics_advanced', 'multi_branch', 'custom_fields', 'workflows_advanced', 'api_integrations', 'helpdesk',
  'engagement', 'workforce_planning'];
const ENTERPRISE = FEATURES.filter((f) => !f[3]).map((f) => f[0]);

export const PLANS = [
  { code: 'BASIC', name: 'Basic', sortOrder: 1, maxEmployees: 20, maxBranches: 1, maxStorageMb: 2048,
    monthly: 1499, annual: 14990, features: BASIC,
    highlights: ['Up to 20 employees', '1 branch', 'Web & mobile attendance', 'Leave management', 'Employee self-service', 'On-screen reports'] },
  { code: 'PROFESSIONAL', name: 'Professional', sortOrder: 2, maxEmployees: 50, maxBranches: 2, maxStorageMb: 10240,
    monthly: 2999, annual: 29990, features: PROFESSIONAL,
    highlights: ['Up to 50 employees', '2 branches', 'Nepal payroll (tax, SSF, PF, CIT)', 'Biometric devices', 'Shift schedules', 'PDF/Excel export & document alerts'] },
  { code: 'BUSINESS', name: 'Business', sortOrder: 3, maxEmployees: 150, maxBranches: 5, maxStorageMb: 51200,
    monthly: 5999, annual: 59990, features: BUSINESS,
    highlights: ['Up to 150 employees', '5 branches', '50 GB document storage', 'Everything in Professional', 'Upcoming modules included as they launch'] },
  { code: 'ENTERPRISE', name: 'Enterprise', sortOrder: 4, maxEmployees: null, maxBranches: null, maxStorageMb: null,
    monthly: null, annual: null, features: ENTERPRISE, isCustom: true, contactSales: true, trialDays: 0,
    highlights: ['150+ employees', 'Negotiated limits and price', 'Features enabled to your needs', 'Dedicated deployment on request', 'Dedicated onboarding'] },
];

// --------------------------------------------------------------------------- tenant permissions
const ALL = ['view', 'create', 'edit', 'delete', 'approve', 'reject', 'export', 'import', 'configure', 'manage'];
const CRUD = ['view', 'create', 'edit', 'delete', 'export', 'import'];

// resource -> { module (feature key or non-feature admin area), actions }
export const RESOURCES = {
  branches: { module: 'organization', actions: [...CRUD, 'configure'] },
  departments: { module: 'organization', actions: [...CRUD, 'configure'] },
  employees: { module: 'employees', actions: [...CRUD, 'manage'] },
  users: { module: 'users', actions: ['view', 'create', 'edit', 'delete', 'manage'] },
  roles: { module: 'roles', actions: ['view', 'create', 'edit', 'delete', 'manage'] },
  settings: { module: 'settings', actions: ['view', 'configure'] },
  subscription: { module: 'subscription', actions: ['view', 'manage'] },
  audit: { module: 'audit', actions: ['view', 'export'] },
  documents: { module: 'documents', actions: CRUD },
  attendance: { module: 'attendance', actions: ALL },
  devices: { module: 'biometric', actions: ['view', 'manage'] },
  leave: { module: 'leave', actions: ALL },
  shifts: { module: 'shifts', actions: ALL },
  payroll: { module: 'payroll', actions: ALL },
  expenses: { module: 'expenses', actions: ALL },
  recruitment: { module: 'recruitment', actions: ALL },
  performance: { module: 'performance', actions: ALL },
  training: { module: 'training', actions: ALL },
  assets: { module: 'assets', actions: ALL },
  reports: { module: 'reports', actions: ['view', 'export', 'configure'] },
  workflows: { module: 'workflows', actions: ['view', 'create', 'edit', 'delete', 'configure'] },
  support: { module: 'support', actions: ['view', 'create'] },
  holidays: { module: 'leave', actions: ['view', 'create', 'edit', 'delete'] },
  announcements: { module: 'ess', actions: ['view', 'create', 'edit', 'delete'] },
  // Work management. tasks: scope = whose tasks (by assignee). work_reports: approve = review and rate.
  tasks: { module: 'tasks', actions: ['view', 'create', 'edit', 'delete', 'export'] },
  work_reports: { module: 'tasks', actions: ['view', 'create', 'approve', 'export'] },
  projects: { module: 'tasks', actions: ['view', 'create', 'edit', 'delete'] },
  // HR letters (employment, salary, experience…). approve = issue or reject; configure = letterhead.
  letters: { module: 'ess', actions: ['view', 'create', 'approve', 'configure'] },
  // Onboarding and offboarding journeys (scope = whose journey). edit = tick off tasks; manage = start/complete/cancel.
  onboarding: { module: 'onboarding', actions: ['view', 'edit', 'manage', 'configure'] },
  // HR helpdesk. create = raise a ticket; manage = work tickets (reply, assign, internal notes); configure = categories.
  helpdesk: { module: 'helpdesk', actions: ['view', 'create', 'manage', 'configure', 'export'] },
  // Goals and appraisals. edit = goals and reviews; approve = finalise/calibrate; configure = cycles.
  appraisals: { module: 'kpi_appraisal', actions: ['view', 'create', 'edit', 'approve', 'configure', 'export'] },
  // Surveys and recognition. view = take surveys, see recognition; create = give recognition; manage = surveys and results.
  engagement: { module: 'engagement', actions: ['view', 'create', 'manage'] },
  // Headcount plans and plan-versus-actual.
  workforce: { module: 'workforce_planning', actions: ['view', 'edit', 'approve'] },
  // Requests made through custom workflows (forms set up under workflows:configure).
  requests: { module: 'workflows', actions: ['view', 'create', 'export'] },
};
// Permissions that are not about records, so data scope does not apply.
const UNSCOPED = new Set(['users', 'roles', 'settings', 'subscription', 'audit', 'workflows', 'support', 'holidays', 'announcements', 'projects', 'workforce']);

export const PERMISSIONS = Object.entries(RESOURCES).flatMap(([resource, { module, actions }]) =>
  actions.map((action) => ({
    key: `${resource}:${action}`,
    module,
    action,
    supportsScope: !UNSCOPED.has(resource),
  })),
);

// --------------------------------------------------------------------------- default tenant roles
// grants: [resourceOrStar, actionsOrStar, scope]
const every = (scope) => [['*', '*', scope]];
const r = (resources, actions, scope) => resources.map((res) => [res, actions, scope]);

export const DEFAULT_ROLES = [
  { key: 'company_owner', name: 'Company Owner', grants: every('COMPANY') },
  { key: 'company_admin', name: 'Company Administrator', grants: every('COMPANY') },
  { key: 'hr_manager', name: 'HR Manager', grants: [
    ...r(['branches', 'departments', 'employees', 'documents', 'attendance', 'leave', 'shifts', 'recruitment',
      'performance', 'training', 'assets', 'reports', 'holidays', 'announcements', 'devices', 'tasks', 'work_reports', 'projects', 'letters',
      'onboarding', 'helpdesk', 'appraisals', 'engagement', 'workforce', 'workflows', 'requests'], '*', 'COMPANY'),
    ...r(['users', 'roles'], ['view'], 'COMPANY'),
    ...r(['support'], ['view', 'create'], 'COMPANY'),
  ] },
  { key: 'hr_officer', name: 'HR Officer', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['employees', 'documents'], ['view', 'create', 'edit', 'import', 'export'], 'COMPANY'),
    ...r(['attendance', 'leave'], ['view', 'create', 'edit'], 'COMPANY'),
    ...r(['recruitment'], ['view', 'create', 'edit'], 'COMPANY'),
    ...r(['branches', 'departments'], ['view'], 'COMPANY'),
    ...r(['letters'], ['view', 'approve'], 'COMPANY'),
    ...r(['onboarding'], ['view', 'edit', 'manage'], 'COMPANY'),
    ...r(['helpdesk'], ['view', 'manage'], 'COMPANY'),
    ...r(['assets'], ['view'], 'COMPANY'),
    ...r(['training'], ['view', 'create', 'edit'], 'COMPANY'),
    ...r(['engagement'], ['view', 'create'], 'COMPANY'),
    ...r(['requests'], ['view', 'create'], 'OWN'),
  ] },
  { key: 'payroll_manager', name: 'Payroll Manager', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['payroll'], '*', 'COMPANY'),
    ...r(['employees', 'attendance', 'leave', 'branches', 'departments'], ['view'], 'COMPANY'),
    ...r(['expenses'], ['view', 'approve', 'reject'], 'COMPANY'),
    ...r(['reports'], ['view', 'export'], 'COMPANY'),
  ] },
  { key: 'accountant', name: 'Accountant', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['payroll'], ['view', 'export'], 'COMPANY'),
    ...r(['expenses'], '*', 'COMPANY'),
    ...r(['reports'], ['view', 'export'], 'COMPANY'),
    ...r(['employees'], ['view'], 'COMPANY'),
    ...r(['subscription'], ['view'], 'COMPANY'),
  ] },
  { key: 'department_manager', name: 'Department Manager', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['employees'], ['view'], 'DEPARTMENT'),
    ...r(['attendance', 'leave', 'expenses'], ['view', 'approve', 'reject'], 'DEPARTMENT'),
    ...r(['performance'], ['view', 'edit', 'approve'], 'DEPARTMENT'),
    ...r(['assets', 'onboarding'], ['view'], 'DEPARTMENT'),
    ...r(['onboarding'], ['edit'], 'DEPARTMENT'),
    ...r(['training'], ['view', 'create', 'approve'], 'DEPARTMENT'),
    ...r(['appraisals'], ['view', 'create', 'edit'], 'DEPARTMENT'),
    ...r(['requests'], ['view'], 'DEPARTMENT'),
    ...r(['workforce'], ['view'], 'COMPANY'),
    ...r(['reports'], ['view'], 'DEPARTMENT'),
    ...r(['tasks'], '*', 'DEPARTMENT'),
    ...r(['work_reports'], ['view', 'approve', 'export'], 'DEPARTMENT'),
    ...r(['projects'], ['view', 'create', 'edit'], 'COMPANY'),
  ] },
  { key: 'branch_manager', name: 'Branch Manager', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['employees'], ['view'], 'BRANCH'),
    ...r(['attendance', 'leave', 'shifts', 'expenses'], ['view', 'approve', 'reject'], 'BRANCH'),
    ...r(['performance'], ['view', 'edit', 'approve'], 'BRANCH'),
    ...r(['assets', 'onboarding'], ['view'], 'BRANCH'),
    ...r(['onboarding'], ['edit'], 'BRANCH'),
    ...r(['training'], ['view', 'create', 'approve'], 'BRANCH'),
    ...r(['appraisals'], ['view', 'create', 'edit'], 'BRANCH'),
    ...r(['requests'], ['view'], 'BRANCH'),
    ...r(['workforce'], ['view'], 'COMPANY'),
    ...r(['reports'], ['view'], 'BRANCH'),
    ...r(['tasks'], '*', 'BRANCH'),
    ...r(['work_reports'], ['view', 'approve', 'export'], 'BRANCH'),
    ...r(['projects'], ['view', 'create', 'edit'], 'COMPANY'),
  ] },
  { key: 'team_leader', name: 'Team Leader', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['employees'], ['view'], 'DIRECT_REPORTS'),
    ...r(['attendance', 'leave'], ['view', 'approve', 'reject'], 'DIRECT_REPORTS'),
    ...r(['performance'], ['view', 'edit'], 'DIRECT_REPORTS'),
    ...r(['expenses'], ['view', 'approve', 'reject'], 'DIRECT_REPORTS'),
    ...r(['assets', 'onboarding'], ['view'], 'DIRECT_REPORTS'),
    ...r(['onboarding'], ['edit'], 'DIRECT_REPORTS'),
    ...r(['training'], ['view', 'create', 'approve'], 'DIRECT_REPORTS'),
    ...r(['appraisals'], ['view', 'create', 'edit'], 'DIRECT_REPORTS'),
    ...r(['requests'], ['view'], 'DIRECT_REPORTS'),
    ...r(['tasks'], ['view', 'create', 'edit', 'delete'], 'DIRECT_REPORTS'),
    ...r(['work_reports'], ['view', 'approve'], 'DIRECT_REPORTS'),
    ...r(['projects'], ['view', 'create'], 'COMPANY'),
  ] },
  { key: 'recruitment_officer', name: 'Recruitment Officer', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['recruitment'], '*', 'COMPANY'),
    ...r(['employees'], ['create'], 'COMPANY'),
    ...r(['branches', 'departments'], ['view'], 'COMPANY'),
  ] },
  { key: 'employee', name: 'Employee', grants: [
    ...r(['holidays', 'announcements'], ['view'], 'COMPANY'),
    ...r(['employees', 'documents', 'payroll'], ['view'], 'OWN'),
    ...r(['attendance', 'leave', 'expenses'], ['view', 'create'], 'OWN'),
    ...r(['branches', 'departments'], ['view'], 'COMPANY'),
    ...r(['tasks'], ['view', 'create', 'edit'], 'OWN'),
    ...r(['work_reports'], ['view', 'create'], 'OWN'),
    ...r(['projects'], ['view'], 'COMPANY'),
    ...r(['letters'], ['view', 'create'], 'OWN'),
    ...r(['assets', 'onboarding'], ['view'], 'OWN'),
    ...r(['onboarding'], ['edit'], 'OWN'),
    ...r(['helpdesk'], ['view', 'create'], 'OWN'),
    ...r(['training'], ['view', 'create'], 'OWN'),
    ...r(['appraisals'], ['view', 'edit'], 'OWN'),
    ...r(['engagement'], ['view', 'create'], 'COMPANY'),
    ...r(['requests'], ['view', 'create'], 'OWN'),
  ] },
  { key: 'auditor', name: 'Auditor', grants: [
    ...r(Object.keys(RESOURCES), ['view', 'export'], 'COMPANY'),
  ] },
];

// --------------------------------------------------------------------------- platform (Lishnu Tech) RBAC
export const PLATFORM_PERMISSIONS = [
  'tenants:view', 'tenants:manage', 'plans:view', 'plans:manage', 'subscriptions:view', 'subscriptions:manage',
  'billing:view', 'billing:manage', 'crm:view', 'crm:manage', 'cms:manage', 'support:view', 'support:manage',
  'platform_users:manage', 'settings:manage', 'audit:view', 'system:manage',
];

export const PLATFORM_ROLES = [
  { key: 'super_admin', name: 'Super Admin', perms: PLATFORM_PERMISSIONS },
  { key: 'platform_admin', name: 'Platform Admin', perms: ['tenants:view', 'tenants:manage', 'plans:view',
    'subscriptions:view', 'subscriptions:manage', 'support:view', 'audit:view'] },
  { key: 'finance_admin', name: 'Finance Admin', perms: ['tenants:view', 'plans:view', 'subscriptions:view',
    'subscriptions:manage', 'billing:view', 'billing:manage'] },
  { key: 'sales_admin', name: 'Sales Admin', perms: ['tenants:view', 'plans:view', 'crm:view', 'crm:manage', 'subscriptions:view'] },
  { key: 'marketing_admin', name: 'Marketing Admin', perms: ['cms:manage', 'plans:view', 'crm:view'] },
  { key: 'support_admin', name: 'Support Admin', perms: ['tenants:view', 'support:view', 'support:manage', 'subscriptions:view'] },
  { key: 'technical_admin', name: 'Technical Admin', perms: ['tenants:view', 'system:manage', 'audit:view', 'support:view'] },
];

// --------------------------------------------------------------------------- statutory payroll rules (Nepal)
// Mirrors migration 006. Re-verify every fiscal year; newer years are added by Super Admin or a new release.
const common = { sstWaivedForSsf: true, femaleRebatePercent: 10, retirementDeduction: { maxAmount: 500000, maxFraction: 0.3333 }, ssf: { employeePercent: 11, employerPercent: 20 }, insurance: { lifeMax: 40000, healthMax: 20000 }, overtimeMultiplier: 1.5 };
const unified2083 = [{ upTo: 1000000, rate: 1, sst: true }, { upTo: 1500000, rate: 10 }, { upTo: 2500000, rate: 20 }, { upTo: 4000000, rate: 27 }, { upTo: null, rate: 29 }];
export const TAX_RULE_SETS = [
  { fiscalYear: '2082/83', effectiveFrom: '2025-07-17', effectiveTo: '2026-07-16', sourceNote: 'Finance Act 2082: separate single/married schedules, top rate 39%.', rules: { ...common, slabs: {
    SINGLE: [{ upTo: 500000, rate: 1, sst: true }, { upTo: 700000, rate: 10 }, { upTo: 1000000, rate: 20 }, { upTo: 2000000, rate: 30 }, { upTo: 5000000, rate: 36 }, { upTo: null, rate: 39 }],
    MARRIED: [{ upTo: 600000, rate: 1, sst: true }, { upTo: 800000, rate: 10 }, { upTo: 1100000, rate: 20 }, { upTo: 2000000, rate: 30 }, { upTo: 5000000, rate: 36 }, { upTo: null, rate: 39 }] } } },
  { fiscalYear: '2083/84', effectiveFrom: '2026-07-17', effectiveTo: '2027-07-16', sourceNote: 'Finance Act 2083: unified schedule for individuals and couples, 1% band to Rs 10 lakh, top rate 29%.', rules: { ...common, slabs: { SINGLE: unified2083, MARRIED: unified2083 } } },
];
