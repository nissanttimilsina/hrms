import { sys, app, withTenant } from '../database/index.js';
import { env } from '../config/env.js';
import { cache } from '../services/redis.js';
import { verifyAccessToken, isSessionRevoked } from '../services/auth.service.js';
import { getTenantContext, evaluateAccess } from '../services/subscription.service.js';
import { loadGrants } from '../services/rbac.service.js';
import { Unauthorized, Forbidden, NotFound, PaymentRequired } from '../utils/errors.js';

/**
 * Tenant identity is NEVER taken from a client-supplied tenant id.
 * It comes from (a) the verified Host -> tenant_domains mapping and/or
 * (b) the signed access token; when both exist they must agree.
 */

const PLATFORM_HOSTS = () => new Set([env.APP_HOST, env.ADMIN_HOST, env.MARKETING_HOST, env.ROOT_DOMAIN].map((h) => h.toLowerCase()));

export async function tenantIdForHost(hostname) {
  const host = (hostname || '').toLowerCase();
  if (!host || PLATFORM_HOSTS().has(host)) return null;
  const key = `host:${host}`;
  const cached = await cache.get(key);
  if (cached !== null) return cached || null;
  const domain = await sys.TenantDomain.findOne({ where: { hostname: host }, attributes: ['tenantId', 'verifiedAt'] });
  const tenantId = domain?.verifiedAt ? domain.tenantId : '';
  await cache.set(key, tenantId, 300);
  return tenantId || null;
}

/** Resolve tenant from Host. Unknown non-platform hosts are rejected. */
export async function resolveHostTenant(req, _res, next) {
  try {
    const host = (req.hostname || '').toLowerCase();
    req.hostTenantId = await tenantIdForHost(host);
    req.isGenericAppHost = host === env.APP_HOST.toLowerCase();
    if (!req.hostTenantId && !PLATFORM_HOSTS().has(host)) throw NotFound('Workspace');
    next();
  } catch (e) {
    next(e);
  }
}

const bearer = (req) => {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

/**
 * Authenticate a tenant user and build req.auth:
 *   { userId, tenantId, sessionId, user, employee, principal, grants, ctx, access }
 * Also exposes req.tx(fn) = withTenant(tenantId, fn) for handlers.
 */
export async function authenticateTenant(req, _res, next) {
  try {
    const token = bearer(req);
    if (!token) throw Unauthorized();
    const claims = verifyAccessToken(token, 'tenant');
    if (await isSessionRevoked(claims.sid)) throw Unauthorized('Session has been revoked', 'SESSION_REVOKED');
    if (req.hostTenantId && req.hostTenantId !== claims.tid) throw Unauthorized('Token does not belong to this workspace', 'TENANT_MISMATCH');

    const tenantId = claims.tid;
    const ctx = await getTenantContext(tenantId);
    const access = evaluateAccess(ctx);
    if (access.state === 'BLOCKED') throw Forbidden('This workspace is not available', 'TENANT_BLOCKED', { reason: access.reason });

    const { user, employee, grants } = await withTenant(tenantId, async (t) => {
      const u = await app.User.findByPk(claims.sub, { transaction: t });
      if (!u || u.status !== 'ACTIVE') return {};
      const e = u.employeeId ? await app.Employee.findByPk(u.employeeId, { transaction: t, attributes: ['id', 'branchId', 'departmentId', 'managerId'] }) : null;
      return { user: u, employee: e, grants: await loadGrants(u.id, t) };
    });
    if (!user) throw Unauthorized('Account is disabled', 'ACCOUNT_DISABLED');

    req.auth = {
      subjectType: 'TENANT', userId: user.id, tenantId, sessionId: claims.sid, user, employee, grants, ctx, access,
      principal: { userId: user.id, employeeId: employee?.id ?? null, branchId: employee?.branchId ?? null, departmentId: employee?.departmentId ?? null },
    };
    req.tx = (fn) => withTenant(tenantId, fn);
    next();
  } catch (e) {
    next(e);
  }
}

/**
 * Subscription guard for every tenant route (after authenticateTenant).
 * READ_ONLY tenants may still GET, and may use routes flagged allowWhenReadOnly
 * (auth, billing/renewal) so they can always pay and recover.
 */
export const subscriptionGuard = ({ allowWhenReadOnly = false } = {}) => (req, res, next) => {
  const { access } = req.auth;
  res.set('X-Subscription-State', access.state);
  if (access.reason) res.set('X-Subscription-Reason', access.reason);
  const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (access.state === 'READ_ONLY' && !isRead && !allowWhenReadOnly) {
    return next(PaymentRequired('Your subscription is inactive. Existing data is read-only until you renew.', {
      reason: access.reason, renew: true,
    }));
  }
  next();
};
