/**
 * Daily reminders for employee documents that are about to expire (30 days, 7 days, on the day) or have just
 * expired (1 day after). Runs in the worker. Recipients: HR users with company-wide documents:edit and the
 * employee. Only for tenants whose plan includes document expiry alerts. Idempotent per day: a reminder already
 * sent today for the same document and milestone is not sent again.
 */
import { Op } from 'sequelize';
import { systemDb, withTenant, app } from '../../database/index.js';
import { getTenantContext, evaluateAccess } from '../subscription.service.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from './notify.js';
import { localDate, addDays } from './calendar.js';
import { logger } from '../../utils/logger.js';

export const MILESTONES = [30, 7, 0, -1];

const describe = (days) => (days > 0 ? `expires in ${days} days` : days === 0 ? 'expires today' : 'has expired');

export async function documentExpiryAlerts(now = new Date()) {
  const today = localDate(now);
  const dates = MILESTONES.map((d) => addDays(today, d));
  const files = await systemDb.query(
    `SELECT f.tenant_id AS "tenantId", f.id, f.filename, f.category, to_char(f.expires_on, 'YYYY-MM-DD') AS "expiresOn",
            e.id AS "employeeId", e.first_name || ' ' || e.last_name AS "employeeName"
       FROM files f
       JOIN employees e ON e.tenant_id = f.tenant_id AND e.id = f.owner_id
       JOIN tenants tn ON tn.id = f.tenant_id AND tn.status = 'ACTIVE'
      WHERE f.owner_type = 'EMPLOYEE_DOCUMENT' AND f.deleted_at IS NULL AND e.deleted_at IS NULL
        AND e.status <> 'TERMINATED' AND f.expires_on IN (:dates)`,
    { replacements: { dates }, type: 'SELECT' },
  );
  const byTenant = Map.groupBy ? Map.groupBy(files, (f) => f.tenantId) : files.reduce((m, f) => m.set(f.tenantId, [...(m.get(f.tenantId) ?? []), f]), new Map());
  let sent = 0;
  for (const [tenantId, list] of byTenant) {
    try {
      const ctx = await getTenantContext(tenantId);
      if (!ctx || evaluateAccess(ctx).state === 'BLOCKED' || !ctx.features.includes('document_expiry_alerts')) continue;
      await withTenant(tenantId, async (t) => {
        const hr = await usersWithPermission(t, 'documents:edit');
        for (const f of list) {
          const days = Math.round((new Date(f.expiresOn) - new Date(today)) / 86_400_000);
          const title = `${f.category ? `${f.category}: ` : ''}${f.filename} for ${f.employeeName} ${describe(days)}`;
          const link = `/employees/${f.employeeId}`;
          const dup = await app.Notification.count({ where: { type: 'document.expiry', title, link, createdAt: { [Op.gte]: new Date(`${today}T00:00:00+05:45`) } }, transaction: t });
          if (dup) continue;
          const employeeUser = await userIdForEmployee(t, f.employeeId);
          await notifyUsers(t, [...hr, employeeUser], {
            type: 'document.expiry', title, link,
            body: `Expiry date: ${f.expiresOn}. Upload the renewed document on the employee's profile.`,
            email: days === 30 || days === 7 || days === 0,
          });
          sent += 1;
        }
      });
    } catch (err) {
      logger.error({ err, tenantId }, 'document expiry alerts failed for tenant');
    }
  }
  return { checked: files.length, sent };
}
