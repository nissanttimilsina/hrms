/**
 * Subscription requests: a company asks for a plan, Enterprise terms or extra modules; the Super Admin reviews it.
 * Approving applies everything in one place: plan + cycle (with a negotiated price for custom plans), limit overrides,
 * per-feature switches, then either issues an invoice (plan activates when paid) or activates immediately (paid offline /
 * complimentary). Feature access always follows the resulting subscription and is enforced by the API.
 */
import { sys, systemDb, withTenant } from '../database/index.js';
import { env } from '../config/env.js';
import * as subs from './subscription.service.js';
import { checkout, createCustomInvoice, workspaceUrl } from './billing.service.js';
import { audit } from './audit.service.js';
import { enqueueEmail } from '../jobs/queues.js';
import { notifyUsers, usersWithPermission } from './hr/notify.js';
import { BadRequest, Conflict, NotFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const describe = (r, plan) => (r.kind === 'FEATURES' ? `Extra modules: ${r.features.join(', ')}` : `${plan?.name ?? 'Enterprise'} plan${r.billingCycle ? ` (${r.billingCycle.toLowerCase()})` : ''}`);

async function tellCompany(tenantId, { title, body, link = '/billing' }) {
  try {
    await withTenant(tenantId, async (t) => notifyUsers(t, await usersWithPermission(t, 'subscription:manage'), { type: 'subscription.request', title, body, link, email: true }));
  } catch (err) { logger.error({ err, tenantId }, 'could not notify company about subscription request'); }
}

export async function createRequest({ tenantId, userId, planCode, billingCycle, employeeCount, features = [], message, actor, req }) {
  const out = await systemDb.transaction(async (transaction) => {
    let plan = null; let kind = 'FEATURES';
    if (await sys.SubscriptionRequest.count({ where: { tenantId, status: 'PENDING' }, transaction })) throw Conflict('You already have a request under review. Cancel it to send a different one.');
    if (planCode) {
      plan = await sys.Plan.findOne({ where: { code: planCode, status: 'ACTIVE' }, transaction });
      if (!plan) throw NotFound('Plan');
      kind = plan.isCustom ? 'ENTERPRISE' : 'PLAN_CHANGE';
    } else if (!features.length) throw BadRequest('Choose a plan or at least one module');
    if (features.length) {
      const known = await sys.FeatureCatalog.count({ where: { key: features }, transaction });
      if (known !== new Set(features).size) throw BadRequest('Unknown module in request');
    }
    const r = await sys.SubscriptionRequest.create({ tenantId, kind, planId: plan?.id ?? null, billingCycle: plan ? billingCycle ?? 'MONTHLY' : null, employeeCount: employeeCount ?? null, features: [...new Set(features)], message: message ?? null, requestedBy: userId }, { transaction });
    await audit({ transaction, tenantId, actor, action: 'subscription.request_created', entityType: 'subscription_request', entityId: r.id, after: { kind, plan: plan?.code, billingCycle, features }, req });
    const tenant = await sys.Tenant.findByPk(tenantId, { transaction });
    return { r, plan, tenant };
  });
  if (env.SALES_NOTIFY_EMAIL) {
    await enqueueEmail({ to: env.SALES_NOTIFY_EMAIL, template: 'platform.subscription_request', data: { company: out.tenant.name, slug: out.tenant.slug, request: describe(out.r, out.plan), employees: out.r.employeeCount, message: out.r.message, url: `${env.ADMIN_URL}/requests` } });
  }
  return out.r;
}

export async function cancelRequest({ tenantId, id, actor, req }) {
  return systemDb.transaction(async (transaction) => {
    const r = await sys.SubscriptionRequest.findOne({ where: { id, tenantId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!r) throw NotFound('Request');
    if (r.status !== 'PENDING') throw Conflict('Only requests under review can be cancelled');
    await r.update({ status: 'CANCELLED' }, { transaction });
    await audit({ transaction, tenantId, actor, action: 'subscription.request_cancelled', entityType: 'subscription_request', entityId: r.id, req });
    return r;
  });
}

async function lockPending(id, transaction) {
  const r = await sys.SubscriptionRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!r) throw NotFound('Request');
  if (r.status !== 'PENDING') throw Conflict(`This request was already ${r.status.toLowerCase()}`);
  return r;
}

/**
 * @param d.mode  'INVOICE' → issue an invoice; the plan switches on when it's paid (default)
 *                'ACTIVATE' → switch on now and start a paid period (payment received offline, or complimentary)
 */
export async function approveRequest({ id, planCode, billingCycle, mode = 'INVOICE', customAmount, maxEmployees, maxBranches, features = {}, note, actor, req }) {
  const r = await systemDb.transaction((t) => lockPending(id, t)); // fail fast before applying anything
  const tenantId = r.tenantId;
  const requested = r.planId ? await sys.Plan.findByPk(r.planId) : null;
  const plan = planCode ? await sys.Plan.findOne({ where: { code: planCode, status: 'ACTIVE' } }) : requested;
  if (planCode && !plan) throw NotFound('Plan');
  const cycle = billingCycle ?? r.billingCycle ?? 'MONTHLY';
  if (plan?.isCustom && !(customAmount > 0)) throw BadRequest('Set the negotiated price for this custom plan');

  // Requested modules are switched on unless the reviewer said otherwise.
  const featureChanges = { ...Object.fromEntries(r.features.map((k) => [k, true])), ...features };
  let invoice = null;
  if (plan) {
    const live = await subs.getTenantContext(tenantId, { fresh: true });
    const samePlan = live?.subscription?.planCode === plan.code && live?.subscription?.billingCycle === cycle;
    if (mode === 'ACTIVATE') {
      if (!samePlan || customAmount != null) await subs.changePlan({ tenantId, planCode: plan.code, billingCycle: cycle, customAmount, actor, req });
      await subs.activatePaidPeriod({ tenantId, actor, req });
    } else if (plan.isCustom || customAmount != null) {
      invoice = await createCustomInvoice({ tenantId, planId: plan.id, billingCycle: cycle, amount: customAmount, actor, req });
    } else {
      const res = await checkout({ tenantId, planCode: plan.code, billingCycle: cycle, actor, req });
      if (res.scheduled) mode = 'SCHEDULED_DOWNGRADE';
      invoice = res.invoice ?? null;
    }
  }
  if (maxEmployees !== undefined || maxBranches !== undefined) await subs.setOverrides({ tenantId, maxEmployees, maxBranches, actor, req });
  for (const [featureKey, enabled] of Object.entries(featureChanges)) await subs.setFeatureOverride({ tenantId, featureKey, enabled, reason: `Request ${r.id}`, actor, req });

  const decision = { plan: plan?.code ?? null, billingCycle: plan ? cycle : null, mode, customAmount: customAmount ?? null, maxEmployees, maxBranches, features: featureChanges };
  const done = await systemDb.transaction(async (transaction) => {
    const row = await lockPending(id, transaction);
    await row.update({ status: 'APPROVED', decidedBy: actor.id, decidedAt: new Date(), decisionNote: note ?? null, decision, invoiceId: invoice?.id ?? null }, { transaction });
    await audit({ transaction, tenantId, actor, action: 'subscription.request_approved', entityType: 'subscription_request', entityId: id, after: decision, req });
    return row;
  });
  await tellCompany(tenantId, {
    title: 'Your subscription request was approved',
    body: invoice ? `Invoice ${invoice.number} for NPR ${invoice.total} is ready. Your plan switches on as soon as it is paid.${note ? ` ${note}` : ''}`
      : mode === 'SCHEDULED_DOWNGRADE' ? `Your plan changes at your next renewal.${note ? ` ${note}` : ''}`
        : `Your plan and features are active now.${note ? ` ${note}` : ''}`,
  });
  return { request: done, invoice };
}

export async function rejectRequest({ id, reason, actor, req }) {
  const r = await systemDb.transaction(async (transaction) => {
    const row = await lockPending(id, transaction);
    await row.update({ status: 'REJECTED', decidedBy: actor.id, decidedAt: new Date(), decisionNote: reason }, { transaction });
    await audit({ transaction, tenantId: row.tenantId, actor, action: 'subscription.request_rejected', entityType: 'subscription_request', entityId: id, after: { reason }, req });
    return row;
  });
  await tellCompany(r.tenantId, { title: 'Your subscription request was not approved', body: reason });
  return r;
}

export async function listRequests({ status, page = 1, pageSize = 25 }) {
  const { rows, count } = await sys.SubscriptionRequest.findAndCountAll({
    where: status ? { status } : {}, order: [['status', 'DESC'], ['createdAt', 'DESC']], limit: pageSize, offset: (page - 1) * pageSize,
    include: [{ model: sys.Plan, as: 'plan', attributes: ['code', 'name', 'isCustom'] }, { model: sys.Tenant, as: 'tenant', attributes: ['id', 'name', 'slug', 'status'] }],
  });
  return { rows, meta: { page, pageSize, total: count } };
}

export const pendingCount = () => sys.SubscriptionRequest.count({ where: { status: 'PENDING' } });
