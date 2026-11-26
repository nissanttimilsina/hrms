import { Op, QueryTypes } from 'sequelize';
import { app, sys, appDb, systemDb } from '../database/index.js';
import { cache } from './redis.js';
import { audit } from './audit.service.js';
import { LimitReached, NotFound, BadRequest, Conflict } from '../utils/errors.js';

/**
 * Subscription engine — the single source of truth for what a tenant may do.
 * Everything here reads plans/prices/entitlements/limits from the database.
 */

const CTX_TTL = 60; // seconds; explicitly invalidated on every change
const ctxKey = (tenantId) => `tenantctx:${tenantId}`;
const LIVE = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED'];
const DAY = 86_400_000;

export const addPeriod = (from, cycle, direction = 1) => {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + direction * (cycle === 'ANNUAL' ? 12 : 1));
  return d;
};

// --------------------------------------------------------------------------- pricing
export async function currentPrice(planId, billingCycle, currency = 'NPR', at = new Date(), transaction) {
  const [row] = await systemDb.query(
    `SELECT amount FROM plan_prices
      WHERE plan_id = :planId AND billing_cycle = :billingCycle AND currency = :currency
        AND effective_from <= :at AND (effective_to IS NULL OR effective_to > :at)
      ORDER BY effective_from DESC LIMIT 1`,
    { replacements: { planId, billingCycle, currency, at }, type: QueryTypes.SELECT, transaction },
  );
  return row ? Number(row.amount) : null;
}

// --------------------------------------------------------------------------- tenant context
/** Loads tenant + live subscription + effective features and limits (cached). */
export async function getTenantContext(tenantId, { fresh = false } = {}) {
  if (!fresh) {
    const hit = await cache.get(ctxKey(tenantId));
    if (hit) return hit;
  }
  const tenant = await sys.Tenant.findByPk(tenantId);
  if (!tenant) return null;

  const sub =
    (await sys.Subscription.findOne({ where: { tenantId, status: { [Op.in]: LIVE } }, include: [{ model: sys.Plan, as: 'plan' }, { model: sys.SubscriptionItem, as: 'items' }] })) ??
    (await sys.Subscription.findOne({ where: { tenantId }, order: [['createdAt', 'DESC']], include: [{ model: sys.Plan, as: 'plan' }, { model: sys.SubscriptionItem, as: 'items' }] }));

  let features = [];
  let limits = { employees: 0, branches: 0, users: 0, storageMb: 0 };
  if (sub) {
    const rows = await systemDb.query(
      `SELECT f.key FROM feature_catalog f
        WHERE f.is_core
           OR EXISTS (SELECT 1 FROM plan_entitlements e WHERE e.feature_id = f.id AND e.plan_id = :planId AND e.enabled)`,
      { replacements: { planId: sub.planId }, type: QueryTypes.SELECT },
    );
    const addons = sub.items.filter((i) => i.type === 'ADDON_MODULE').map((i) => i.featureKey);
    features = [...new Set([...rows.map((r) => r.key), ...addons])].sort();

    const extra = (type) => sub.items.filter((i) => i.type === type).reduce((n, i) => n + i.quantity, 0);
    const lim = (override, base, type) => {
      const b = override ?? base;
      return b == null ? null : b + extra(type);
    };
    limits = {
      employees: lim(sub.maxEmployeesOverride, sub.plan.maxEmployees, 'EXTRA_EMPLOYEES'),
      branches: lim(sub.maxBranchesOverride, sub.plan.maxBranches, 'EXTRA_BRANCHES'),
      users: lim(null, sub.plan.maxUsers, 'EXTRA_USERS'),
      storageMb: lim(null, sub.plan.maxStorageMb, 'EXTRA_STORAGE_MB'),
    };
  }

  const ctx = {
    tenant: {
      id: tenant.id, slug: tenant.slug, name: tenant.name, status: tenant.status, timezone: tenant.timezone,
      currency: tenant.currency, locale: tenant.locale, calendar: tenant.calendar,
    },
    subscription: sub && {
      id: sub.id, status: sub.status, planId: sub.planId, planCode: sub.plan.code, planName: sub.plan.name,
      billingCycle: sub.billingCycle, currentPeriodEnd: sub.currentPeriodEnd, trialEndsAt: sub.trialEndsAt,
      graceEndsAt: sub.graceEndsAt, graceDays: sub.plan.graceDays, pendingPlanId: sub.pendingPlanId,
    },
    features,
    limits,
  };
  await cache.set(ctxKey(tenantId), ctx, CTX_TTL);
  return ctx;
}

export const invalidateTenantContext = (tenantId) => cache.del(ctxKey(tenantId));

/**
 * Decide what the tenant may do *right now*. Evaluated from timestamps, not only
 * the stored status, so access is correct even if the lifecycle job is late.
 *   FULL       – everything (subject to RBAC/entitlements/limits)
 *   GRACE      – everything, with an upgrade/renew warning
 *   READ_ONLY  – reads + auth + billing only; data preserved
 *   BLOCKED    – tenant not usable (pending, archived, suspended by platform)
 */
export function evaluateAccess(ctx, now = new Date()) {
  if (!ctx) return { state: 'BLOCKED', reason: 'TENANT_NOT_FOUND' };
  const { tenant, subscription: s } = ctx;
  if (tenant.status !== 'ACTIVE') return { state: 'BLOCKED', reason: `TENANT_${tenant.status}` };
  if (!s) return { state: 'READ_ONLY', reason: 'NO_SUBSCRIPTION' };

  const t = now.getTime();
  const end = new Date(s.currentPeriodEnd).getTime();
  const graceEnd = s.graceEndsAt ? new Date(s.graceEndsAt).getTime() : end + s.graceDays * DAY;

  switch (s.status) {
    case 'TRIAL':
    case 'ACTIVE':
    case 'PAST_DUE':
    case 'GRACE_PERIOD':
      if (t <= end && s.status !== 'GRACE_PERIOD') {
        return s.status === 'PAST_DUE' ? { state: 'GRACE', reason: 'PAYMENT_PAST_DUE' } : { state: 'FULL' };
      }
      if (t <= graceEnd) return { state: 'GRACE', reason: 'SUBSCRIPTION_EXPIRED_IN_GRACE', graceEndsAt: new Date(graceEnd) };
      return { state: 'READ_ONLY', reason: 'GRACE_PERIOD_ENDED' };
    case 'CANCELLED':
      return t <= end ? { state: 'FULL', reason: 'CANCELS_AT_PERIOD_END' } : { state: 'READ_ONLY', reason: 'SUBSCRIPTION_CANCELLED' };
    case 'SUSPENDED':
    case 'EXPIRED':
    default:
      return { state: 'READ_ONLY', reason: `SUBSCRIPTION_${s.status}` };
  }
}

// --------------------------------------------------------------------------- limits & usage
const COUNTERS = {
  employees: (t) => app.Employee.count({ where: { deletedAt: null, status: { [Op.ne]: 'TERMINATED' } }, transaction: t }),
  branches: (t) => app.Branch.count({ where: { deletedAt: null }, transaction: t }),
  users: (t) => app.User.count({ where: { status: { [Op.ne]: 'DISABLED' } }, transaction: t }),
};

/**
 * Assert that adding `adding` more units of `metric` stays within the plan.
 * Must run inside withTenant(). Takes a transaction-scoped advisory lock per
 * (tenant, metric) so concurrent requests cannot both squeeze past the limit.
 */
export async function assertWithinLimit(ctx, metric, transaction, adding = 1) {
  const limit = ctx.limits[metric];
  if (limit == null) return;
  await appDb.query('SELECT pg_advisory_xact_lock(hashtext(:k))', {
    replacements: { k: `${ctx.tenant.id}:${metric}` },
    transaction,
  });
  const current = await COUNTERS[metric](transaction);
  if (current + adding > limit) throw LimitReached(metric, limit, current);
}

export async function assertStorageAvailable(ctx, bytes, transaction) {
  const limitMb = ctx.limits.storageMb;
  if (limitMb == null) return;
  const row = await app.SubscriptionUsage.findOne({ where: { metric: 'storage_bytes' }, transaction, lock: transaction.LOCK.UPDATE });
  const used = Number(row?.value ?? 0);
  if (used + bytes > limitMb * 1024 * 1024) throw LimitReached('MB of storage', limitMb, Math.ceil(used / 1048576));
}

export async function addUsage(tenantId, metric, delta, transaction) {
  await appDb.query(
    `INSERT INTO subscription_usage (tenant_id, metric, value) VALUES (:tenantId, :metric, GREATEST(:delta, 0))
     ON CONFLICT (tenant_id, metric) DO UPDATE SET value = GREATEST(subscription_usage.value + :delta, 0)`,
    { replacements: { tenantId, metric, delta }, transaction },
  );
}

export async function getUsage(transaction) {
  // Sequential: all four run on the same transaction connection.
  const employees = await COUNTERS.employees(transaction);
  const branches = await COUNTERS.branches(transaction);
  const users = await COUNTERS.users(transaction);
  const storage = await app.SubscriptionUsage.findOne({ where: { metric: 'storage_bytes' }, transaction });
  return { employees, branches, users, storageMb: Math.ceil(Number(storage?.value ?? 0) / 1048576) };
}

// --------------------------------------------------------------------------- lifecycle (system role)
async function recordEvent(sub, type, { from, to, payload = {}, actor, transaction }) {
  await sys.SubscriptionEvent.create({
    tenantId: sub.tenantId, subscriptionId: sub.id, type, fromStatus: from ?? null, toStatus: to ?? null,
    payload, actorType: actor?.type ?? 'SYSTEM', actorId: actor?.id ?? null,
  }, { transaction });
}

/** Create the first subscription for a newly provisioned tenant. */
export async function createSubscription({ tenantId, plan, billingCycle, trial, actor, transaction, now = new Date() }) {
  const amount = (await currentPrice(plan.id, billingCycle, 'NPR', now, transaction)) ?? 0;
  const trialDays = trial ? plan.trialDays : 0;
  const status = trialDays > 0 ? 'TRIAL' : 'ACTIVE';
  const currentPeriodEnd = trialDays > 0 ? new Date(now.getTime() + trialDays * DAY) : addPeriod(now, billingCycle);
  const sub = await sys.Subscription.create({
    tenantId, planId: plan.id, status, billingCycle, amount, startsAt: now, currentPeriodEnd,
    trialEndsAt: trialDays > 0 ? currentPeriodEnd : null,
    paymentStatus: trialDays > 0 || amount === 0 ? 'NOT_REQUIRED' : 'PENDING',
  }, { transaction });
  await recordEvent(sub, 'created', { to: status, payload: { plan: plan.code, billingCycle, amount }, actor, transaction });
  return sub;
}

async function liveSubscription(tenantId, transaction) {
  const sub = await sys.Subscription.findOne({
    where: { tenantId, status: { [Op.in]: LIVE } }, transaction, lock: transaction?.LOCK.UPDATE,
  });
  if (!sub) throw NotFound('Active subscription');
  return sub;
}

/** Super Admin: change plan immediately (proration/invoicing arrives with billing in Phase 2). */
export async function changePlan({ tenantId, planCode, billingCycle, actor, req }) {
  const result = await systemDb.transaction(async (transaction) => {
    const sub = await liveSubscription(tenantId, transaction);
    const plan = await sys.Plan.findOne({ where: { code: planCode, status: 'ACTIVE' }, transaction });
    if (!plan) throw NotFound('Plan');
    if (plan.id === sub.planId && (!billingCycle || billingCycle === sub.billingCycle)) throw Conflict('Tenant is already on this plan');
    const cycle = billingCycle ?? sub.billingCycle;
    const amount = await currentPrice(plan.id, cycle, sub.currency, new Date(), transaction);
    if (amount == null && !plan.isCustom) throw BadRequest(`Plan ${plan.code} has no ${cycle} price configured`);
    const before = sub.toJSON();
    await sub.update({ previousPlanId: sub.planId, planId: plan.id, billingCycle: cycle, amount: amount ?? sub.amount, pendingPlanId: null }, { transaction });
    await recordEvent(sub, 'plan_changed', { payload: { from: before.planId, to: plan.id, billingCycle: cycle }, actor, transaction });
    await audit({ transaction, tenantId, actor, action: 'subscription.change_plan', entityType: 'subscription', entityId: sub.id, before, after: sub.toJSON(), req });
    return sub;
  });
  await invalidateTenantContext(tenantId);
  return result;
}

/** Super Admin: negotiated limit overrides (null = use plan default). */
export async function setOverrides({ tenantId, maxEmployees, maxBranches, actor, req }) {
  const result = await systemDb.transaction(async (transaction) => {
    const sub = await liveSubscription(tenantId, transaction);
    const before = { maxEmployeesOverride: sub.maxEmployeesOverride, maxBranchesOverride: sub.maxBranchesOverride };
    const patch = {};
    if (maxEmployees !== undefined) patch.maxEmployeesOverride = maxEmployees;
    if (maxBranches !== undefined) patch.maxBranchesOverride = maxBranches;
    await sub.update(patch, { transaction });
    await recordEvent(sub, 'limit_override', { payload: { before, after: patch }, actor, transaction });
    await audit({ transaction, tenantId, actor, action: 'subscription.override_limits', entityType: 'subscription', entityId: sub.id, before, after: patch, req });
    return sub;
  });
  await invalidateTenantContext(tenantId);
  return result;
}

/** Super Admin: enable an extra module for one tenant. */
export async function addAddonModule({ tenantId, featureKey, unitAmount = 0, actor, req }) {
  const result = await systemDb.transaction(async (transaction) => {
    const sub = await liveSubscription(tenantId, transaction);
    const feature = await sys.FeatureCatalog.findOne({ where: { key: featureKey }, transaction });
    if (!feature) throw NotFound('Feature');
    const exists = await sys.SubscriptionItem.findOne({ where: { subscriptionId: sub.id, type: 'ADDON_MODULE', featureKey }, transaction });
    if (exists) throw Conflict('Module already added');
    const item = await sys.SubscriptionItem.create({ tenantId, subscriptionId: sub.id, type: 'ADDON_MODULE', featureKey, unitAmount }, { transaction });
    await recordEvent(sub, 'addon_added', { payload: { featureKey, unitAmount }, actor, transaction });
    await audit({ transaction, tenantId, actor, action: 'subscription.add_module', entityType: 'subscription', entityId: sub.id, after: { featureKey }, req });
    return item;
  });
  await invalidateTenantContext(tenantId);
  return result;
}

/**
 * Move a subscription to a new status, recording history and audit.
 * Used by the lifecycle job and by Super Admin (e.g. manual payment verification).
 */
export async function transition({ subscriptionId, to, actor = { type: 'SYSTEM' }, patch = {}, reason, req }) {
  const out = await systemDb.transaction(async (transaction) => {
    const sub = await sys.Subscription.findByPk(subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!sub) throw NotFound('Subscription');
    const from = sub.status;
    if (from === to && !Object.keys(patch).length) return { sub, changed: false };
    await sub.update({ status: to, ...patch }, { transaction });
    await recordEvent(sub, 'status_changed', { from, to, payload: { reason, ...patch }, actor, transaction });
    await audit({ transaction, tenantId: sub.tenantId, actor, action: 'subscription.status_change', entityType: 'subscription', entityId: sub.id, before: { status: from }, after: { status: to, reason }, req });
    return { sub, from, changed: true };
  });
  await invalidateTenantContext(out.sub.tenantId);
  return out;
}

/** Super Admin: activate/renew after verified payment — starts a fresh period. */
export async function activatePaidPeriod({ tenantId, actor, req, now = new Date() }) {
  const sub = await systemDb.transaction((t) => liveSubscription(tenantId, t));
  const start = now > sub.currentPeriodEnd ? now : sub.currentPeriodEnd;
  return transition({
    subscriptionId: sub.id, to: 'ACTIVE', actor, req, reason: 'payment_verified',
    patch: {
      planId: sub.pendingPlanId ?? sub.planId,
      previousPlanId: sub.pendingPlanId ? sub.planId : sub.previousPlanId,
      pendingPlanId: null, paymentStatus: 'PAID', trialEndsAt: null, graceEndsAt: null,
      currentPeriodEnd: addPeriod(start, sub.billingCycle),
    },
  });
}

/**
 * Lifecycle sweep (runs on a schedule). Returns the transitions made.
 *   TRIAL/ACTIVE/PAST_DUE past period end  -> GRACE_PERIOD (or SUSPENDED when grace = 0)
 *   GRACE_PERIOD past grace end            -> SUSPENDED (read-only; data preserved)
 *   CANCELLED past period end              -> EXPIRED
 * Never deletes tenant data.
 */
export async function sweepSubscriptions(now = new Date()) {
  const changes = [];
  const due = await sys.Subscription.findAll({
    where: {
      [Op.or]: [
        { status: { [Op.in]: ['TRIAL', 'ACTIVE', 'PAST_DUE'] }, currentPeriodEnd: { [Op.lt]: now } },
        { status: 'GRACE_PERIOD', graceEndsAt: { [Op.lt]: now } },
        { status: 'CANCELLED', currentPeriodEnd: { [Op.lt]: now } },
      ],
    },
    include: [{ model: sys.Plan, as: 'plan' }],
    limit: 500,
  });
  for (const s of due) {
    let to;
    let patch = {};
    if (s.status === 'CANCELLED') to = 'EXPIRED';
    else if (s.status === 'GRACE_PERIOD') to = 'SUSPENDED';
    else {
      const graceEndsAt = new Date(s.currentPeriodEnd.getTime() + s.plan.graceDays * DAY);
      to = graceEndsAt > now ? 'GRACE_PERIOD' : 'SUSPENDED';
      patch = { graceEndsAt };
    }
    const r = await transition({ subscriptionId: s.id, to, patch, reason: 'lifecycle_sweep' });
    if (r.changed) changes.push({ tenantId: s.tenantId, subscriptionId: s.id, from: r.from, to });
  }
  return changes;
}
