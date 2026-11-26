/**
 * Idempotent seeding.
 *   node src/database/seeds/run.js            -> reference data (features, permissions, platform roles, initial plans)
 *   node src/database/seeds/run.js --demo     -> + demo tenant (development only)
 *
 * Bootstrap Super Admin: set SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD.
 * No credentials are hard-coded.
 */
import { fileURLToPath } from 'node:url';
import { FEATURES, PLANS, PERMISSIONS, PLATFORM_PERMISSIONS, PLATFORM_ROLES, DEFAULT_ROLES, TAX_RULE_SETS } from './catalog.js';
import { CMS_DEFAULTS } from './cms-content.js';

export async function seedReference({ sys, systemDb }) {
  await systemDb.transaction(async (transaction) => {
    const o = { transaction, ignoreDuplicates: true };

    await sys.FeatureCatalog.bulkCreate(
      FEATURES.map(([key, name, category, isCore], i) => ({ key, name, category, isCore, sortOrder: i })), o);
    const before = new Set((await sys.Permission.findAll({ attributes: ['key'], transaction, raw: true })).map((p) => p.key));
    await sys.Permission.bulkCreate(PERMISSIONS, o);
    const added = (await sys.Permission.findAll({ transaction })).filter((p) => before.size && !before.has(p.key));
    if (added.length) await backfillDefaultRoles(sys, added, transaction);
    await sys.PlatformPermission.bulkCreate(PLATFORM_PERMISSIONS.map((key) => ({ key })), o);
    await sys.PlatformRole.bulkCreate(PLATFORM_ROLES.map(({ key, name }) => ({ key, name, isSystem: true })), o);
    await sys.TaxRuleSet.bulkCreate(TAX_RULE_SETS.map((r) => ({ country: 'NP', status: 'ACTIVE', ...r })), o);

    // Sequential: queries in one transaction share a single connection.
    const roles = await sys.PlatformRole.findAll({ transaction });
    const perms = await sys.PlatformPermission.findAll({ transaction });
    const features = await sys.FeatureCatalog.findAll({ transaction });
    const roleId = Object.fromEntries(roles.map((x) => [x.key, x.id]));
    const permId = Object.fromEntries(perms.map((x) => [x.key, x.id]));
    const featureId = Object.fromEntries(features.map((x) => [x.key, x.id]));

    await sys.PlatformRolePermission.bulkCreate(
      PLATFORM_ROLES.flatMap((r) => r.perms.map((p) => ({ roleId: roleId[r.key], permissionId: permId[p] }))), o);

    // Plans: create only if missing — never overwrite Super Admin changes.
    for (const p of PLANS) {
      const [plan, created] = await sys.Plan.findOrCreate({
        where: { code: p.code },
        defaults: {
          name: p.name, sortOrder: p.sortOrder, maxEmployees: p.maxEmployees, maxBranches: p.maxBranches,
          maxStorageMb: p.maxStorageMb, highlights: p.highlights, isCustom: !!p.isCustom,
          contactSales: !!p.contactSales, trialDays: p.trialDays ?? 14,
        },
        transaction,
      });
      if (!created) continue;
      const prices = [];
      if (p.monthly != null) prices.push({ planId: plan.id, billingCycle: 'MONTHLY', amount: p.monthly });
      if (p.annual != null) prices.push({ planId: plan.id, billingCycle: 'ANNUAL', amount: p.annual });
      await sys.PlanPrice.bulkCreate(prices, { transaction });
      await sys.PlanEntitlement.bulkCreate(
        p.features.map((k) => ({ planId: plan.id, featureId: featureId[k], enabled: true })), { transaction });
    }
  });
}

/**
 * When new permissions are added in a release, give existing tenants' *default*
 * roles the grants their template specifies for those new permissions only —
 * customisations of existing permissions are never touched.
 */
async function backfillDefaultRoles(sys, added, transaction) {
  const { expandTemplate } = await import('../../services/rbac.service.js');
  for (const tpl of DEFAULT_ROLES) {
    const grants = expandTemplate(tpl.grants, added);
    if (!grants.length) continue;
    const roles = await sys.Role.findAll({ where: { key: tpl.key, isSystem: true }, transaction });
    await sys.RolePermission.bulkCreate(
      roles.flatMap((role) => grants.map((g) => ({ ...g, tenantId: role.tenantId, roleId: role.id }))),
      { transaction, ignoreDuplicates: true },
    );
  }
}

/** Give tenants created before a module existed the same defaults new tenants get (idempotent). */
export async function backfillTenantDefaults({ sys }) {
  const { DEFAULT_LEAVE_TYPES } = await import('../../modules/leave/leave.routes.js');
  const { DEFAULT_COMPONENTS } = await import('../../modules/payroll/payroll.routes.js');
  const tenants = await sys.Tenant.findAll({ attributes: ['id'] });
  for (const { id: tenantId } of tenants) {
    if (!(await sys.LeaveType.count({ where: { tenantId } }))) {
      await sys.LeaveType.bulkCreate(DEFAULT_LEAVE_TYPES.map((lt) => ({ isPaid: true, allowHalfDay: true, allowNegative: false, encashable: false, carryForwardMax: 0, minNoticeDays: 0, approvalLevels: 1, maxConsecutiveDays: null, appliesToGender: null, isActive: true, ...lt, tenantId })));
    }
    if (!(await sys.Shift.count({ where: { tenantId } }))) {
      await sys.Shift.create({ tenantId, name: 'General (10:00–17:00)', startTime: '10:00', endTime: '17:00', breakMinutes: 60, graceMinutes: 10, weeklyOffs: ['SAT'], isDefault: true });
    }
    if (!(await sys.SalaryComponent.count({ where: { tenantId } }))) {
      await sys.SalaryComponent.bulkCreate(DEFAULT_COMPONENTS.map((c) => ({ ...c, tenantId, isActive: true })));
    }
  }
}

export async function seedCmsDefaults({ sys }) {
  await sys.CmsEntry.bulkCreate(CMS_DEFAULTS.map((e, i) => ({ status: 'PUBLISHED', sortOrder: i, data: {}, seo: {}, summary: null, body: null, ...e })), { ignoreDuplicates: true });
}

export async function seedSuperAdmin({ sys }, { email, password, fullName = 'Super Admin' }) {
  const { hashPassword } = await import('../../services/password.service.js');
  const existing = await sys.PlatformUser.findOne({ where: { email } });
  if (existing) return existing;
  const user = await sys.PlatformUser.create({ email, fullName, passwordHash: await hashPassword(password), status: 'ACTIVE' });
  const role = await sys.PlatformRole.findOne({ where: { key: 'super_admin' } });
  await sys.PlatformUserRole.create({ userId: user.id, roleId: role.id });
  return user;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await import('../index.js');
  try {
    await seedReference(db);
    await seedCmsDefaults(db);
    await backfillTenantDefaults(db);
    console.log('✓ reference data, default content and tenant defaults seeded');
    const { SEED_SUPERADMIN_EMAIL: email, SEED_SUPERADMIN_PASSWORD: password } = process.env;
    if (email && password) {
      await seedSuperAdmin(db, { email, password });
      console.log(`✓ super admin ensured: ${email}`);
    }
    if (process.argv.includes('--demo')) {
      if (process.env.NODE_ENV === 'production') throw new Error('--demo is not allowed in production');
      const { provisionTenant } = await import('../../services/provisioning.service.js');
      const exists = await db.sys.Tenant.findOne({ where: { slug: 'demo' } });
      if (!exists) {
        await provisionTenant({
          slug: 'demo', name: 'Demo Company Pvt. Ltd.', planCode: 'PROFESSIONAL', billingCycle: 'MONTHLY',
          owner: { email: 'owner@demo.local', fullName: 'Demo Owner', password: process.env.SEED_DEMO_PASSWORD || 'ChangeMe!2026' },
          actor: { type: 'SYSTEM' },
        });
        console.log('✓ demo tenant created (owner@demo.local)');
      }
    }
  } finally {
    const { closeQueues } = await import('../../jobs/queues.js');
    const { closeRedis } = await import('../../services/redis.js');
    await closeQueues();
    await closeRedis();
    await db.closeDatabase();
  }
}
