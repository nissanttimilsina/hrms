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
  ['attendance', 'Attendance Management', 'Time', false],
  ['leave', 'Leave Management', 'Time', false],
  ['shifts', 'Shift Scheduling', 'Time', false],
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
const STANDARD = [...BASIC, 'payroll', 'shifts', 'recruitment', 'expenses', 'performance',
  'reports_advanced', 'document_expiry_alerts', 'workflows', 'onboarding'];
const PREMIUM = [...STANDARD, 'payroll_advanced', 'kpi_appraisal', 'training', 'assets',
  'analytics_advanced', 'multi_branch', 'custom_fields', 'workflows_advanced', 'api_integrations', 'helpdesk'];
const ENTERPRISE = FEATURES.filter((f) => !f[3]).map((f) => f[0]);

export const PLANS = [
  { code: 'BASIC', name: 'Basic', sortOrder: 1, maxEmployees: 20, maxBranches: 1, maxStorageMb: 2048,
    monthly: 1499, annual: 14990, features: BASIC,
    highlights: ['Up to 20 employees', '1 branch', 'Attendance & leave', 'Employee self-service', 'Basic reports'] },
  { code: 'STANDARD', name: 'Standard', sortOrder: 2, maxEmployees: 50, maxBranches: 2, maxStorageMb: 10240,
    monthly: 2999, annual: 29990, features: STANDARD,
    highlights: ['Up to 50 employees', '2 branches', 'Payroll', 'Shift scheduling', 'Recruitment', 'Custom approval workflows'] },
  { code: 'PREMIUM', name: 'Premium', sortOrder: 3, maxEmployees: 150, maxBranches: 5, maxStorageMb: 51200,
    monthly: 5999, annual: 59990, features: PREMIUM,
    highlights: ['Up to 150 employees', '5 branches', 'Advanced payroll', 'KPI & appraisal', 'Advanced analytics', 'API integrations'] },
  { code: 'ENTERPRISE', name: 'Enterprise', sortOrder: 4, maxEmployees: null, maxBranches: null, maxStorageMb: null,
    monthly: null, annual: null, features: ENTERPRISE, isCustom: true, contactSales: true, trialDays: 0,
    highlights: ['150+ employees', 'Custom capacity', 'Dedicated deployment option', 'Custom integrations', 'Dedicated account manager'] },
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
};
// Permissions that are not about records, so data scope does not apply.
const UNSCOPED = new Set(['users', 'roles', 'settings', 'subscription', 'audit', 'workflows']);

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
      'performance', 'training', 'assets', 'reports'], '*', 'COMPANY'),
    ...r(['users', 'roles'], ['view'], 'COMPANY'),
  ] },
  { key: 'hr_officer', name: 'HR Officer', grants: [
    ...r(['employees', 'documents'], ['view', 'create', 'edit', 'import', 'export'], 'COMPANY'),
    ...r(['attendance', 'leave'], ['view', 'create', 'edit'], 'COMPANY'),
    ...r(['recruitment'], ['view', 'create', 'edit'], 'COMPANY'),
    ...r(['branches', 'departments'], ['view'], 'COMPANY'),
  ] },
  { key: 'payroll_manager', name: 'Payroll Manager', grants: [
    ...r(['payroll'], '*', 'COMPANY'),
    ...r(['employees', 'attendance', 'leave', 'branches', 'departments'], ['view'], 'COMPANY'),
    ...r(['expenses'], ['view', 'approve', 'reject'], 'COMPANY'),
    ...r(['reports'], ['view', 'export'], 'COMPANY'),
  ] },
  { key: 'accountant', name: 'Accountant', grants: [
    ...r(['payroll'], ['view', 'export'], 'COMPANY'),
    ...r(['expenses'], '*', 'COMPANY'),
    ...r(['reports'], ['view', 'export'], 'COMPANY'),
    ...r(['employees'], ['view'], 'COMPANY'),
  ] },
  { key: 'department_manager', name: 'Department Manager', grants: [
    ...r(['employees'], ['view'], 'DEPARTMENT'),
    ...r(['attendance', 'leave', 'expenses'], ['view', 'approve', 'reject'], 'DEPARTMENT'),
    ...r(['performance'], ['view', 'edit', 'approve'], 'DEPARTMENT'),
    ...r(['reports'], ['view'], 'DEPARTMENT'),
  ] },
  { key: 'branch_manager', name: 'Branch Manager', grants: [
    ...r(['employees'], ['view'], 'BRANCH'),
    ...r(['attendance', 'leave', 'shifts', 'expenses'], ['view', 'approve', 'reject'], 'BRANCH'),
    ...r(['performance'], ['view', 'edit', 'approve'], 'BRANCH'),
    ...r(['reports'], ['view'], 'BRANCH'),
  ] },
  { key: 'team_leader', name: 'Team Leader', grants: [
    ...r(['employees'], ['view'], 'DIRECT_REPORTS'),
    ...r(['attendance', 'leave'], ['view', 'approve', 'reject'], 'DIRECT_REPORTS'),
    ...r(['performance'], ['view', 'edit'], 'DIRECT_REPORTS'),
  ] },
  { key: 'recruitment_officer', name: 'Recruitment Officer', grants: [
    ...r(['recruitment'], '*', 'COMPANY'),
    ...r(['employees'], ['create'], 'COMPANY'),
    ...r(['branches', 'departments'], ['view'], 'COMPANY'),
  ] },
  { key: 'employee', name: 'Employee', grants: [
    ...r(['employees', 'documents', 'payroll'], ['view'], 'OWN'),
    ...r(['attendance', 'leave', 'expenses'], ['view', 'create'], 'OWN'),
    ...r(['branches', 'departments'], ['view'], 'COMPANY'),
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
