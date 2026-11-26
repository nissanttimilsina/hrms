import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, api, host, teardown, db } from './helpers/context.js';

const { withTenant, app, sys, appDb } = db;

describe('Tenant isolation', () => {
  let A; let B; let tokA; let tokB; let empA; let empB; let branchB;

  before(async () => {
    await resetDatabase();
    A = await makeTenant('alpha');
    B = await makeTenant('bravo');
    tokA = (await login('alpha', A.ownerEmail)).token;
    tokB = (await login('bravo', B.ownerEmail)).token;
    empA = (await as('alpha', tokA).post('/employees').send({ firstName: 'Asha', lastName: 'A', joinedOn: '2026-01-01' })).body.data;
    empB = (await as('bravo', tokB).post('/employees').send({ firstName: 'Bikash', lastName: 'B', joinedOn: '2026-01-01' })).body.data;
    branchB = await sys.Branch.findOne({ where: { tenantId: B.id } });
  });
  after(teardown);

  // ------------------------------------------------------------------ database layer (RLS)
  describe('PostgreSQL row-level security (hrms_app role)', () => {
    it('every table with a tenant_id column has RLS enabled and forced', async () => {
      const [rows] = await appDb.query(`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND EXISTS (SELECT 1 FROM information_schema.columns col
                        WHERE col.table_name = c.relname AND col.column_name = 'tenant_id')
           AND c.relname NOT IN ('auth_sessions', 'auth_action_tokens')`);
      assert.ok(rows.length >= 15);
      const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname);
      assert.deepEqual(unprotected, [], `tables without RLS: ${unprotected}`);
    });

    it('tables with tenant_id but no RLS are never readable by the app role', async () => {
      for (const table of ['auth_sessions', 'auth_action_tokens', 'platform_users']) {
        await assert.rejects(appDb.query(`SELECT 1 FROM ${table} LIMIT 1`), /permission denied/);
      }
    });

    it('fails closed: without app.tenant_id the app role sees nothing', async () => {
      const [rows] = await appDb.query('SELECT count(*)::int AS n FROM employees');
      assert.equal(rows[0].n, 0);
      const [users] = await appDb.query('SELECT count(*)::int AS n FROM users');
      assert.equal(users[0].n, 0);
    });

    it('a tenant transaction only sees its own rows', async () => {
      const ids = await withTenant(A.id, async (t) => (await app.Employee.findAll({ transaction: t })).map((e) => e.id));
      assert.deepEqual(ids, [empA.id]);
      const tenants = await withTenant(A.id, (t) => app.Tenant.findAll({ transaction: t }));
      assert.deepEqual(tenants.map((t) => t.id), [A.id]);
    });

    it('even an explicit WHERE on another tenant returns nothing', async () => {
      const found = await withTenant(A.id, (t) => app.Employee.findAll({ where: { tenantId: B.id }, transaction: t }));
      assert.equal(found.length, 0);
    });

    it('cannot write a row for another tenant (WITH CHECK)', async () => {
      await assert.rejects(
        withTenant(A.id, (t) => app.Branch.create({ tenantId: B.id, code: 'X', name: 'Evil' }, { transaction: t })),
        /row-level security/,
      );
    });

    it('cannot update or delete another tenant\'s rows', async () => {
      const [, updated] = await withTenant(A.id, (t) => app.Employee.update({ firstName: 'Hacked' }, { where: { id: empB.id }, transaction: t }));
      assert.equal(updated ?? 0, 0);
      const deleted = await withTenant(A.id, (t) => app.Employee.destroy({ where: { id: empB.id }, transaction: t }));
      assert.equal(deleted, 0);
      const still = await sys.Employee.findByPk(empB.id);
      assert.equal(still.firstName, 'Bikash');
    });

    it('tenant setting does not leak to the next pooled transaction', async () => {
      await withTenant(A.id, async () => {});
      const [rows] = await appDb.query("SELECT current_setting('app.tenant_id', true) AS v");
      assert.ok(!rows[0].v);
    });

    it('composite FKs block cross-tenant references even for the BYPASSRLS system role', async () => {
      await assert.rejects(
        sys.Employee.create({ tenantId: A.id, employeeCode: 'X1', firstName: 'x', lastName: 'y', joinedOn: '2026-01-01', branchId: branchB.id }),
        /foreign key/i,
      );
    });

    it('audit logs are append-only for app and system roles', async () => {
      await assert.rejects(withTenant(A.id, (t) => appDb.query('DELETE FROM audit_logs', { transaction: t })), /permission denied/);
      await assert.rejects(db.systemDb.query("UPDATE audit_logs SET action = 'x'"), /permission denied/);
    });
  });

  // ------------------------------------------------------------------ API layer
  describe('API', () => {
    it("A's token is rejected on B's host", async () => {
      const res = await api().get('/api/v1/employees').set('Host', host('bravo')).set('Authorization', `Bearer ${tokA}`);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'TENANT_MISMATCH');
    });

    it('generic app host derives tenant from the signed token only', async () => {
      const res = await api().get('/api/v1/employees').set('Host', 'app.hrms.test').set('Authorization', `Bearer ${tokA}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.map((e) => e.id), [empA.id]);
    });

    it('client-supplied tenant identifiers are ignored', async () => {
      const res = await as('alpha', tokA).get('/employees').set('X-Tenant-Id', B.id).query({ tenantId: B.id });
      // strict query schema rejects unknown params; header is simply never read
      assert.equal(res.status, 422);
      const ok = await as('alpha', tokA).get('/employees').set('X-Tenant-Id', B.id);
      assert.deepEqual(ok.body.data.map((e) => e.id), [empA.id]);
    });

    it("cannot read or modify B's employee by id from A", async () => {
      assert.equal((await as('alpha', tokA).get(`/employees/${empB.id}`)).status, 404);
      assert.equal((await as('alpha', tokA).patch(`/employees/${empB.id}`).send({ firstName: 'X' })).status, 404);
    });

    it("cannot attach A's employee to B's branch", async () => {
      const res = await as('alpha', tokA).post('/employees').send({ firstName: 'C', lastName: 'C', joinedOn: '2026-01-01', branchId: branchB.id });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'INVALID_REFERENCE');
    });

    it('tenant_id in a request body cannot be smuggled in', async () => {
      const res = await as('alpha', tokA).post('/branches').send({ code: 'SM', name: 'Smuggle', tenantId: B.id });
      assert.equal(res.status, 422); // strict schema
    });

    it('unknown hosts are rejected', async () => {
      const res = await api().post('/api/v1/auth/login').set('Host', 'evil.example.com').send({ email: A.ownerEmail, password: 'x' });
      assert.equal(res.status, 404);
    });

    it('audit log of A contains only A entries', async () => {
      const res = await as('alpha', tokA).get('/audit-logs').query({ pageSize: 100 });
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length > 0);
      assert.ok(res.body.data.every((l) => l.tenantId === A.id));
    });
  });
});
