import { Op, QueryTypes } from 'sequelize';
import { sys, systemDb } from '../database/index.js';
import { env } from '../config/env.js';
import { addPeriod, currentPrice, invalidateTenantContext } from './subscription.service.js';
import { findValidCoupon, priceBreakdown } from './pricing.service.js';
import { getSetting } from './settings.service.js';
import { audit } from './audit.service.js';
import { esewa, khalti } from './payments/providers.js';
import { enqueueEmail } from '../jobs/queues.js';
import { uuid } from '../utils/crypto.js';
import { BadRequest, Conflict, NotFound } from '../utils/errors.js';

const DAY = 86_400_000;
const LIVE = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'GRACE_PERIOD', 'SUSPENDED'];
const r2 = (n) => Math.round(n * 100) / 100;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
export const workspaceUrl = (slug) => `https://${slug}.${env.ROOT_DOMAIN}`;

async function nextInvoiceNumber(transaction) {
  const [{ n }] = await systemDb.query("SELECT nextval('invoice_number_seq')::int AS n", { type: QueryTypes.SELECT, transaction });
  return `INV-${new Date().getUTCFullYear()}-${String(n).padStart(6, '0')}`;
}

async function billTo(tenant, transaction) {
  const profile = await sys.TenantSetting.findOne({ where: { tenantId: tenant.id, key: 'billing.profile' }, transaction });
  return { name: tenant.legalName || tenant.name, ...(profile?.value ?? {}) };
}

async function currentSubscription(tenantId, transaction) {
  return (await sys.Subscription.findOne({ where: { tenantId, status: { [Op.in]: LIVE } }, include: [{ model: sys.Plan, as: 'plan' }], transaction }))
    ?? (await sys.Subscription.findOne({ where: { tenantId }, order: [['createdAt', 'DESC']], include: [{ model: sys.Plan, as: 'plan' }], transaction }));
}

/**
 * Work out what a checkout for (plan, cycle) means for this tenant right now.
 *   UPGRADE  – paid & in period, same cycle, more expensive: prorated difference, same period end
 *   RENEWAL  – same plan & cycle, paid: next period starting at current end
 *   SUBSCRIPTION – trial / lapsed / unpaid / cycle change: full price, period starts now
 *   DOWNGRADE – paid & in period, cheaper: no invoice; scheduled for renewal
 */
export async function planCheckout({ tenantId, planCode, billingCycle, now = new Date(), transaction }) {
  const sub = await currentSubscription(tenantId, transaction);
  if (!sub) throw NotFound('Subscription');
  const plan = await sys.Plan.findOne({ where: { code: planCode, status: 'ACTIVE' }, transaction });
  if (!plan) throw NotFound('Plan');
  if (plan.contactSales || plan.isCustom) throw BadRequest('This plan is arranged with our sales team. Please contact us.', [{ path: 'planCode', message: 'Contact sales' }]);
  const newPrice = await currentPrice(plan.id, billingCycle, 'NPR', now, transaction);
  if (newPrice == null) throw BadRequest(`${plan.name} is not available for ${billingCycle.toLowerCase()} billing`);

  const paidInPeriod = sub.paymentStatus === 'PAID' && ['ACTIVE', 'PAST_DUE'].includes(sub.status) && sub.currentPeriodEnd > now;
  if (paidInPeriod && billingCycle === sub.billingCycle && plan.id !== sub.planId) {
    const oldPrice = Number(sub.amount);
    if (newPrice < oldPrice) return { kind: 'DOWNGRADE', sub, plan, effectiveAt: sub.currentPeriodEnd };
    if (await getSetting('billing.proration')) {
      const start = addPeriod(sub.currentPeriodEnd, billingCycle, -1);
      const total = sub.currentPeriodEnd - start;
      const fraction = Math.max(0, Math.min(1, (sub.currentPeriodEnd - now) / total));
      return {
        kind: 'UPGRADE', sub, plan, newPrice, periodStart: now, periodEnd: sub.currentPeriodEnd,
        subtotal: r2((newPrice - oldPrice) * fraction),
        description: `Upgrade ${sub.plan.name} → ${plan.name} (prorated ${Math.round(fraction * 100)}% of period to ${ymd(sub.currentPeriodEnd)})`,
      };
    }
  }
  if (paidInPeriod && billingCycle === sub.billingCycle && plan.id === sub.planId) {
    const periodEnd = addPeriod(sub.currentPeriodEnd, billingCycle);
    return { kind: 'RENEWAL', sub, plan, newPrice, periodStart: sub.currentPeriodEnd, periodEnd, subtotal: newPrice,
      description: `${plan.name} plan — ${billingCycle.toLowerCase()} renewal (${ymd(sub.currentPeriodEnd)} – ${ymd(periodEnd)})` };
  }
  const periodEnd = addPeriod(now, billingCycle);
  return { kind: 'SUBSCRIPTION', sub, plan, newPrice, periodStart: now, periodEnd, subtotal: newPrice,
    description: `${plan.name} plan — ${billingCycle.toLowerCase()} (${ymd(now)} – ${ymd(periodEnd)})` };
}

/** Create (or reuse) an open invoice for a checkout. Downgrades are scheduled instead. */
export async function checkout({ tenantId, planCode, billingCycle, couponCode, actor, req }) {
  const result = await systemDb.transaction(async (transaction) => {
    const p = await planCheckout({ tenantId, planCode, billingCycle, transaction });
    if (p.kind === 'DOWNGRADE') {
      await p.sub.update({ pendingPlanId: p.plan.id }, { transaction });
      await sys.SubscriptionEvent.create({ tenantId, subscriptionId: p.sub.id, type: 'downgrade_scheduled', payload: { to: p.plan.code, effectiveAt: p.effectiveAt }, actorType: actor.type, actorId: actor.id }, { transaction });
      await audit({ transaction, tenantId, actor, action: 'subscription.downgrade_scheduled', entityType: 'subscription', entityId: p.sub.id, after: { plan: p.plan.code }, req });
      return { scheduled: true, kind: 'DOWNGRADE', plan: p.plan.code, effectiveAt: p.effectiveAt };
    }
    if (p.subtotal <= 0) throw BadRequest('Nothing to pay for this change');

    // Reuse an identical open invoice instead of creating duplicates.
    const existing = await sys.Invoice.findOne({
      where: { tenantId, status: 'OPEN', kind: p.kind, targetPlanId: p.plan.id, targetCycle: billingCycle, couponCode: couponCode ?? null },
      include: [{ model: sys.InvoiceItem, as: 'items' }], transaction,
    });
    if (existing) return { invoice: existing };

    // Supersede other open checkout invoices that have no payment under verification.
    const others = await sys.Invoice.findAll({ where: { tenantId, status: 'OPEN', kind: { [Op.in]: ['SUBSCRIPTION', 'UPGRADE', 'RENEWAL'] } }, transaction });
    for (const inv of others) {
      const pending = await sys.Payment.count({ where: { invoiceId: inv.id, status: 'PENDING_VERIFICATION' }, transaction });
      if (!pending) await inv.update({ status: 'VOID', voidedAt: new Date(), voidReason: 'superseded' }, { transaction });
    }

    const coupon = await findValidCoupon(couponCode, p.plan.code, billingCycle, transaction);
    const money = await priceBreakdown(p.subtotal, coupon);
    const tenant = await sys.Tenant.findByPk(tenantId, { transaction });
    const invoice = await sys.Invoice.create({
      tenantId, subscriptionId: p.sub.id, number: await nextInvoiceNumber(transaction), status: 'OPEN', kind: p.kind,
      ...money, couponCode: coupon?.code ?? null, targetPlanId: p.plan.id, targetCycle: billingCycle,
      periodStart: p.periodStart, periodEnd: p.periodEnd, billTo: await billTo(tenant, transaction),
      dueAt: new Date(Date.now() + Number(await getSetting('billing.due_days')) * DAY),
    }, { transaction });
    await sys.InvoiceItem.create({ tenantId, invoiceId: invoice.id, description: p.description, quantity: 1, unitAmount: p.subtotal, amount: p.subtotal }, { transaction });
    await audit({ transaction, tenantId, actor, action: 'invoice.create', entityType: 'invoice', entityId: invoice.id, after: { number: invoice.number, total: money.total, kind: p.kind }, req });
    invoice.items = await sys.InvoiceItem.findAll({ where: { invoiceId: invoice.id }, transaction });
    return { invoice, created: true, slug: tenant.slug, email: await ownerEmail(tenantId, transaction) };
  });
  if (result.created) {
    await enqueueEmail({ tenantId, to: result.email, template: 'billing.invoice', data: { number: result.invoice.number, total: result.invoice.total, dueDate: ymd(result.invoice.dueAt), url: `${workspaceUrl(result.slug)}/billing/invoices/${result.invoice.id}` } });
  }
  return result.scheduled ? result : { invoice: result.invoice };
}

async function ownerEmail(tenantId, transaction) {
  const u = await sys.User.findOne({
    where: { tenantId, status: 'ACTIVE' },
    include: [{ model: sys.Role, as: 'roles', where: { key: 'company_owner' }, attributes: [] }],
    order: [['createdAt', 'ASC']], transaction,
  });
  return u?.email;
}

/**
 * Apply a successful payment exactly once (idempotent, row-locked).
 * Marks invoice + payment paid and moves the subscription accordingly.
 */
export async function markInvoicePaid({ paymentId, providerRef, providerData, actor = { type: 'SYSTEM' }, req }) {
  const out = await systemDb.transaction(async (transaction) => {
    const payment = await sys.Payment.findByPk(paymentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!payment) throw NotFound('Payment');
    const invoice = await sys.Invoice.findByPk(payment.invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (payment.status === 'SUCCEEDED') return { already: true, invoice };
    if (invoice.status !== 'OPEN') {
      // Paid twice or invoice voided: record the money, flag for refund review.
      await payment.update({ status: 'SUCCEEDED', providerRef: providerRef ?? payment.providerRef, providerData: { ...payment.providerData, ...providerData, needsReview: `invoice was ${invoice.status}` } }, { transaction });
      await audit({ transaction, tenantId: payment.tenantId, actor, action: 'payment.needs_review', entityType: 'payment', entityId: payment.id, req });
      return { review: true, invoice };
    }
    const now = new Date();
    await payment.update({
      status: 'SUCCEEDED', providerRef: providerRef ?? payment.providerRef, providerData: { ...payment.providerData, ...providerData },
      ...(actor.type === 'PLATFORM_USER' && { verifiedBy: actor.id, verifiedAt: now }),
    }, { transaction });
    await invoice.update({ status: 'PAID', paidAt: now }, { transaction });

    const sub = await sys.Subscription.findByPk(invoice.subscriptionId, { transaction, lock: transaction.LOCK.UPDATE });
    const from = sub.status;
    const plan = await sys.Plan.findByPk(invoice.targetPlanId, { transaction });
    // Custom (Enterprise) plans have no list price: the invoiced subtotal is the negotiated amount.
    const amount = (await currentPrice(plan.id, invoice.targetCycle, 'NPR', now, transaction)) ?? Number(invoice.subtotal);
    const patch = invoice.kind === 'UPGRADE'
      ? { previousPlanId: sub.planId, planId: plan.id, amount }
      : {
        previousPlanId: sub.planId !== plan.id ? sub.planId : sub.previousPlanId, planId: plan.id, billingCycle: invoice.targetCycle,
        amount, status: 'ACTIVE', paymentStatus: 'PAID', currentPeriodEnd: invoice.periodEnd, trialEndsAt: null, graceEndsAt: null,
        pendingPlanId: null, discountAmount: invoice.discount, taxAmount: invoice.tax,
      };
    await sub.update(patch, { transaction });
    await sys.SubscriptionEvent.create({
      tenantId: sub.tenantId, subscriptionId: sub.id, type: invoice.kind === 'UPGRADE' ? 'plan_changed' : 'payment_applied',
      fromStatus: from, toStatus: sub.status, payload: { invoice: invoice.number, plan: plan.code, total: invoice.total },
      actorType: actor.type, actorId: actor.id ?? null,
    }, { transaction });
    if (invoice.couponCode) await sys.Coupon.increment('redemptions', { where: { code: invoice.couponCode }, transaction });
    await audit({ transaction, tenantId: sub.tenantId, actor, action: 'invoice.paid', entityType: 'invoice', entityId: invoice.id, after: { number: invoice.number, provider: payment.provider, total: invoice.total }, req });
    const tenant = await sys.Tenant.findByPk(sub.tenantId, { transaction });
    return { invoice, sub, slug: tenant.slug, email: await ownerEmail(sub.tenantId, transaction) };
  });
  if (!out.already && !out.review) {
    await invalidateTenantContext(out.sub.tenantId);
    await enqueueEmail({ tenantId: out.sub.tenantId, to: out.email, template: 'billing.receipt', data: { number: out.invoice.number, total: out.invoice.total, periodEnd: ymd(out.sub.currentPeriodEnd), url: `${workspaceUrl(out.slug)}/billing/invoices/${out.invoice.id}` } });
  }
  return out;
}

export async function markPaymentFailed(paymentId, reason, data = {}) {
  const p = await sys.Payment.findByPk(paymentId);
  if (!p || p.status === 'SUCCEEDED') return p;
  await p.update({ status: 'FAILED', failureReason: reason, providerData: { ...p.providerData, ...data } });
  return p;
}

// --------------------------------------------------------------------------- starting a payment
export async function startPayment({ tenantId, invoiceId, provider, proofNote, actor, req }) {
  if (!env.paymentProviders.includes(provider)) throw BadRequest(`${provider} payments are not enabled`);
  const invoice = await sys.Invoice.findOne({ where: { id: invoiceId, tenantId } });
  if (!invoice) throw NotFound('Invoice');
  if (invoice.status !== 'OPEN') throw Conflict(`Invoice is ${invoice.status.toLowerCase()}`, 'INVOICE_NOT_OPEN');
  const tenant = await sys.Tenant.findByPk(tenantId);
  if (await sys.Payment.count({ where: { invoiceId, status: 'PENDING_VERIFICATION' } })) {
    throw Conflict('A payment for this invoice is already awaiting verification', 'PAYMENT_PENDING');
  }
  const payment = await sys.Payment.create({
    tenantId, invoiceId, provider, amount: invoice.total, reference: uuid(),
    status: provider === 'BANK_TRANSFER' ? 'PENDING_VERIFICATION' : 'INITIATED', proofNote: proofNote ?? null,
  });
  await audit({ tenantId, actor, action: 'payment.start', entityType: 'payment', entityId: payment.id, after: { provider, amount: invoice.total, invoice: invoice.number }, req });

  const back = `${env.APP_URL}/api/v1/payments`;
  if (provider === 'ESEWA') {
    return { payment, redirect: esewa.buildCheckout({ payment, successUrl: `${back}/esewa/return`, failureUrl: `${back}/esewa/return?failed=${payment.reference}` }) };
  }
  if (provider === 'KHALTI') {
    const owner = await sys.User.findByPk(actor.id);
    const r = await khalti.initiate({
      payment, invoice, tenant, returnUrl: `${back}/khalti/return`, websiteUrl: workspaceUrl(tenant.slug),
      customer: { name: owner?.fullName ?? tenant.name, email: owner?.email },
    });
    await payment.update({ providerRef: r.pidx, providerData: { initiate: r.data } });
    return { payment, redirect: { method: 'GET', url: r.paymentUrl } };
  }
  // Bank transfer: finance verifies manually in the Super Admin portal.
  await enqueueEmail({ tenantId, to: (await sys.User.findByPk(actor.id))?.email, template: 'billing.bank_transfer_received', data: { number: invoice.number } });
  return { payment, bankAccounts: await getSetting('billing.bank_accounts') };
}

/** Verify a provider payment server-side and apply it. Used by return URLs and the reconciliation job. */
export async function verifyProviderPayment(payment) {
  if (payment.status === 'SUCCEEDED') return { ok: true, already: true };
  const v = payment.provider === 'ESEWA'
    ? await esewa.verify({ reference: payment.reference, amount: payment.amount })
    : await khalti.verify({ pidx: payment.providerRef, amount: payment.amount });
  if (v.ok) {
    await markInvoicePaid({ paymentId: payment.id, providerRef: v.providerRef, providerData: { verification: v.data } });
    return { ok: true };
  }
  if (!v.pending) await markPaymentFailed(payment.id, `Provider status: ${v.data?.status ?? 'unknown'}`, { verification: v.data });
  return { ok: false, pending: v.pending };
}

/** Void an open invoice (finance). Paid invoices are corrected with credit notes, never edited. */
export async function voidInvoice({ invoiceId, reason, actor, req }) {
  return systemDb.transaction(async (transaction) => {
    const inv = await sys.Invoice.findByPk(invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!inv) throw NotFound('Invoice');
    if (inv.status !== 'OPEN') throw Conflict('Only open invoices can be voided; issue a credit note for paid invoices');
    await inv.update({ status: 'VOID', voidedAt: new Date(), voidReason: reason }, { transaction });
    await sys.Payment.update({ status: 'CANCELLED' }, { where: { invoiceId, status: { [Op.in]: ['INITIATED', 'PENDING_VERIFICATION'] } }, transaction });
    await audit({ transaction, tenantId: inv.tenantId, actor, action: 'invoice.void', entityType: 'invoice', entityId: inv.id, after: { reason }, req });
    return inv;
  });
}

/** Credit note against a paid invoice (refund record). */
export async function issueCreditNote({ invoiceId, amount, reason, actor, req }) {
  return systemDb.transaction(async (transaction) => {
    const inv = await sys.Invoice.findByPk(invoiceId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!inv || inv.status !== 'PAID') throw BadRequest('Credit notes can only be issued against paid invoices');
    const credited = Number((await sys.Invoice.sum('total', { where: { relatedInvoiceId: inv.id, kind: 'CREDIT_NOTE' }, transaction })) ?? 0);
    if (amount + credited > Number(inv.total) + 0.001) throw BadRequest('Credit exceeds the invoice total');
    const subtotal = r2(amount / (1 + Number(inv.taxRate) / 100));
    const cn = await sys.Invoice.create({
      tenantId: inv.tenantId, subscriptionId: inv.subscriptionId, number: await nextInvoiceNumber(transaction), status: 'PAID', kind: 'CREDIT_NOTE',
      subtotal, discount: 0, taxRate: inv.taxRate, tax: r2(amount - subtotal), total: amount, billTo: inv.billTo,
      dueAt: new Date(), paidAt: new Date(), relatedInvoiceId: inv.id,
    }, { transaction });
    await sys.InvoiceItem.create({ tenantId: inv.tenantId, invoiceId: cn.id, description: `Credit for ${inv.number}: ${reason}`, quantity: 1, unitAmount: subtotal, amount: subtotal }, { transaction });
    if (amount + credited >= Number(inv.total) - 0.001) await inv.update({ status: 'REFUNDED' }, { transaction });
    await audit({ transaction, tenantId: inv.tenantId, actor, action: 'invoice.credit_note', entityType: 'invoice', entityId: cn.id, after: { against: inv.number, amount, reason }, req });
    return cn;
  });
}

/** Renewal invoices for subscriptions ending within `days` (scheduled job). */
export async function createRenewalInvoices(days = 7) {
  const soon = await sys.Subscription.findAll({
    where: { status: { [Op.in]: ['ACTIVE', 'PAST_DUE'] }, paymentStatus: 'PAID', autoRenew: true, currentPeriodEnd: { [Op.between]: [new Date(), new Date(Date.now() + days * DAY)] } },
    include: [{ model: sys.Plan, as: 'plan' }],
  });
  const created = [];
  for (const s of soon) {
    const open = await sys.Invoice.count({ where: { tenantId: s.tenantId, status: 'OPEN', periodStart: s.currentPeriodEnd } });
    if (open) continue;
    const target = s.pendingPlanId ? await sys.Plan.findByPk(s.pendingPlanId) : s.plan;
    try {
      // Renewal (or scheduled downgrade) billed for the next period.
      const r = await createPeriodInvoice({ sub: s, plan: target });
      created.push(r.number);
    } catch { /* plan without price: handled by sales */ }
  }
  return created;
}

async function createPeriodInvoice({ sub, plan }) {
  return systemDb.transaction(async (transaction) => {
    const price = (await currentPrice(plan.id, sub.billingCycle, 'NPR', new Date(), transaction)) ?? (plan.isCustom ? Number(sub.amount) : null);
    if (price == null || price <= 0) throw new Error('no price');
    const money = await priceBreakdown(price, null);
    const tenant = await sys.Tenant.findByPk(sub.tenantId, { transaction });
    const periodEnd = addPeriod(sub.currentPeriodEnd, sub.billingCycle);
    const inv = await sys.Invoice.create({
      tenantId: sub.tenantId, subscriptionId: sub.id, number: await nextInvoiceNumber(transaction), status: 'OPEN', kind: 'RENEWAL', ...money,
      targetPlanId: plan.id, targetCycle: sub.billingCycle, periodStart: sub.currentPeriodEnd, periodEnd, billTo: await billTo(tenant, transaction),
      dueAt: sub.currentPeriodEnd,
    }, { transaction });
    await sys.InvoiceItem.create({ tenantId: sub.tenantId, invoiceId: inv.id, description: `${plan.name} plan — ${sub.billingCycle.toLowerCase()} renewal (${ymd(sub.currentPeriodEnd)} – ${ymd(periodEnd)})`, quantity: 1, unitAmount: price, amount: price }, { transaction });
    return inv;
  });
}

/**
 * Super Admin: invoice for a negotiated price (Enterprise / custom plans). Paying it activates the plan for one period,
 * exactly like a self-service checkout invoice.
 */
export async function createCustomInvoice({ tenantId, planId, billingCycle, amount, description, actor, req }) {
  const result = await systemDb.transaction(async (transaction) => {
    const sub = await currentSubscription(tenantId, transaction);
    const plan = await sys.Plan.findByPk(planId, { transaction });
    if (!plan) throw NotFound('Plan');
    if (!(amount > 0)) throw BadRequest('Amount must be greater than zero');
    const money = await priceBreakdown(amount, null);
    const tenant = await sys.Tenant.findByPk(tenantId, { transaction });
    const start = new Date();
    const periodEnd = addPeriod(start, billingCycle);
    const invoice = await sys.Invoice.create({
      tenantId, subscriptionId: sub.id, number: await nextInvoiceNumber(transaction), status: 'OPEN', kind: 'SUBSCRIPTION', ...money,
      targetPlanId: plan.id, targetCycle: billingCycle, periodStart: start, periodEnd, billTo: await billTo(tenant, transaction),
      dueAt: new Date(Date.now() + Number(await getSetting('billing.due_days')) * DAY),
    }, { transaction });
    await sys.InvoiceItem.create({ tenantId, invoiceId: invoice.id, description: description ?? `${plan.name} plan (${billingCycle.toLowerCase()}, ${ymd(start)} – ${ymd(periodEnd)})`, quantity: 1, unitAmount: amount, amount }, { transaction });
    await audit({ transaction, tenantId, actor, action: 'invoice.create', entityType: 'invoice', entityId: invoice.id, after: { number: invoice.number, total: money.total, custom: true }, req });
    return { invoice, slug: tenant.slug, email: await ownerEmail(tenantId, transaction) };
  });
  await enqueueEmail({ tenantId, to: result.email, template: 'billing.invoice', data: { number: result.invoice.number, total: result.invoice.total, dueDate: ymd(result.invoice.dueAt), url: `${workspaceUrl(result.slug)}/billing/invoices/${result.invoice.id}` } });
  return result.invoice;
}
