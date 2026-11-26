/**
 * Background worker process (run separately from the API: `npm run worker`).
 *  - subscriptions: repeatable lifecycle sweep (expiry -> grace -> read-only)
 *  - notifications: email delivery with retries; delivery is logged
 */
import { Worker } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { QUEUES, getQueue, enqueueEmail, closeQueues } from './queues.js';
import { sweepSubscriptions } from '../services/subscription.service.js';
import { sys, closeDatabase } from '../database/index.js';
import { sendEmail } from '../services/email.service.js';
import { verifyProviderPayment, createRenewalInvoices } from '../services/billing.service.js';
import { Op } from 'sequelize';

if (!env.REDIS_URL) {
  logger.fatal('REDIS_URL is required for the worker');
  process.exit(1);
}
const connection = { url: env.REDIS_URL };

/** Notify owners/admins of a tenant (system connection, explicitly tenant-scoped). */
async function notifyTenantAdmins(tenantId, template, data) {
  const admins = await sys.User.findAll({
    where: { tenantId, status: 'ACTIVE' },
    include: [{ model: sys.Role, as: 'roles', where: { key: ['company_owner', 'company_admin'] }, attributes: [] }],
    attributes: ['email'],
  });
  await Promise.all(admins.map((a) => enqueueEmail({ tenantId, to: a.email, template, data })));
}

const subscriptionWorker = new Worker(QUEUES.SUBSCRIPTIONS, async (job) => {
  if (job.name === 'payment-reconcile') {
    // Payments where the customer never came back from eSewa/Khalti: ask the provider directly.
    const stale = await sys.Payment.findAll({ where: { status: 'INITIATED', provider: { [Op.in]: ['ESEWA', 'KHALTI'] }, createdAt: { [Op.between]: [new Date(Date.now() - 2 * 86_400_000), new Date(Date.now() - 10 * 60_000)] } }, limit: 200 });
    let paid = 0;
    for (const p of stale) {
      try { if ((await verifyProviderPayment(p)).ok) paid += 1; } catch (err) { logger.warn({ err, paymentId: p.id }, 'reconcile failed'); }
    }
    return { checked: stale.length, paid };
  }
  if (job.name === 'renewal-invoices') return { created: await createRenewalInvoices(7) };
  if (job.name !== 'lifecycle-sweep') return;
  const changes = await sweepSubscriptions(new Date());
  for (const c of changes) {
    await notifyTenantAdmins(c.tenantId, `subscription.${c.to.toLowerCase()}`, { from: c.from, to: c.to });
  }
  logger.info({ count: changes.length }, 'subscription sweep complete');
  return { changes: changes.length };
}, { connection, concurrency: 1 });

const notificationWorker = new Worker(QUEUES.NOTIFICATIONS, async (job) => {
  if (job.name === 'email') return sendEmail(job.data);
  return null;
}, { connection, concurrency: 10 });

for (const w of [subscriptionWorker, notificationWorker]) {
  w.on('failed', (job, err) => logger.error({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err }, 'job failed'));
}

// Schedule the sweep every 15 minutes (idempotent: same scheduler id).
const subsQ = getQueue(QUEUES.SUBSCRIPTIONS);
await subsQ.upsertJobScheduler('lifecycle-sweep', { every: 15 * 60_000 }, { name: 'lifecycle-sweep' });
await subsQ.upsertJobScheduler('payment-reconcile', { every: 10 * 60_000 }, { name: 'payment-reconcile' });
await subsQ.upsertJobScheduler('renewal-invoices', { pattern: '15 2 * * *', tz: 'Asia/Kathmandu' }, { name: 'renewal-invoices' });
logger.info('worker started');

async function shutdown() {
  await Promise.allSettled([subscriptionWorker.close(), notificationWorker.close()]);
  await Promise.allSettled([closeQueues(), closeDatabase()]);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
