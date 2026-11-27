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
    id, tenantId, code: S, name: S, address: T, isHeadOffice: B, isActive: B, defaultShiftId: U, deletedAt: D,
  }, opts('branches'));

  const Department = sequelize.define('Department', {
    id, tenantId, branchId: U, parentId: U, code: S, name: S, deletedAt: D,
  }, opts('departments'));

  const Employee = sequelize.define('Employee', {
    id, tenantId, employeeCode: S, firstName: S, lastName: S, workEmail: S, phone: S,
    branchId: U, departmentId: U, managerId: U, status: S,
    joinedOn: DataTypes.DATEONLY, exitedOn: DataTypes.DATEONLY, deletedAt: D,
    designationId: U, shiftId: U, employmentType: S, dateOfBirth: DataTypes.DATEONLY, gender: S, maritalStatus: S,
    personalEmail: S, pan: S, ssfId: S, biometricId: S, citizenshipNo: S, address: J, emergencyContacts: J, bank: J,
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
    weeklyOffs: DataTypes.ARRAY(DataTypes.TEXT), dayHours: J, isDefault: B, deletedAt: D,
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
  const Holiday = sequelize.define('Holiday', { id, tenantId, date: DO, name: S, kind: S, isOptional: B, branchIds: DataTypes.ARRAY(DataTypes.UUID) }, createdOnly('holidays'));
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
  const PayrollAdjustment = sequelize.define('PayrollAdjustment', { id, tenantId, employeeId: U, period: S, kind: S, code: S, description: T, amount: M, taxable: B, createdBy: U }, createdOnly('payroll_adjustments'));
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

  const AttendanceDevice = sequelize.define('AttendanceDevice', {
    id, tenantId, branchId: U, name: S, serialNumber: S, vendor: S, model: S, location: S, status: S, allowedIps: DataTypes.ARRAY(DataTypes.TEXT),
    lastSeenAt: D, lastIp: S, firmware: S, deviceInfo: J, lastPunchAt: D, punchCount: DataTypes.BIGINT, lastError: T, lastErrorAt: D,
    offlineAlertedAt: D, deletedAt: D,
  }, opts('attendance_devices'));
  const DevicePunch = sequelize.define('DevicePunch', {
    id, tenantId, deviceId: U, deviceUserId: S, punchedAt: D, statusCode: I, verifyMode: I, employeeId: U, result: S, message: T,
  }, createdOnly('device_punches'));
  const DeviceLog = sequelize.define('DeviceLog', {
    id, tenantId, deviceId: U, level: S, event: S, message: T, details: J,
  }, createdOnly('device_logs'));
  DevicePunch.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  DevicePunch.belongsTo(AttendanceDevice, { foreignKey: 'deviceId', as: 'device' });
  AttendanceDevice.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });

  const EmployeeLoan = sequelize.define('EmployeeLoan', {
    id, tenantId, employeeId: U, kind: S, title: S, principal: M, installmentAmount: M, startPeriod: S, status: S, note: T, createdBy: U, closedAt: D,
  }, opts('employee_loans'));
  EmployeeLoan.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });

  // ---------------------------------------------------------------- work management
  const Project = sequelize.define('Project', {
    id, tenantId, name: S, code: S, description: T, color: S, status: S, leadEmployeeId: U,
    startsOn: DataTypes.DATEONLY, endsOn: DataTypes.DATEONLY, createdBy: U, deletedAt: D,
  }, opts('projects'));
  const Task = sequelize.define('Task', {
    id, tenantId, number: I, projectId: U, title: S, description: T, assigneeId: U, createdBy: U, priority: S, status: S,
    progress: I, requiresReview: B, startOn: DataTypes.DATEONLY, dueOn: DataTypes.DATEONLY, estimateHours: DataTypes.DECIMAL(6, 2),
    loggedHours: DataTypes.DECIMAL(8, 2), tags: DataTypes.ARRAY(DataTypes.TEXT), blockedReason: T, completedAt: D, deletedAt: D,
  }, opts('tasks'));
  const TaskActivity = sequelize.define('TaskActivity', {
    id, tenantId, taskId: U, authorId: U, kind: S, body: T, fromValue: J, toValue: J,
  }, createdOnly('task_activity'));
  const WorkReport = sequelize.define('WorkReport', {
    id, tenantId, employeeId: U, reportDate: DataTypes.DATEONLY, summary: T, challenges: T, planNext: T, hours: DataTypes.DECIMAL(5, 2),
    status: S, submittedAt: D, reviewerId: U, reviewedAt: D, rating: I, feedback: T,
  }, opts('work_reports'));
  const WorkReportItem = sequelize.define('WorkReportItem', {
    id, tenantId, reportId: U, taskId: U, description: T, hours: DataTypes.DECIMAL(5, 2), progress: I, completed: B, sortOrder: I,
  }, noTs('work_report_items'));
  Task.belongsTo(Employee, { foreignKey: 'assigneeId', as: 'assignee' });
  Task.belongsTo(Project, { foreignKey: 'projectId', as: 'project' });
  Task.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });
  Task.hasMany(TaskActivity, { foreignKey: 'taskId', as: 'activity' });
  TaskActivity.belongsTo(User, { foreignKey: 'authorId', as: 'author' });
  Project.belongsTo(Employee, { foreignKey: 'leadEmployeeId', as: 'lead' });
  WorkReport.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  WorkReport.belongsTo(User, { foreignKey: 'reviewerId', as: 'reviewer' });
  WorkReport.hasMany(WorkReportItem, { foreignKey: 'reportId', as: 'items' });
  WorkReportItem.belongsTo(Task, { foreignKey: 'taskId', as: 'task' });

  // ---------------------------------------------------------------- self-service (013)
  const ExpenseClaim = sequelize.define('ExpenseClaim', {
    id, tenantId, number: I, employeeId: U, category: S, title: S, expenseDate: DataTypes.DATEONLY, amount: M, merchant: S, description: T,
    receiptFileId: U, status: S, managerUserId: U, managerDecidedBy: U, managerDecidedAt: D, managerNote: T,
    approvedBy: U, approvedAt: D, approvedAmount: M, financeNote: T, rejectedBy: U, rejectedAt: D, rejectReason: T,
    payoutMethod: S, payrollPeriod: S, payrollAdjustmentId: U, paidAt: D, paymentRef: S, createdBy: U,
  }, opts('expense_claims'));
  const LetterRequest = sequelize.define('LetterRequest', {
    id, tenantId, number: I, employeeId: U, type: S, purpose: T, addressedTo: T, details: T, status: S, requestedBy: U,
    decidedBy: U, decidedAt: D, decisionNote: T, reference: S, verifyCode: S, content: J, issuedAt: D, revokedAt: D, revokeReason: T,
  }, opts('letter_requests'));
  ExpenseClaim.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  ExpenseClaim.belongsTo(File, { foreignKey: 'receiptFileId', as: 'receipt' });
  LetterRequest.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  LetterRequest.belongsTo(User, { foreignKey: 'decidedBy', as: 'decider' });

  // ---------------------------------------------------------------- talent and operations (014)
  const DATE = DataTypes.DATEONLY;
  const R = DataTypes.DECIMAL(3, 2);
  const UA = DataTypes.ARRAY(DataTypes.UUID);
  const Asset = sequelize.define('Asset', {
    id, tenantId, number: I, name: S, category: S, assetTag: S, serialNo: S, brandModel: S, branchId: U, purchaseDate: DATE, purchaseCost: M,
    vendor: S, warrantyUntil: DATE, condition: S, status: S, assignedEmployeeId: U, assignedAt: D, dueBackOn: DATE, notes: T, createdBy: U,
  }, opts('assets'));
  const AssetEvent = sequelize.define('AssetEvent', { id, tenantId, assetId: U, type: S, employeeId: U, condition: S, note: T, authorId: U }, createdOnly('asset_events'));
  const ChecklistTemplate = sequelize.define('ChecklistTemplate', { id, tenantId, kind: S, name: S, description: T, items: J, isDefault: B, active: B }, opts('checklist_templates'));
  const Journey = sequelize.define('Journey', {
    id, tenantId, number: I, kind: S, employeeId: U, templateId: U, status: S, startDate: DATE, exitType: S, noticeDate: DATE, lastWorkingDay: DATE,
    exitReason: T, rehireEligible: B, exitInterview: J, terminateEmployee: B, completedAt: D, completedBy: U, createdBy: U,
  }, opts('journeys'));
  const JourneyTask = sequelize.define('JourneyTask', { id, tenantId, journeyId: U, sort: I, title: S, description: T, owner: S, dueDate: DATE, doneAt: D, doneBy: U, note: T }, opts('journey_tasks'));
  const JobOpening = sequelize.define('JobOpening', {
    id, tenantId, number: I, slug: S, title: S, departmentId: U, branchId: U, designationId: U, employmentType: S, location: S, positions: I,
    description: T, requirements: T, salaryMin: M, salaryMax: M, showSalary: B, status: S, published: B, closesOn: DATE, hiringManagerId: U,
    createdBy: U, openedAt: D, closedAt: D,
  }, opts('job_openings'));
  const Candidate = sequelize.define('Candidate', {
    id, tenantId, number: I, jobId: U, firstName: S, lastName: S, email: S, phone: S, currentTitle: S, experienceYears: DataTypes.DECIMAL(4, 1),
    expectedSalary: M, noticeDays: I, source: S, referredBy: U, coverNote: T, cvFileId: U, stage: S, rating: I, offer: J, rejectReason: T,
    employeeId: U, consentAt: D, stageChangedAt: D, createdBy: U,
  }, opts('candidates'));
  const CandidateEvent = sequelize.define('CandidateEvent', { id, tenantId, candidateId: U, type: S, data: J, authorId: U }, createdOnly('candidate_events'));
  const Interview = sequelize.define('Interview', {
    id, tenantId, candidateId: U, round: S, scheduledAt: D, durationMinutes: I, mode: S, location: S, interviewerIds: UA, status: S, createdBy: U,
  }, opts('interviews'));
  const InterviewFeedback = sequelize.define('InterviewFeedback', { id, tenantId, interviewId: U, authorId: U, rating: I, recommendation: S, scores: J, notes: T }, opts('interview_feedback'));
  const HrTicket = sequelize.define('HrTicket', {
    id, tenantId, number: I, employeeId: U, requesterId: U, category: S, subject: S, priority: S, status: S, confidential: B, assigneeId: U,
    dueAt: D, firstResponseAt: D, resolvedAt: D, closedAt: D, satisfaction: I, satisfactionNote: T,
  }, opts('hr_tickets'));
  const HrTicketMessage = sequelize.define('HrTicketMessage', { id, tenantId, ticketId: U, authorId: U, body: T, internal: B, attachmentFileId: U }, createdOnly('hr_ticket_messages'));
  const TrainingCourse = sequelize.define('TrainingCourse', {
    id, tenantId, title: S, category: S, description: T, delivery: S, provider: S, durationHours: DataTypes.DECIMAL(6, 1), costPerPerson: M,
    certificateValidMonths: I, mandatory: B, selfEnroll: B, active: B,
  }, opts('training_courses'));
  const TrainingSession = sequelize.define('TrainingSession', { id, tenantId, courseId: U, startsAt: D, endsAt: D, location: S, trainer: S, capacity: I, status: S }, opts('training_sessions'));
  const TrainingEnrollment = sequelize.define('TrainingEnrollment', {
    id, tenantId, courseId: U, sessionId: U, employeeId: U, status: S, requestedBy: U, requestNote: T, decidedBy: U, decisionNote: T,
    completedOn: DATE, score: DataTypes.DECIMAL(5, 1), certificateExpiresOn: DATE, certificateFileId: U, feedbackRating: I, feedbackComment: T,
  }, opts('training_enrollments'));
  const AppraisalCycle = sequelize.define('AppraisalCycle', {
    id, tenantId, name: S, periodStart: DATE, periodEnd: DATE, selfReviewDue: DATE, managerReviewDue: DATE, status: S, competencies: J,
    goalWeight: I, peerFeedback: B, createdBy: U, launchedAt: D, closedAt: D,
  }, opts('appraisal_cycles'));
  const Goal = sequelize.define('Goal', {
    id, tenantId, employeeId: U, cycleId: U, title: S, description: T, measure: S, target: S, actual: S, weight: I, progress: I, dueDate: DATE, status: S, createdBy: U,
  }, opts('goals'));
  const Appraisal = sequelize.define('Appraisal', {
    id, tenantId, cycleId: U, employeeId: U, reviewerId: U, status: S, selfReview: J, managerReview: J, goalScore: R, competencyScore: R,
    calculatedRating: R, finalRating: R, calibrationNote: T, recommendation: S, workScore: I, selfSubmittedAt: D, managerSubmittedAt: D,
    finalizedAt: D, finalizedBy: U, acknowledgedAt: D, employeeComment: T,
  }, opts('appraisals'));
  const AppraisalFeedback = sequelize.define('AppraisalFeedback', {
    id, tenantId, appraisalId: U, fromEmployeeId: U, requestedBy: U, rating: I, strengths: T, improvements: T, submittedAt: D,
  }, createdOnly('appraisal_feedback'));
  const Survey = sequelize.define('Survey', {
    id, tenantId, title: S, description: T, anonymous: B, status: S, closesOn: DATE, audience: J, questions: J, minGroup: I, createdBy: U, openedAt: D, closedAt: D,
  }, opts('surveys'));
  const SurveyParticipant = sequelize.define('SurveyParticipant', {
    tenantId, surveyId: { type: U, primaryKey: true }, employeeId: { type: U, primaryKey: true }, responded: B,
  }, noTs('survey_participants'));
  const SurveyResponse = sequelize.define('SurveyResponse', { id, tenantId, surveyId: U, employeeId: U, departmentId: U, answers: J, submittedOn: DATE }, noTs('survey_responses'));
  const Kudos = sequelize.define('Kudos', { id, tenantId, fromEmployeeId: U, toEmployeeId: U, value: S, message: T, hiddenAt: D, hiddenBy: U }, createdOnly('kudos'));
  const HeadcountPlan = sequelize.define('HeadcountPlan', { id, tenantId, name: S, fiscalYear: S, status: S, notes: T, approvedBy: U, approvedAt: D, createdBy: U }, opts('headcount_plans'));
  const HeadcountPlanLine = sequelize.define('HeadcountPlanLine', {
    id, tenantId, planId: U, departmentId: U, designationId: U, branchId: U, planned: I, monthlyCost: M, neededBy: DATE, note: T,
  }, noTs('headcount_plan_lines'));
  const WorkflowDefinition = sequelize.define('WorkflowDefinition', { id, tenantId, name: S, description: T, icon: S, fields: J, steps: J, active: B, createdBy: U }, opts('workflow_definitions'));
  const WorkflowRequest = sequelize.define('WorkflowRequest', {
    id, tenantId, number: I, definitionId: U, snapshot: J, employeeId: U, requesterId: U, data: J, status: S, currentStep: I, decidedAt: D,
  }, opts('workflow_requests'));
  const WorkflowRequestStep = sequelize.define('WorkflowRequestStep', {
    id, tenantId, requestId: U, stepIndex: I, name: S, approverIds: UA, status: S, decidedBy: U, decidedAt: D, note: T,
  }, noTs('workflow_request_steps'));

  Asset.belongsTo(Employee, { foreignKey: 'assignedEmployeeId', as: 'holder' });
  Asset.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  Asset.hasMany(AssetEvent, { foreignKey: 'assetId', as: 'events' });
  AssetEvent.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  AssetEvent.belongsTo(User, { foreignKey: 'authorId', as: 'author' });
  Journey.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  Journey.hasMany(JourneyTask, { foreignKey: 'journeyId', as: 'tasks' });
  JobOpening.belongsTo(Department, { foreignKey: 'departmentId', as: 'department' });
  JobOpening.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  JobOpening.belongsTo(Designation, { foreignKey: 'designationId', as: 'designation' });
  JobOpening.belongsTo(Employee, { foreignKey: 'hiringManagerId', as: 'hiringManager' });
  Candidate.belongsTo(JobOpening, { foreignKey: 'jobId', as: 'job' });
  Interview.belongsTo(Candidate, { foreignKey: 'candidateId', as: 'candidate' });
  Interview.hasMany(InterviewFeedback, { foreignKey: 'interviewId', as: 'feedback' });
  HrTicket.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  HrTicket.hasMany(HrTicketMessage, { foreignKey: 'ticketId', as: 'messages' });
  TrainingSession.belongsTo(TrainingCourse, { foreignKey: 'courseId', as: 'course' });
  TrainingEnrollment.belongsTo(TrainingCourse, { foreignKey: 'courseId', as: 'course' });
  TrainingEnrollment.belongsTo(TrainingSession, { foreignKey: 'sessionId', as: 'session' });
  TrainingEnrollment.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  Goal.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  Appraisal.belongsTo(AppraisalCycle, { foreignKey: 'cycleId', as: 'cycle' });
  Appraisal.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  Appraisal.belongsTo(Employee, { foreignKey: 'reviewerId', as: 'reviewer' });
  AppraisalFeedback.belongsTo(Employee, { foreignKey: 'fromEmployeeId', as: 'from' });
  Kudos.belongsTo(Employee, { foreignKey: 'fromEmployeeId', as: 'from' });
  Kudos.belongsTo(Employee, { foreignKey: 'toEmployeeId', as: 'to' });
  HeadcountPlan.hasMany(HeadcountPlanLine, { foreignKey: 'planId', as: 'lines' });
  WorkflowRequest.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });
  WorkflowRequest.hasMany(WorkflowRequestStep, { foreignKey: 'requestId', as: 'steps' });

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
    Project, Task, TaskActivity, WorkReport, WorkReportItem, ExpenseClaim, LetterRequest,
    Asset, AssetEvent, ChecklistTemplate, Journey, JourneyTask, JobOpening, Candidate, CandidateEvent, Interview, InterviewFeedback,
    HrTicket, HrTicketMessage, TrainingCourse, TrainingSession, TrainingEnrollment, AppraisalCycle, Goal, Appraisal, AppraisalFeedback,
    Survey, SurveyParticipant, SurveyResponse, Kudos, HeadcountPlan, HeadcountPlanLine, WorkflowDefinition, WorkflowRequest, WorkflowRequestStep,
    SubscriptionRequest, TenantFeatureOverride, EmployeeLoan, AttendanceDevice, DevicePunch, DeviceLog,
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
