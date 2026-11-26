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

  // ---------------------------------------------------------------- associations
  PlatformUser.belongsToMany(PlatformRole, { through: PlatformUserRole, foreignKey: 'userId', otherKey: 'roleId', as: 'roles' });
  PlatformRole.belongsToMany(PlatformPermission, { through: PlatformRolePermission, foreignKey: 'roleId', otherKey: 'permissionId', as: 'permissions' });

  Tenant.hasMany(TenantDomain, { foreignKey: 'tenantId', as: 'domains' });
  Tenant.hasMany(Subscription, { foreignKey: 'tenantId', as: 'subscriptions' });

  Role.hasMany(RolePermission, { foreignKey: 'roleId', as: 'grants' });
  RolePermission.belongsTo(Permission, { foreignKey: 'permissionId', as: 'permission' });
  User.belongsToMany(Role, { through: UserRole, foreignKey: 'userId', otherKey: 'roleId', as: 'roles' });
  User.belongsTo(Employee, { foreignKey: 'employeeId', as: 'employee' });

  Plan.hasMany(PlanPrice, { foreignKey: 'planId', as: 'prices' });
  Plan.hasMany(PlanEntitlement, { foreignKey: 'planId', as: 'entitlements' });
  PlanEntitlement.belongsTo(FeatureCatalog, { foreignKey: 'featureId', as: 'feature' });
  Subscription.belongsTo(Plan, { foreignKey: 'planId', as: 'plan' });
  Subscription.hasMany(SubscriptionItem, { foreignKey: 'subscriptionId', as: 'items' });

  Employee.belongsTo(Branch, { foreignKey: 'branchId', as: 'branch' });
  Employee.belongsTo(Department, { foreignKey: 'departmentId', as: 'department' });
  Employee.belongsTo(Employee, { foreignKey: 'managerId', as: 'manager' });

  return {
    PlatformUser, PlatformRole, PlatformPermission, PlatformRolePermission, PlatformUserRole,
    AuthSession, AuthActionToken, Tenant, TenantDomain, TenantSetting, Branch, Department, Employee,
    User, Permission, Role, RolePermission, UserRole, TenantInvitation, FeatureCatalog, Plan, PlanPrice,
    PlanEntitlement, Subscription, SubscriptionItem, SubscriptionEvent, SubscriptionUsage, AuditLog,
  };
}
