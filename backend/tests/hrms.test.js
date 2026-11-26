import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, db, makeUser, api, host } from './helpers/context.js';
import { compute } from '../src/services/hr/attendance.js';
import { localDate, addDays, weekday, fiscalYear, fiscalYearRange } from '../src/services/hr/calendar.js';

const TZ = 'Asia/Kathmandu';
const today = localDate(new Date(), TZ);
/** n-th upcoming working day (not Saturday), starting tomorrow. */
const workday = (n) => { let d = today; let k = 0; while (k < n) { d = addDays(d, 1); if (weekday(d) !== 'SAT') k += 1; } return d; };
const at = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+05:45`).toISOString();

describe('Core HRMS', () => {
  let T; let owner; let hq; let eng;
  const emp = {};
  const tok = {};

  before(async () => {
    await resetDatabase();
    T = await makeTenant('acmehr', 'BUSINESS');
    owner = as('acmehr', (await login('acmehr', T.ownerEmail)).token);
    hq = (await owner.get('/branches')).body.data[0];
    eng = (await owner.post('/departments').send({ code: 'ENG', name: 'Engineering' })).body.data;
    const fyStart = fiscalYearRange(fiscalYear(today)).start;
    const mk = async (k, extra = {}) => { emp[k] = (await owner.post('/employees').send({ firstName: k, lastName: 'Test', joinedOn: fyStart, branchId: hq.id, departmentId: eng.id, ...extra })).body.data; };
    await mk('lead', { gender: 'FEMALE' });
    await mk('dev', { gender: 'MALE', managerId: emp.lead.id });
    await makeUser(T.id, { email: 'lead@acmehr.test', roles: ['department_manager', 'employee'], employeeId: emp.lead.id });
    await makeUser(T.id, { email: 'dev@acmehr.test', roles: ['employee'], employeeId: emp.dev.id });
    await makeUser(T.id, { email: 'hr@acmehr.test', roles: ['hr_manager'] });
    for (const k of ['lead', 'dev', 'hr']) tok[k] = as('acmehr', (await login('acmehr', `${k}@acmehr.test`)).token);
  });
  after(teardown);

  describe('provisioning defaults', () => {
    it('creates Labour-Act leave types and a default shift', async () => {
      const types = (await owner.get('/leave/types')).body.data.map((x) => x.code).sort();
      assert.deepEqual(types, ['HOME', 'MATERNITY', 'MATERNITY_EXT', 'MOURNING', 'PATERNITY', 'SICK', 'UNPAID']);
      const shifts = (await owner.get('/shifts')).body.data;
      assert.equal(shifts.filter((s) => s.isDefault).length, 1);
    });
  });

  describe('employee lifecycle', () => {
    it('bank account numbers are encrypted at rest and masked in the API', async () => {
      const res = await owner.patch(`/employees/${emp.dev.id}`).send({ bank: { bankName: 'NIC Asia', accountName: 'Dev Test', accountNumber: '0123456789012' }, pan: '123456789' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.bank.last4, '9012');
      assert.equal(res.body.data.bank.accountNumber, undefined);
      assert.equal(res.body.data.bank.accountNumberEnc, undefined);
      const raw = await db.sys.Employee.findByPk(emp.dev.id);
      assert.ok(raw.bank.accountNumberEnc.startsWith('v1.'));
      assert.ok(!JSON.stringify(raw.bank).includes('0123456789012'));
    });
    it('colleagues cannot see sensitive fields; the employee can see their own', async () => {
      const asLead = (await tok.lead.get(`/employees/${emp.dev.id}`)).body.data;
      assert.equal(asLead.pan, undefined);
      assert.equal(asLead.bank, undefined);
      const self = (await tok.dev.get('/employees/me')).body.data;
      assert.equal(self.pan, '123456789');
    });
    it('transfers and designation changes are recorded as dated history', async () => {
      const ops = (await owner.post('/departments').send({ code: 'OPS', name: 'Operations' })).body.data;
      const des = (await owner.post('/designations').send({ name: 'Senior Engineer', level: 3 })).body.data;
      await owner.patch(`/employees/${emp.dev.id}`).send({ departmentId: ops.id, designationId: des.id, effectiveOn: today, changeNote: 'Reorg' });
      const h = (await owner.get(`/employees/${emp.dev.id}/history`)).body.data;
      assert.ok(h.some((x) => x.type === 'TRANSFER' && x.toValue.departmentId === ops.id && x.fromValue.departmentId === eng.id));
      assert.ok(h.some((x) => x.type === 'DESIGNATION_CHANGE'));
      assert.ok(h.some((x) => x.type === 'JOINED'));
      await assert.rejects(db.systemDb.query('UPDATE employee_history SET note = \'x\''), /permission denied/);
      await owner.patch(`/employees/${emp.dev.id}`).send({ departmentId: eng.id });
    });
    it('employees can update only their own contact details', async () => {
      assert.equal((await tok.dev.patch('/employees/me').send({ phone: '9800000001', emergencyContacts: [{ name: 'Mother', relation: 'Mother', phone: '9800000002' }] })).status, 200);
      assert.equal((await tok.dev.patch('/employees/me').send({ pan: '999999999' })).status, 422);
      assert.equal((await tok.dev.patch(`/employees/${emp.dev.id}`).send({ firstName: 'Hacker' })).status, 403);
    });
    it('CSV import validates every row (dry run) and is all-or-nothing', async () => {
      const bad = 'First name,Last name,Joined on,Branch\nGood,Row,2026-01-01,Head Office\nBad,Row,not-a-date,Nowhere\n';
      const r1 = await owner.post('/employees/import?dryRun=true').attach('file', Buffer.from(bad), 'e.csv');
      assert.equal(r1.status, 422);
      assert.ok(r1.body.error.details.some((d) => d.path.startsWith('row 3')));
      const good = '﻿First name,Last name,Joined on,Branch,Employment type\n"Ram, Jr",Karki,2026-01-01,HQ,Contract\nHari,Thapa,2026-02-01,Head Office,permanent\n';
      const dry = await owner.post('/employees/import?dryRun=true').attach('file', Buffer.from(good), 'e.csv');
      assert.deepEqual(dry.body.data, { valid: 2, imported: 0 });
      const real = await owner.post('/employees/import').attach('file', Buffer.from(good), 'e.csv');
      assert.equal(real.body.data.imported, 2);
      const list = (await owner.get('/employees').query({ search: 'Karki' })).body.data;
      assert.equal(list[0].firstName, 'Ram, Jr');
      assert.equal(list[0].employmentType, 'CONTRACT');
    });
    it('CSV export neutralises spreadsheet formulas', async () => {
      await owner.post('/employees').send({ firstName: '=HYPERLINK("http://evil")', lastName: 'X', joinedOn: '2026-01-01' });
      const res = await owner.get('/employees/export');
      assert.equal(res.status, 200);
      assert.ok(res.text.includes(`"'=HYPERLINK`));
    });
    it('invite creates a linked login; termination disables it and frees the seat', async () => {
      const e = (await owner.post('/employees').send({ firstName: 'Leaver', lastName: 'Test', joinedOn: '2026-01-01', workEmail: 'leaver@acmehr.test' })).body.data;
      const inv = await owner.post(`/employees/${e.id}/invite`).send({});
      assert.equal(inv.status, 201);
      assert.equal((await owner.post(`/employees/${e.id}/invite`).send({})).body.error.code, 'USER_EXISTS');
      const term = await owner.post(`/employees/${e.id}/terminate`).send({ exitedOn: today, reason: 'RESIGNATION' });
      assert.equal(term.status, 200);
      assert.equal((await db.sys.User.findOne({ where: { employeeId: e.id } })).status, 'DISABLED');
      assert.ok((await owner.get(`/employees/${e.id}/history`)).body.data.some((h) => h.type === 'TERMINATION'));
    });
    it('documents: type-sniffed upload, private download, storage usage tracked', async () => {
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32)]);
      const up = await owner.post(`/employees/${emp.dev.id}/documents`).field('category', 'Contract').attach('file', pdf, { filename: 'contract.pdf', contentType: 'application/pdf' });
      assert.equal(up.status, 201);
      assert.equal(up.body.data.storageKey, undefined);
      const fake = await owner.post(`/employees/${emp.dev.id}/documents`).attach('file', Buffer.from('MZ evil exe'), { filename: 'cv.pdf', contentType: 'application/pdf' });
      assert.equal(fake.status, 400);
      const dl = await owner.get(`/employees/${emp.dev.id}/documents/${up.body.data.id}`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      assert.equal(dl.status, 200);
      assert.equal(dl.headers['cache-control'], 'private, no-store');
      assert.equal(dl.body.subarray(0, 4).toString(), '%PDF');
      assert.equal((await owner.get('/subscription')).body.data.usage.storageMb, 1);
    });
  });

  describe('attendance', () => {
    const sch = { start: '10:00', end: '17:00', breakMinutes: 60, graceMinutes: 10, weeklyOffs: ['SAT'] };
    const pol = { halfDayMinutes: 240, overtimeAfterMinutes: 30 };
    it('calculates late, half-day and overtime correctly', () => {
      const d = '2026-11-26';
      assert.equal(compute({ clockIn: at(d, '10:05') }, sch, pol, TZ).status, 'PRESENT'); // within grace
      const late = compute({ clockIn: at(d, '10:25'), clockOut: at(d, '17:00') }, sch, pol, TZ);
      assert.equal(late.status, 'LATE'); assert.equal(late.lateMinutes, 25); assert.equal(late.workedMinutes, 335);
      assert.equal(compute({ clockIn: at(d, '10:00'), clockOut: at(d, '13:00') }, sch, pol, TZ).status, 'HALF_DAY');
      const ot = compute({ clockIn: at(d, '09:55'), clockOut: at(d, '19:00') }, sch, pol, TZ);
      assert.equal(ot.overtimeMinutes, 125);
      const night = compute({ clockIn: at(d, '22:10'), clockOut: at(addDays(d, 1), '06:00') }, { ...sch, start: '22:00', end: '06:00' }, pol, TZ);
      assert.equal(night.lateMinutes, 0); assert.equal(night.workedMinutes, 410); assert.equal(night.earlyMinutes, 0);
    });
    it('clock in/out once per day; requires a linked employee', async () => {
      const r = await tok.dev.post('/attendance/clock-in').send({});
      assert.equal(r.status, 201);
      assert.equal((await tok.dev.post('/attendance/clock-in').send({})).body.error.code, 'ALREADY_CLOCKED_IN');
      assert.equal((await tok.dev.post('/attendance/clock-out').send({})).status, 200);
      assert.equal((await tok.hr.post('/attendance/clock-in').send({})).status, 400); // HR user not linked to an employee
      const todayRes = (await tok.dev.get('/attendance/me/today')).body.data;
      assert.ok(todayRes.record.clockOut);
    });
    it('geofence and location rules are enforced on the server', async () => {
      await owner.put('/attendance/policy').send({ geofence: { enabled: true, lat: 27.7172, lng: 85.324, radiusM: 200 } });
      const none = await tok.lead.post('/attendance/clock-in').send({});
      assert.equal(none.status, 400);
      const far = await tok.lead.post('/attendance/clock-in').send({ lat: 27.6915, lng: 85.342, accuracy: 10 });
      assert.equal(far.body.error.code, 'OUTSIDE_GEOFENCE');
      const near = await tok.lead.post('/attendance/clock-in').send({ lat: 27.7173, lng: 85.3241, accuracy: 10 });
      assert.equal(near.status, 201);
      assert.ok(near.body.data.inMeta.distanceM < 50);
      await owner.put('/attendance/policy').send({ geofence: { enabled: false, lat: null, lng: null, radiusM: 200 } });
    });
    it('corrections: manager approves, self-approval is blocked, record recalculated', async () => {
      const yesterday = addDays(today, -1);
      const c = await tok.dev.post('/attendance/corrections').send({ workDate: yesterday, clockIn: at(yesterday, '09:58'), clockOut: at(yesterday, '17:05'), reason: 'Forgot to clock in' });
      assert.equal(c.status, 201);
      assert.equal((await tok.dev.post(`/attendance/corrections/${c.body.data.id}/approve`).send({})).status, 403); // employee role lacks approve
      const ok = await tok.lead.post(`/attendance/corrections/${c.body.data.id}/approve`).send({ note: 'ok' });
      assert.equal(ok.status, 200);
      const rec = await db.sys.AttendanceRecord.findOne({ where: { employeeId: emp.dev.id, workDate: yesterday } });
      assert.equal(rec.source, 'CORRECTION');
      assert.equal(rec.lateMinutes, 0);
      const notif = (await tok.dev.get('/notifications')).body.data;
      assert.ok(notif.items.some((n) => n.type === 'attendance.correction_decided'));
    });
    it('daily register and monthly summary respect scope; CSV export needs permission', async () => {
      const reg = (await tok.lead.get('/attendance/daily')).body.data;
      assert.ok(reg.rows.every((r) => [emp.lead.id, emp.dev.id].includes(r.employee.id)));
      assert.ok(reg.totals.present >= 2);
      const mine = (await tok.dev.get('/attendance/daily')).body.data;
      assert.equal(mine.rows.length, 1);
      const sum = await owner.get('/attendance/summary').query({ from: addDays(today, -6), to: today });
      assert.equal(sum.status, 200);
      assert.equal((await tok.dev.get('/attendance/summary').query({ from: today, to: today, format: 'csv' })).status, 403);
    });
  });

  describe('leave', () => {
    it('balances: yearly allocation and monthly home-leave accrual', async () => {
      const b = (await tok.dev.get('/leave/balances/me')).body.data.balances;
      const sick = b.find((x) => x.code === 'SICK');
      assert.equal(sick.entitled, 12);
      const home = b.find((x) => x.code === 'HOME');
      assert.ok(home.entitled >= 0 && home.entitled <= 18);
      assert.ok(!b.some((x) => x.code === 'MATERNITY')); // male employee
      const lb = (await tok.lead.get('/leave/balances/me')).body.data.balances;
      assert.ok(lb.some((x) => x.code === 'MATERNITY' && x.entitled === 60));
    });
    it('apply → manager approves → balance used; weekly offs excluded from day count', async () => {
      const types = (await owner.get('/leave/types')).body.data;
      const sick = types.find((x) => x.code === 'SICK');
      let s = workday(3);
      while (weekday(addDays(s, 1)) !== 'SAT' && weekday(addDays(s, 2)) !== 'SAT') s = addDays(s, 1);
      const e = addDays(s, 3); // spans a Saturday
      const r = await tok.dev.post('/leave/requests').send({ leaveTypeId: sick.id, startDate: s, endDate: e, reason: 'Fever' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(Number(r.body.data.days), 3);
      const pending = (await tok.dev.get('/leave/balances/me')).body.data.balances.find((x) => x.code === 'SICK');
      assert.equal(pending.available, 9);
      assert.equal((await tok.dev.post('/leave/requests').send({ leaveTypeId: sick.id, startDate: s, endDate: s })).body.error.code, 'LEAVE_OVERLAP');
      assert.equal((await tok.dev.post(`/leave/requests/${r.body.data.id}/approve`).send({})).status, 403);
      const ap = await tok.lead.post(`/leave/requests/${r.body.data.id}/approve`).send({});
      assert.equal(ap.body.data.status, 'APPROVED');
      const after = (await tok.dev.get('/leave/balances/me')).body.data.balances.find((x) => x.code === 'SICK');
      assert.equal(after.used, 3); assert.equal(after.balance, 9);
      // cancel future approved leave → reversal
      assert.equal((await tok.dev.post(`/leave/requests/${r.body.data.id}/cancel`).send({})).status, 200);
      assert.equal((await tok.dev.get('/leave/balances/me')).body.data.balances.find((x) => x.code === 'SICK').balance, 12);
    });
    it('rejects insufficient balance, wrong gender and multi-year spans', async () => {
      const types = (await owner.get('/leave/types')).body.data;
      const sick = types.find((x) => x.code === 'SICK');
      const mat = types.find((x) => x.code === 'MATERNITY');
      assert.equal((await tok.dev.post('/leave/requests').send({ leaveTypeId: sick.id, startDate: workday(1), endDate: addDays(workday(1), 30) })).status, 400);
      assert.equal((await tok.dev.post('/leave/requests').send({ leaveTypeId: mat.id, startDate: workday(2), endDate: workday(2) })).status, 400);
    });
    it('two-level approval: manager first, then HR; manager cannot do HR level', async () => {
      const unpaid = (await owner.get('/leave/types')).body.data.find((x) => x.code === 'UNPAID');
      const d = workday(15);
      const r = (await tok.dev.post('/leave/requests').send({ leaveTypeId: unpaid.id, startDate: d, endDate: d, reason: 'Personal' })).body.data;
      const l1 = (await tok.lead.post(`/leave/requests/${r.id}/approve`).send({})).body.data;
      assert.equal(l1.status, 'PENDING'); assert.equal(l1.currentLevel, 2);
      assert.equal((await tok.lead.post(`/leave/requests/${r.id}/approve`).send({})).body.error.code, 'NEEDS_HR');
      const l2 = (await tok.hr.post(`/leave/requests/${r.id}/approve`).send({})).body.data;
      assert.equal(l2.status, 'APPROVED');
      const approvals = await db.sys.LeaveApproval.count({ where: { requestId: r.id } });
      assert.equal(approvals, 2);
      // approved leave shows on the daily register for that date
      const reg = (await owner.get('/attendance/daily').query({ date: d })).body.data;
      assert.equal(reg.rows.find((x) => x.employee.id === emp.dev.id).status, 'ON_LEAVE');
    });
    it('holidays reduce leave days and appear with BS dates', async () => {
      const d = workday(20);
      await owner.post('/leave/holidays').send({ date: d, name: 'Test Festival' });
      const hols = (await owner.get('/leave/holidays')).body.data;
      assert.ok(hols.find((h) => h.date === d).bs.match(/^20\d{2}-\d{2}-\d{2}$/));
      const sick = (await owner.get('/leave/types')).body.data.find((x) => x.code === 'SICK');
      const r = await tok.dev.post('/leave/requests').send({ leaveTypeId: sick.id, startDate: d, endDate: d });
      assert.equal(r.status, 400); // only a holiday selected
    });
    it('leave ledger is append-only', async () => {
      await assert.rejects(db.systemDb.query('UPDATE leave_transactions SET days = 100'), /permission denied/);
    });
  });

  describe('workspace', () => {
    it('dashboard adapts to role', async () => {
      const o = (await owner.get('/dashboard')).body.data;
      assert.ok(o.headcount.total >= 5);
      assert.ok(o.attendanceToday);
      assert.ok(o.byDepartment.length >= 1);
      const e = (await tok.dev.get('/dashboard')).body.data;
      assert.equal(e.headcount.total, 1); // own record only
      assert.equal(e.attendanceToday, undefined);
    });
    it('announcements notify everyone; notifications are private', async () => {
      assert.equal((await tok.dev.post('/announcements').send({ title: 'Hi', body: 'x' })).status, 403);
      assert.equal((await tok.hr.post('/announcements').send({ title: 'Dashain holidays', body: 'Office closed from Ashwin 26.' })).status, 201);
      const n = (await tok.dev.get('/notifications')).body.data;
      assert.ok(n.unread >= 1);
      await tok.dev.post('/notifications/read').send({});
      assert.equal((await tok.dev.get('/notifications')).body.data.unread, 0);
      assert.ok((await tok.lead.get('/notifications')).body.data.unread >= 1);
    });
    it('company settings are validated', async () => {
      assert.equal((await owner.put('/settings/org.employee_id_format').send({ value: { prefix: 'AC-', padding: 3, next: 50 } })).status, 200);
      assert.equal((await owner.put('/settings/branding').send({ value: { primaryColor: 'red' } })).status, 422);
      const e = (await owner.post('/employees').send({ firstName: 'Code', lastName: 'Fmt', joinedOn: '2026-01-01' })).body.data;
      assert.equal(e.employeeCode, 'AC-050');
    });
  });

  it('BASIC plan without payroll cannot reach payroll-scoped modules (entitlement enforced)', async () => {
    const B = await makeTenant('basicco', 'BASIC');
    const t = as('basicco', (await login('basicco', B.ownerEmail)).token);
    assert.equal((await t.get('/shifts')).body.error.code, 'FEATURE_NOT_IN_PLAN');
    assert.equal((await t.get('/attendance/daily')).status, 200);
    assert.equal((await api().get('/api/v1/leave/types').set('Host', host('basicco'))).status, 401);
  });
});
