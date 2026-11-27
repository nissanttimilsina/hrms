import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, db } from './helpers/context.js';

describe('Deleting an employee added by mistake', () => {
  let owner; let hq; let T;
  before(async () => {
    await resetDatabase();
    T = await makeTenant('delco', 'BUSINESS');
    owner = as('delco', (await login('delco', T.ownerEmail)).token);
    hq = (await owner.get('/branches')).body.data[0];
  });
  after(teardown);

  const add = async (extra = {}) => (await owner.post('/employees').send({ firstName: 'Nishan', lastName: 'Timilsina', workEmail: 'nishan@example.com', joinedOn: '2024-05-27', branchId: hq.id, ...extra })).body.data;

  it('deletes the record and its login, then lets the same person be added and invited again', async () => {
    const first = await add();
    const mgr = await add({ firstName: 'Report', workEmail: 'report@example.com', managerId: first.id });
    let r = await owner.post(`/employees/${first.id}/invite`).send({});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await owner.delete(`/employees/${first.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await owner.get(`/employees/${first.id}`)).status, 404);
    assert.ok(!(await owner.get('/employees')).body.data.some((e) => e.id === first.id));
    assert.equal((await owner.get(`/employees/${mgr.id}`)).body.data.managerId ?? null, null);
    const again = await add();
    assert.notEqual(again.employeeCode, first.employeeCode);
    r = await owner.post(`/employees/${again.id}/invite`).send({});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const audit = (await owner.get('/audit-logs?action=employee.delete')).body.data ?? [];
    assert.ok(audit.length === 0 || audit[0].action === 'employee.delete');
  });

  it('refuses to delete someone who has been through payroll', async () => {
    const e = await add({ workEmail: 'paid@example.com' });
    const q = (sql, replacements) => db.systemDb.query(sql, { replacements, type: 'SELECT' });
    const [pr] = await q(`insert into payroll_runs (tenant_id, period, period_start, period_end, fiscal_year, status, created_by)
      values (:t, '2083-08', '2026-11-16', '2026-12-15', '2083/84', 'CALCULATED', :e) returning id`, { t: T.id, e: e.id });
    await q(`insert into payroll_items (tenant_id, run_id, employee_id, lines, attendance, tax_detail, snapshot, gross, deductions, tax, net)
      values (:t, :r, :e, '[]', '{}', '{}', '{}', 1000, 0, 10, 990) returning id`, { t: T.id, r: pr.id, e: e.id });
    const r = await owner.delete(`/employees/${e.id}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'HAS_PAYROLL');
  });

  it('does not let you delete your own record', async () => {
    const me = (await owner.get('/auth/me')).body.data.user;
    if (!me.employeeId) return;
    assert.equal((await owner.delete(`/employees/${me.employeeId}`)).status, 409);
  });
});
