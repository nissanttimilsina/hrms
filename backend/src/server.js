import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { closeDatabase } from './database/index.js';
import { closeRedis } from './services/redis.js';
import { closeQueues } from './jobs/queues.js';

const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'HRMS API listening'));
server.keepAliveTimeout = 65_000; // > nginx keepalive_timeout

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await Promise.allSettled([closeQueues(), closeDatabase(), closeRedis()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
