import { sys, systemDb } from '../database/index.js';
import { env } from '../config/env.js';
import { DEFAULT_ROLES } from '../database/seeds/catalog.js';
import { expandTemplate } from './rbac.service.js';
import { createSubscription } from './subscription.service.js';
import { hashPassword } from './password.service.js';
import { audit } from './audit.service.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { BadRequest, Conflict, NotFound } from '../utils/errors.js';
import { enqueueEmail } from '../jobs/queues.js';

const RESERVED = new Set(['www', 'app', 'admin', 'api', 'mail', 'smtp', 'status', 'help', 'docs', 'blog',
  'support', 'billing', 'static', 'cdn', 'assets', 'staging', 'dev', 'test', 'demo-admin', 'auth']);

export const DEFAULT_TENANT_SETTINGS = {
  'org.financial_year_start': { calendar: 'BS', month: 4, day: 1 }, // Shrawan 1
  'org.work_week': ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI'],
  'org.employee_id_format': { prefix: 'EMP-', padding: 4, next: 1 },
  'security.session_idle_minutes': 60,
  'branding': { primaryColor: '#1D4ED8', logoFileId: null },
};

export function validateSlug(slug) {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(slug)) {
    throw BadRequest('Workspace name must be 3–63 lowercase letters, numbers or hyphens');
  }
  if (RESERVED.has(slug)) throw BadRequest('This workspace name is reserved');
}

/**
 * Create a fully working tenant workspace in one transaction:
 * tenant, subdomain, settings, default roles, head-office branch, owner user, subscription.
 * Used by self-service registration (Phase 2), Super Admin "create company", CRM conversion and seeds.
 */
export async function provisionTenant({
  slug, name, legalName, industry, planCode, billingCycle = 'MONTHLY', trial = true,
  owner, actor = { type: 'SYSTEM' }, req, status = 'ACTIVE', transactionHook,
}) {
  validateSlug(slug);
  const result = await systemDb.transaction(async (transaction) => {
    if (await sys.Tenant.findOne({ where: { slug }, transaction })) throw Conflict('Workspace name is already taken', 'SLUG_TAKEN');
    const plan = await sys.Plan.findOne({ where: { code: planCode, status: 'ACTIVE' }, transaction });
    if (!plan) throw NotFound('Plan');

    const tenant = await sys.Tenant.create({ slug, name, legalName, industry, status }, { transaction });
    const tenantId = tenant.id;

    await sys.TenantDomain.create({
      tenantId, hostname: `${slug}.${env.ROOT_DOMAIN}`, type: 'SUBDOMAIN', isPrimary: true, verifiedAt: new Date(),
    }, { transaction });

    await sys.TenantSetting.bulkCreate(
      Object.entries(DEFAULT_TENANT_SETTINGS).map(([key, value]) => ({ tenantId, key, value })), { transaction });

    // Default roles copied into the tenant — the company can edit them afterwards.
    const permissions = await sys.Permission.findAll({ transaction });
    const roleIds = {};
    for (const tpl of DEFAULT_ROLES) {
      const role = await sys.Role.create({ tenantId, key: tpl.key, name: tpl.name, isSystem: true }, { transaction });
      roleIds[tpl.key] = role.id;
      await sys.RolePermission.bulkCreate(
        expandTemplate(tpl.grants, permissions).map((g) => ({ ...g, tenantId, roleId: role.id })), { transaction });
    }

    await sys.Branch.create({ tenantId, code: 'HQ', name: 'Head Office', isHeadOffice: true }, { transaction });
    await sys.Shift.create({ tenantId, name: 'General (10:00–17:00)', startTime: '10:00', endTime: '17:00', breakMinutes: 60, graceMinutes: 10, weeklyOffs: ['SAT'], isDefault: true }, { transaction });
    const { DEFAULT_LEAVE_TYPES } = await import('../modules/leave/leave.routes.js');
    const { DEFAULT_COMPONENTS } = await import('../modules/payroll/payroll.routes.js');
    await sys.SalaryComponent.bulkCreate(DEFAULT_COMPONENTS.map((c) => ({ ...c, tenantId, isActive: true })), { transaction });
    await sys.LeaveType.bulkCreate(DEFAULT_LEAVE_TYPES.map((lt) => ({ isPaid: true, allowHalfDay: true, allowNegative: false, encashable: false, carryForwardMax: 0, minNoticeDays: 0, approvalLevels: 1, maxConsecutiveDays: null, appliesToGender: null, isActive: true, ...lt, tenantId })), { transaction });

    const user = await sys.User.create({
      tenantId, email: owner.email, fullName: owner.fullName,
      passwordHash: owner.password ? await hashPassword(owner.password) : null,
      status: owner.password ? 'ACTIVE' : 'INVITED',
    }, { transaction });
    await sys.UserRole.create({ tenantId, userId: user.id, roleId: roleIds.company_owner }, { transaction });

    let invitationToken;
    if (!owner.password) {
      invitationToken = randomToken();
      await sys.TenantInvitation.create({
        tenantId, email: owner.email, roleId: roleIds.company_owner, tokenHash: sha256(invitationToken),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      }, { transaction });
    }

    const subscription = await createSubscription({ tenantId, plan, billingCycle, trial, actor, transaction });

    await audit({
      transaction, tenantId, actor, action: 'tenant.provision', entityType: 'tenant', entityId: tenantId,
      after: { slug, name, plan: plan.code, billingCycle, ownerEmail: owner.email }, req,
    });

    const extra = transactionHook ? await transactionHook({ transaction, tenant, user }) : {};
    return { tenant, owner: user, subscription, invitationToken, hostname: `${slug}.${env.ROOT_DOMAIN}`, ...extra };
  });

  if (status === 'ACTIVE') await enqueueEmail({
    tenantId: result.tenant.id,
    to: owner.email,
    template: result.invitationToken ? 'tenant.invitation' : 'tenant.welcome',
    data: { companyName: name, workspaceUrl: `https://${result.hostname}`, token: result.invitationToken },
  });
  return result;
}
