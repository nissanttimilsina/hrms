import { Router } from 'express';
import { z } from 'zod';
import { Op, QueryTypes } from 'sequelize';
import { sys, systemDb, withTenant } from '../../database/index.js';
import { authenticatePlatform, requirePlatformPermission as can } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { provisionTenant } from '../../services/provisioning.service.js';
import * as subs from '../../services/subscription.service.js';
import { audit, platformActor } from '../../services/audit.service.js';
import { revokeAllForUser } from '../../services/auth.service.js';
import { passwordPolicy } from '../../services/password.service.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta, searchWhere } from '../../utils/http.js';
import { NotFound, Conflict, BadRequest } from '../../utils/errors.js';

/**
 * Super Admin portal API (admin.yourhrms.com). Platform users only.
 * Runs on the system connection; every query is scoped to an explicit tenant id
 * taken from the URL and every privileged change is audited.
 */
export const adminRouter = Router();
adminRouter.use(authenticatePlatform);

const tenantParam = { params: z.object({ id: z.string().uuid() }) };
const CYCLES = ['MONTHLY', 'ANNUAL'];

async function invalidatePlanTenants(planId) {
  const rows = await sys.Subscription.findAll({ where: { planId }, attributes: ['tenantId'], raw: true });
  await Promise.all(rows.map((r) => subs.invalidateTenantContext(r.tenantId)));
}

// =========================================================================== tenants
adminRouter.get('/tenants', can('tenants:view'), validate({
  query: listQuery(['createdAt', 'name', 'slug'], { status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional() }),
}), asyncHandler(async (req, res) => {
  const q = req.query;
  const where = { ...(q.status && { status: q.status }), ...searchWhere(q.search, ['name', 'slug']) };
  const { rows, count } = await sys.Tenant.findAndCountAll({
    where, ...paginate(q), distinct: true,
    include: [{ model: sys.Subscription, as: 'subscriptions', required: false, where: { status: { [Op.notIn]: ['CANCELLED', 'EXPIRED'] } },
      include: [{ model: sys.Plan, as: 'plan', attributes: ['code', 'name'] }] }],
  });
  return ok(res, rows.map((t) => {
    const s = t.subscriptions[0];
    return { id: t.id, slug: t.slug, name: t.name, status: t.status, industry: t.industry, createdAt: t.createdAt,
      subscription: s ? { status: s.status, plan: s.plan.code, billingCycle: s.billingCycle, currentPeriodEnd: s.currentPeriodEnd } : null };
  }), pageMeta(q, count));
}));

adminRouter.post('/tenants', can('tenants:manage'), validate({
  body: z.object({
    slug: z.string().trim().toLowerCase(), name: z.string().trim().min(2).max(160),
    legalName: z.string().trim().max(200).optional(), industry: z.string().trim().max(80).optional(),
    planCode: z.string().trim().toUpperCase(), billingCycle: z.enum(CYCLES).default('MONTHLY'), trial: z.boolean().default(true),
    owner: z.object({
      email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(120),
      password: passwordPolicy.optional(), // omitted => invitation email
    }).strict(),
  }).strict(),
}), asyncHandler(async (req, res) => {
  const r = await provisionTenant({ ...req.body, actor: platformActor(req), req });
  return created(res, { tenantId: r.tenant.id, slug: r.tenant.slug, hostname: r.hostname, subscriptionId: r.subscription.id, ownerStatus: r.owner.status });
}));

adminRouter.get('/tenants/:id', can('tenants:view'), validate(tenantParam), asyncHandler(async (req, res) => {
  const tenant = await sys.Tenant.findByPk(req.params.id, { include: [{ model: sys.TenantDomain, as: 'domains' }] });
  if (!tenant) throw NotFound('Tenant');
  const ctx = await subs.getTenantContext(tenant.id, { fresh: true });
  const usage = await withTenant(tenant.id, (t) => subs.getUsage(t));
  const history = await sys.SubscriptionEvent.findAll({ where: { tenantId: tenant.id }, order: [['createdAt', 'DESC']], limit: 50 });
  const featureOverrides = await sys.TenantFeatureOverride.findAll({ where: { tenantId: tenant.id } });
  const requests = await sys.SubscriptionRequest.findAll({ where: { tenantId: tenant.id }, order: [['createdAt', 'DESC']], limit: 10, include: [{ model: sys.Plan, as: 'plan', attributes: ['code', 'name'] }] });
  return ok(res, { tenant, subscription: ctx.subscription, access: subs.evaluateAccess(ctx), features: ctx.features, featureOverrides, limits: ctx.limits, usage, history, requests });
}));

const statusBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

adminRouter.post('/tenants/:id/suspend', can('tenants:manage'), validate({ ...tenantParam, body: statusBody }), asyncHandler(async (req, res) => {
  const tenant = await sys.Tenant.findByPk(req.params.id);
  if (!tenant) throw NotFound('Tenant');
  if (tenant.status === 'SUSPENDED') throw Conflict('Tenant is already suspended');
  const before = tenant.status;
  await tenant.update({ status: 'SUSPENDED', suspendedReason: req.body.reason });
  await audit({ tenantId: tenant.id, actor: platformActor(req), action: 'tenant.suspend', entityType: 'tenant', entityId: tenant.id, before: { status: before }, after: { status: 'SUSPENDED', reason: req.body.reason }, req });
  await subs.invalidateTenantContext(tenant.id);
  // Kick everyone out of the workspace immediately.
  const users = await sys.User.findAll({ where: { tenantId: tenant.id }, attributes: ['id'], raw: true });
  await Promise.all(users.map((u) => revokeAllForUser({ subjectType: 'TENANT', userId: u.id, reason: 'tenant_suspended' })));
  return ok(res, { status: 'SUSPENDED' });
}));

adminRouter.post('/tenants/:id/activate', can('tenants:manage'), validate({ ...tenantParam, body: statusBody }), asyncHandler(async (req, res) => {
  const tenant = await sys.Tenant.findByPk(req.params.id);
  if (!tenant) throw NotFound('Tenant');
  if (tenant.status === 'ARCHIVED') throw Conflict('Archived tenants must be restored through the retention process');
  const before = tenant.status;
  await tenant.update({ status: 'ACTIVE', suspendedReason: null });
  await audit({ tenantId: tenant.id, actor: platformActor(req), action: 'tenant.activate', entityType: 'tenant', entityId: tenant.id, before: { status: before }, after: { status: 'ACTIVE', reason: req.body.reason }, req });
  await subs.invalidateTenantContext(tenant.id);
  return ok(res, { status: 'ACTIVE' });
}));

// =========================================================================== tenant subscription controls
adminRouter.patch('/tenants/:id/subscription/plan', can('subscriptions:manage'), validate({
  ...tenantParam, body: z.object({ planCode: z.string().trim().toUpperCase(), billingCycle: z.enum(CYCLES).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const sub = await subs.changePlan({ tenantId: req.params.id, ...req.body, actor: platformActor(req), req });
  return ok(res, sub);
}));

adminRouter.patch('/tenants/:id/subscription/limits', can('subscriptions:manage'), validate({
  ...tenantParam,
  body: z.object({ maxEmployees: z.number().int().min(0).nullable().optional(), maxBranches: z.number().int().min(0).nullable().optional() })
    .strict().refine((b) => Object.keys(b).length, 'Provide at least one limit'),
}), asyncHandler(async (req, res) => {
  const sub = await subs.setOverrides({ tenantId: req.params.id, ...req.body, actor: platformActor(req), req });
  return ok(res, sub);
}));

adminRouter.post('/tenants/:id/subscription/modules', can('subscriptions:manage'), validate({
  ...tenantParam, body: z.object({ featureKey: z.string().regex(/^[a-z_]+$/), unitAmount: z.number().min(0).default(0) }).strict(),
}), asyncHandler(async (req, res) => {
  const item = await subs.addAddonModule({ tenantId: req.params.id, ...req.body, actor: platformActor(req), req });
  return created(res, item);
}));

/** Switch one feature on/off for this company regardless of plan; enabled: null clears the switch. */
adminRouter.put('/tenants/:id/features/:featureKey', can('subscriptions:manage'), validate({
  params: z.object({ id: z.string().uuid(), featureKey: z.string().regex(/^[a-z_]+$/) }),
  body: z.object({ enabled: z.boolean().nullable(), reason: z.string().trim().max(500).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  await subs.setFeatureOverride({ tenantId: req.params.id, featureKey: req.params.featureKey, ...req.body, actor: platformActor(req), req });
  const ctx = await subs.getTenantContext(req.params.id, { fresh: true });
  return ok(res, { features: ctx.features });
}));

/** Manual payment verification (bank transfer etc.) — starts a new paid period. */
adminRouter.post('/tenants/:id/subscription/activate', can('billing:manage'), validate(tenantParam), asyncHandler(async (req, res) => {
  const { sub } = await subs.activatePaidPeriod({ tenantId: req.params.id, actor: platformActor(req), req });
  return ok(res, sub);
}));

// =========================================================================== plans & entitlements
adminRouter.get('/features', can('plans:view'), asyncHandler(async (_req, res) =>
  ok(res, await sys.FeatureCatalog.findAll({ order: [['sortOrder', 'ASC']] }))));

adminRouter.get('/plans', can('plans:view'), asyncHandler(async (_req, res) => {
  const plans = await sys.Plan.findAll({
    order: [['sortOrder', 'ASC']],
    include: [
      { model: sys.PlanPrice, as: 'prices', separate: true, order: [['effectiveFrom', 'DESC']] },
      { model: sys.PlanEntitlement, as: 'entitlements', include: [{ model: sys.FeatureCatalog, as: 'feature', attributes: ['key', 'name'] }] },
    ],
  });
  return ok(res, plans);
}));

const planBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/),
  name: z.string().trim().min(2).max(80), description: z.string().trim().max(1000).nullish(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(), isPublic: z.boolean().optional(), isCustom: z.boolean().optional(),
  contactSales: z.boolean().optional(), sortOrder: z.number().int().optional(),
  trialDays: z.number().int().min(0).max(365).optional(), graceDays: z.number().int().min(0).max(90).optional(),
  maxEmployees: z.number().int().min(0).nullable().optional(), maxBranches: z.number().int().min(0).nullable().optional(),
  maxUsers: z.number().int().min(0).nullable().optional(), maxStorageMb: z.number().int().min(0).nullable().optional(),
  highlights: z.array(z.string().trim().max(120)).max(20).optional(),
}).strict();

adminRouter.post('/plans', can('plans:manage'), validate({ body: planBody }), asyncHandler(async (req, res) => {
  const plan = await systemDb.transaction(async (transaction) => {
    const p = await sys.Plan.create(req.body, { transaction });
    await audit({ transaction, actor: platformActor(req), action: 'plan.create', entityType: 'plan', entityId: p.id, after: p.toJSON(), req });
    return p;
  });
  return created(res, plan);
}));

adminRouter.patch('/plans/:id', can('plans:manage'), validate({ ...tenantParam, body: planBody.omit({ code: true }).partial() }), asyncHandler(async (req, res) => {
  const plan = await systemDb.transaction(async (transaction) => {
    const p = await sys.Plan.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!p) throw NotFound('Plan');
    const before = p.toJSON();
    await p.update(req.body, { transaction });
    await audit({ transaction, actor: platformActor(req), action: 'plan.update', entityType: 'plan', entityId: p.id, before, after: p.toJSON(), req });
    return p;
  });
  await invalidatePlanTenants(plan.id);
  return ok(res, plan);
}));

/**
 * Set a new price. Prices are versioned: the open row is closed at effectiveFrom
 * and a new row inserted, so historical subscriptions/invoices stay reproducible.
 */
adminRouter.put('/plans/:id/prices', can('plans:manage'), validate({
  ...tenantParam,
  body: z.object({
    billingCycle: z.enum(CYCLES), amount: z.number().min(0).max(99_999_999), currency: z.string().length(3).toUpperCase().default('NPR'),
    effectiveFrom: z.coerce.date().optional(),
  }).strict(),
}), asyncHandler(async (req, res) => {
  const { billingCycle, amount, currency } = req.body;
  const effectiveFrom = req.body.effectiveFrom ?? new Date();
  const price = await systemDb.transaction(async (transaction) => {
    const plan = await sys.Plan.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!plan) throw NotFound('Plan');
    const open = await sys.PlanPrice.findOne({ where: { planId: plan.id, billingCycle, currency, effectiveTo: null }, transaction });
    if (open) {
      if (effectiveFrom <= open.effectiveFrom) throw BadRequest('effectiveFrom must be after the current price start');
      await open.update({ effectiveTo: effectiveFrom }, { transaction });
    }
    const p = await sys.PlanPrice.create({ planId: plan.id, billingCycle, currency, amount, effectiveFrom }, { transaction });
    await audit({ transaction, actor: platformActor(req), action: 'plan.price_change', entityType: 'plan', entityId: plan.id, before: open && { amount: open.amount }, after: { billingCycle, currency, amount, effectiveFrom }, req });
    return p;
  });
  return ok(res, price);
}));

adminRouter.put('/plans/:id/entitlements', can('plans:manage'), validate({
  ...tenantParam, body: z.object({ features: z.array(z.string().regex(/^[a-z_]+$/)).max(200) }).strict(),
}), asyncHandler(async (req, res) => {
  await systemDb.transaction(async (transaction) => {
    const plan = await sys.Plan.findByPk(req.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!plan) throw NotFound('Plan');
    const features = await sys.FeatureCatalog.findAll({ where: { key: req.body.features }, transaction });
    if (features.length !== new Set(req.body.features).size) throw BadRequest('Unknown feature key in list');
    const before = await systemDb.query(
      'SELECT f.key FROM plan_entitlements e JOIN feature_catalog f ON f.id = e.feature_id WHERE e.plan_id = :id AND e.enabled',
      { replacements: { id: plan.id }, type: QueryTypes.SELECT, transaction });
    await sys.PlanEntitlement.destroy({ where: { planId: plan.id }, transaction });
    await sys.PlanEntitlement.bulkCreate(features.map((f) => ({ planId: plan.id, featureId: f.id, enabled: true })), { transaction });
    await audit({ transaction, actor: platformActor(req), action: 'plan.entitlements_update', entityType: 'plan', entityId: plan.id, before: before.map((r) => r.key), after: req.body.features, req });
  });
  await invalidatePlanTenants(req.params.id);
  return ok(res, { updated: true });
}));

// =========================================================================== platform audit
adminRouter.get('/audit-logs', can('audit:view'), validate({
  query: listQuery(['createdAt'], { tenantId: z.string().uuid().optional(), action: z.string().max(60).optional() }),
}), asyncHandler(async (req, res) => {
  const q = req.query;
  const where = { ...(q.tenantId && { tenantId: q.tenantId }), ...(q.action && { action: q.action }) };
  const { rows, count } = await sys.AuditLog.findAndCountAll({ where, ...paginate(q) });
  return ok(res, rows, pageMeta(q, count));
}));
