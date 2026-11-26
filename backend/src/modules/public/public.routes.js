import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Op } from 'sequelize';
import { sys } from '../../database/index.js';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/common.js';
import { quote } from '../../services/pricing.service.js';
import { register, slugAvailable, verifyEmail, resendVerification } from '../../services/signup.service.js';
import { passwordPolicy } from '../../services/password.service.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { AppError, NotFound } from '../../utils/errors.js';

/** Unauthenticated endpoints used by the marketing website. */
export const publicRouter = Router();

const formLimiter = rateLimit({
  windowMs: 60 * 60_000, limit: env.isTest ? 10_000 : 20, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (_q, _s, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many submissions. Please try again later.')),
});

// Bots fill every field; humans never see "website". A filled honeypot is silently accepted and dropped.
const honeypot = { website: z.string().max(0).optional().or(z.string().transform(() => '__bot__')) };
const isBot = (b) => b.website === '__bot__';
const utm = z.object({ source: z.string().max(100), medium: z.string().max(100), campaign: z.string().max(100), term: z.string().max(100), content: z.string().max(100) }).partial().optional();

const MODULE_KEYS = z.array(z.string().regex(/^[a-z_]+$/)).max(40).default([]);
const CYCLE = z.enum(['MONTHLY', 'ANNUAL']);

// ------------------------------------------------------------------ pricing calculator
publicRouter.post('/pricing/quote', validate({
  body: z.object({
    employees: z.number().int().min(1).max(100_000), branches: z.number().int().min(1).max(1000).default(1),
    modules: MODULE_KEYS, billingCycle: CYCLE.default('MONTHLY'), coupon: z.string().trim().max(30).optional(),
  }).strict(),
}), asyncHandler(async (req, res) => ok(res, await quote(req.body))));

publicRouter.get('/features', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  return ok(res, await sys.FeatureCatalog.findAll({ attributes: ['key', 'name', 'category', 'description', 'isCore'], order: [['sortOrder', 'ASC']] }));
}));

// ------------------------------------------------------------------ leads / CRM intake
const leadBody = z.object({
  source: z.enum(['CONTACT', 'DEMO', 'ENTERPRISE_QUOTE', 'CALLBACK']),
  name: z.string().trim().min(2).max(120), company: z.string().trim().max(160).optional(),
  email: z.string().trim().toLowerCase().email().max(254), phone: z.string().trim().regex(/^\+?[0-9 -]{7,20}$/, 'Enter a valid phone number').optional(),
  industry: z.string().trim().max(80).optional(), employeeCount: z.number().int().min(1).max(1_000_000).optional(),
  branchCount: z.number().int().min(1).max(10_000).optional(), modules: MODULE_KEYS, interestedPlan: z.string().max(30).optional(),
  message: z.string().trim().max(4000).optional(), preferredAt: z.coerce.date().optional(), utm, consent: z.literal(true, { message: 'Please accept the privacy policy' }),
  ...honeypot,
}).strict();

publicRouter.post('/leads', formLimiter, validate({ body: leadBody }), asyncHandler(async (req, res) => {
  if (isBot(req.body)) return created(res, { received: true });
  const { consent, website, utm: u, ...data } = req.body;
  const lead = await sys.Lead.create({ ...data, utm: u ?? {}, ip: req.ip });
  await sys.LeadActivity.create({ leadId: lead.id, type: 'SYSTEM', body: `Lead captured from website (${lead.source})` });
  await enqueueEmail({ to: lead.email, template: 'lead.acknowledgement', data: { name: lead.name, source: lead.source } });
  if (env.SALES_NOTIFY_EMAIL) await enqueueEmail({ to: env.SALES_NOTIFY_EMAIL, template: 'sales.new_lead', data: lead.toJSON() });
  return created(res, { received: true });
}));

publicRouter.post('/newsletter', formLimiter, validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), ...honeypot }).strict() }),
  asyncHandler(async (req, res) => {
    if (!isBot(req.body)) {
      await sys.NewsletterSubscriber.findOrCreate({ where: { email: req.body.email } });
      await sys.NewsletterSubscriber.update({ unsubscribedAt: null }, { where: { email: req.body.email } });
    }
    return created(res, { subscribed: true });
  }));

// ------------------------------------------------------------------ CMS content
const PUBLIC_TYPES = ['PAGE', 'BLOG_POST', 'TESTIMONIAL', 'FAQ', 'CUSTOMER_LOGO', 'ANNOUNCEMENT', 'FEATURE', 'INDUSTRY', 'CHANGELOG', 'SETTING'];
const published = () => ({ status: 'PUBLISHED', [Op.or]: [{ publishAt: null }, { publishAt: { [Op.lte]: new Date() } }] });

publicRouter.get('/content', validate({
  query: z.object({ type: z.enum(PUBLIC_TYPES), locale: z.enum(['en', 'ne']).default('en'), limit: z.coerce.number().int().min(1).max(100).default(50), tag: z.string().max(40).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const { type, locale, limit, tag } = req.query;
  const rows = await sys.CmsEntry.findAll({
    where: { type, locale, ...published(), ...(tag && { data: { tags: { [Op.contains]: [tag] } } }) },
    attributes: ['slug', 'title', 'summary', 'data', 'seo', 'publishAt', 'updatedAt', ...(type === 'BLOG_POST' ? [] : ['body'])],
    order: type === 'BLOG_POST' ? [['publishAt', 'DESC NULLS LAST'], ['createdAt', 'DESC']] : [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    limit,
  });
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, rows);
}));

publicRouter.get('/content/:type/:slug', validate({
  params: z.object({ type: z.enum(PUBLIC_TYPES), slug: z.string().regex(/^[a-z0-9-]{1,120}$/) }),
  query: z.object({ locale: z.enum(['en', 'ne']).default('en') }).strict(),
}), asyncHandler(async (req, res) => {
  const row = await sys.CmsEntry.findOne({
    where: { type: req.params.type, slug: req.params.slug, locale: req.query.locale, ...published() },
    attributes: ['slug', 'title', 'summary', 'body', 'data', 'seo', 'publishAt', 'updatedAt'],
  });
  if (!row) throw NotFound('Page');
  res.set('Cache-Control', 'public, max-age=60');
  return ok(res, row);
}));

// ------------------------------------------------------------------ self-service signup
publicRouter.get('/signup/slug-available', validate({ query: z.object({ slug: z.string().trim().toLowerCase().max(63) }).strict() }),
  asyncHandler(async (req, res) => ok(res, await slugAvailable(req.query.slug))));

publicRouter.post('/signup', formLimiter, validate({
  body: z.object({
    companyName: z.string().trim().min(2).max(160), slug: z.string().trim().toLowerCase().min(3).max(63),
    industry: z.string().trim().max(80).optional(), employeeCount: z.number().int().min(1).max(1_000_000).optional(),
    fullName: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email().max(254),
    phone: z.string().trim().regex(/^\+?[0-9 -]{7,20}$/, 'Enter a valid phone number'), password: passwordPolicy,
    planCode: z.string().trim().toUpperCase().default('STANDARD'), billingCycle: CYCLE.default('MONTHLY'),
    acceptTerms: z.literal(true, { message: 'You must accept the terms of service' }), utm, ...honeypot,
  }).strict(),
}), asyncHandler(async (req, res) => {
  if (isBot(req.body)) return created(res, { verificationRequired: true });
  return created(res, await register(req.body, req));
}));

publicRouter.post('/signup/verify-email', validate({ body: z.object({ token: z.string().min(20).max(200) }).strict() }),
  asyncHandler(async (req, res) => ok(res, await verifyEmail(req.body.token, req))));

publicRouter.post('/signup/resend-verification', formLimiter, validate({ body: z.object({ email: z.string().trim().toLowerCase().email() }).strict() }),
  asyncHandler(async (req, res) => { await resendVerification(req.body.email); return ok(res, { sent: true }); }));
