import { Router } from 'express';
import { resolveHostTenant, authenticateTenant, subscriptionGuard } from '../middleware/tenant.js';
import { tenantAuthRouter, platformAuthRouter } from '../modules/auth/auth.routes.js';
import { organizationRouter } from '../modules/organization/organization.routes.js';
import { employeesRouter } from '../modules/employees/employees.routes.js';
import { accessRouter } from '../modules/access/access.routes.js';
import { tenantSubscriptionRouter, publicPlansRouter } from '../modules/subscriptions/subscription.routes.js';
import { adminRouter } from '../modules/admin/admin.routes.js';

/**
 * /api/v1 route map.
 *   /public/*     no auth (marketing site)
 *   /admin/auth/* platform login;  /admin/* Super Admin portal (platform token)
 *   /auth/*       tenant login/session
 *   everything else: tenant workspace => authenticateTenant + subscriptionGuard
 *                    + per-route requirePermission (which also enforces entitlements)
 */
export function apiRouter() {
  const r = Router();

  r.use('/public', publicPlansRouter);

  r.use('/admin/auth', platformAuthRouter);
  r.use('/admin', adminRouter);

  r.use(resolveHostTenant);
  r.use('/auth', tenantAuthRouter);

  const tenant = Router();
  tenant.use(authenticateTenant, subscriptionGuard());
  tenant.use('/', organizationRouter); // /branches, /departments
  tenant.use('/employees', employeesRouter);
  tenant.use('/', accessRouter); // /roles, /permissions, /users, /audit-logs
  tenant.use('/subscription', tenantSubscriptionRouter);
  r.use(tenant);

  return r;
}
