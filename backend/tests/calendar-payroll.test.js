import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, db, makeUser } from './helpers/context.js';
import { localDate, toBS, bsMonthRange, eachDate, weekday, fiscalYear, fiscalYearRange, addDays } from '../src/services/hr/calendar.js';
import { zonedToUtc } from '../src/services/biometric/adms.js';
import { tenantAttendanceAlerts } from '../src/services/hr/attendance-alerts.js';

const KTM = 'Asia/Kathmandu';
const at = (d, hm) => zonedToUtc(`${d} ${hm}:00`, KTM).toISOString();
const r2 = (n) => Math.round(n * 100) / 100;
/** BS period string `offset` months before the current BS month. */
function periodBack(offset) {
  const bs = toBS(localDate());
  let y = bs.year; let m = bs.month - offset; // month is 0-based
  while (m < 0) { m += 12; y -= 1; }
  return { period: `${y}-${String(m + 1).padStart(2, '0')}`, ...bsMonthRange(y, m) };
}

describe('Working calendar, attendance rules, loans, bonuses and encashment', () => {
  let T; let owner; let maker; let checker; let e1; let e2; let branch; let bEmp; let fridayShift;
  const P0 = periodBack(2); const P1 = periodBack(1); const P2 = periodBack(0);
  const workdays = [...eachDate(P1.start, P1.end)].filter((d) => weekday(d) !== 'SAT');
  const runPayroll = async (period, approve = false) => {
    const run = (await maker.post('/payroll/runs').send({ period })).body.data;
    const calc = await maker.post(`/payroll/runs/${run.id}/calculate`);
    assert.equal(calc.status, 200, JSON.stringify(calc.body));
    if (approve) {
      assert.equal((await maker.post(`/payroll/runs/${run.id}/submit`)).status, 200);
      assert.equal((await checker.post(`/payroll/runs/${run.id}/approve`)).status, 200);
    }
    const items = (await maker.get(`/payroll/runs/${run.id}`)).body.data.items;
    return { run, items, of: (id) => items.find((i) => i.employeeId === id) };
  };

  before(async () => {
    await resetDatabase();
    T = await makeTenant('calco', 'PROFESSIONAL');
    owner = as('calco', (await login('calco', T.ownerEmail)).token);
    const fy = fiscalYearRange(fiscalYear(localDate()));
    const mk = (b) => owner.post('/employees').send({ joinedOn: fy.start, pan: '123456789', bank: { bankName: 'NIC', accountName: 'X', accountNumber: '1234567890' }, ...b }).then((r) => { assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; });
    e1 = await mk({ firstName: 'Late', lastName: 'Comer' });
    e2 = await mk({ firstName: 'Never', lastName: 'Here' });
    await makeUser(T.id, { email: 'maker@calco.test', roles: ['payroll_manager'] });
    await makeUser(T.id, { email: 'checker@calco.test', roles: ['payroll_manager'] });
    await makeUser(T.id, { email: 'late@calco.test', roles: ['employee'], employeeId: e1.id });
    maker = as('calco', (await login('calco', 'maker@calco.test')).token);
    checker = as('calco', (await login('calco', 'checker@calco.test')).token);
    for (const e of [e1, e2]) assert.equal((await maker.post('/payroll/salaries').send({ employeeId: e.id, effectiveFrom: fy.start, basic: 30000, components: [] })).status, 201);
  });
  after(teardown);

  describe('working calendar', () => {
    it('branch default shift with shorter Friday hours drives late/early/half-day', async () => {
      fridayShift = (await owner.post('/shifts').send({ name: 'Branch 9-5', startTime: '09:00', endTime: '17:00', breakMinutes: 60, graceMinutes: 10, weeklyOffs: ['SUN'], dayHours: { FRI: { start: '09:00', end: '13:00', breakMinutes: 0 } } })).body.data;
      assert.ok(fridayShift?.id);
      assert.equal((await owner.post('/shifts').send({ name: 'Bad', startTime: '09:00', endTime: '17:00', dayHours: { XYZ: { start: '1', end: '2' } } })).status, 422);
      branch = (await owner.post('/branches').send({ code: 'PKR', name: 'Pokhara', defaultShiftId: fridayShift.id })).body.data;
      bEmp = (await owner.post('/employees').send({ firstName: 'Branch', lastName: 'Worker', joinedOn: '2025-01-01', branchId: branch.id })).body.data;
      const friday = [...eachDate(addDays(localDate(), -14), addDays(localDate(), -1))].find((d) => weekday(d) === 'FRI');
      const r = await owner.post('/attendance/manual').send({ employeeId: bEmp.id, workDate: friday, clockIn: at(friday, '09:20'), clockOut: at(friday, '13:00'), note: 'Test Friday' });
      assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
      const rec = await db.sys.AttendanceRecord.findOne({ where: { employeeId: bEmp.id, workDate: friday } });
      assert.equal(rec.lateMinutes, 20, 'late against the branch 09:00 start');
      assert.equal(rec.earlyMinutes, 0, 'Friday ends at 13:00');
      assert.equal(rec.status, 'LATE', 'not a half day on a 4-hour Friday');
      const sat = [...eachDate(addDays(localDate(), -14), addDays(localDate(), -1))].find((d) => weekday(d) === 'SAT');
      const reg = (await owner.get('/attendance/daily').query({ date: sat })).body.data.rows;
      assert.equal(reg.find((x) => x.employee.id === bEmp.id).status, 'ABSENT', 'Saturday is a working day for the branch shift');
      assert.equal(reg.find((x) => x.employee.id === e2.id).status, 'WEEKLY_OFF');
    });

    it('a special working day turns a weekly off into a working day', async () => {
      const sat = [...eachDate(addDays(localDate(), -21), addDays(localDate(), -1))].find((d) => weekday(d) === 'SAT');
      assert.equal((await owner.post('/leave/holidays').send({ date: sat, name: 'Make-up working day', kind: 'WORKING_DAY' })).status, 201);
      const reg = (await owner.get('/attendance/daily').query({ date: sat })).body.data.rows;
      assert.equal(reg.find((x) => x.employee.id === e2.id).status, 'ABSENT');
      await db.sys.Holiday.destroy({ where: { tenantId: T.id, date: sat } });
    });
  });

  describe('payroll', () => {
    it('advance recovered in instalments across runs, then closed', async () => {
      const adv = await maker.post('/payroll/loans').send({ employeeId: e2.id, kind: 'ADVANCE', title: 'Salary advance', principal: 10000, installmentAmount: 4000, startPeriod: P0.period });
      assert.equal(adv.status, 201, JSON.stringify(adv.body));
      assert.equal((await maker.post('/payroll/loans').send({ employeeId: e2.id, kind: 'LOAN', title: 'Bad', principal: 100, installmentAmount: 200, startPeriod: P0.period })).status, 422);
      const small = (await maker.post('/payroll/loans').send({ employeeId: e2.id, kind: 'LOAN', title: 'Laptop loan', principal: 3000, installmentAmount: 3000, startPeriod: P1.period })).body.data;
      const run0 = await runPayroll(P0.period, true);
      const l0 = run0.of(e2.id).lines.find((l) => l.code === 'ADVANCE');
      assert.equal(l0.amount, 4000);
      assert.match(l0.name, /balance after: NPR 6000/);
      assert.ok(!run0.of(e2.id).lines.some((l) => l.code === 'LOAN'), 'laptop loan starts next month');
      const loans = (await maker.get('/payroll/loans').query({ employeeId: e2.id })).body.data;
      assert.equal(loans.find((l) => l.id === adv.body.data.id).balance, 6000);
      // P1 also carries a bonus and the late rule (below)
      assert.ok(small.id);
    });

    it('bonus, typed adjustments and the late-arrival rule on the next run', async () => {
      assert.equal((await maker.post('/payroll/adjustments').send({ employeeId: e1.id, period: P1.period, kind: 'EARNING', code: 'BONUS', description: 'Dashain bonus', amount: 5000 })).status, 201);
      assert.equal((await maker.post('/payroll/adjustments').send({ employeeId: e1.id, period: P1.period, kind: 'EARNING', code: 'FINE', description: 'Wrong', amount: 10 })).status, 422);
      assert.equal((await owner.put('/attendance/policy').send({ lateRule: { enabled: true, everyLateDays: 3, deductDays: 0.5 } })).status, 200);
      for (const d of workdays.slice(0, 3)) {
        const r = await owner.post('/attendance/manual').send({ employeeId: e1.id, workDate: d, clockIn: at(d, '10:30'), clockOut: at(d, '17:00'), note: 'Late test' });
        assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
      }
      const run1 = await runPayroll(P1.period, true);
      const it1 = run1.of(e1.id);
      const days = (new Date(P1.end) - new Date(P1.start)) / 86_400_000 + 1;
      assert.deepEqual({ ...it1.attendance.unpaidBreakdown, outsideEmployment: 0 }, { outsideEmployment: 0, unpaidLeave: 0, absences: 0, lateRule: 0.5, lateCount: 3 });
      const basic = it1.lines.find((l) => l.code === 'BASIC');
      assert.equal(basic.amount, r2(30000 * (days - 0.5) / days));
      assert.match(basic.name, new RegExp(`${days - 0.5} of ${days} days paid`));
      assert.ok(it1.anomalies.some((a) => /0.5 late-arrival rule/.test(a)));
      assert.equal(it1.lines.find((l) => l.code === 'BONUS').amount, 5000);
      // e2: absences are not deducted (policy off); advance second instalment + laptop loan in full
      const it2 = run1.of(e2.id);
      assert.equal(it2.attendance.unpaidBreakdown.absences, 0);
      assert.equal(it2.lines.find((l) => l.code === 'ADVANCE').amount, 4000);
      assert.equal(it2.lines.find((l) => l.code === 'LOAN').amount, 3000);
      const loans = (await maker.get('/payroll/loans').query({ employeeId: e2.id })).body.data;
      assert.equal(loans.find((l) => l.title === 'Laptop loan').status, 'CLOSED');
      assert.equal(loans.find((l) => l.title === 'Salary advance').balance, 2000);
      assert.equal(loans.find((l) => l.title === 'Salary advance').status, 'ACTIVE');
    });

    it('employees see their own advances; others cannot list loans company-wide', async () => {
      const emp = as('calco', (await login('calco', 'late@calco.test')).token);
      assert.deepEqual((await emp.get('/payroll/loans/me')).body.data, []);
      assert.equal((await emp.get('/payroll/loans')).status, 403);
    });
  });

  describe('leave', () => {
    it('casual leave exists but is switched off by default', async () => {
      const types = (await owner.get('/leave/types')).body.data;
      const casual = types.find((x) => x.code === 'CASUAL');
      assert.ok(casual && casual.isActive === false);
    });

    it('encashment debits the leave ledger and adds a taxable payroll earning', async () => {
      const home = (await owner.get('/leave/types')).body.data.find((x) => x.code === 'HOME');
      const before = (await owner.get(`/leave/balances/${e1.id}`)).body.data.balances.find((b) => b.code === 'HOME');
      assert.ok(before.available >= 1, JSON.stringify(before));
      const r = await owner.post('/leave/encashments').send({ employeeId: e1.id, leaveTypeId: home.id, days: 1, period: P2.period });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.amount, 1000);
      const after = (await owner.get(`/leave/balances/${e1.id}`)).body.data.balances.find((b) => b.code === 'HOME');
      assert.equal(r2(before.available - after.available), 1);
      const adj = await db.sys.PayrollAdjustment.findOne({ where: { tenantId: T.id, code: 'LEAVE_ENCASHMENT' } });
      assert.equal(Number(adj.amount), 1000);
      assert.equal(adj.taxable, true);
      assert.equal((await owner.post('/leave/encashments').send({ employeeId: e1.id, leaveTypeId: home.id, days: 400, period: P2.period })).status, 422);
      assert.equal((await owner.post('/leave/encashments').send({ employeeId: e1.id, leaveTypeId: home.id, days: 100, period: P2.period })).status, 400);
      assert.equal((await owner.post('/leave/encashments').send({ employeeId: e1.id, leaveTypeId: home.id, days: 1, period: P1.period })).body.error?.code, 'PERIOD_LOCKED');
      const unpaid = (await owner.get('/leave/types')).body.data.find((x) => x.code === 'UNPAID');
      assert.equal((await owner.post('/leave/encashments').send({ employeeId: e1.id, leaveTypeId: unpaid.id, days: 1, period: P2.period })).status, 400);
    });
  });

  describe('attendance alerts', () => {
    it('late, missing and repeated-lateness notices go to the right people, once', async () => {
      const third = workdays[2];
      const r = await tenantAttendanceAlerts(T.id, third);
      assert.ok(r.late >= 1 && r.absent >= 1);
      assert.equal(r.repeated, 1, 'third late day this month reaches the threshold of 3');
      const lateUser = await db.sys.User.findOne({ where: { email: 'late@calco.test' } });
      const mine = await db.sys.Notification.findAll({ where: { userId: lateUser.id } });
      assert.ok(mine.some((n) => n.type === 'attendance.late' && n.title.includes(third)));
      const ownerUser = await db.sys.User.findOne({ where: { email: T.ownerEmail } });
      const hr = await db.sys.Notification.findAll({ where: { userId: ownerUser.id } });
      assert.ok(hr.some((n) => n.type === 'attendance.repeated_late' && /late 3 times/.test(n.title)));
      assert.ok(hr.some((n) => n.type === 'attendance.daily_summary'));
      const count = await db.sys.Notification.count({ where: { tenantId: T.id } });
      await tenantAttendanceAlerts(T.id, third);
      assert.equal(await db.sys.Notification.count({ where: { tenantId: T.id } }), count, 'idempotent');
      await owner.put('/attendance/policy').send({ notifyLate: false, notifyMissingPunch: false, repeatedLateThreshold: 0 });
      await tenantAttendanceAlerts(T.id, workdays[3] ?? workdays[0]);
      assert.ok(!(await db.sys.Notification.findAll({ where: { userId: lateUser.id } })).some((n) => n.title.includes(workdays[3])), 'switched off');
    });
  });
});
