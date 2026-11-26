import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { requestId, apiLimiter, notFound, errorHandler } from './middleware/common.js';
import { apiRouter } from './routes/index.js';
import { checkDatabase } from './database/index.js';
import { checkRedis } from './services/redis.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url.startsWith('/health') } }));
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }));

  // CORS: exact origins from config plus any *.ROOT_DOMAIN tenant subdomain over https.
  const tenantOrigin = new RegExp(`^https://[a-z0-9-]+\\.${env.ROOT_DOMAIN.replace(/\./g, '\\.')}$`);
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin) || tenantOrigin.test(origin)),
    credentials: true,
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Request-Id', 'X-Client'],
    exposedHeaders: ['X-Request-Id', 'X-Subscription-State', 'X-Subscription-Reason'],
    maxAge: 600,
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // ------------------------------------------------------------------ health
  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    const checks = {};
    try { await checkDatabase(); checks.database = 'ok'; } catch { checks.database = 'down'; }
    try { checks.redis = (await checkRedis()) === 'PONG' ? 'ok' : 'disabled'; } catch { checks.redis = 'down'; }
    const healthy = checks.database === 'ok' && checks.redis !== 'down';
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  });

  // ------------------------------------------------------------------ API docs
  if (env.ENABLE_API_DOCS) {
    const spec = YAML.parse(fs.readFileSync(path.join(here, '..', 'openapi.yaml'), 'utf8'));
    app.get('/api/v1/openapi.json', (_req, res) => res.json(spec));
    app.use('/api/docs', (_req, res, next) => { res.removeHeader('Content-Security-Policy'); next(); }, swaggerUi.serve, swaggerUi.setup(spec));
  }

  app.use('/api/v1', apiLimiter, apiRouter());

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
