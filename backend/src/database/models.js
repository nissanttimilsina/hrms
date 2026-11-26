import { DataTypes } from 'sequelize';

/**
 * Model definitions. The schema itself is owned by SQL migrations; models only
 * map columns. defineModels() is called once per connection pool (app/system)
 * so each pool has its own bound model set.
 */
const id = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantId = { type: DataTypes.UUID, allowNull: false };
const opts = (tableName, extra = {}) => ({ tableName, underscored: true, timestamps: true, ...extra });
const noTs = (tableName) => opts(tableName, { timestamps: false });
const createdOnly = (tableName) => opts(tableName, { updatedAt: false });

export function defineModels(sequelize) {
  const S = DataTypes.STRING;
  const T = DataTypes.TEXT;
  const B = DataTypes.BOOLEAN;
  const D = DataTypes.DATE;
  const J = DataTypes.JSONB;
  const I = DataTypes.INTEGER;
  const U = DataTypes.UUID;
  const M = DataTypes.DECIMAL(14, 2);

  // ---------------------------------------------------------------- platform
  const PlatformUser = sequelize.define('PlatformUser', {
    id, email: S, passwordHash: T, fullName: S, status: S, mfaSecretEnc: T,
    failedLogins: I, lockedUntil: D, lastLoginAt: D,
  }, opts('platform_users'));

  const PlatformRole = sequelize.define('PlatformRole', {
    id, key: S, name: S, description: T, isSystem: B,
  }, noTs('platform_roles'));

  const PlatformPermission = sequelize.define('PlatformPermission', { id, key: S, description: T }, noTs('platform_permissions'));

  const PlatformRolePermission = sequelize.define('PlatformRolePermission', {
    roleId: { type: U, primaryKey: true }, permissionId: { type: U, primaryKey: true },
  }, noTs('platform_role_permissions'));

  const PlatformUserRole = sequelize.define('PlatformUserRole', {
    userId: { type: U, primaryKey: true }, roleId: { type: U, primaryKey: true },
  }, noTs('platform_user_roles'));

  const AuthSession = sequelize.define('AuthSession', {
    id, subjectType: S, userId: U, tenantId: U, familyId: U, tokenHash: S, expiresAt: D,
    revokedAt: D, revokeReason: S, replacedById: U, userAgent: T, ip: S, lastUsedAt: D,
  }, createdOnly('auth_sessions'));

  const AuthActionToken = sequelize.define('AuthActionToken', {
    id, subjectType: S, userId: U, tenantId: U, purpose: S, tokenHash: S, expiresAt: D, usedAt: D,
  }, createdOnly('auth_action_tokens'));

  // ---------------------------------------------------------------- tenancy
  const Tenant = sequelize.define('Tenant', {
    id, slug: S, name: S, legalName: S, status: S, industry: S, country: S, timezone: S,
    currency: S, locale: S, calendar: S, deploymentMode: S, dedicatedDbRef: S,
    suspendedReason: T, archivedAt: D, retentionUntil: D,
  }, opts('tenants'));

  const TenantDomain = sequelize.define('TenantDomain', {
    id, tenantId, hostname: S, type: S, isPrimary: B, verificationToken: S, verifiedAt: D,
  }, createdOnly('tenant_domains'));

  const TenantSetting = sequelize.define('TenantSetting', { id, tenantId, key: S, value: J }, opts('tenant_settings', { createdAt: false }));

  // ---------------------------------------------------------------- organisation
  const Branch = sequelize.define('Branch', {
    id, tenantId, code: S, name: S, address: T, isHeadOffice: B, isActive: B, deletedAt: D,
  }, opts('branches'));

  const Department = sequelize.define('Department', {
    id, tenantId, branchId: U, parentId: U, code: S, name: S, deletedAt: D,
  }, opts('departments'));

  const Employee = sequelize.define('Employee', {
    id, tenantId, employeeCode: S, firstName: S, lastName: S, workEmail: S, phone: S,
    branchId: U, departmentId: U, managerId: U, status: S,
    joinedOn: DataTypes.DATEONLY, exitedOn: DataTypes.DATEONLY, deletedAt: D,
    designationId: U, shiftId: U, employmentType: S, dateOfBirth: DataTypes.DATEONLY, gender: S, maritalStatus: S,
    personalEmail: S, pan: S, ssfId: S, citizenshipNo: S, address: J, emergencyContacts: J, bank: J,
    contractEndOn: DataTypes.DATEONLY, probationEndOn: DataTypes.DATEONLY, photoFileId: U, customFields: J,
  }, opts('employees'));

  // ---------------------------------------------------------------- users & RBAC
  const User = sequelize.define('User', {
    id, tenantId, email: S, passwordHash: T, fullName: S, status: S, employeeId: U,
    emailVerifiedAt: D, mfaSecretEnc: T, failedLogins: I, lockedUntil: D, lastLoginAt: D,
  }, opts('users'));

  const Permission = sequelize.define('Permission', {
    id, key: S, module: S, action: S, description: T, supportsScope: B,
  }, noTs('permissions'));

  const Role = sequelize.define('Role', { id, tenantId, key: S, name: S, description: T, isSystem: B }, opts('roles'));

  const RolePermission = sequelize.define('RolePermission', {
    id, tenantId, roleId: U, permissionId: U, scope: S, branchIds: DataTypes.ARRAY(DataTypes.UUID),
  }, noTs('role_permissions'));

  const UserRole = sequelize.define('UserRole', {
    tenantId, userId: { type: U, primaryKey: true }, roleId: { type: U, primaryKey: true },
  }, noTs('user_roles'));

  const TenantInvitation = sequelize.define('TenantInvitation', {
    id, tenantId, email: S, roleId: U, tokenHash: S, invitedById: U, expiresAt: D, acceptedAt: D,
  }, createdOnly('tenant_invitations'));

  // ---------------------------------------------------------------- subscriptions
  const FeatureCatalog = sequelize.define('FeatureCatalog', {
    id, key: S, name: S, category: S, description: T, isCore: B, sortOrder: I,
  }, noTs('feature_catalog'));

  const Plan = sequelize.define('Plan', {
    id, code: S, name: S, description: T, status: S, isPublic: B, isCustom: B, contactSales: B,
    sortOrder: I, trialDays: I, graceDays: I, maxEmployees: I, maxBranches: I, maxUsers: I,
    maxStorageMb: I, highlights: J,
  }, opts('plans'));

  const PlanPrice = sequelize.define('PlanPrice', {
    id, planId: U, billingCycle: S, currency: S, amount: M, effectiveFrom: D, effectiveTo: D,
  }, createdOnly('plan_prices'));

  const PlanEntitlement = sequelize.define('PlanEntitlement', {
    id, planId: U, featureId: U, enabled: B, config: J,
  }, noTs('plan_entitlements'));

  const Subscription = sequelize.define('Subscription', {
    id, tenantId, planId: U, previousPlanId: U, pendingPlanId: U, status: S, billingCycle: S,
    currency: S, amount: M, discountAmount: M, taxAmount: M, paymentStatus: S, autoRenew: B,
    startsAt: D, trialEndsAt: D, currentPeriodEnd: D, graceEndsAt: D, cancelledAt: D,
    maxEmployeesOverride: I, maxBranchesOverride: I,
  }, opts('subscriptions'));

  const SubscriptionItem = sequelize.define('SubscriptionItem', {
    id, tenantId, subscriptionId: U, type: S, featureKey: S, quantity: I, unitAmount: M,
  }, createdOnly('subscription_items'));

  const SubscriptionEvent = sequelize.define('SubscriptionEvent', {
    id, tenantId, subscriptionId: U, type: S, fromStatus: S, toStatus: S, payload: J, actorType: S, actorId: U,
  }, createdOnly('subscription_events'));

  const SubscriptionUsage = sequelize.define('SubscriptionUsage', {
    id, tenantId, metric: S, value: DataTypes.BIGINT,
  }, opts('subscription_usage', { createdAt: false }));

  // ---------------------------------------------------------------- audit
  const AuditLog = sequelize.define('AuditLog', {
    id, tenantId: U, actorType: S, actorId: U, action: S, entityType: S, entityId: S,
    before: J, after: J, ip: S, userAgent: T, requestId: S,
  }, createdOnly('audit_logs'));

  // ---------------------------------------------------------------- commercial (004)
  const PlatformSetting = sequelize.define('PlatformSetting', { key: { type: S, primaryKey: true }, value: J }, opts('platform_settings', { createdAt: false }));
  const Lead = sequelize.define('Lead', {
    id, source: S, status: S, name: S, company: S, email: S, phone: S, industry: S, employeeCount: I, branchCount: I,
    modules: DataTypes.ARRAY(DataTypes.TEXT), interestedPlan: S, message: T, preferredAt: D, demoAt: D, followUpAt: D,
    assignedTo: U, estimatedValue: M, lostReason: T, convertedTenantId: U, utm: J, ip: S,
  }, opts('leads'));
  const LeadActivity = sequelize.define('LeadActivity', { id, leadId: U, type: S, body: T, meta: J, actorId: U }, createdOnly('lead_activities'));
  const NewsletterSubscriber = sequelize.define('NewsletterSubscriber', { id, email: S, unsubscribedAt: D }, createdOnly('newsletter_subscribers'));
  const CmsEntry = sequelize.define('CmsEntry', {
    id, type: S, slug: S, locale: S, title: S, summary: T, body: T, data: J, seo: J, status: S, publishAt: D, sortOrder: I, authorId: U,
  }, opts('cms_entries'));
  const Coupon = sequelize.define('Coupon', {
    id, code: S, description: T, percentOff: DataTypes.DECIMAL(5, 2), amountOff: M, planCodes: DataTypes.ARRAY(DataTypes.TEXT),
    billingCycles: DataTypes.ARRAY(DataTypes.TEXT), validFrom: D, validUntil: D, maxRedemptions: I, redemptions: I, isActive: B,
  }, createdOnly('coupons'));
  const Invoice = sequelize.define('Invoice', {
    id, tenantId, subscriptionId: U, number: S, status: S, kind: S, currency: S, subtotal: M, discount: M,
    taxRate: DataTypes.DECIMAL(5, 2), tax: M, total: M, couponCode: S, targetPlanId: U, targetCycle: S, periodStart: D, periodEnd: D,
    billTo: J, issuedAt: D, dueAt: D, paidAt: D, voidedAt: D, voidReason: T, relatedInvoiceId: U,
  }, opts('invoices'));
  const InvoiceItem = sequelize.define('InvoiceItem', {
    id, tenantId, invoiceId: U, description: T, quantity: DataTypes.DECIMAL(10, 2), unitAmount: M, amount: M,
  }, noTs('invoice_items'));
  const Payment = sequelize.define('Payment', {
    id, tenantId, invoiceId: U, provider: S, status: S, amount: M, currency: S, reference: S, providerRef: S,
    providerData: J, proofNote: T, failureReason: T, verifiedBy: U, verifiedAt: D,
  }, opts('payments'));
  const SupportTicket = sequelize.define('SupportTicket', {
    id, tenantId, number: { type: DataTypes.BIGINT, autoIncrement: true }, subject: S, category: S, priority: S, status: S,
    createdBy: U, assignedTo: U, firstResponseDueAt: D, firstRespondedAt: D, resolvedAt: D, satisfaction: I,
  }, opts('support_tickets'));
  const SupportMessage = sequelize.define('SupportMessage', {
    id, tenantId, ticketId: U, authorType: S, authorId: U, body: T, isInternal: B,
  }, createdOnly('support_messages'));

  // ---------------------------------------------------------------- HRMS core (005)
  const DO = DataTypes.DATEONLY;
  const N = DataTypes.DECIMAL(6, 1);
  const Designation = sequelize.define('Designation', { id, tenantId, name: S, level: I, deletedAt: D }, opts('designations'));
  const Shift = sequelize.define('Shift', {
    id, tenantId, name: S, startTime: DataTypes.TIME, endTime: DataTypes.TIME, breakMinutes: I, graceMinutes: I,
    weeklyOffs: DataTypes.ARRAY(DataTypes.TEXT), isDefault: B, deletedAt: D,
  }, opts('shifts'));
  const EmployeeHistory = sequelize.define('EmployeeHistory', {
    id, tenantId, employeeId: U, type: S, effectiveOn: DO, fromValue: J, toValue: J, note: T, actorId: U,
  }, createdOnly('employee_history'));
  const File = sequelize.define('File', {
    id, tenantId, ownerType: S, ownerId: U, storageKey: S, filename: S, mimeType: S, sizeBytes: DataTypes.BIGINT,
    sha256: S, category: S, expiresOn: DO, uploadedBy: U, deletedAt: D,
  }, createdOnly('files'));
  const AttendanceRecord = sequelize.define('AttendanceRecord', {
    id, tenantId, employeeId: U, workDate: DO, clockIn: D, clockOut: D, inMeta: J, outMeta: J, status: S,
    lateMinutes: I, earlyMinutes: I, workedMinutes: I, overtimeMinutes: I, source: S, note: T,
  }, opts('attendance_records'));
  const AttendanceCorrection = sequelize.define('AttendanceCorrection', {
    id, tenantId, employeeId: U, workDate: DO, clockIn: D, clockOut: D, reason: T, status: S, requestedBy: U,
    reviewedBy: U, reviewedAt: D, reviewNote: T,
  }, createdOnly('attendance_corrections'));
  const Holiday = sequelize.define('Holiday', { id, tenantId, date: DO, name: S, isOptional: B, branchIds: DataTypes.ARRAY(DataTypes.UUID) }, createdOnly('holidays'));
  const LeaveType = sequelize.define('LeaveType', {
    id, tenantId, code: S, name: S, isPaid: B, annualQuota: N, accrual: S, carryForwardMax: N, encashable: B,
    allowHalfDay: B, allowNegative: B, maxConsecutiveDays: I, minNoticeDays: I, approvalLevels: I, appliesToGender: S, isActive: B,
  }, opts('leave_types'));
  const LeaveTransaction = sequelize.define('LeaveTransaction', {
    id, tenantId, employeeId: U, leaveTypeId: U, leaveYear: S, kind: S, days: N, requestId: U, note: T, actorId: U,
  }, createdOnly('leave_transactions'));
  const LeaveRequest = sequelize.define('LeaveRequest', {
    id, tenantId, employeeId: U, leaveTypeId: U, startDate: DO, endDate: DO, halfDay: S, days: N, leaveYear: S, reason: T,
    status: S, currentLevel: I, requiredLevels: I, requestedBy: U, decidedAt: D,
  }, opts('leave_requests'));
  const LeaveApproval = sequelize.define('LeaveApproval', { id, tenantId, requestId: U, level: I, decision: S, approverId: U, note: T }, createdOnly('leave_approvals'));
  const Announcement = sequelize.define('Announcement', {
    id, tenantId, title: S, body: T, branchIds: DataTypes.ARRAY(DataTypes.UUID), pinned: B, publishedAt: D, expiresAt: D, authorId: U,
  }, createdOnly('announcements'));
  const Notification = sequelize.define('Notification', { id, tenantId, userId: U, type: S, title: S, body: T, link: S, readAt: D }, createdOnly('notifications'));

  // ---------------------------------------------------------------- payroll (006)
  const TaxRuleSet = sequelize.define('TaxRuleSet', { id, country: S, fiscalYear: S, effectiveFrom: DO, effectiveTo: DO, rules: J, sourceNote: T, status: S }, createdOnly('tax_rule_sets'));
  const SalaryComponent = sequelize.define('SalaryComponent', { id, tenantId, code: S, name: S, kind: S, taxable: B, prorated: B, isActive: B, sortOrder: I }, createdOnly('salary_components'));
  const EmployeeSalary = sequelize.define('EmployeeSalary', {
    id, tenantId, employeeId: U, effectiveFrom: DO, basic: M, components: J, ssfEnrolled: B, pfPercent: DataTypes.DECIMAL(5, 2), citMonthly: M, taxProfile: J, reason: T, createdBy: U,
  }, createdOnly('employee_salaries'));
  const PayrollRun = sequelize.define('PayrollRun', {
    id, tenantId, period: S, periodStart: DO, periodEnd: DO, fiscalYear: S, status: S, ruleSetId: U, totals: J, anomalies: I, createdBy: U,
    calculatedAt: D, submittedBy: U, submittedAt: D, approvedBy: U, approvedAt: D, publishedAt: D, paidAt: D, paymentRef: S, notes: T,
  }, opts('payroll_runs'));
  const PayrollItem = sequelize.define('PayrollItem', {
    id, tenantId, runId: U, employeeId: U, lines: J, attendance: J, taxDetail: J, snapshot: J, gross: M, deductions: M, tax: M, ssfEmployee: M, ssfEmployer: M, net: M, anomalies: J,
  }, createdOnly('payroll_items'));
  const PayrollAdjustment = sequelize.define('PayrollAdjustment', { id, tenantId, employeeId: U, period: S, kind: S, description: T, amount: M, taxable: B, createdBy: U }, createdOnly('payroll_adjustments'));
  PayrollItem.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  PayrollItem.belongsTo(PayrollRun, { foreignKey: 'runId', as: 'run' });
  PayrollRun.hasMany(PayrollItem, { foreignKey: 'runId', as: 'items' });

  Employee.belongsTo(Designation, { foreignKey: 'designationId', as: 'designation' });
  Employee.belongsTo(Shift, { foreignKey: 'shiftId', as: 'shift' });
  AttendanceRecord.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  AttendanceCorrection.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  LeaveRequest.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  LeaveRequest.belongsTo(LeaveType, { foreignKey: 'leaveTypeId', as: 'leaveType' });
  LeaveRequest.hasMany(LeaveApproval, { foreignKey: 'requestId', as: 'approvals' });

  // ---------------------------------------------------------------- associations
  PlatformUser.belongsToMany(PlatformRole, { through: PlatformUserRole, foreignKey: 'userId', otherKey: 'roleId', as: 'roles' });
  PlatformRole.belongsToMany(PlatformPermission, { through: PlatformRolePermission, foreignKey: 'roleId', otherKey: 'permissionId', as: 'permissions' });

  Tenant.hasMany(TenantDomain, { foreignKey: 'tenantId', as: 'domains' });
  Tenant.hasMany(Subscription, { foreignKey: 'tenantId', as: 'subscriptions' });

  Role.hasMany(RolePermission, { foreignKey: 'roleId', as: 'grants' });
  RolePermission.belongsTo(Permission, { foreignKey: 'permissionId', as: 'permission' });
  User.belongsToMany(Role, { through: UserRole, foreignKey: 'userId', otherKey: 'roleId', as: 'roles' });
  User.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  User.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

  Plan.hasMany(PlanPrice, { foreignKey: 'planId', as: 'prices' });
  Plan.hasMany(PlanEntitlement, { foreignKey: 'planId', as: 'entitlements' });
  const SubscriptionRequest = sequelize.define('SubscriptionRequest', {
    id, tenantId, kind: S, planId: U, billingCycle: S, employeeCount: I, features: DataTypes.ARRAY(DataTypes.TEXT), message: T,
    status: S, requestedBy: U, decidedBy: U, decidedAt: D, decisionNote: T, decision: J, invoiceId: U,
  }, opts('subscription_requests'));
  const TenantFeatureOverride = sequelize.define('TenantFeatureOverride', {
    tenantId: { type: DataTypes.UUID, primaryKey: true }, featureKey: { type: S, primaryKey: true }, enabled: B, reason: T, updatedBy: U,
  }, opts('tenant_feature_overrides', { createdAt: false }));
  SubscriptionRequest.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });
  SubscriptionRequest.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

  PlanEntitlement.belongsTo(FeatureCatalog, { foreignKey: 'featureId', as: 'feature' });
  Subscription.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });
  Subscription.hasMany(SubscriptionItem, { foreignKey: 'subscriptionId', as: 'items' });

  Employee.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  Employee.belongsTo(Department, { foreignKey: 'departmentId', as: 'department' });
  Employee.belongsTo(Employee, { foreignKey: 'managerId', as: 'manager' });

  Lead.hasMany(LeadActivity, { foreignKey: 'leadId', as: 'activities' });
  Invoice.hasMany(InvoiceItem, { foreignKey: 'invoiceId', as: 'items' });
  Invoice.hasMany(Payment, { foreignKey: 'invoiceId', as: 'payments' });
  Invoice.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });
  Payment.belongsTo(Invoice, { foreignKey: 'invoiceId', as: 'invoice' });
  Payment.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });
  SupportTicket.hasMany(SupportMessage, { foreignKey: 'ticketId', as: 'messages' });
  SupportTicket.belongsTo(Tenant, { foreignKey: 'tenantId', as: 'tenant' });

  return {
    SubscriptionRequest, TenantFeatureOverride,
    TaxRuleSet, SalaryComponent, EmployeeSalary, PayrollRun, PayrollItem, PayrollAdjustment,
    Designation, Shift, EmployeeHistory, File, AttendanceRecord, AttendanceCorrection, Holiday, LeaveType, LeaveTransaction,
    LeaveRequest, LeaveApproval, Announcement, Notification,
    PlatformSetting, Lead, LeadActivity, NewsletterSubscriber, CmsEntry, Coupon, Invoice, InvoiceItem, Payment, SupportTicket, SupportMessage,
    PlatformUser, PlatformRole, PlatformPermission, PlatformRolePermission, PlatformUserRole,
    AuthSession, AuthActionToken, Tenant, TenantDomain, TenantSetting, Branch, Department, Employee,
    User, Permission, Role, RolePermission, UserRole, TenantInvitation, FeatureCatalog, Plan, PlanPrice,
    PlanEntitlement, Subscription, SubscriptionItem, SubscriptionEvent, SubscriptionUsage, AuditLog,
  };
}
