import { Sequelize } from 'sequelize';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { defineModels } from './models.js';
import { isUuid } from '../utils/crypto.js';

const common = {
  dialect: 'postgres',
  logging: env.LOG_LEVEL === 'trace' ? (sql) => logger.trace({ sql }) : false,
  pool: { max: env.DB_POOL_MAX, min: 0, idle: 10_000, acquire: 30_000 },
  define: { underscored: true },
  dialectOptions: (() => {
    const mode = env.DB_SSL ?? (env.isProd ? 'verify' : 'disable');
    return mode === 'disable' ? {} : { ssl: { require: true, rejectUnauthorized: mode === 'verify' } };
  })(),
};

/**
 * appDb  — role hrms_app, RLS enforced. ALL tenant request handling goes through
 *          withTenant(), which pins app.tenant_id for the transaction.
 * systemDb — role hrms_system (BYPASSRLS). Platform admin, tenant resolution,
 *          auth sessions, provisioning and schedulers only. Callers MUST scope
 *          queries by tenant_id explicitly.
 */
export const appDb = new Sequelize(env.DATABASE_URL_APP, common);
export const systemDb = new Sequelize(env.DATABASE_URL_SYSTEM, common);

export const app = defineModels(appDb);
export const sys = defineModels(systemDb);

/**
 * Run fn inside a transaction on the RLS-enforced pool with the tenant pinned.
 * set_config(..., true) is transaction-local, so the value can never leak to
 * the next user of a pooled connection.
 *
 *   await withTenant(tenantId, async (t) => app.Employee.findAll({ transaction: t }))
 */
export async function withTenant(tenantId, fn) {
  if (!isUuid(tenantId)) throw new Error('withTenant: invalid tenantId');
  return appDb.transaction(async (transaction) => {
    await appDb.query("SELECT set_config('app.tenant_id', :tenantId, true)", {
      replacements: { tenantId },
      transaction,
    });
    transaction.tenantId = tenantId;
    return fn(transaction);
  });
}

export async function checkDatabase() {
  await Promise.all([appDb.query('SELECT 1'), systemDb.query('SELECT 1')]);
}

export async function closeDatabase() {
  await Promise.allSettled([appDb.close(), systemDb.close()]);
}
