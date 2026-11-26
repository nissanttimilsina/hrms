import { Router } from 'express';
import { listRequests, approveRequest, rejectRequest, pendingCount } from '../../services/subscription-requests.service.js';
import { z } from 'zod';
import { Op, QueryTypes } from 'sequelize';
import { sys, systemDb } from '../../database/index.js';
import { requirePlatformPermission as can, invalidatePlatformPermissions } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { provisionTenant } from '../../services/provisioning.service.js';
import { markInvoicePaid, markPaymentFailed, voidInvoice, issueCreditNote } from '../../services/billing.service.js';
import { renderInvoicePdf } from '../../services/invoice-pdf.service.js';
import { getAllSettings, setSetting, PLATFORM_DEFAULTS } from '../../services/settings.service.js';
import { hashPassword, passwordPolicy } from '../../services/password.service.js';
import { revokeAllForUser } from '../../services/auth.service.js';
import { audit, platformActor } from '../../services/audit.service.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { env } from '../../config/env.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta, searchWhere } from '../../utils/http.js';
import { NotFound, BadRequest, Conflict } from '../../utils/errors.js';

/** Super Admin: dashboard, CRM, CMS, billing, coupons, support, settings, staff. Mounted under /admin (already authenticated). */
export const commercialAdminRouter = Router();
const idParam = { params: z.object({ id: z.string().uuid() }) };
const q = (sql, replacements = {}) => systemDb.query(sql, { replacements, type: QueryTypes.SELECT });

// =========================================================================== dashboard
commercialAdminRouter.get('/dashboard', can('tenants:view'), validate({
  query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), plan: z.string().max(30).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const to = req.query.to ?? new Date();
  const from = req.query.from ?? new Date(to.getTime() - 365 * 86_400_000);
  const plan = req.query.plan ?? null;
  const r = { from, to, plan };
  const planFilter = 'AND (CAST(:plan AS text) IS NULL OR p.code = :plan)';
  const [tenants] = await q(`SELECT count(*)::int total,
      count(*) FILTER (WHERE status='ACTIVE')::int active, count(*) FILTER (WHERE status='SUSPENDED')::int suspended,
      count(*) FILTER (WHERE status='PENDING')::int pending FROM tenants`);
  const [subs] = await q(`SELECT
      count(*) FILTER (WHERE s.status='TRIAL')::int trial,
      count(*) FILTER (WHERE s.status IN ('ACTIVE','PAST_DUE') AND s.payment_status='PAID')::int paying,
      count(*) FILTER (WHERE s.status IN ('GRACE_PERIOD','SUSPENDED'))::int at_risk,
      count(*) FILTER (WHERE s.current_period_end BETWEEN now() AND now() + interval '14 days' AND s.status NOT IN ('CANCELLED','EXPIRED'))::int expiring,
      COALESCE(sum(CASE WHEN s.billing_cycle='ANNUAL' THEN s.amount/12 ELSE s.amount END)
        FILTER (WHERE s.status IN ('ACTIVE','PAST_DUE') AND s.payment_status='PAID'), 0)::float mrr,
      count(*) FILTER (WHERE s.created_at BETWEEN :from AND :to)::int new_subscriptions
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE true ${planFilter}`, r);
  const [churn] = await q(`SELECT count(*)::int cancellations FROM subscription_events
      WHERE to_status IN ('CANCELLED','EXPIRED','SUSPENDED') AND created_at BETWEEN :from AND :to`, r);
  const [money] = await q(`SELECT
      COALESCE(sum(total) FILTER (WHERE status='OPEN'),0)::float outstanding, count(*) FILTER (WHERE status='OPEN')::int open_invoices,
      COALESCE(sum(CASE WHEN kind='CREDIT_NOTE' THEN -total ELSE total END) FILTER (WHERE status IN ('PAID','REFUNDED') AND paid_at BETWEEN :from AND :to),0)::float revenue
    FROM invoices`, r);
  const [pay] = await q("SELECT count(*)::int pending_verification FROM payments WHERE status='PENDING_VERIFICATION'");
  const [leads] = await q(`SELECT count(*)::int total, count(*) FILTER (WHERE status='WON')::int won,
      count(*) FILTER (WHERE status NOT IN ('WON','LOST'))::int open FROM leads WHERE created_at BETWEEN :from AND :to`, r);
  const [emp] = await q("SELECT count(*)::int employees FROM employees WHERE deleted_at IS NULL AND status <> 'TERMINATED'");

  const revenueByMonth = await q(`SELECT to_char(date_trunc('month', paid_at),'YYYY-MM') AS month,
      sum(CASE WHEN kind='CREDIT_NOTE' THEN -total ELSE total END)::float amount
    FROM invoices WHERE status IN ('PAID','REFUNDED') AND paid_at BETWEEN :from AND :to GROUP BY 1 ORDER BY 1`, r);
  const tenantGrowth = await q(`SELECT to_char(date_trunc('month', created_at),'YYYY-MM') AS month, count(*)::int count
    FROM tenants WHERE created_at BETWEEN :from AND :to GROUP BY 1 ORDER BY 1`, r);
  const churnByMonth = await q(`SELECT to_char(date_trunc('month', created_at),'YYYY-MM') AS month, count(*)::int count
    FROM subscription_events WHERE to_status IN ('CANCELLED','EXPIRED','SUSPENDED') AND created_at BETWEEN :from AND :to GROUP BY 1 ORDER BY 1`, r);
  const employeeGrowth = await q(`SELECT to_char(date_trunc('month', created_at),'YYYY-MM') AS month, count(*)::int count
    FROM employees WHERE created_at BETWEEN :from AND :to GROUP BY 1 ORDER BY 1`, r);
  const leadSources = await q(`SELECT source, count(*)::int total, count(*) FILTER (WHERE status='WON')::int won
    FROM leads WHERE created_at BETWEEN :from AND :to GROUP BY source ORDER BY total DESC`, r);
  const planDistribution = await q(`SELECT p.code, p.name, count(*)::int count FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.status NOT IN ('CANCELLED','EXPIRED') GROUP BY p.code, p.name, p.sort_order ORDER BY p.sort_order`);
  const moduleUsage = await q(`SELECT f.key, f.name, count(DISTINCT s.tenant_id)::int tenants
    FROM subscriptions s JOIN plan_entitlements e ON e.plan_id = s.plan_id AND e.enabled JOIN feature_catalog f ON f.id = e.feature_id
    WHERE s.status NOT IN ('CANCELLED','EXPIRED') AND NOT f.is_core GROUP BY f.key, f.name ORDER BY tenants DESC LIMIT 10`);
  const recentTenants = await q(`SELECT t.id, t.name, t.slug, t.status, t.created_at, p.code plan, s.status subscription_status
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status NOT IN ('CANCELLED','EXPIRED')
    LEFT JOIN plans p ON p.id = s.plan_id ORDER BY t.created_at DESC LIMIT 8`);
  const recentActivity = await sys.AuditLog.findAll({ where: { actorType: { [Op.in]: ['PLATFORM_USER', 'SYSTEM'] } }, order: [['createdAt', 'DESC']], limit: 10 });

  return ok(res, {
    range: { from, to },
    kpis: {
      tenants: tenants.total, activeTenants: tenants.active, suspendedTenants: tenants.suspended, pendingTenants: tenants.pending,
      trialTenants: subs.trial, payingTenants: subs.paying, atRisk: subs.at_risk, expiringSoon: subs.expiring,
      mrr: Math.round(subs.mrr * 100) / 100, arr: Math.round(subs.mrr * 1200) / 100, newSubscriptions: subs.new_subscriptions,
      cancellations: churn.cancellations, revenue: money.revenue, outstanding: money.outstanding, openInvoices: money.open_invoices,
      pendingPayments: pay.pending_verification, pendingRequests: await pendingCount(), leads: leads.total, openLeads: leads.open,
      conversionRate: leads.total ? Math.round((leads.won / leads.total) * 1000) / 10 : 0, employees: emp.employees,
    },
    charts: { revenueByMonth, tenantGrowth, churnByMonth, employeeGrowth, leadSources, planDistribution, moduleUsage },
    recentTenants, recentActivity,
  });
}));

// =========================================================================== CRM
const LEAD_STATUS = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_SCHEDULED', 'PROPOSAL', 'WON', 'LOST'];
commercialAdminRouter.get('/leads', can('crm:view'), validate({
  query: listQuery(['createdAt', 'followUpAt', 'updatedAt'], { status: z.enum(LEAD_STATUS).optional(), source: z.string().max(30).optional(), assignedTo: z.string().uuid().optional(), due: z.coerce.boolean().optional() }),
}), asyncHandler(async (req, res) => {
  const x = req.query;
  const where = {
    ...searchWhere(x.search, ['name', 'company', 'email']), ...(x.status && { status: x.status }), ...(x.source && { source: x.source }),
    ...(x.assignedTo && { assignedTo: x.assignedTo }), ...(x.due && { followUpAt: { [Op.lte]: new Date() }, status: { [Op.notIn]: ['WON', 'LOST'] } }),
  };
  const { rows, count } = await sys.Lead.findAndCountAll({ where, ...paginate(x) });
  return ok(res, rows, pageMeta(x, count));
}));

commercialAdminRouter.get('/leads/:id', can('crm:view'), validate(idParam), asyncHandler(async (req, res) => {
  const lead = await sys.Lead.findByPk(req.params.id, { include: [{ model: sys.LeadActivity, as: 'activities', separate: true, order: [['createdAt', 'DESC']] }] });
  if (!lead) throw NotFound('Lead');
  return ok(res, lead);
}));

const leadPatch = z.object({
  status: z.enum(LEAD_STATUS), assignedTo: z.string().uuid().nullable(), followUpAt: z.coerce.date().nullable(), demoAt: z.coerce.date().nullable(),
  estimatedValue: z.number().min(0).nullable(), lostReason: z.string().trim().max(500), interestedPlan: z.string().max(30),
  name: z.string().trim().min(2).max(120), company: z.string().trim().max(160), phone: z.string().trim().max(30), employeeCount: z.number().int().min(1),
}).partial().strict();

commercialAdminRouter.post('/leads', can('crm:manage'), validate({
  body: leadPatch.extend({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email(), source: z.enum(['MANUAL', 'REFERRAL', 'CALLBACK', 'CONTACT']).default('MANUAL'), message: z.string().max(4000).optional() }),
}), asyncHandler(async (req, res) => {
  const lead = await sys.Lead.create(req.body);
  await sys.LeadActivity.create({ leadId: lead.id, type: 'SYSTEM', body: 'Lead created manually', actorId: req.auth.userId });
  return created(res, lead);
}));

commercialAdminRouter.patch('/leads/:id', can('crm:manage'), validate({ ...idParam, body: leadPatch }), asyncHandler(async (req, res) => {
  const lead = await sys.Lead.findByPk(req.params.id);
  if (!lead) throw NotFound('Lead');
  if (req.body.status === 'LOST' && !(req.body.lostReason || lead.lostReason)) throw BadRequest('Record why the deal was lost', [{ path: 'lostReason', message: 'Required when marking lost' }]);
  const before = lead.status;
  await lead.update(req.body);
  if (req.body.status && req.body.status !== before) {
    await sys.LeadActivity.create({ leadId: lead.id, type: 'STATUS_CHANGE', body: `${before} → ${lead.status}${lead.status === 'LOST' ? `: ${lead.lostReason}` : ''}`, actorId: req.auth.userId });
  }
  return ok(res, lead);
}));

commercialAdminRouter.post('/leads/:id/activities', can('crm:manage'), validate({
  ...idParam, body: z.object({ type: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING', 'QUOTE']), body: z.string().trim().min(1).max(5000), meta: z.record(z.string(), z.any()).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  if (!(await sys.Lead.count({ where: { id: req.params.id } }))) throw NotFound('Lead');
  return created(res, await sys.LeadActivity.create({ leadId: req.params.id, ...req.body, actorId: req.auth.userId }));
}));

/** Convert a won lead into a working tenant with a subscription. */
commercialAdminRouter.post('/leads/:id/convert', can('tenants:manage'), validate({
  ...idParam,
  body: z.object({
    slug: z.string().trim().toLowerCase(), planCode: z.string().toUpperCase(), billingCycle: z.enum(['MONTHLY', 'ANNUAL']).default('MONTHLY'),
    trial: z.boolean().default(true), maxEmployees: z.number().int().min(1).optional(), maxBranches: z.number().int().min(1).optional(),
  }).strict(),
}), asyncHandler(async (req, res) => {
  const lead = await sys.Lead.findByPk(req.params.id);
  if (!lead) throw NotFound('Lead');
  if (lead.convertedTenantId) throw Conflict('Lead is already converted');
  const r = await provisionTenant({
    slug: req.body.slug, name: lead.company || lead.name, industry: lead.industry, planCode: req.body.planCode, billingCycle: req.body.billingCycle,
    trial: req.body.trial, owner: { email: lead.email, fullName: lead.name }, actor: platformActor(req), req,
  });
  if (req.body.maxEmployees || req.body.maxBranches) {
    await r.subscription.update({ maxEmployeesOverride: req.body.maxEmployees ?? null, maxBranchesOverride: req.body.maxBranches ?? null });
  }
  await lead.update({ status: 'WON', convertedTenantId: r.tenant.id });
  await sys.LeadActivity.create({ leadId: lead.id, type: 'STATUS_CHANGE', body: `Converted to tenant ${r.tenant.slug} (${req.body.planCode})`, actorId: req.auth.userId });
  return created(res, { tenantId: r.tenant.id, hostname: r.hostname });
}));

commercialAdminRouter.get('/crm/report', can('crm:view'), asyncHandler(async (_req, res) => ok(res, {
  pipeline: await q("SELECT status, count(*)::int count, COALESCE(sum(estimated_value),0)::float value FROM leads GROUP BY status"),
  byRep: await q(`SELECT u.id, u.full_name, count(l.*)::int leads, count(l.*) FILTER (WHERE l.status='WON')::int won
    FROM platform_users u JOIN leads l ON l.assigned_to = u.id GROUP BY u.id, u.full_name ORDER BY won DESC`),
  lostReasons: await q("SELECT lost_reason reason, count(*)::int count FROM leads WHERE status='LOST' GROUP BY 1 ORDER BY 2 DESC LIMIT 10"),
  sources: await q("SELECT source, count(*)::int total, count(*) FILTER (WHERE status='WON')::int won FROM leads GROUP BY 1 ORDER BY 2 DESC"),
})));

commercialAdminRouter.get('/newsletter', can('crm:view'), asyncHandler(async (_req, res) =>
  ok(res, await sys.NewsletterSubscriber.findAll({ where: { unsubscribedAt: null }, order: [['createdAt', 'DESC']], limit: 5000 }))));

// =========================================================================== CMS
const CMS_TYPES = ['PAGE', 'BLOG_POST', 'TESTIMONIAL', 'FAQ', 'CUSTOMER_LOGO', 'ANNOUNCEMENT', 'FEATURE', 'INDUSTRY', 'CHANGELOG', 'SETTING'];
const cmsBody = z.object({
  type: z.enum(CMS_TYPES), slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase-words-with-hyphens').max(120), locale: z.enum(['en', 'ne']).default('en'),
  title: z.string().trim().min(1).max(200), summary: z.string().max(1000).nullish(), body: z.string().max(200_000).nullish(),
  data: z.record(z.string(), z.any()).default({}), seo: z.object({ title: z.string().max(70), description: z.string().max(170), image: z.string().url() }).partial().default({}),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'), publishAt: z.coerce.date().nullish(), sortOrder: z.number().int().default(0),
}).strict();

commercialAdminRouter.get('/cms', can('cms:manage'), validate({ query: listQuery(['sortOrder', 'updatedAt', 'createdAt'], { type: z.enum(CMS_TYPES).optional(), status: z.string().optional(), locale: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const x = req.query;
    const where = { ...searchWhere(x.search, ['title', 'slug']), ...(x.type && { type: x.type }), ...(x.status && { status: x.status }), ...(x.locale && { locale: x.locale }) };
    const { rows, count } = await sys.CmsEntry.findAndCountAll({ where, ...paginate(x) });
    return ok(res, rows, pageMeta(x, count));
  }));
commercialAdminRouter.get('/cms/:id', can('cms:manage'), validate(idParam), asyncHandler(async (req, res) => {
  const e = await sys.CmsEntry.findByPk(req.params.id);
  if (!e) throw NotFound('Entry');
  return ok(res, e);
}));
commercialAdminRouter.post('/cms', can('cms:manage'), validate({ body: cmsBody }), asyncHandler(async (req, res) => {
  const e = await sys.CmsEntry.create({ ...req.body, authorId: req.auth.userId });
  await audit({ actor: platformActor(req), action: 'cms.create', entityType: 'cms', entityId: e.id, after: { type: e.type, slug: e.slug, status: e.status }, req });
  return created(res, e);
}));
commercialAdminRouter.patch('/cms/:id', can('cms:manage'), validate({ ...idParam, body: cmsBody.partial() }), asyncHandler(async (req, res) => {
  const e = await sys.CmsEntry.findByPk(req.params.id);
  if (!e) throw NotFound('Entry');
  await e.update(req.body);
  await audit({ actor: platformActor(req), action: 'cms.update', entityType: 'cms', entityId: e.id, after: { status: e.status }, req });
  return ok(res, e);
}));
commercialAdminRouter.delete('/cms/:id', can('cms:manage'), validate(idParam), asyncHandler(async (req, res) => {
  const n = await sys.CmsEntry.destroy({ where: { id: req.params.id } });
  if (!n) throw NotFound('Entry');
  await audit({ actor: platformActor(req), action: 'cms.delete', entityType: 'cms', entityId: req.params.id, req });
  return ok(res, { deleted: true });
}));

// =========================================================================== billing (finance)
commercialAdminRouter.get('/invoices', can('billing:view'), validate({ query: listQuery(['issuedAt', 'dueAt', 'total'], { status: z.string().optional(), tenantId: z.string().uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const x = req.query;
    const where = { ...(x.status && { status: x.status }), ...(x.tenantId && { tenantId: x.tenantId }), ...(x.search && { number: { [Op.iLike]: `%${x.search}%` } }) };
    const { rows, count } = await sys.Invoice.findAndCountAll({ where, include: [{ model: sys.Tenant, as: 'tenant', attributes: ['id', 'name', 'slug'] }], ...paginate(x) });
    return ok(res, rows, pageMeta(x, count));
  }));
commercialAdminRouter.get('/invoices/:id', can('billing:view'), validate(idParam), asyncHandler(async (req, res) => {
  const inv = await sys.Invoice.findByPk(req.params.id, { include: [{ model: sys.InvoiceItem, as: 'items' }, { model: sys.Payment, as: 'payments' }, { model: sys.Tenant, as: 'tenant', attributes: ['id', 'name', 'slug'] }] });
  if (!inv) throw NotFound('Invoice');
  return ok(res, inv);
}));
commercialAdminRouter.get('/invoices/:id/pdf', can('billing:view'), validate(idParam), asyncHandler(async (req, res) => {
  const inv = await sys.Invoice.findByPk(req.params.id, { include: [{ model: sys.InvoiceItem, as: 'items' }, { model: sys.Payment, as: 'payments' }] });
  if (!inv) throw NotFound('Invoice');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${inv.number}.pdf"` });
  (await renderInvoicePdf(inv, inv.items, inv.payments)).pipe(res);
}));
commercialAdminRouter.post('/invoices/:id/void', can('billing:manage'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict() }),
  asyncHandler(async (req, res) => ok(res, await voidInvoice({ invoiceId: req.params.id, reason: req.body.reason, actor: platformActor(req), req }))));
commercialAdminRouter.post('/invoices/:id/credit-note', can('billing:manage'), validate({ ...idParam, body: z.object({ amount: z.number().positive(), reason: z.string().trim().min(3).max(500) }).strict() }),
  asyncHandler(async (req, res) => created(res, await issueCreditNote({ invoiceId: req.params.id, ...req.body, actor: platformActor(req), req }))));

commercialAdminRouter.get('/payments', can('billing:view'), validate({ query: listQuery(['createdAt'], { status: z.string().optional(), provider: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const x = req.query;
    const { rows, count } = await sys.Payment.findAndCountAll({
      where: { ...(x.status && { status: x.status }), ...(x.provider && { provider: x.provider }) },
      include: [{ model: sys.Tenant, as: 'tenant', attributes: ['id', 'name', 'slug'] }, { model: sys.Invoice, as: 'invoice', attributes: ['id', 'number', 'total'] }], ...paginate(x),
    });
    return ok(res, rows, pageMeta(x, count));
  }));
/** Manual verification of a bank transfer (or recording an offline/manual payment). */
commercialAdminRouter.post('/payments/:id/approve', can('billing:manage'), validate({ ...idParam, body: z.object({ providerRef: z.string().trim().min(3).max(120), note: z.string().max(500).optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const p = await sys.Payment.findByPk(req.params.id);
    if (!p) throw NotFound('Payment');
    if (p.status !== 'PENDING_VERIFICATION') throw Conflict('Only payments awaiting verification can be approved');
    const r = await markInvoicePaid({ paymentId: p.id, providerRef: req.body.providerRef, providerData: { note: req.body.note }, actor: platformActor(req), req });
    return ok(res, { invoice: r.invoice.number, status: 'SUCCEEDED' });
  }));
commercialAdminRouter.post('/payments/:id/reject', can('billing:manage'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict() }),
  asyncHandler(async (req, res) => {
    const p = await sys.Payment.findByPk(req.params.id, { include: [{ model: sys.Invoice, as: 'invoice' }] });
    if (!p || p.status !== 'PENDING_VERIFICATION') throw Conflict('Only payments awaiting verification can be rejected');
    await markPaymentFailed(p.id, req.body.reason);
    await audit({ tenantId: p.tenantId, actor: platformActor(req), action: 'payment.reject', entityType: 'payment', entityId: p.id, after: req.body, req });
    const owner = await sys.User.findOne({ where: { tenantId: p.tenantId, status: 'ACTIVE' }, order: [['createdAt', 'ASC']] });
    if (owner) await enqueueEmail({ tenantId: p.tenantId, to: owner.email, template: 'billing.payment_failed', data: { number: p.invoice.number, reason: req.body.reason } });
    return ok(res, { status: 'FAILED' });
  }));
/** Record an offline payment against an open invoice (cash/cheque). */
commercialAdminRouter.post('/invoices/:id/record-payment', can('billing:manage'), validate({ ...idParam, body: z.object({ providerRef: z.string().trim().min(3).max(120), note: z.string().max(500).optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const inv = await sys.Invoice.findByPk(req.params.id);
    if (!inv || inv.status !== 'OPEN') throw Conflict('Invoice is not open');
    const p = await sys.Payment.create({ tenantId: inv.tenantId, invoiceId: inv.id, provider: 'MANUAL', amount: inv.total, reference: crypto.randomUUID(), status: 'PENDING_VERIFICATION', proofNote: req.body.note });
    await markInvoicePaid({ paymentId: p.id, providerRef: req.body.providerRef, actor: platformActor(req), req });
    return ok(res, { status: 'PAID' });
  }));

// =========================================================================== coupons
const couponBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/), description: z.string().max(300).optional(),
  percentOff: z.number().gt(0).max(100).optional(), amountOff: z.number().positive().optional(),
  planCodes: z.array(z.string()).default([]), billingCycles: z.array(z.enum(['MONTHLY', 'ANNUAL'])).default([]),
  validFrom: z.coerce.date().optional(), validUntil: z.coerce.date().optional(), maxRedemptions: z.number().int().positive().optional(), isActive: z.boolean().default(true),
}).strict().refine((c) => (c.percentOff == null) !== (c.amountOff == null), 'Set either percentOff or amountOff');
commercialAdminRouter.get('/coupons', can('billing:view'), asyncHandler(async (_req, res) => ok(res, await sys.Coupon.findAll({ order: [['createdAt', 'DESC']] }))));
commercialAdminRouter.post('/coupons', can('billing:manage'), validate({ body: couponBody }), asyncHandler(async (req, res) => {
  const c = await sys.Coupon.create(req.body);
  await audit({ actor: platformActor(req), action: 'coupon.create', entityType: 'coupon', entityId: c.id, after: req.body, req });
  return created(res, c);
}));
commercialAdminRouter.patch('/coupons/:id', can('billing:manage'), validate({ ...idParam, body: z.object({ isActive: z.boolean(), validUntil: z.coerce.date().nullable(), maxRedemptions: z.number().int().positive().nullable(), description: z.string().max(300) }).partial().strict() }),
  asyncHandler(async (req, res) => {
    const c = await sys.Coupon.findByPk(req.params.id);
    if (!c) throw NotFound('Coupon');
    await c.update(req.body);
    return ok(res, c);
  }));

// =========================================================================== support desk
commercialAdminRouter.get('/support', can('support:view'), validate({ query: listQuery(['createdAt', 'updatedAt', 'firstResponseDueAt'], { status: z.string().optional(), priority: z.string().optional(), assignedTo: z.string().uuid().optional(), breached: z.coerce.boolean().optional() }) }),
  asyncHandler(async (req, res) => {
    const x = req.query;
    const where = {
      ...(x.status && { status: x.status }), ...(x.priority && { priority: x.priority }), ...(x.assignedTo && { assignedTo: x.assignedTo }),
      ...(x.breached && { firstRespondedAt: null, firstResponseDueAt: { [Op.lt]: new Date() } }), ...searchWhere(x.search, ['subject']),
    };
    const { rows, count } = await sys.SupportTicket.findAndCountAll({ where, include: [{ model: sys.Tenant, as: 'tenant', attributes: ['id', 'name', 'slug'] }], ...paginate(x) });
    return ok(res, rows, pageMeta(x, count));
  }));
commercialAdminRouter.get('/support/:id', can('support:view'), validate(idParam), asyncHandler(async (req, res) => {
  const t = await sys.SupportTicket.findByPk(req.params.id, { include: [{ model: sys.SupportMessage, as: 'messages', separate: true, order: [['createdAt', 'ASC']] }, { model: sys.Tenant, as: 'tenant', attributes: ['id', 'name', 'slug'] }] });
  if (!t) throw NotFound('Ticket');
  return ok(res, t);
}));
commercialAdminRouter.post('/support/:id/messages', can('support:manage'), validate({ ...idParam, body: z.object({ body: z.string().trim().min(1).max(10_000), isInternal: z.boolean().default(false), status: z.enum(['IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED']).optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const t = await sys.SupportTicket.findByPk(req.params.id, { include: [{ model: sys.Tenant, as: 'tenant' }] });
    if (!t) throw NotFound('Ticket');
    const msg = await sys.SupportMessage.create({ tenantId: t.tenantId, ticketId: t.id, authorType: 'PLATFORM_USER', authorId: req.auth.userId, body: req.body.body, isInternal: req.body.isInternal });
    const patch = { ...(req.body.status && { status: req.body.status }), ...(req.body.status === 'RESOLVED' && { resolvedAt: new Date() }) };
    if (!req.body.isInternal && !t.firstRespondedAt) patch.firstRespondedAt = new Date();
    if (!req.body.isInternal && !req.body.status && t.status === 'OPEN') patch.status = 'IN_PROGRESS';
    await t.update(patch);
    if (!req.body.isInternal) {
      const creator = await sys.User.findByPk(t.createdBy);
      if (creator) await enqueueEmail({ tenantId: t.tenantId, to: creator.email, template: 'support.reply', data: { number: t.number, subject: t.subject, body: req.body.body, url: `https://${t.tenant.slug}.${env.ROOT_DOMAIN}/support/${t.id}` } });
    }
    return created(res, msg);
  }));
commercialAdminRouter.patch('/support/:id', can('support:manage'), validate({ ...idParam, body: z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']), assignedTo: z.string().uuid().nullable() }).partial().strict() }),
  asyncHandler(async (req, res) => {
    const t = await sys.SupportTicket.findByPk(req.params.id);
    if (!t) throw NotFound('Ticket');
    await t.update({ ...req.body, ...(req.body.status === 'RESOLVED' && { resolvedAt: new Date() }) });
    return ok(res, t);
  }));

// =========================================================================== platform settings
commercialAdminRouter.get('/settings', can('settings:manage'), asyncHandler(async (_req, res) => ok(res, await getAllSettings())));
commercialAdminRouter.put('/settings/:key', can('settings:manage'), validate({ params: z.object({ key: z.enum(Object.keys(PLATFORM_DEFAULTS)) }), body: z.object({ value: z.any() }).strict() }),
  asyncHandler(async (req, res) => {
    const def = PLATFORM_DEFAULTS[req.params.key];
    const v = req.body.value;
    if (v === undefined || typeof v !== typeof def || Array.isArray(v) !== Array.isArray(def)) throw BadRequest(`Setting ${req.params.key} must be of type ${Array.isArray(def) ? 'array' : typeof def}`);
    if (req.params.key === 'billing.vat_rate' && (v < 0 || v > 50)) throw BadRequest('VAT rate must be between 0 and 50');
    await setSetting(req.params.key, v);
    await audit({ actor: platformActor(req), action: 'settings.update', entityType: 'setting', entityId: req.params.key, after: { value: v }, req });
    return ok(res, { key: req.params.key, value: v });
  }));

// =========================================================================== platform staff
commercialAdminRouter.get('/staff', can('platform_users:manage'), asyncHandler(async (_req, res) => ok(res, await sys.PlatformUser.findAll({
  attributes: ['id', 'email', 'fullName', 'status', 'lastLoginAt', 'createdAt'], include: [{ model: sys.PlatformRole, as: 'roles', attributes: ['key', 'name'], through: { attributes: [] } }], order: [['createdAt', 'ASC']],
}))));
commercialAdminRouter.get('/staff/roles', can('platform_users:manage'), asyncHandler(async (_req, res) => ok(res, await sys.PlatformRole.findAll({ attributes: ['id', 'key', 'name'] }))));
commercialAdminRouter.post('/staff', can('platform_users:manage'), validate({
  body: z.object({ email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(120), password: passwordPolicy, roleKeys: z.array(z.string()).min(1) }).strict(),
}), asyncHandler(async (req, res) => {
  const roles = await sys.PlatformRole.findAll({ where: { key: req.body.roleKeys } });
  if (roles.length !== req.body.roleKeys.length) throw BadRequest('Unknown role');
  const u = await systemDb.transaction(async (transaction) => {
    const user = await sys.PlatformUser.create({ email: req.body.email, fullName: req.body.fullName, passwordHash: await hashPassword(req.body.password), status: 'ACTIVE' }, { transaction });
    await sys.PlatformUserRole.bulkCreate(roles.map((r) => ({ userId: user.id, roleId: r.id })), { transaction });
    await audit({ transaction, actor: platformActor(req), action: 'staff.create', entityType: 'platform_user', entityId: user.id, after: { email: user.email, roles: req.body.roleKeys }, req });
    return user;
  });
  return created(res, { id: u.id, email: u.email });
}));
commercialAdminRouter.patch('/staff/:id', can('platform_users:manage'), validate({ ...idParam, body: z.object({ status: z.enum(['ACTIVE', 'DISABLED']), roleKeys: z.array(z.string()).min(1) }).partial().strict() }),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.auth.userId) throw Conflict('You cannot change your own access');
    const u = await sys.PlatformUser.findByPk(req.params.id);
    if (!u) throw NotFound('Staff member');
    await systemDb.transaction(async (transaction) => {
      if (req.body.status) await u.update({ status: req.body.status }, { transaction });
      if (req.body.roleKeys) {
        const roles = await sys.PlatformRole.findAll({ where: { key: req.body.roleKeys }, transaction });
        await sys.PlatformUserRole.destroy({ where: { userId: u.id }, transaction });
        await sys.PlatformUserRole.bulkCreate(roles.map((r) => ({ userId: u.id, roleId: r.id })), { transaction });
      }
      await audit({ transaction, actor: platformActor(req), action: 'staff.update', entityType: 'platform_user', entityId: u.id, after: req.body, req });
    });
    await invalidatePlatformPermissions(u.id);
    if (req.body.status === 'DISABLED') await revokeAllForUser({ subjectType: 'PLATFORM', userId: u.id, reason: 'disabled' });
    return ok(res, { updated: true });
  }));

// =========================================================================== subscription requests
commercialAdminRouter.get('/subscription-requests', can('subscriptions:view'), validate({
  query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }),
}), asyncHandler(async (req, res) => {
  const { rows, meta } = await listRequests(req.query);
  return ok(res, rows, meta);
}));

commercialAdminRouter.post('/subscription-requests/:id/approve', can('subscriptions:manage'), validate({
  ...idParam,
  body: z.object({
    planCode: z.string().trim().toUpperCase().optional(),
    billingCycle: z.enum(['MONTHLY', 'ANNUAL']).optional(),
    mode: z.enum(['INVOICE', 'ACTIVATE']).default('INVOICE'),
    customAmount: z.number().positive().max(100_000_000).optional(),
    maxEmployees: z.number().int().min(0).nullable().optional(),
    maxBranches: z.number().int().min(0).nullable().optional(),
    features: z.record(z.string().regex(/^[a-z_]+$/), z.boolean().nullable()).default({}),
    note: z.string().trim().max(1000).optional(),
  }).strict(),
}), asyncHandler(async (req, res) => ok(res, await approveRequest({ id: req.params.id, ...req.body, actor: platformActor(req), req }))));

commercialAdminRouter.post('/subscription-requests/:id/reject', can('subscriptions:manage'), validate({
  ...idParam, body: z.object({ reason: z.string().trim().min(5).max(1000) }).strict(),
}), asyncHandler(async (req, res) => ok(res, await rejectRequest({ id: req.params.id, reason: req.body.reason, actor: platformActor(req), req }))));
