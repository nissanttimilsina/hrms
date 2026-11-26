import jwt from 'jsonwebtoken';
import { Op } from 'sequelize';
import { env } from '../config/env.js';
import { app, sys, systemDb, withTenant } from '../database/index.js';
import { hashPassword, verifyPassword, burnVerify } from './password.service.js';
import { cache } from './redis.js';
import { audit } from './audit.service.js';
import { randomToken, sha256, uuid } from '../utils/crypto.js';
import { Unauthorized, BadRequest, Forbidden } from '../utils/errors.js';
import { enqueueEmail } from '../jobs/queues.js';

/**
 * Token model
 *  - Access token: JWT (HS256), short-lived (default 15 min). Claims:
 *      sub=userId, aud='tenant'|'platform', tid=tenantId (tenant only), sid=session family id
 *  - Refresh token: 256-bit opaque random string, stored only as sha256 in
 *    auth_sessions. Every refresh ROTATES it (old row revoked 'rotated', new row
 *    in the same family). Presenting an already-rotated token is treated as
 *    theft: the whole family is revoked (reuse detection).
 *  - Logout / revocation marks the family revoked in DB and in Redis so that
 *    still-valid access tokens of that family are rejected immediately.
 */

const INVALID = () => Unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
const revokedKey = (sid) => `revoked:sid:${sid}`;

// --------------------------------------------------------------------------- tokens
function signAccess({ subjectType, userId, tenantId, familyId }) {
  const aud = subjectType === 'PLATFORM' ? 'platform' : 'tenant';
  return jwt.sign({ typ: 'access', ...(tenantId && { tid: tenantId }), sid: familyId }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256', subject: userId, audience: aud, issuer: env.JWT_ISSUER, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

export function verifyAccessToken(token, audience) {
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], audience, issuer: env.JWT_ISSUER });
    if (claims.typ !== 'access') throw new Error('wrong token type');
    return claims;
  } catch (e) {
    throw Unauthorized(e.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token',
      e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
  }
}

export async function isSessionRevoked(familyId) {
  return (await cache.get(revokedKey(familyId))) === true;
}

async function createSession({ subjectType, userId, tenantId = null, familyId = uuid(), req, transaction }) {
  const refreshToken = randomToken(32);
  const session = await sys.AuthSession.create({
    subjectType, userId, tenantId, familyId, tokenHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    userAgent: req?.get?.('user-agent')?.slice(0, 500), ip: req?.ip,
  }, { transaction });
  return {
    session,
    tokens: {
      accessToken: signAccess({ subjectType, userId, tenantId, familyId }),
      refreshToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    },
  };
}

// --------------------------------------------------------------------------- login
async function checkLockAndVerify(user, password, update) {
  if (!user) return burnVerify(password);
  if (user.status !== 'ACTIVE') { await burnVerify(password); return false; }
  if (user.lockedUntil && user.lockedUntil > new Date()) { await burnVerify(password); return false; }
  const ok = await verifyPassword(user.passwordHash, password);
  if (ok) {
    await update({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() });
  } else {
    const failed = user.failedLogins + 1;
    const lock = failed >= env.LOGIN_MAX_FAILED_ATTEMPTS;
    await update({
      failedLogins: lock ? 0 : failed,
      lockedUntil: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : user.lockedUntil,
    });
  }
  return ok;
}

export async function loginTenant({ tenantId, email, password, req }) {
  const tenant = await sys.Tenant.findByPk(tenantId, { attributes: ['status'] });
  if (tenant?.status !== 'ACTIVE') throw Forbidden('This workspace is not available', 'TENANT_BLOCKED');
  const user = await withTenant(tenantId, async (t) => {
    const u = await app.User.findOne({ where: { email }, transaction: t });
    const ok = await checkLockAndVerify(u, password, (patch) => u.update(patch, { transaction: t }));
    if (ok) {
      await app.AuditLog.create({ tenantId, actorType: 'TENANT_USER', actorId: u.id, action: 'auth.login', ip: req?.ip, requestId: req?.id }, { transaction: t });
    }
    return ok ? u : null;
  });
  if (!user) throw INVALID();
  const { tokens } = await createSession({ subjectType: 'TENANT', userId: user.id, tenantId, req });
  return { tokens, user };
}

export async function loginPlatform({ email, password, req }) {
  const u = await sys.PlatformUser.findOne({ where: { email } });
  const ok = await checkLockAndVerify(u, password, (patch) => u.update(patch));
  if (!ok) throw INVALID();
  await audit({ actor: { type: 'PLATFORM_USER', id: u.id }, action: 'auth.login', req });
  const { tokens } = await createSession({ subjectType: 'PLATFORM', userId: u.id, req });
  return { tokens, user: u };
}

// --------------------------------------------------------------------------- refresh / revoke
export async function rotateRefreshToken(refreshToken, { req, subjectType, tenantId }) {
  if (!refreshToken) throw Unauthorized('Refresh token missing', 'INVALID_REFRESH');
  const outcome = await systemDb.transaction(async (transaction) => {
    const current = await sys.AuthSession.findOne({
      where: { tokenHash: sha256(refreshToken) }, transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!current || current.subjectType !== subjectType || (tenantId && current.tenantId !== tenantId)) {
      return { error: 'INVALID_REFRESH' };
    }
    if (current.revokedAt) {
      if (current.revokeReason === 'rotated') {
        // A rotated token was replayed => assume theft, kill the whole family.
        await revokeFamilyInTx(current.familyId, 'reuse_detected', transaction);
        await audit({ transaction, tenantId: current.tenantId, actor: { type: 'SYSTEM' }, action: 'auth.refresh_reuse_detected', entityType: 'session', entityId: current.familyId, req });
        return { error: 'TOKEN_REUSED', familyId: current.familyId };
      }
      return { error: 'INVALID_REFRESH' };
    }
    if (current.expiresAt < new Date()) return { error: 'INVALID_REFRESH' };

    // Subject must still be allowed to log in.
    if (subjectType === 'TENANT') {
      const user = await sys.User.findOne({ where: { id: current.userId, tenantId: current.tenantId }, transaction });
      const tenant = await sys.Tenant.findByPk(current.tenantId, { transaction });
      if (user?.status !== 'ACTIVE' || tenant?.status !== 'ACTIVE') return { error: 'INVALID_REFRESH' };
    } else {
      const user = await sys.PlatformUser.findByPk(current.userId, { transaction });
      if (user?.status !== 'ACTIVE') return { error: 'INVALID_REFRESH' };
    }

    const next = await createSession({
      subjectType, userId: current.userId, tenantId: current.tenantId, familyId: current.familyId, req, transaction,
    });
    await current.update({ revokedAt: new Date(), revokeReason: 'rotated', replacedById: next.session.id, lastUsedAt: new Date() }, { transaction });
    return { tokens: next.tokens };
  });

  if (outcome.error === 'TOKEN_REUSED') await markRevokedInCache(outcome.familyId);
  if (outcome.error) throw Unauthorized('Session is no longer valid. Please sign in again.', outcome.error);
  return outcome.tokens;
}

async function revokeFamilyInTx(familyId, reason, transaction) {
  await sys.AuthSession.update(
    { revokedAt: new Date(), revokeReason: reason },
    { where: { familyId, revokedAt: null }, transaction },
  );
}

async function markRevokedInCache(familyId) {
  // Long enough to outlive any access token issued for this family.
  await cache.set(revokedKey(familyId), true, env.ACCESS_TOKEN_TTL_SECONDS + 60);
}

export async function revokeFamily(familyId, reason = 'logout') {
  await systemDb.transaction((t) => revokeFamilyInTx(familyId, reason, t));
  await markRevokedInCache(familyId);
}

export async function revokeAllForUser({ subjectType, userId, reason = 'logout_all' }) {
  const families = await sys.AuthSession.findAll({
    where: { subjectType, userId, revokedAt: null }, attributes: ['familyId'], group: ['familyId'], raw: true,
  });
  await sys.AuthSession.update({ revokedAt: new Date(), revokeReason: reason }, { where: { subjectType, userId, revokedAt: null } });
  await Promise.all(families.map((f) => markRevokedInCache(f.familyId)));
  return families.length;
}

export async function listSessions({ subjectType, userId }) {
  return sys.AuthSession.findAll({
    where: { subjectType, userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    attributes: ['familyId', 'userAgent', 'ip', 'createdAt', 'lastUsedAt'],
    order: [['createdAt', 'DESC']],
  });
}

// --------------------------------------------------------------------------- password reset / invitations
export async function requestPasswordReset({ subjectType, tenantId = null, email }) {
  const user = subjectType === 'TENANT'
    ? await sys.User.findOne({ where: { tenantId, email, status: 'ACTIVE' } })
    : await sys.PlatformUser.findOne({ where: { email, status: 'ACTIVE' } });
  if (!user) return; // never reveal whether the account exists
  const token = randomToken(32);
  await sys.AuthActionToken.create({
    subjectType, userId: user.id, tenantId, purpose: 'PASSWORD_RESET', tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
  });
  await enqueueEmail({ tenantId, to: user.email, template: 'auth.password_reset', data: { token } });
}

export async function resetPassword({ token, password, subjectType, tenantId = null, req }) {
  const userId = await systemDb.transaction(async (transaction) => {
    const row = await sys.AuthActionToken.findOne({
      where: { tokenHash: sha256(token), purpose: 'PASSWORD_RESET', subjectType, tenantId }, transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw BadRequest('Reset link is invalid or has expired');
    const Model = subjectType === 'TENANT' ? sys.User : sys.PlatformUser;
    await Model.update({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null }, { where: { id: row.userId }, transaction });
    await row.update({ usedAt: new Date() }, { transaction });
    await audit({ transaction, tenantId, actor: { type: subjectType === 'TENANT' ? 'TENANT_USER' : 'PLATFORM_USER', id: row.userId }, action: 'auth.password_reset', req });
    return row.userId;
  });
  await revokeAllForUser({ subjectType, userId, reason: 'password_reset' });
}

export async function changePassword({ subjectType, tenantId, userId, currentPassword, newPassword, req }) {
  const Model = subjectType === 'TENANT' ? sys.User : sys.PlatformUser;
  const where = subjectType === 'TENANT' ? { id: userId, tenantId } : { id: userId };
  const user = await Model.findOne({ where });
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    throw BadRequest('Current password is incorrect', [{ path: 'currentPassword', message: 'Incorrect password' }]);
  }
  await user.update({ passwordHash: await hashPassword(newPassword) });
  await audit({ tenantId, actor: { type: subjectType === 'TENANT' ? 'TENANT_USER' : 'PLATFORM_USER', id: userId }, action: 'auth.password_change', req });
  await revokeAllForUser({ subjectType, userId, reason: 'password_change' });
}

export async function acceptInvitation({ tenantId, token, password, fullName, req }) {
  return systemDb.transaction(async (transaction) => {
    const inv = await sys.TenantInvitation.findOne({ where: { tenantId, tokenHash: sha256(token) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!inv || inv.acceptedAt || inv.expiresAt < new Date()) throw BadRequest('Invitation is invalid or has expired');
    let user = await sys.User.findOne({ where: { tenantId, email: inv.email }, transaction });
    const passwordHash = await hashPassword(password);
    if (user) {
      await user.update({ passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date(), ...(fullName && { fullName }) }, { transaction });
    } else {
      user = await sys.User.create({ tenantId, email: inv.email, fullName: fullName ?? inv.email, passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() }, { transaction });
    }
    await sys.UserRole.findOrCreate({ where: { userId: user.id, roleId: inv.roleId }, defaults: { tenantId }, transaction });
    await inv.update({ acceptedAt: new Date() }, { transaction });
    await audit({ transaction, tenantId, actor: { type: 'TENANT_USER', id: user.id }, action: 'auth.invitation_accepted', entityType: 'user', entityId: user.id, req });
    return user;
  });
}

