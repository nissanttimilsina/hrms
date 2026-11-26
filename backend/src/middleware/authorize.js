import { sys } from '../database/index.js';
import { cache } from '../services/redis.js';
import { Forbidden, FeatureNotInPlan, Unauthorized } from '../utils/errors.js';
import { verifyAccessToken, isSessionRevoked } from '../services/auth.service.js';

// --------------------------------------------------------------------------- feature catalogue
let featureKeysCache = { at: 0, keys: new Set() };
export async function allFeatureKeys() {
  if (Date.now() - featureKeysCache.at < 300_000) return featureKeysCache.keys;
  const rows = await sys.FeatureCatalog.findAll({ attributes: ['key'], raw: true });
  featureKeysCache = { at: Date.now(), keys: new Set(rows.map((r) => r.key)) };
  return featureKeysCache.keys;
}

/** Require a module to be included in the tenant's subscription. */
export const requireFeature = (featureKey) => (req, _res, next) => {
  if (!req.auth.ctx.features.includes(featureKey)) return next(FeatureNotInPlan(featureKey));
  next();
};

/**
 * Require a tenant permission ("<resource>:<action>").
 * Enforces, in order: the permission's module is entitled by the plan, and the
 * user holds the permission. Sets req.scopes for data-scope filtering.
 */
export const requirePermission = (key) => async (req, _res, next) => {
  try {
    const grant = req.auth.grants.get(key);
    const module = grant?.module;
    if (module && (await allFeatureKeys()).has(module) && !req.auth.ctx.features.includes(module)) {
      throw FeatureNotInPlan(module);
    }
    if (!grant) throw Forbidden(undefined, 'FORBIDDEN', { permission: key });
    req.scopes = grant.scopes;
    next();
  } catch (e) {
    next(e);
  }
};

export const hasPermission = (req, key) => req.auth.grants.has(key);

// --------------------------------------------------------------------------- platform (Super Admin portal)
async function platformPermissions(userId) {
  const key = `pperms:${userId}`;
  const hit = await cache.get(key);
  if (hit) return hit;
  const user = await sys.PlatformUser.findByPk(userId, {
    include: [{ model: sys.PlatformRole, as: 'roles', include: [{ model: sys.PlatformPermission, as: 'permissions' }] }],
  });
  const value = user && user.status === 'ACTIVE'
    ? { active: true, roles: user.roles.map((r) => r.key), perms: [...new Set(user.roles.flatMap((r) => r.permissions.map((p) => p.key)))] }
    : { active: false, roles: [], perms: [] };
  await cache.set(key, value, 60);
  return value;
}
export const invalidatePlatformPermissions = (userId) => cache.del(`pperms:${userId}`);

export async function authenticatePlatform(req, _res, next) {
  try {
    const h = req.get('authorization') || '';
    if (!h.startsWith('Bearer ')) throw Unauthorized();
    const claims = verifyAccessToken(h.slice(7), 'platform');
    if (await isSessionRevoked(claims.sid)) throw Unauthorized('Session has been revoked', 'SESSION_REVOKED');
    const p = await platformPermissions(claims.sub);
    if (!p.active) throw Unauthorized('Account is disabled', 'ACCOUNT_DISABLED');
    req.auth = { subjectType: 'PLATFORM', userId: claims.sub, sessionId: claims.sid, roles: p.roles, perms: new Set(p.perms) };
    next();
  } catch (e) {
    next(e);
  }
}

export const requirePlatformPermission = (key) => (req, _res, next) =>
  req.auth.perms.has(key) ? next() : next(Forbidden(undefined, 'FORBIDDEN', { permission: key }));
