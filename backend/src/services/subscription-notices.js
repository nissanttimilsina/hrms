/**
 * Daily notices to the people who manage a company's subscription (in-app + email):
 * - trial ending in 7 / 3 / 1 days, paid period ending in 7 / 1 days (cancelled or unpaid renewals);
 * - employee limit at 80% and at 100% of the plan.
 * Each notice is sent once (deduplicated by title).
 */
import { systemDb, withTenant, app } from '../database/index.js';
import { getTenantContext, getUsage } from './subscription.service.js';
import { notifyUsers, usersWithPermission } from './hr/notify.js';
import { logger } from '../utils/logger.js';

const DAY = 86_400_000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

async function once(t, users, n) {
  const fresh = [];
  for (const id of users) if (!(await app.Notification.count({ where: { userId: id, type: n.type, title: n.title }, transaction: t }))) fresh.push(id);
  if (fresh.length) await notifyUsers(t, fresh, n);
  return fresh.length;
}

export async function tenantSubscriptionNotices(tenantId, now = new Date()) {
  const ctx = await getTenantContext(tenantId, { fresh: true });
  if (!ctx?.subscription) return { sent: 0 };
  const s = ctx.subscription;
  return withTenant(tenantId, async (t) => {
    const users = await usersWithPermission(t, 'subscription:manage');
    if (!users.length) return { sent: 0 };
    let sent = 0;
    const daysTo = (d) => Math.ceil((new Date(d) - now) / DAY);
    if (s.status === 'TRIAL' && s.trialEndsAt) {
      const d = daysTo(s.trialEndsAt);
      if ([7, 3, 1].includes(d)) sent += await once(t, users, { type: 'subscription.trial_ending', title: `Your free trial ends in ${d} day${d > 1 ? 's' : ''} (${ymd(s.trialEndsAt)})`, body: 'Choose a plan to keep using every feature without interruption. Your data stays as it is.', link: '/billing', email: true });
    }
    if (['ACTIVE', 'PAST_DUE', 'CANCELLED'].includes(s.status) && s.currentPeriodEnd) {
      const d = daysTo(s.currentPeriodEnd);
      if ([7, 1].includes(d)) {
        const open = await app.Invoice.count({ where: { status: 'OPEN' }, transaction: t });
        const ending = s.status === 'CANCELLED';
        if (ending || open) {
          sent += await once(t, users, {
            type: 'subscription.period_ending', email: true, link: '/billing',
            title: ending ? `Your subscription ends in ${d} day${d > 1 ? 's' : ''} (${ymd(s.currentPeriodEnd)})` : `Renewal due in ${d} day${d > 1 ? 's' : ''}: invoice awaiting payment`,
            body: ending ? 'Renew to keep full access. After that the workspace becomes read-only; your data is preserved.' : 'Pay the open invoice before the period ends to avoid the grace period.',
          });
        }
      }
    }
    const lim = ctx.limits.employees;
    if (lim) {
      const used = (await getUsage(t)).employees;
      const pct = (used / lim) * 100;
      const period = ymd(s.currentPeriodEnd ?? s.trialEndsAt ?? now);
      if (pct >= 100) sent += await once(t, users, { type: 'subscription.limit', title: `Employee limit reached: ${used} of ${lim} (period to ${period})`, body: 'You can’t add more employees on this plan. Upgrade or request a higher limit from Subscription.', link: '/billing', email: true });
      else if (pct >= 80) sent += await once(t, users, { type: 'subscription.limit', title: `${Math.floor(pct)}% of your employee limit used: ${used} of ${lim} (period to ${period})`, body: 'Plan ahead: upgrade before you reach the limit.', link: '/billing', email: true });
    }
    return { sent };
  });
}

export async function subscriptionNotices(now = new Date()) {
  const tenants = await systemDb.query("SELECT id FROM tenants WHERE status = 'ACTIVE'", { type: 'SELECT' });
  let sent = 0;
  for (const { id } of tenants) {
    try { sent += (await tenantSubscriptionNotices(id, now)).sent; } catch (err) { logger.error({ err, tenantId: id }, 'subscription notices failed'); }
  }
  return { tenants: tenants.length, sent };
}
