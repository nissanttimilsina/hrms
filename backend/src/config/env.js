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

  // Public URLs (used in emails, payment return URLs)
  APP_URL: z.string().url().default('https://app.yourhrms.com'),
  MARKETING_URL: z.string().url().default('https://www.yourhrms.com'),
  ADMIN_URL: z.string().url().default('https://admin.yourhrms.com'),

  // Email (SMTP). EMAIL_TRANSPORT=log prints instead of sending (development).
  EMAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('Lishnu HRMS <no-reply@yourhrms.com>'),
  SALES_NOTIFY_EMAIL: z.string().email().optional(),

  // Payment providers (credentials supplied by Lishnu Tech; sandbox defaults are public test values)
  PAYMENTS_ENABLED: z.string().default('BANK_TRANSFER'), // comma list: ESEWA,KHALTI,BANK_TRANSFER
  ESEWA_PRODUCT_CODE: z.string().default('EPAYTEST'),
  ESEWA_SECRET_KEY: z.string().default('8gBm/:&EnhH.1/q'),
  ESEWA_FORM_URL: z.string().url().default('https://rc-epay.esewa.com.np/api/epay/main/v2/form'),
  ESEWA_STATUS_URL: z.string().url().default('https://rc.esewa.com.np/api/epay/transaction/status/'),
  KHALTI_SECRET_KEY: z.string().optional(),
  KHALTI_BASE_URL: z.string().url().default('https://dev.khalti.com/api/v2'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (parsed.data.NODE_ENV === 'production') {
  const enabled = parsed.data.PAYMENTS_ENABLED.toUpperCase();
  const problems = [];
  if (enabled.includes('ESEWA') && (parsed.data.ESEWA_PRODUCT_CODE === 'EPAYTEST' || parsed.data.ESEWA_FORM_URL.includes('rc-epay'))) problems.push('eSewa is enabled with sandbox settings');
  if (enabled.includes('KHALTI') && (!parsed.data.KHALTI_SECRET_KEY || parsed.data.KHALTI_BASE_URL.includes('dev.khalti'))) problems.push('Khalti is enabled without live credentials');
  if (!parsed.data.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true');
  if (parsed.data.EMAIL_TRANSPORT !== 'smtp') problems.push('EMAIL_TRANSPORT must be smtp');
  if (problems.length) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
    process.exit(1);
  }
}

export const env = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  paymentProviders: parsed.data.PAYMENTS_ENABLED.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
});
