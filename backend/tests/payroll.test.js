import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, db, makeUser } from './helpers/context.js';
import { calculateItem, annualTax } from '../src/services/hr/payroll-calc.js';
import { localDate, toBS, fiscalYear, fiscalYearRange } from '../src/services/hr/calendar.js';

const comps = [{ code: 'DEARNESS', name: 'Dearness', kind: 'EARNING', taxable: true, prorated: true }, { code: 'FESTIVAL', name: 'Festival', kind: 'EARNING', taxable: true, prorated: false }];

describe('Payroll', () => {
  let rules;
  before(async () => { await resetDatabase(); rules = (await db.sys.TaxRuleSet.findOne({ where: { fiscalYear: '2083/84' } })).rules; });
  after(teardown);

  // ------------------------------------------------------------------ independent hand-computed cases
  describe('calculation engine (FY 2083/84 rules)', () => {
    it('progressive slabs', () => {
      const s = rules.slabs.SINGLE;
      assert.equal(annualTax(1_200_000, s).tax, 30_000);
      assert.equal(annualTax(5_000_000, s).tax, 955_000);
      assert.equal(annualTax(1_200_000, s, { waiveSst: true }).tax, 20_000);
      assert.equal(annualTax(0, s).tax, 0);
    });
    it('SSF employee: 11% / 20%, retirement deduction, 1% SST waived', () => {
      const r = calculateItem({ salary: { basic: 60000, components: [{ code: 'DEARNESS', amount: 10000 }], ssfEnrolled: true, pfPercent: 0, citMonthly: 0 }, components: comps, rules, att: { calendarDays: 30, unpaidDays: 0, overtimeMinutes: 0 }, employee: { gender: 'MALE', pan: '123456789', bank: { last4: '1234' } } });
      assert.equal(r.gross, 70000);
      assert.equal(r.ssfEmployee, 6600);
      assert.equal(r.ssfEmployer, 12000);
      assert.equal(r.taxDetail.annualTaxable, 760800);
      assert.equal(r.tax, 0);
      assert.equal(r.net, 63400);
      assert.deepEqual(r.anomalies, []);
    });
    it('PF + CIT, female rebate on income tax (not SST)', () => {
      const r = calculateItem({ salary: { basic: 150000, components: [], ssfEnrolled: false, pfPercent: 10, citMonthly: 5000 }, components: comps, rules, att: { calendarDays: 30, unpaidDays: 0, overtimeMinutes: 0 }, employee: { gender: 'FEMALE', pan: '123456789', bank: { last4: '1' } } });
      assert.equal(r.taxDetail.retirementDeduction, 420000);
      assert.equal(r.taxDetail.annualTaxable, 1560000);
      assert.equal(r.taxDetail.annualTaxBeforeRebate, 72000);
      assert.equal(r.taxDetail.femaleRebate, 6200);
      assert.equal(r.tax, 5483);
      assert.equal(r.net, 150000 - 15000 - 5000 - 5483);
    });
    it('unpaid days prorate prorated components only; overtime at 1.5×; anomalies flagged', () => {
      const r = calculateItem({ salary: { basic: 30000, components: [{ code: 'DEARNESS', amount: 3000 }, { code: 'FESTIVAL', amount: 30000 }], ssfEnrolled: false }, components: comps, rules, att: { calendarDays: 30, unpaidDays: 3, overtimeMinutes: 120, workingDaysInPeriod: 26 }, employee: {} });
      assert.equal(r.lines.find((l) => l.code === 'BASIC').amount, 27000);
      assert.equal(r.lines.find((l) => l.code === 'DEARNESS').amount, 2700);
      assert.equal(r.lines.find((l) => l.code === 'FESTIVAL').amount, 30000);
      assert.equal(r.lines.find((l) => l.code === 'OVERTIME').amount, 375); // 2h × (30000/240) × 1.5
      assert.ok(r.anomalies.includes('Missing PAN'));
      assert.ok(r.anomalies.includes('Unpaid days: 3'));
    });
    it('year-to-date: tax already paid is spread over remaining months', () => {
      const base = { salary: { basic: 200000, components: [], ssfEnrolled: false }, components: comps, rules, att: { calendarDays: 30, unpaidDays: 0, overtimeMinutes: 0 }, employee: { pan: '1', bank: { last4: '1' } } };
      const m1 = calculateItem({ ...base, monthsRemaining: 12 });
      const m2 = calculateItem({ ...base, monthsRemaining: 11, ytd: { assessable: m1.taxDetail.assessableMonth, retirement: 0, tax: m1.tax } });
      assert.ok(Math.abs(m1.tax - m2.tax) <= 1, 'steady salary → steady monthly tax');
      assert.ok(Math.abs(m1.tax * 12 - m1.taxDetail.annualTax) <= 12);
    });
  });

  // ------------------------------------------------------------------ workflow
  describe('payroll run workflow', () => {
    let T; let maker; let checker; let empTok; let e1; let e2; let runId; let period;
    before(async () => {
      T = await makeTenant('payrollco', 'PROFESSIONAL');
      const owner = as('payrollco', (await login('payrollco', T.ownerEmail)).token);
      const fy = fiscalYearRange(fiscalYear(localDate()));
      e1 = (await owner.post('/employees').send({ firstName: 'Asha', lastName: 'Rai', joinedOn: fy.start, gender: 'FEMALE', pan: '111111111', bank: { bankName: 'Nabil', accountName: 'Asha Rai', accountNumber: '00112233445566' } })).body.data;
      e2 = (await owner.post('/employees').send({ firstName: 'Bina', lastName: 'Gurung', joinedOn: fy.start })).body.data;
      await makeUser(T.id, { email: 'maker@payrollco.test', roles: ['payroll_manager'] });
      await makeUser(T.id, { email: 'checker@payrollco.test', roles: ['payroll_manager'] });
      await makeUser(T.id, { email: 'asha@payrollco.test', roles: ['employee'], employeeId: e1.id });
      maker = as('payrollco', (await login('payrollco', 'maker@payrollco.test')).token);
      checker = as('payrollco', (await login('payrollco', 'checker@payrollco.test')).token);
      empTok = as('payrollco', (await login('payrollco', 'asha@payrollco.test')).token);
      // previous BS month so all days are in the past
      const bs = toBS(localDate());
      const pm = bs.month === 0 ? 12 : bs.month; const py = bs.month === 0 ? bs.year - 1 : bs.year;
      period = `${py}-${String(pm).padStart(2, '0')}`;
    });

    it('salary is versioned and validated', async () => {
      const r = await maker.post('/payroll/salaries').send({ employeeId: e1.id, effectiveFrom: '2026-07-17', basic: 60000, components: [{ code: 'DEARNESS', amount: 10000 }], ssfEnrolled: true });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await maker.post('/payroll/salaries').send({ employeeId: e1.id, effectiveFrom: '2026-08-01', basic: 1, components: [{ code: 'NOPE', amount: 1 }] })).status, 400);
      assert.equal((await maker.get(`/payroll/salaries/${e1.id}`)).body.data.length, 1);
      await assert.rejects(db.systemDb.query('UPDATE employee_salaries SET basic = 1'), /permission denied/);
    });

    it('create → calculate: employees without salary are skipped and flagged', async () => {
      const run = await maker.post('/payroll/runs').send({ period });
      assert.equal(run.status, 201, JSON.stringify(run.body));
      runId = run.body.data.id;
      assert.equal((await maker.post('/payroll/runs').send({ period })).body.error.code, 'RUN_EXISTS');
      const calc = await maker.post(`/payroll/runs/${runId}/calculate`);
      assert.equal(calc.status, 200, JSON.stringify(calc.body));
      assert.equal(calc.body.data.totals.employees, 1);
      assert.equal(calc.body.data.totals.skipped[0].reason, 'No salary configured');
      const detail = (await maker.get(`/payroll/runs/${runId}`)).body.data;
      const it = detail.items[0];
      assert.equal(Number(it.ssfEmployee), Math.round(Number(it.lines.find((l) => l.code === 'BASIC').amount) * 0.11 * 100) / 100);
      assert.ok(it.taxDetail.bands);
      // No attendance kept: days without a record are NOT docked unless the company opts in.
      assert.equal(Number(it.attendance.unpaidDays), 0);
      assert.equal(Number(it.lines.find((l) => l.code === 'BASIC').amount), 60000);
      const owner = as('payrollco', (await login('payrollco', T.ownerEmail)).token);
      assert.equal((await owner.put('/attendance/policy').send({ deductAbsences: true })).status, 200);
      await maker.post(`/payroll/runs/${runId}/calculate`);
      const docked = (await maker.get(`/payroll/runs/${runId}`)).body.data.items[0];
      assert.ok(Number(docked.attendance.unpaidDays) > 0);
      assert.ok(Number(docked.lines.find((l) => l.code === 'BASIC').amount) < 60000);
      await owner.put('/attendance/policy').send({ deductAbsences: false });
      await maker.post(`/payroll/runs/${runId}/calculate`);
    });

    it('maker cannot approve own payroll; checker approves; approved payroll is immutable', async () => {
      assert.equal((await maker.post(`/payroll/runs/${runId}/submit`)).status, 200);
      assert.equal((await maker.post(`/payroll/runs/${runId}/approve`)).body.error.code, 'MAKER_CHECKER');
      assert.equal((await checker.post(`/payroll/runs/${runId}/approve`)).status, 200);
      assert.equal((await maker.post(`/payroll/runs/${runId}/calculate`)).body.error.code, 'INVALID_STATE');
      await assert.rejects(db.systemDb.query(`UPDATE payroll_items SET net = 0 WHERE run_id = '${runId}'`), /cannot be modified/);
      await assert.rejects(db.systemDb.query(`UPDATE payroll_runs SET status = 'DRAFT' WHERE id = '${runId}'`), /cannot be reopened/);
      assert.equal((await maker.post('/payroll/salaries').send({ employeeId: e1.id, effectiveFrom: '2026-07-20', basic: 70000 })).body.error.code, 'PERIOD_LOCKED');
    });

    it('payslips are visible to the employee only after publishing; PDF downloads', async () => {
      assert.equal((await empTok.get('/payroll/payslips/me')).body.data.length, 0);
      assert.equal((await maker.post(`/payroll/runs/${runId}/publish`)).status, 200);
      const slips = (await empTok.get('/payroll/payslips/me')).body.data;
      assert.equal(slips.length, 1);
      const pdf = await empTok.get(`/payroll/payslips/${slips[0].id}/pdf`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      assert.equal(pdf.status, 200);
      assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
      assert.equal((await empTok.get(`/payroll/runs/${runId}`)).status, 403); // employees cannot see the whole run
    });

    it('bank transfer file decrypts account numbers only for authorised exports; reports are audited', async () => {
      const bank = await maker.get(`/payroll/runs/${runId}/reports/bank-transfer`);
      assert.equal(bank.status, 200);
      assert.ok(bank.text.includes('00112233445566'));
      const tds = await maker.get(`/payroll/runs/${runId}/reports/tds`);
      assert.ok(tds.text.includes('111111111'));
      assert.equal((await empTok.get(`/payroll/runs/${runId}/reports/bank-transfer`)).status, 403);
      assert.ok(await db.sys.AuditLog.count({ where: { action: 'payroll.report_bank-transfer' } }));
    });

    it('mark paid; adjustments go to open periods only', async () => {
      assert.equal((await maker.post(`/payroll/runs/${runId}/mark-paid`).send({ paymentRef: 'NABIL-BATCH-001' })).status, 200);
      assert.equal((await maker.post('/payroll/adjustments').send({ employeeId: e1.id, period, kind: 'EARNING', description: 'Bonus', amount: 5000 })).body.error.code, 'PERIOD_LOCKED');
    });

    it('BASIC plan has no payroll module', async () => {
      const B = await makeTenant('nopayroll', 'BASIC');
      const t = as('nopayroll', (await login('nopayroll', B.ownerEmail)).token);
      assert.equal((await t.get('/payroll/runs')).body.error.code, 'FEATURE_NOT_IN_PLAN');
    });
  });
});
