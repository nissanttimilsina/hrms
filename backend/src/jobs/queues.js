import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Queue registry. Conventions for tenant-aware jobs:
 *  - job.data.tenantId is REQUIRED for any job that touches tenant data.
 *  - processors run tenant work through withTenant(job.data.tenantId, ...) so RLS
 *    applies inside workers exactly as it does in the API.
 */
export const QUEUES = { NOTIFICATIONS: 'notifications', SUBSCRIPTIONS: 'subscriptions' };

const connection = env.REDIS_URL ? { url: env.REDIS_URL } : null;
const queues = {};

export function getQueue(name) {
  if (!connection) return null;
  queues[name] ??= new Queue(name, {
    connection,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 7 * 86_400, count: 10_000 },
      removeOnFail: { age: 30 * 86_400 },
    },
  });
  return queues[name];
}

/** Queue an email. In environments without Redis the message is logged instead. */
export async function enqueueEmail({ tenantId = null, to, template, data = {}, locale = 'en' }) {
  const q = getQueue(QUEUES.NOTIFICATIONS);
  if (!q) {
    logger.warn({ to, template }, 'REDIS_URL not set: email not queued');
    return null;
  }
  return q.add('email', { tenantId, to, template, data, locale });
}

export async function closeQueues() {
  await Promise.allSettled(Object.values(queues).map((q) => q.close()));
}
