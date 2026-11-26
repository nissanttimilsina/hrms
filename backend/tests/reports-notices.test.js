import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, db } from './helpers/context.js';
import { localDate, addDays } from '../src/services/hr/calendar.js';
import { zonedToUtc } from '../src/services/biometric/adms.js';
import { tenantSubscriptionNotices } from '../src/services/subscription-notices.js';
import { invalidateTenantContext } from '../src/services/subscription.service.js';

const binary = (r) => r.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

describe('More reports, PDF export and subscription notices', () => {
  let T; let owner; let e1;
  before(async () => {
    await resetDatabase();
    T = await makeTenant('repco2', 'PROFESSIONAL');
    owner = as('repco2', (await login('repco2', T.ownerEmail)).token);
    e1 = (await owner.post('/employees').send({ firstName: 'Kiran', lastName: 'Late', joinedOn: addDays(localDate(), -60), gender: 'MALE' })).body.data;
    for (const n of [3, 4]) {
      const d = addDays(localDate(), -n);
      await owner.post('/attendance/manual').send({ employeeId: e1.id, workDate: d, clockIn: zonedToUtc(`${d} 10:45:00`, 'Asia/Kathmandu').toISOString(), note: 'test' });
    }
  });
  after(teardown);

  it('lists every report the plan and role allow', async () => {
    const keys = (await owner.get('/reports')).body.data.reports.map((r) => r.key);
    for (const k of ['headcount', 'attendance', 'punctuality', 'leave', 'balances', 'payroll', 'deductions', 'devices', 'subscription']) assert.ok(keys.includes(k), k);
    const B = await makeTenant('repbasic', 'BASIC');
    const b = as('repbasic', (await login('repbasic', B.ownerEmail)).token);
    const bk = (await b.get('/reports')).body.data.reports.map((r) => r.key);
    assert.ok(!bk.includes('payroll') && !bk.includes('deductions') && !bk.includes('devices'));
    assert.equal((await b.get('/reports/devices')).body.error.code, 'FEATURE_NOT_IN_PLAN');
  });

  it('late & absences: late days, missing check-outs and absences per employee', async () => {
    const r = await owner.get('/reports/punctuality').query({ from: addDays(localDate(), -10), to: addDays(localDate(), -1) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = r.body.data.table.rows.find((x) => x.code === e1.employeeCode);
    assert.equal(row.late_days, 2);
    assert.equal(row.missing_punch, 2);
    assert.ok(row.absent >= 1);
  });

  it('leave balances, deductions, devices and subscription reports respond', async () => {
    const bal = (await owner.get('/reports/balances')).body.data;
    assert.ok(bal.table.rows.some((x) => x.code === e1.employeeCode && x.type === 'Home leave'));
    assert.equal((await owner.get('/reports/deductions')).status, 200);
    assert.equal((await owner.get('/reports/devices')).status, 200);
    const sub = (await owner.get('/reports/subscription')).body.data;
    assert.equal(sub.table.rows[0].metric, 'Employees');
    assert.equal(sub.table.rows[0].used, 1);
  });

  it('exports a real PDF (and Excel/CSV still work)', async () => {
    const pdf = await binary(owner.get('/reports/punctuality').query({ format: 'pdf' }));
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    assert.equal((await binary(owner.get('/reports/balances').query({ format: 'xlsx' }))).body.subarray(0, 2).toString(), 'PK');
    assert.ok((await db.sys.AuditLog.count({ where: { tenantId: T.id, action: 'report.export' } })) >= 2);
  });

  it('trial ending notice, once', async () => {
    await db.sys.Subscription.update({ status: 'TRIAL', trialEndsAt: new Date(Date.now() + 3 * 86_400_000 - 3600_000) }, { where: { tenantId: T.id } });
    await invalidateTenantContext(T.id);
    assert.equal((await tenantSubscriptionNotices(T.id)).sent, 1);
    assert.equal((await tenantSubscriptionNotices(T.id)).sent, 0);
    const n = await db.sys.Notification.findOne({ where: { tenantId: T.id, type: 'subscription.trial_ending' } });
    assert.match(n.title, /ends in 3 days/);
  });

  it('employee limit warnings at 80% and 100%', async () => {
    await db.sys.Subscription.update({ trialEndsAt: new Date(Date.now() + 20 * 86_400_000), maxEmployeesOverride: 1 }, { where: { tenantId: T.id } });
    await invalidateTenantContext(T.id);
    await tenantSubscriptionNotices(T.id);
    const n = await db.sys.Notification.findOne({ where: { tenantId: T.id, type: 'subscription.limit' } });
    assert.match(n.title, /Employee limit reached: 1 of 1/);
  });
});
