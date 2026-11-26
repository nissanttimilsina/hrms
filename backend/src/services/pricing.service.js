import { sys } from '../database/index.js';
import { publicPlanCatalogue } from '../modules/subscriptions/subscription.routes.js';
import { getSetting } from './settings.service.js';
import { BadRequest } from '../utils/errors.js';

const r2 = (n) => Math.round(n * 100) / 100;

/** Validate a coupon for a plan/cycle; returns the coupon row or throws. */
export async function findValidCoupon(code, planCode, billingCycle, transaction) {
  if (!code) return null;
  const c = await sys.Coupon.findOne({ where: { code, isActive: true }, transaction });
  const now = new Date();
  const invalid = !c
    || (c.validFrom && c.validFrom > now) || (c.validUntil && c.validUntil < now)
    || (c.maxRedemptions && c.redemptions >= c.maxRedemptions)
    || (c.planCodes.length && !c.planCodes.includes(planCode))
    || (c.billingCycles.length && !c.billingCycles.includes(billingCycle));
  if (invalid) throw BadRequest('This promo code is not valid for the selected plan', [{ path: 'coupon', message: 'Invalid or expired code' }]);
  return c;
}

export function applyCoupon(subtotal, coupon) {
  if (!coupon) return 0;
  const d = coupon.percentOff ? subtotal * (Number(coupon.percentOff) / 100) : Number(coupon.amountOff);
  return r2(Math.min(subtotal, d));
}

/** Price breakdown with VAT, computed only from DB values. */
export async function priceBreakdown(subtotal, coupon) {
  const vatRate = Number(await getSetting('billing.vat_rate'));
  const discount = applyCoupon(subtotal, coupon);
  const taxable = r2(subtotal - discount);
  const tax = r2(taxable * (vatRate / 100));
  return { subtotal: r2(subtotal), discount, taxRate: vatRate, tax, total: r2(taxable + tax) };
}

/**
 * Pricing calculator: recommend the cheapest public plan that satisfies the
 * employee count, branch count and required modules; otherwise Enterprise.
 */
export async function quote({ employees, branches = 1, modules = [], billingCycle = 'MONTHLY', coupon }) {
  const plans = await publicPlanCatalogue();
  const fits = (p) => (p.limits.employees == null || employees <= p.limits.employees)
    && (p.limits.branches == null || branches <= p.limits.branches)
    && modules.every((m) => p.features.some((f) => f.key === m));
  const priced = plans.filter((p) => !p.contactSales && p.prices.monthly != null);
  const match = priced.find(fits);
  const enterprise = plans.find((p) => p.contactSales);

  if (!match) {
    const reasons = [];
    const biggest = priced.at(-1);
    if (biggest && biggest.limits.employees != null && employees > biggest.limits.employees) reasons.push(`more than ${biggest.limits.employees} employees`);
    if (biggest && biggest.limits.branches != null && branches > biggest.limits.branches) reasons.push(`more than ${biggest.limits.branches} branches`);
    const missing = modules.filter((m) => !priced.some((p) => p.features.some((f) => f.key === m)));
    if (missing.length) reasons.push(`modules: ${missing.join(', ')}`);
    return { recommended: enterprise?.code ?? 'ENTERPRISE', contactSales: true, reasons };
  }

  const base = billingCycle === 'ANNUAL' ? match.prices.annual : match.prices.monthly;
  if (base == null) throw BadRequest(`${match.name} has no ${billingCycle.toLowerCase()} price`);
  const c = coupon ? await findValidCoupon(coupon, match.code, billingCycle) : null;
  const breakdown = await priceBreakdown(base, c);
  const alternatives = priced.filter((p) => p.code !== match.code && fits(p)).map((p) => ({ code: p.code, name: p.name }));
  return {
    recommended: match.code, planName: match.name, contactSales: false, billingCycle, currency: 'NPR',
    ...breakdown, coupon: c ? c.code : null, perEmployeeMonthly: r2((billingCycle === 'ANNUAL' ? base / 12 : base) / Math.max(1, employees)),
    annualSavings: match.annualSavings, trialDays: match.trialDays, alternatives,
  };
}

