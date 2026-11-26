import 'dotenv/config';
import { z } from 'zod';

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Three DB roles — see documentation/architecture/multi-tenancy.md
  DATABASE_URL_OWNER: z.string().url(), // migrations only
  DATABASE_URL_APP: z.string().url(), // RLS-enforced tenant traffic
  DATABASE_URL_SYSTEM: z.string().url(), // platform / auth / schedulers (BYPASSRLS)
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_ISSUER: z.string().default('hrms-platform'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Domains
  ROOT_DOMAIN: z.string().default('yourhrms.com'), // tenants get <slug>.<ROOT_DOMAIN>
  APP_HOST: z.string().default('app.yourhrms.com'), // generic company-app host
  ADMIN_HOST: z.string().default('admin.yourhrms.com'),
  MARKETING_HOST: z.string().default('www.yourhrms.com'),
  CORS_ORIGINS: z.string().default(''), // comma-separated exact origins
  TRUST_PROXY: z.coerce.number().int().min(0).default(1), // hops (nginx = 1)
  COOKIE_SECURE: bool(true),

  // Security policy
  LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  ENABLE_API_DOCS: bool(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
});
