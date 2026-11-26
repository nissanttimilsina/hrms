import { Router } from 'express';
import { QueryTypes } from 'sequelize';
import { systemDb } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { getUsage } from '../../services/subscription.service.js';
import { asyncHandler, ok } from '../../utils/http.js';

// --------------------------------------------------------------------------- tenant: "My subscription"
export const tenantSubscriptionRouter = Router();

tenantSubscriptionRouter.get('/', requirePermission('subscription:view'), asyncHandler(async (req, res) => {
  const { ctx, access } = req.auth;
  const usage = await req.tx((t) => getUsage(t));
  return ok(res, { ...ctx.subscription, access, features: ctx.features, limits: ctx.limits, usage });
}));

// --------------------------------------------------------------------------- public: pricing page data
/**
 * Pricing for the marketing site. Everything comes from the DB: plans, the
 * currently effective prices, limits and the entitled feature list. Annual
 * savings are computed here, never in the frontend.
 */
export const publicPlansRouter = Router();

export async function publicPlanCatalogue(currency = 'NPR') {
  const rows = await systemDb.query(
    `SELECT p.id, p.code, p.name, p.description, p.sort_order, p.is_custom, p.contact_sales, p.trial_days,
            p.max_employees, p.max_branches, p.max_storage_mb, p.highlights,
            (SELECT amount FROM plan_prices pp WHERE pp.plan_id = p.id AND pp.billing_cycle = 'MONTHLY' AND pp.currency = :currency
               AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
             ORDER BY pp.effective_from DESC LIMIT 1) AS monthly,
            (SELECT amount FROM plan_prices pp WHERE pp.plan_id = p.id AND pp.billing_cycle = 'ANNUAL' AND pp.currency = :currency
               AND pp.effective_from <= now() AND (pp.effective_to IS NULL OR pp.effective_to > now())
             ORDER BY pp.effective_from DESC LIMIT 1) AS annual,
            COALESCE((SELECT json_agg(json_build_object('key', f.key, 'name', f.name, 'category', f.category) ORDER BY f.sort_order)
               FROM feature_catalog f
              WHERE f.is_core OR EXISTS (SELECT 1 FROM plan_entitlements e WHERE e.plan_id = p.id AND e.feature_id = f.id AND e.enabled)), '[]') AS features
       FROM plans p
      WHERE p.status = 'ACTIVE' AND p.is_public
      ORDER BY p.sort_order`,
    { replacements: { currency }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => {
    const monthly = r.monthly == null ? null : Number(r.monthly);
    const annual = r.annual == null ? null : Number(r.annual);
    const savings = monthly != null && annual != null ? Math.max(0, monthly * 12 - annual) : null;
    return {
      code: r.code, name: r.name, description: r.description, contactSales: r.contact_sales, isCustom: r.is_custom,
      trialDays: r.trial_days, currency,
      prices: { monthly, annual },
      annualSavings: savings == null ? null : { amount: Number(savings.toFixed(2)), percent: monthly ? Math.round((savings / (monthly * 12)) * 100) : 0 },
      limits: { employees: r.max_employees, branches: r.max_branches, storageMb: r.max_storage_mb },
      highlights: r.highlights,
      features: r.features,
    };
  });
}

publicPlansRouter.get('/plans', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, await publicPlanCatalogue());
}));
