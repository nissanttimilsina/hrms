import { ZodError } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError, ValidationError, NotFound } from '../utils/errors.js';
import { redis } from '../services/redis.js';
import { uuid } from '../utils/crypto.js';

export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : uuid();
  res.set('X-Request-Id', req.id);
  next();
}

/** validate({ body, query, params }) — replaces each part with the parsed (typed, stripped) value. */
export const validate = (schemas) => (req, _res, next) => {
  try {
    for (const part of ['params', 'query', 'body']) {
      if (schemas[part]) {
        const parsed = schemas[part].parse(req[part] ?? {});
        if (part === 'query') Object.defineProperty(req, 'query', { value: parsed, writable: true });
        else req[part] = parsed;
      }
    }
    next();
  } catch (e) {
    next(e);
  }
};

/** Cookie-authenticated endpoints require a custom header => forces CORS preflight (CSRF defence). */
export function requireXhrHeader(req, _res, next) {
  if (req.get('x-requested-with') !== 'XMLHttpRequest' && req.get('x-client') !== 'mobile') {
    return next(new AppError(403, 'CSRF_CHECK_FAILED', 'Missing X-Requested-With header'));
  }
  next();
}

const store = (prefix) =>
  redis ? new RedisStore({ prefix: `rl:${prefix}:`, sendCommand: (...args) => redis.call(...args) }) : undefined;

const limiterHandler = (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));

export const apiLimiter = rateLimit({
  windowMs: 60_000, limit: env.isTest ? 10_000 : 300, standardHeaders: 'draft-7', legacyHeaders: false,
  store: store('api'), handler: limiterHandler,
});

/** Per IP + email to slow credential stuffing without locking out a whole office NAT. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60_000, limit: env.isTest ? 1_000 : 10, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String(req.body?.email || '').toLowerCase()}`,
  store: store('login'), handler: limiterHandler,
});

export const notFound = (req, _res, next) => next(NotFound(`Route ${req.method} ${req.path}`));

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let e = err;
  if (err instanceof ZodError) {
    e = ValidationError(err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  } else if (err?.name === 'SequelizeUniqueConstraintError') {
    e = new AppError(409, 'DUPLICATE', 'A record with these details already exists',
      err.errors?.map((x) => ({ path: x.path, message: `${x.path} must be unique` })));
  } else if (err?.name === 'SequelizeForeignKeyConstraintError') {
    e = new AppError(422, 'INVALID_REFERENCE', 'A referenced record does not exist');
  } else if (err?.type === 'entity.parse.failed') {
    e = new AppError(400, 'BAD_JSON', 'Malformed JSON body');
  } else if (err?.type === 'entity.too.large') {
    e = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  if (!(e instanceof AppError)) {
    logger.error({ err, reqId: req.id, path: req.path }, 'unhandled error');
    e = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
    if (!env.isProd) e.details = { message: err?.message }; // never expose internals in production
  } else if (e.status >= 500) {
    logger.error({ err, reqId: req.id }, e.message);
  }

  res.status(e.status).json({
    success: false,
    error: { code: e.code, message: e.message, ...(e.details && { details: e.details }), requestId: req.id },
  });
}
