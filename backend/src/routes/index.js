import { Router } from 'express';
import { resolveHostTenant, authenticateTenant, subscriptionGuard } from '../middleware/tenant.js';
import { tenantAuthRouter, platformAuthRouter } from '../modules/auth/auth.routes.js';
import { organizationRouter } from '../modules/organization/organization.routes.js';
import { employeesRouter } from '../modules/employees/employees.routes.js';
import { accessRouter } from '../modules/access/access.routes.js';
import { tenantSubscriptionRouter, publicPlansRouter } from '../modules/subscriptions/subscription.routes.js';
import { adminRouter } from '../modules/admin/admin.routes.js';
import { commercialAdminRouter } from '../modules/admin/commercial.routes.js';
import { publicRouter } from '../modules/public/public.routes.js';
import { tenantBillingRouter, paymentReturnRouter } from '../modules/billing/billing.routes.js';
import { tenantSupportRouter } from '../modules/support/support.routes.js';
import { attendanceRouter } from '../modules/attendance/attendance.routes.js';
import { leaveRouter } from '../modules/leave/leave.routes.js';
import { workspaceRouter } from '../modules/workspace/workspace.routes.js';

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

  r.use('/public', publicPlansRouter, publicRouter);
  r.use('/payments', paymentReturnRouter); // provider browser redirects; verified server-side

  r.use('/admin/auth', platformAuthRouter);
  r.use('/admin', adminRouter, commercialAdminRouter);

  r.use(resolveHostTenant);
  r.use('/auth', tenantAuthRouter);

  // Billing and support stay writable when the workspace is read-only, so customers can always pay and get help.
  const recovery = [authenticateTenant, subscriptionGuard({ allowWhenReadOnly: true })];
  r.use('/billing', ...recovery, tenantBillingRouter);
  r.use('/support/tickets', ...recovery, tenantSupportRouter);

  const tenant = Router();
  tenant.use(authenticateTenant, subscriptionGuard());
  tenant.use('/', organizationRouter); // /branches, /departments
  tenant.use('/employees', employeesRouter);
  tenant.use('/', accessRouter); // /roles, /permissions, /users, /audit-logs
  tenant.use('/subscription', tenantSubscriptionRouter);
  tenant.use('/attendance', attendanceRouter);
  tenant.use('/leave', leaveRouter);
  tenant.use('/', workspaceRouter); // /dashboard, /announcements, /notifications, /settings
  r.use(tenant);

  return r;
}
