import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, db, makeUser } from './helpers/context.js';
import { localDate, addDays } from '../src/services/hr/calendar.js';
import { documentExpiryAlerts } from '../src/services/hr/document-alerts.js';

describe('Reports & document expiry alerts', () => {
  let T; let owner; let deptA; let deptB; let emps;
  const today = localDate();
  before(async () => {
    await resetDatabase();
    T = await makeTenant('reportco', 'STANDARD');
    owner = as('reportco', (await login('reportco', T.ownerEmail)).token);
    deptA = (await owner.post('/departments').send({ code: 'SAL', name: 'Sales' })).body.data;
    deptB = (await owner.post('/departments').send({ code: 'FIN', name: 'Finance' })).body.data;
    const mk = (b) => owner.post('/employees').send(b).then((r) => { assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; });
    emps = [
      await mk({ firstName: 'Old', lastName: 'Timer', joinedOn: addDays(today, -400), gender: 'MALE', departmentId: deptA.id }),
      await mk({ firstName: 'New', lastName: 'Joiner', joinedOn: addDays(today, -10), gender: 'FEMALE', departmentId: deptA.id }),
      await mk({ firstName: '=HYPERLINK("x")', lastName: 'Evil', joinedOn: addDays(today, -200), gender: 'FEMALE', departmentId: deptB.id }),
      await mk({ firstName: 'Gone', lastName: 'Soon', joinedOn: addDays(today, -300), gender: 'MALE', departmentId: deptB.id }),
    ];
    await db.sys.Employee.update({ exitedOn: addDays(today, -5), status: 'TERMINATED' }, { where: { id: emps[3].id } });
  });
  after(teardown);

  it('headcount & turnover: start/end, joiners, leavers, breakdown', async () => {
    const r = await owner.get('/reports/headcount').query({ from: addDays(today, -29), to: today });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = Object.fromEntries(r.body.data.summary);
    assert.equal(s['Headcount at start'], 3);
    assert.equal(s['Headcount at end'], 3);
    assert.equal(s.Joiners, 1);
    assert.equal(s.Leavers, 1);
    assert.equal(s['Turnover rate'], '33.3%');
    const sales = r.body.data.table.rows.find((x) => x.department === 'Sales');
    assert.deepEqual([sales.total, sales.female, sales.male], [2, 1, 1]);
  });

  it('filters by department and validates the range', async () => {
    const r = await owner.get('/reports/headcount').query({ departmentId: deptB.id });
    assert.equal(Object.fromEntries(r.body.data.summary)['Headcount at end'], 1);
    assert.equal((await owner.get('/reports/headcount').query({ from: today, to: addDays(today, -3) })).status, 400);
    assert.equal((await owner.get('/reports/headcount').query({ from: addDays(today, -800), to: today })).status, 400);
    assert.equal((await owner.get('/reports/nope')).status, 400);
  });

  it('department managers only see their department', async () => {
    await makeUser(T.id, { email: 'mgr@reportco.test', roles: ['department_manager'], employeeId: emps[0].id });
    const mgr = as('reportco', (await login('reportco', 'mgr@reportco.test')).token);
    const r = await mgr.get('/reports/headcount');
    assert.equal(r.status, 200);
    assert.equal(Object.fromEntries(r.body.data.summary)['Headcount at end'], 2);
    assert.ok(r.body.data.table.rows.every((x) => x.department === 'Sales'));
    // no export permission, no payroll report
    assert.equal((await mgr.get('/reports/headcount').query({ format: 'csv' })).status, 403);
    assert.equal((await mgr.get('/reports/payroll')).status, 403);
  });

  it('employees cannot open reports', async () => {
    await makeUser(T.id, { email: 'emp@reportco.test', roles: ['employee'], employeeId: emps[1].id });
    const emp = as('reportco', (await login('reportco', 'emp@reportco.test')).token);
    assert.equal((await emp.get('/reports/headcount')).status, 403);
    assert.equal((await emp.get('/reports/payroll')).status, 403);
  });

  it('attendance, leave and payroll reports respond with tables', async () => {
    await owner.post('/attendance/clock-in').send({});
    for (const key of ['attendance', 'leave', 'payroll']) {
      const r = await owner.get(`/reports/${key}`);
      assert.equal(r.status, 200, `${key}: ${JSON.stringify(r.body)}`);
      assert.ok(Array.isArray(r.body.data.table.rows) && r.body.data.table.columns.length > 2);
    }
    const att = await owner.get('/reports/attendance');
    assert.equal(att.body.data.table.rows.length, 4, 'everyone employed at any point in the range, incl. the recent leaver');
    const later = await owner.get('/reports/attendance').query({ from: addDays(today, -3), to: today });
    assert.equal(later.body.data.table.rows.length, 3, 'leaver excluded after their exit date');
  });

  it('CSV export neutralises spreadsheet formulas and is audited', async () => {
    const r = await owner.get('/reports/attendance').query({ format: 'csv' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /attachment; filename="attendance-/);
    assert.ok(r.text.includes(`"'=HYPERLINK(""x"") Evil"`), r.text);
    assert.ok(!/(^|,)=HYPERLINK/m.test(r.text));
    assert.equal(await db.sys.AuditLog.count({ where: { tenantId: T.id, action: 'report.export' } }), 1);
  });

  it('Excel export is a real workbook', async () => {
    const r = await owner.get('/reports/headcount').query({ format: 'xlsx' }).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    assert.equal(r.status, 200);
    assert.equal(r.body.subarray(0, 2).toString(), 'PK');
  });

  it('Basic plan: view reports, but export and payroll report need a higher plan', async () => {
    await makeTenant('basicrep', 'BASIC');
    const b = as('basicrep', (await login('basicrep', 'owner@basicrep.test')).token);
    assert.equal((await b.get('/reports/headcount')).status, 200);
    const ex = await b.get('/reports/headcount').query({ format: 'xlsx' });
    assert.equal(ex.status, 403); assert.equal(ex.body.error.code, 'FEATURE_NOT_IN_PLAN');
    assert.equal((await b.get('/reports/payroll')).body.error.code, 'FEATURE_NOT_IN_PLAN');
    const cat = (await b.get('/reports')).body.data;
    assert.equal(cat.canExport, false);
    assert.ok(!cat.reports.some((r) => r.key === 'payroll'));
  });

  it('reports stay inside the tenant', async () => {
    await makeTenant('otherco', 'STANDARD');
    const other = as('otherco', (await login('otherco', 'owner@otherco.test')).token);
    const r = await other.get('/reports/headcount');
    assert.equal(Object.fromEntries(r.body.data.summary)['Headcount at end'], 0);
  });

  describe('document expiry alerts', () => {
    const doc = (tenantId, employeeId, days, name = 'passport.pdf') => db.sys.File.create({
      tenantId, ownerType: 'EMPLOYEE_DOCUMENT', ownerId: employeeId, storageKey: `tenants/${tenantId}/${name}-${days}-${Math.random()}`,
      filename: name, mimeType: 'application/pdf', sizeBytes: 10, sha256: 'x', category: 'Passport', expiresOn: addDays(today, days),
    });

    it('notifies HR and the employee at 30/7/0 days and after expiry, once per day', async () => {
      await makeUser(T.id, { email: 'emp2@reportco.test', roles: ['employee'], employeeId: emps[2].id });
      await doc(T.id, emps[2].id, 7);
      await doc(T.id, emps[2].id, 12, 'not-a-milestone.pdf');
      await doc(T.id, emps[3].id, 7, 'terminated.pdf');
      const first = await documentExpiryAlerts();
      assert.equal(first.sent, 1);
      const notes = await db.sys.Notification.findAll({ where: { tenantId: T.id, type: 'document.expiry' } });
      const recipients = await db.sys.User.findAll({ where: { id: notes.map((n) => n.userId) }, attributes: ['email'] });
      const emails = recipients.map((u) => u.email);
      assert.ok(emails.includes(T.ownerEmail) && emails.includes('emp2@reportco.test'), emails.join());
      assert.match(notes[0].title, /passport\.pdf .* expires in 7 days/);
      assert.equal((await documentExpiryAlerts()).sent, 0, 'idempotent within a day');
    });

    it('is skipped for plans without document expiry alerts', async () => {
      const B = await makeTenant('basicdocs', 'BASIC');
      const e = await db.sys.Employee.create({ tenantId: B.id, employeeCode: 'E1', firstName: 'A', lastName: 'B', joinedOn: today, status: 'ACTIVE' });
      await doc(B.id, e.id, 0);
      await documentExpiryAlerts();
      assert.equal(await db.sys.Notification.count({ where: { tenantId: B.id } }), 0);
    });
  });
});
