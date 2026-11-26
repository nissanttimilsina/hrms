import { Router } from 'express';
import { z } from 'zod';
import { app, sys } from '../../database/index.js';
import { env } from '../../config/env.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { checkout, startPayment, verifyProviderPayment, markPaymentFailed, planCheckout, workspaceUrl } from '../../services/billing.service.js';
import { esewa } from '../../services/payments/providers.js';
import { renderInvoicePdf } from '../../services/invoice-pdf.service.js';
import { publicPlanCatalogue } from '../subscriptions/subscription.routes.js';
import { priceBreakdown } from '../../services/pricing.service.js';
import { getSetting } from '../../services/settings.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta } from '../../utils/http.js';
import { NotFound } from '../../utils/errors.js';
import { createRequest, cancelRequest } from '../../services/subscription-requests.service.js';
import { logger } from '../../utils/logger.js';

// =========================================================================== tenant billing (mounted with allowWhenReadOnly)
export const tenantBillingRouter = Router();
const CYCLE = z.enum(['MONTHLY', 'ANNUAL']);
const idParam = { params: z.object({ id: z.string().uuid() }) };

tenantBillingRouter.get('/', requirePermission('subscription:view'), asyncHandler(async (req, res) => {
  const { ctx, access } = req.auth;
  const [plans, openInvoices] = await Promise.all([
    publicPlanCatalogue(),
    req.tx((t) => app.Invoice.findAll({ where: { status: 'OPEN' }, order: [['issuedAt', 'DESC']], transaction: t })),
  ]);
  const pending = ctx.subscription?.pendingPlanId ? await sys.Plan.findByPk(ctx.subscription.pendingPlanId, { attributes: ['code', 'name'] }) : null;
  return ok(res, {
    subscription: ctx.subscription, access, plans, openInvoices, pendingDowngrade: pending,
    providers: env.paymentProviders, bankAccounts: env.paymentProviders.includes('BANK_TRANSFER') ? await getSetting('billing.bank_accounts') : [],
    profile: (await req.tx((t) => app.TenantSetting.findOne({ where: { key: 'billing.profile' }, transaction: t })))?.value ?? {},
  });
}));

tenantBillingRouter.put('/profile', requirePermission('subscription:manage'), validate({
  body: z.object({
    name: z.string().trim().min(2).max(200), pan: z.string().trim().regex(/^\d{9}$/, 'PAN must be 9 digits').optional().or(z.literal('')),
    address: z.string().trim().max(300).optional(), email: z.string().trim().email().optional(), phone: z.string().trim().max(30).optional(),
  }).strict(),
}), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const [row] = await app.TenantSetting.findOrCreate({ where: { key: 'billing.profile' }, defaults: { tenantId: req.auth.tenantId, value: req.body }, transaction: t });
    await row.update({ value: req.body }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'billing.profile_update', after: req.body, req });
  });
  return ok(res, req.body);
}));

/** Preview what a plan change will cost before committing. */
tenantBillingRouter.post('/preview', requirePermission('subscription:manage'), validate({
  body: z.object({ planCode: z.string().toUpperCase(), billingCycle: CYCLE }).strict(),
}), asyncHandler(async (req, res) => {
  const p = await planCheckout({ tenantId: req.auth.tenantId, ...req.body });
  if (p.kind === 'DOWNGRADE') return ok(res, { kind: p.kind, plan: p.plan.code, effectiveAt: p.effectiveAt });
  return ok(res, { kind: p.kind, plan: p.plan.code, description: p.description, periodStart: p.periodStart, periodEnd: p.periodEnd, ...(await priceBreakdown(p.subtotal, null)) });
}));

tenantBillingRouter.post('/checkout', requirePermission('subscription:manage'), validate({
  body: z.object({ planCode: z.string().toUpperCase(), billingCycle: CYCLE, couponCode: z.string().trim().max(30).optional() }).strict(),
}), asyncHandler(async (req, res) => created(res, await checkout({ tenantId: req.auth.tenantId, ...req.body, actor: tenantActor(req), req }))));

tenantBillingRouter.post('/cancel-downgrade', requirePermission('subscription:manage'), asyncHandler(async (req, res) => {
  await sys.Subscription.update({ pendingPlanId: null }, { where: { id: req.auth.ctx.subscription.id, tenantId: req.auth.tenantId } });
  await audit({ tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'subscription.downgrade_cancelled', req });
  return ok(res, { cancelled: true });
}));

tenantBillingRouter.get('/invoices', requirePermission('subscription:view'), validate({ query: listQuery(['issuedAt']) }), asyncHandler(async (req, res) => {
  const q = req.query;
  const { rows, count } = await req.tx((t) => app.Invoice.findAndCountAll({ ...paginate(q), transaction: t }));
  return ok(res, rows, pageMeta(q, count));
}));

tenantBillingRouter.get('/invoices/:id', requirePermission('subscription:view'), validate(idParam), asyncHandler(async (req, res) => {
  const inv = await req.tx((t) => app.Invoice.findByPk(req.params.id, {
    include: [{ model: app.InvoiceItem, as: 'items' }, { model: app.Payment, as: 'payments', attributes: { exclude: ['providerData'] } }], transaction: t,
  }));
  if (!inv) throw NotFound('Invoice');
  return ok(res, inv);
}));

tenantBillingRouter.get('/invoices/:id/pdf', requirePermission('subscription:view'), validate(idParam), asyncHandler(async (req, res) => {
  const inv = await req.tx((t) => app.Invoice.findByPk(req.params.id, { include: [{ model: app.InvoiceItem, as: 'items' }, { model: app.Payment, as: 'payments' }], transaction: t }));
  if (!inv) throw NotFound('Invoice');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${inv.number}.pdf"`, 'Cache-Control': 'private, no-store' });
  (await renderInvoicePdf(inv, inv.items, inv.payments)).pipe(res);
}));

tenantBillingRouter.post('/invoices/:id/pay', requirePermission('subscription:manage'), validate({
  ...idParam,
  body: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('ESEWA') }).strict(),
    z.object({ provider: z.literal('KHALTI') }).strict(),
    z.object({ provider: z.literal('BANK_TRANSFER'), proofNote: z.string().trim().min(5, 'Enter the bank, date and transaction reference').max(1000) }).strict(),
  ]),
}), asyncHandler(async (req, res) => {
  const r = await startPayment({ tenantId: req.auth.tenantId, invoiceId: req.params.id, ...req.body, actor: tenantActor(req), req });
  return created(res, { paymentId: r.payment.id, status: r.payment.status, redirect: r.redirect, bankAccounts: r.bankAccounts });
}));

// =========================================================================== provider return URLs (public, browser redirects)
export const paymentReturnRouter = Router();

async function finish(res, payment, outcome) {
  const tenant = await sys.Tenant.findByPk(payment.tenantId, { attributes: ['slug'] });
  res.redirect(303, `${workspaceUrl(tenant.slug)}/billing?payment=${outcome}&invoice=${payment.invoiceId}`);
}

paymentReturnRouter.get('/esewa/return', asyncHandler(async (req, res) => {
  try {
    if (req.query.failed) {
      const p = await sys.Payment.findOne({ where: { reference: String(req.query.failed), provider: 'ESEWA' } });
      if (!p) throw NotFound('Payment');
      await markPaymentFailed(p.id, 'Cancelled or failed at eSewa');
      return finish(res, p, 'failed');
    }
    const payload = esewa.parseCallback(req.query.data); // authenticity of the redirect
    const p = await sys.Payment.findOne({ where: { reference: payload.transaction_uuid, provider: 'ESEWA' } });
    if (!p) throw NotFound('Payment');
    const v = await verifyProviderPayment(p); // authoritative server-to-server check
    return finish(res, p, v.ok ? 'success' : v.pending ? 'pending' : 'failed');
  } catch (err) {
    logger.warn({ err, query: req.query }, 'eSewa return rejected');
    return res.redirect(303, `${env.APP_URL}/billing?payment=failed`);
  }
}));

paymentReturnRouter.get('/khalti/return', asyncHandler(async (req, res) => {
  try {
    const pidx = String(req.query.pidx || '');
    const p = await sys.Payment.findOne({ where: { providerRef: pidx, provider: 'KHALTI' } });
    if (!p || p.reference !== req.query.purchase_order_id) throw NotFound('Payment');
    const v = await verifyProviderPayment(p);
    return finish(res, p, v.ok ? 'success' : v.pending ? 'pending' : 'failed');
  } catch (err) {
    logger.warn({ err, query: req.query }, 'Khalti return rejected');
    return res.redirect(303, `${env.APP_URL}/billing?payment=failed`);
  }
}));

// ----------------------------------------------------------------------------- plan / Enterprise / module requests
const requestBody = z.object({
  planCode: z.string().trim().toUpperCase().optional(),
  billingCycle: z.enum(['MONTHLY', 'ANNUAL']).optional(),
  employeeCount: z.number().int().min(1).max(100000).optional(),
  features: z.array(z.string().regex(/^[a-z_]+$/)).max(30).default([]),
  message: z.string().trim().max(2000).optional(),
}).strict().refine((b) => b.planCode || b.features.length, 'Choose a plan or at least one module');

tenantBillingRouter.get('/requests', requirePermission('subscription:view'), asyncHandler(async (req, res) => {
  const rows = await req.tx((t) => app.SubscriptionRequest.findAll({ order: [['createdAt', 'DESC']], limit: 20, include: [{ model: app.Plan, as: 'plan', attributes: ['code', 'name'] }], transaction: t }));
  return ok(res, rows);
}));

tenantBillingRouter.post('/requests', requirePermission('subscription:manage'), validate({ body: requestBody }), asyncHandler(async (req, res) => {
  const r = await createRequest({ tenantId: req.auth.tenantId, userId: req.auth.userId, ...req.body, actor: tenantActor(req), req });
  return created(res, r);
}));

tenantBillingRouter.post('/requests/:id/cancel', requirePermission('subscription:manage'), validate({ params: z.object({ id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  return ok(res, await cancelRequest({ tenantId: req.auth.tenantId, id: req.params.id, actor: tenantActor(req), req }));
}));
