import { sys, systemDb } from '../database/index.js';
import { env } from '../config/env.js';
import { provisionTenant, validateSlug } from './provisioning.service.js';
import { getSetting } from './settings.service.js';
import { audit } from './audit.service.js';
import { enqueueEmail } from '../jobs/queues.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { BadRequest, Conflict } from '../utils/errors.js';

const VERIFY_TTL_MS = 48 * 3_600_000;

export async function slugAvailable(slug) {
  try { validateSlug(slug); } catch (e) { return { available: false, reason: e.message }; }
  const taken = await sys.Tenant.count({ where: { slug } });
  return taken ? { available: false, reason: 'This workspace name is already taken' } : { available: true };
}

async function issueVerification({ tenant, user, transaction }) {
  const token = randomToken(32);
  await sys.AuthActionToken.create({
    subjectType: 'TENANT', userId: user.id, tenantId: tenant.id, purpose: 'EMAIL_VERIFY',
    tokenHash: sha256(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
  }, { transaction });
  return token;
}

/**
 * Self-service registration from the marketing site. Creates the tenant in
 * PENDING state with a trial subscription; it becomes ACTIVE once the owner
 * confirms their email. Also records a WON lead for funnel analytics.
 */
export async function register(input, req) {
  if (!(await getSetting('signup.enabled'))) throw BadRequest('Online sign-up is temporarily unavailable. Please contact sales.');
  const plan = await sys.Plan.findOne({ where: { code: input.planCode, status: 'ACTIVE', isPublic: true } });
  if (!plan || plan.contactSales) throw BadRequest('Please choose a self-service plan, or contact sales for Enterprise', [{ path: 'planCode', message: 'Not available for self sign-up' }]);
  const check = await slugAvailable(input.slug);
  if (!check.available) throw Conflict(check.reason, 'SLUG_TAKEN', [{ path: 'slug', message: check.reason }]);

  const result = await provisionTenant({
    slug: input.slug, name: input.companyName, industry: input.industry, planCode: plan.code,
    billingCycle: input.billingCycle, trial: true, status: 'PENDING', req,
    owner: { email: input.email, fullName: input.fullName, password: input.password },
    transactionHook: async ({ transaction, tenant, user }) => {
      await sys.TenantSetting.create({ tenantId: tenant.id, key: 'billing.profile', value: { name: input.companyName, phone: input.phone, email: input.email } }, { transaction });
      await sys.Lead.create({
        source: 'SIGNUP', status: 'WON', name: input.fullName, company: input.companyName, email: input.email, phone: input.phone,
        industry: input.industry, employeeCount: input.employeeCount, interestedPlan: plan.code, convertedTenantId: tenant.id,
        utm: input.utm ?? {}, ip: req?.ip,
      }, { transaction });
      return { verifyToken: await issueVerification({ tenant, user, transaction }) };
    },
  });
  await enqueueEmail({
    tenantId: result.tenant.id, to: input.email, template: 'auth.verify_email',
    data: { companyName: input.companyName, url: `${env.MARKETING_URL}/verify-email?token=${result.verifyToken}` },
  });
  return { slug: result.tenant.slug, hostname: result.hostname, verificationRequired: true, trialDays: plan.trialDays, _verifyToken: env.isTest ? result.verifyToken : undefined };
}

export async function verifyEmail(token, req) {
  return systemDb.transaction(async (transaction) => {
    const row = await sys.AuthActionToken.findOne({ where: { tokenHash: sha256(token), purpose: 'EMAIL_VERIFY' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw BadRequest('This confirmation link is invalid or has expired. Request a new one.');
    const tenant = await sys.Tenant.findByPk(row.tenantId, { transaction, lock: transaction.LOCK.UPDATE });
    await sys.User.update({ emailVerifiedAt: new Date() }, { where: { id: row.userId, tenantId: row.tenantId }, transaction });
    if (tenant.status === 'PENDING') await tenant.update({ status: 'ACTIVE' }, { transaction });
    await row.update({ usedAt: new Date() }, { transaction });
    await audit({ transaction, tenantId: tenant.id, actor: { type: 'TENANT_USER', id: row.userId }, action: 'tenant.email_verified', req });
    return { slug: tenant.slug, workspaceUrl: `https://${tenant.slug}.${env.ROOT_DOMAIN}` };
  });
}

export async function resendVerification(email) {
  const user = await sys.User.findOne({ where: { email, emailVerifiedAt: null }, include: [{ model: sys.Tenant, as: 'tenant', where: { status: 'PENDING' } }] }).catch(() => null);
  if (!user) return; // silent: never reveal account state
  const token = await systemDb.transaction((transaction) => issueVerification({ tenant: user.tenant, user, transaction }));
  await enqueueEmail({ tenantId: user.tenantId, to: email, template: 'auth.verify_email', data: { url: `${env.MARKETING_URL}/verify-email?token=${token}` } });
}
