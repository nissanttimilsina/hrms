import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Email transport abstraction. Phase 1 ships a 'log' transport (development)
 * and the interface for SMTP/API providers. The notification engine (Phase 2+)
 * will render tenant-customisable, multi-language templates from the database
 * and write delivery logs; this function is the single delivery entry point.
 */
const transports = {
  log: async (msg) => {
    // Never log secrets (tokens) outside development.
    logger.info({ to: msg.to, template: msg.template, ...(env.NODE_ENV === 'development' && { data: msg.data }) }, 'email (log transport)');
    return { delivered: true, transport: 'log' };
  },
};

export async function sendEmail({ to, template, data, locale, tenantId }) {
  const name = process.env.EMAIL_TRANSPORT || 'log';
  const transport = transports[name];
  if (!transport) throw new Error(`Email transport "${name}" is not configured`);
  return transport({ to, template, data, locale, tenantId });
}
