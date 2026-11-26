import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { sys } from '../../database/index.js';
import * as auth from '../../services/auth.service.js';
import { passwordPolicy } from '../../services/password.service.js';
import { validate, loginLimiter, requireXhrHeader } from '../../middleware/common.js';
import { authenticateTenant, subscriptionGuard } from '../../middleware/tenant.js';
import { authenticatePlatform } from '../../middleware/authorize.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { BadRequest, NotFound, Unauthorized } from '../../utils/errors.js';
import { getUsage } from '../../services/subscription.service.js';

/**
 * Refresh tokens travel in an httpOnly, Secure, SameSite=Strict cookie scoped to
 * the auth path. Native mobile clients (X-Client: mobile) receive/send it in the body.
 */
const cookieOpts = (path) => ({
  httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'strict', path,
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
});
const isMobile = (req) => req.get('x-client') === 'mobile';

function sendTokens(req, res, tokens, cookieName, path, extra = {}) {
  res.cookie(cookieName, tokens.refreshToken, cookieOpts(path));
  return ok(res, {
    accessToken: tokens.accessToken,
    expiresIn: tokens.expiresIn,
    ...(isMobile(req) && { refreshToken: tokens.refreshToken }),
    ...extra,
  });
}
const readRefresh = (req, cookieName) => (isMobile(req) ? req.body?.refreshToken : req.cookies?.[cookieName]);

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  workspace: z.string().trim().toLowerCase().max(63).optional(),
}).strict();

// =========================================================================== tenant users
export const tenantAuthRouter = Router();
const T_COOKIE = 'hrms_rt';
const T_PATH = '/api/v1/auth';

/** Which tenant is this login for? Host mapping wins; workspace slug only on the generic app host. */
async function loginTenantId(req) {
  if (req.hostTenantId) {
    if (req.body.workspace) {
      const t = await sys.Tenant.findOne({ where: { slug: req.body.workspace }, attributes: ['id'] });
      if (t?.id !== req.hostTenantId) throw BadRequest('Workspace does not match this address');
    }
    return req.hostTenantId;
  }
  if (!req.isGenericAppHost) throw NotFound('Workspace');
  if (!req.body.workspace) throw BadRequest('Workspace is required', [{ path: 'workspace', message: 'Required' }]);
  const t = await sys.Tenant.findOne({ where: { slug: req.body.workspace }, attributes: ['id', 'status'] });
  // Same error as bad credentials: do not reveal which workspaces exist.
  if (!t || t.status !== 'ACTIVE') throw Unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  return t.id;
}

tenantAuthRouter.post('/login', loginLimiter, validate({ body: credentials }), asyncHandler(async (req, res) => {
  const tenantId = await loginTenantId(req);
  const { tokens, user } = await auth.loginTenant({ tenantId, email: req.body.email, password: req.body.password, req });
  return sendTokens(req, res, tokens, T_COOKIE, T_PATH, { user: { id: user.id, email: user.email, fullName: user.fullName } });
}));

tenantAuthRouter.post('/refresh', requireXhrHeader, asyncHandler(async (req, res) => {
  const tokens = await auth.rotateRefreshToken(readRefresh(req, T_COOKIE), { req, subjectType: 'TENANT', tenantId: req.hostTenantId });
  return sendTokens(req, res, tokens, T_COOKIE, T_PATH);
}));

tenantAuthRouter.post('/logout', authenticateTenant, asyncHandler(async (req, res) => {
  await auth.revokeFamily(req.auth.sessionId, 'logout');
  res.clearCookie(T_COOKIE, { path: T_PATH });
  return ok(res, { loggedOut: true });
}));

tenantAuthRouter.post('/logout-all', authenticateTenant, asyncHandler(async (req, res) => {
  const count = await auth.revokeAllForUser({ subjectType: 'TENANT', userId: req.auth.userId });
  res.clearCookie(T_COOKIE, { path: T_PATH });
  return ok(res, { revokedSessions: count });
}));

tenantAuthRouter.get('/me', authenticateTenant, subscriptionGuard(), asyncHandler(async (req, res) => {
  const { user, ctx, access, grants, principal } = req.auth;
  const usage = await req.tx((t) => getUsage(t));
  return ok(res, {
    user: { id: user.id, email: user.email, fullName: user.fullName, employeeId: principal.employeeId },
    tenant: ctx.tenant,
    permissions: Object.fromEntries([...grants].map(([k, v]) => [k, v.scopes.map((s) => s.scope)])),
    subscription: { ...ctx.subscription, access, features: ctx.features, limits: ctx.limits, usage },
  });
}));

tenantAuthRouter.get('/sessions', authenticateTenant, asyncHandler(async (req, res) =>
  ok(res, (await auth.listSessions({ subjectType: 'TENANT', userId: req.auth.userId })).map((s) => ({ ...s.toJSON(), current: s.familyId === req.auth.sessionId })))));

tenantAuthRouter.delete('/sessions/:familyId', authenticateTenant, validate({ params: z.object({ familyId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const own = await sys.AuthSession.findOne({ where: { familyId: req.params.familyId, userId: req.auth.userId, subjectType: 'TENANT' } });
  if (!own) throw NotFound('Session');
  await auth.revokeFamily(req.params.familyId, 'user_revoked');
  return ok(res, { revoked: true });
}));

tenantAuthRouter.post('/password/forgot', loginLimiter, validate({ body: z.object({ email: z.string().trim().toLowerCase().email() }).strict() }), asyncHandler(async (req, res) => {
  if (req.hostTenantId) await auth.requestPasswordReset({ subjectType: 'TENANT', tenantId: req.hostTenantId, email: req.body.email });
  return ok(res, { message: 'If that account exists, a reset link has been sent.' });
}));

tenantAuthRouter.post('/password/reset', validate({ body: z.object({ token: z.string().min(20).max(200), password: passwordPolicy }).strict() }), asyncHandler(async (req, res) => {
  if (!req.hostTenantId) throw NotFound('Workspace');
  await auth.resetPassword({ ...req.body, subjectType: 'TENANT', tenantId: req.hostTenantId, req });
  return ok(res, { reset: true });
}));

tenantAuthRouter.post('/password/change', authenticateTenant, validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: passwordPolicy }).strict() }), asyncHandler(async (req, res) => {
  await auth.changePassword({ subjectType: 'TENANT', tenantId: req.auth.tenantId, userId: req.auth.userId, ...req.body, req });
  return ok(res, { changed: true });
}));

tenantAuthRouter.post('/invitations/accept', validate({ body: z.object({ token: z.string().min(20).max(200), password: passwordPolicy, fullName: z.string().trim().min(2).max(120).optional() }).strict() }), asyncHandler(async (req, res) => {
  if (!req.hostTenantId) throw NotFound('Workspace');
  const user = await auth.acceptInvitation({ tenantId: req.hostTenantId, ...req.body, req });
  return ok(res, { userId: user.id, email: user.email });
}));

// =========================================================================== platform users
export const platformAuthRouter = Router();
const P_COOKIE = 'hrms_prt';
const P_PATH = '/api/v1/admin/auth';

platformAuthRouter.post('/login', loginLimiter, validate({ body: credentials.omit({ workspace: true }) }), asyncHandler(async (req, res) => {
  const { tokens, user } = await auth.loginPlatform({ ...req.body, req });
  return sendTokens(req, res, tokens, P_COOKIE, P_PATH, { user: { id: user.id, email: user.email, fullName: user.fullName } });
}));

platformAuthRouter.post('/refresh', requireXhrHeader, asyncHandler(async (req, res) => {
  const tokens = await auth.rotateRefreshToken(readRefresh(req, P_COOKIE), { req, subjectType: 'PLATFORM' });
  return sendTokens(req, res, tokens, P_COOKIE, P_PATH);
}));

platformAuthRouter.post('/logout', authenticatePlatform, asyncHandler(async (req, res) => {
  await auth.revokeFamily(req.auth.sessionId, 'logout');
  res.clearCookie(P_COOKIE, { path: P_PATH });
  return ok(res, { loggedOut: true });
}));

platformAuthRouter.get('/me', authenticatePlatform, asyncHandler(async (req, res) => {
  const u = await sys.PlatformUser.findByPk(req.auth.userId, { attributes: ['id', 'email', 'fullName'] });
  return ok(res, { user: u, roles: req.auth.roles, permissions: [...req.auth.perms] });
}));

platformAuthRouter.post('/password/change', authenticatePlatform, validate({ body: z.object({ currentPassword: z.string().min(1), newPassword: passwordPolicy }).strict() }), asyncHandler(async (req, res) => {
  await auth.changePassword({ subjectType: 'PLATFORM', userId: req.auth.userId, ...req.body, req });
  return ok(res, { changed: true });
}));
