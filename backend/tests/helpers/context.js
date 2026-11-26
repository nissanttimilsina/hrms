import './env.js';
import pg from 'pg';
import request from 'supertest';
import { migrate } from '../../src/database/migrate.js';
import * as db from '../../src/database/index.js';
import { seedReference, seedSuperAdmin, seedCmsDefaults } from '../../src/database/seeds/run.js';
import { createApp } from '../../src/app.js';
import { provisionTenant } from '../../src/services/provisioning.service.js';
import { hashPassword } from '../../src/services/password.service.js';
import { redis, closeRedis } from '../../src/services/redis.js';
import { closeQueues } from '../../src/jobs/queues.js';

export const PASSWORD = 'Str0ngPassw0rd!';
export const ADMIN = { email: 'root@lishnu.test', password: 'Platf0rmAdmin!' };
export const host = (slug) => `${slug}.hrms.test`;

/** Migrate, wipe all data (keeps schema), reseed reference data. */
export async function resetDatabase() {
  await migrate(process.env.DATABASE_URL_OWNER, { log: () => {} });
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  const { rows } = await c.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('schema_migrations', 'tax_rule_sets')`);
  await c.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await c.end();
  await redis.flushdb();
  await seedReference(db);
  await seedSuperAdmin(db, ADMIN);
  await seedCmsDefaults(db);
}

export const app = createApp();
export const api = () => request(app);

export async function makeTenant(slug, planCode = 'PROFESSIONAL', { trial = true } = {}) {
  const r = await provisionTenant({
    slug, name: `${slug} Pvt. Ltd.`, planCode, trial,
    owner: { email: `owner@${slug}.test`, fullName: `${slug} Owner`, password: PASSWORD },
  });
  return { id: r.tenant.id, slug, ownerEmail: `owner@${slug}.test`, subscriptionId: r.subscription.id };
}

export async function login(slug, email, password = PASSWORD) {
  const res = await api().post('/api/v1/auth/login').set('Host', host(slug)).send({ email, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers['set-cookie'].find((c) => c.startsWith('hrms_rt='));
  return { token: res.body.data.accessToken, cookie: cookie.split(';')[0], user: res.body.data.user };
}

export async function adminLogin() {
  const res = await api().post('/api/v1/admin/auth/login').set('Host', 'admin.hrms.test').send(ADMIN);
  if (res.status !== 200) throw new Error(`admin login failed ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken;
}

/** Tenant-scoped request builder: as(tenant, token).get('/employees') */
export const as = (slug, token) => {
  const wrap = (m) => (path) => api()[m](`/api/v1${path}`).set('Host', host(slug)).set('Authorization', `Bearer ${token}`);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') };
};
export const asAdmin = (token) => {
  const wrap = (m) => (path) => api()[m](`/api/v1/admin${path}`).set('Host', 'admin.hrms.test').set('Authorization', `Bearer ${token}`);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), delete: wrap('delete') };
};
export const pub = () => {
  const wrap = (m) => (path) => api()[m](`/api/v1/public${path}`).set('Host', 'www.yourhrms.com');
  return { get: wrap('get'), post: wrap('post') };
};

/** Create an extra platform staff member with given role keys and return a token. */
export async function staffToken(email, roleKey) {
  const u = await db.sys.PlatformUser.create({ email, fullName: email, passwordHash: await hashPassword(PASSWORD) });
  const role = await db.sys.PlatformRole.findOne({ where: { key: roleKey } });
  await db.sys.PlatformUserRole.create({ userId: u.id, roleId: role.id });
  const res = await api().post('/api/v1/admin/auth/login').set('Host', 'admin.hrms.test').send({ email, password: PASSWORD });
  return res.body.data.accessToken;
}

/** Create an ACTIVE user with given role keys (and optionally linked employee) directly in the DB. */
export async function makeUser(tenantId, { email, roles, employeeId = null }) {
  const user = await db.sys.User.create({
    tenantId, email, fullName: email, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', employeeId,
  });
  const roleRows = await db.sys.Role.findAll({ where: { tenantId, key: roles } });
  await db.sys.UserRole.bulkCreate(roleRows.map((r) => ({ tenantId, userId: user.id, roleId: r.id })));
  return user;
}

export async function teardown() {
  await closeQueues();
  await db.closeDatabase();
  await closeRedis();
}

export { db };
