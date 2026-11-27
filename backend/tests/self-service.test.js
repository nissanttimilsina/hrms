import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, makeUser, db, api, host } from './helpers/context.js';
import { localDate, addDays, toBS, fromBS, fiscalYear, fiscalYearRange } from '../src/services/hr/calendar.js';

const today = localDate(new Date(), 'Asia/Kathmandu');
const binary = (req) => req.buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

describe('Employee self-service: expenses, letters, tax statement, corrections, performance fixes', () => {
  let T; let owner; let boss; let staff; let other; let finance; let checker; let hr; const emp = {};
  let claim; let period; let fy;

  before(async () => {
    await resetDatabase();
    T = await makeTenant('selfco', 'PROFESSIONAL');
    owner = as('selfco', (await login('selfco', T.ownerEmail)).token);
    const hq = (await owner.get('/branches')).body.data[0];
    fy = fiscalYearRange(fiscalYear(today));
    const mk = async (k, extra = {}) => { emp[k] = (await owner.post('/employees').send({ firstName: k, lastName: 'Test', joinedOn: fy.start, branchId: hq.id, ...extra })).body.data; };
    await mk('boss', { gender: 'MALE' });
    await mk('staff', { managerId: emp.boss.id, gender: 'FEMALE', bank: { bankName: 'Nabil Bank', accountName: 'staff Test', accountNumber: '00112233445566' } });
    await mk('other');
    await makeUser(T.id, { email: 'boss@selfco.test', roles: ['team_leader', 'employee'], employeeId: emp.boss.id });
    await makeUser(T.id, { email: 'staff@selfco.test', roles: ['employee'], employeeId: emp.staff.id });
    await makeUser(T.id, { email: 'other@selfco.test', roles: ['employee'], employeeId: emp.other.id });
    await makeUser(T.id, { email: 'finance@selfco.test', roles: ['payroll_manager'] });
    await makeUser(T.id, { email: 'checker@selfco.test', roles: ['payroll_manager'] });
    await makeUser(T.id, { email: 'hr@selfco.test', roles: ['hr_manager'] });
    const tok = async (e) => as('selfco', (await login('selfco', e)).token);
    boss = await tok('boss@selfco.test'); staff = await tok('staff@selfco.test'); other = await tok('other@selfco.test');
    finance = await tok('finance@selfco.test'); checker = await tok('checker@selfco.test'); hr = await tok('hr@selfco.test');
    // Previous BS month: fully in the past, so payroll can run for it.
    const bs = toBS(today);
    const pm = bs.month === 0 ? 12 : bs.month; const py = bs.month === 0 ? bs.year - 1 : bs.year;
    period = `${py}-${String(pm).padStart(2, '0')}`;
  });
  after(teardown);

  // ------------------------------------------------------------------ performance fixes
  describe('performance score', () => {
    it('a late arrival still counts as late on a half day, and today is not counted before its report', async () => {
      const y = addDays(today, -1);
      await db.sys.AttendanceRecord.create({ tenantId: T.id, employeeId: emp.other.id, workDate: y, clockIn: new Date(`${y}T10:40:00+05:45`), clockOut: new Date(`${y}T12:00:00+05:45`), status: 'HALF_DAY', lateMinutes: 40, workedMinutes: 80, source: 'MANUAL' });
      await db.sys.AttendanceRecord.create({ tenantId: T.id, employeeId: emp.other.id, workDate: today, clockIn: new Date(), status: 'PRESENT', lateMinutes: 0, workedMinutes: 0, source: 'MANUAL' });
      const d = (await other.get(`/performance/employees/${emp.other.id}`)).body.data;
      assert.equal(d.attendance.present, 2);
      assert.equal(d.attendance.late, 1);
      assert.equal(d.attendance.punctuality, 50);
      assert.equal(d.reports.expected, 1, 'only yesterday is expected; today is still open');
      assert.equal(d.reports.rate, 0);
    });
  });

  // ------------------------------------------------------------------ expenses
  describe('expense claims', () => {
    it('employees read the policy; the claim is checked before it is accepted', async () => {
      const p = (await staff.get('/expenses/policy')).body.data;
      assert.ok(p.categories.some((c) => c.code === 'TRAVEL'));
      let r = await staff.post('/expenses').field('category', 'TRAVEL').field('title', 'Taxi to client').field('expenseDate', today).field('amount', '1500');
      assert.equal(r.status, 400);
      assert.equal(r.body.error.details[0].path, 'receipt');
      r = await staff.post('/expenses').field('category', 'TRAVEL').field('title', 'Taxi to client').field('expenseDate', addDays(today, 1)).field('amount', '100');
      assert.equal(r.status, 400);
      r = await staff.post('/expenses').field('category', 'NOPE').field('title', 'Taxi to client').field('expenseDate', today).field('amount', '100');
      assert.equal(r.status, 400);
      r = await staff.post('/expenses').field('category', 'TRAVEL').field('title', 'Taxi to client').field('expenseDate', today).field('amount', '100')
        .attach('receipt', Buffer.from('MZ not an image'), { filename: 'r.png', contentType: 'image/png' });
      assert.equal(r.status, 400);
    });

    it('a claim with a receipt goes to the manager first, and duplicates are refused', async () => {
      const r = await staff.post('/expenses').field('category', 'TRAVEL').field('title', 'Taxi to client meeting').field('expenseDate', today).field('amount', '1500').field('merchant', 'Pathao')
        .attach('receipt', png, { filename: 'receipt.png', contentType: 'image/png' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      claim = r.body.data;
      assert.equal(claim.key, 'EXP-1');
      assert.equal(claim.status, 'SUBMITTED');
      assert.equal(claim.needsManager, true);
      const dup = await staff.post('/expenses').field('category', 'TRAVEL').field('title', 'Again').field('expenseDate', today).field('amount', '1500').attach('receipt', png, { filename: 'r.png', contentType: 'image/png' });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'DUPLICATE_CLAIM');
      assert.ok((await boss.get('/notifications')).body.data.items.some((n) => n.title === 'Expense claim to review'));
    });

    it('only the employee and people in scope can see it; the receipt downloads privately', async () => {
      assert.equal((await other.get(`/expenses/${claim.id}`)).status, 404);
      assert.equal((await other.get('/expenses?view=mine')).body.data.length, 0);
      const rc = await binary(boss.get(`/expenses/${claim.id}/receipt`));
      assert.equal(rc.status, 200);
      assert.equal(rc.headers['content-type'], 'image/png');
      assert.equal((await staff.post(`/expenses/${claim.id}/approve`).send({})).status, 403);
    });

    it('the manager approves (cannot change the amount); finance approves less with a reason', async () => {
      const q = (await boss.get('/expenses?view=queue')).body.data;
      assert.equal(q.length, 1);
      assert.equal(q[0].abilities.approve, true);
      assert.equal(q[0].abilities.changeAmount, false);
      assert.equal((await boss.post(`/expenses/${claim.id}/approve`).send({ amount: 1000 })).status, 400);
      let r = await boss.post(`/expenses/${claim.id}/approve`).send({ note: 'Client visit confirmed' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, 'MANAGER_APPROVED');
      assert.equal((await boss.get('/expenses?view=queue')).body.data.length, 0);
      const fq = (await finance.get('/expenses?view=queue')).body.data;
      assert.equal(fq.length, 1);
      assert.equal((await finance.post(`/expenses/${claim.id}/approve`).send({ amount: 2000 })).status, 400);
      assert.equal((await finance.post(`/expenses/${claim.id}/approve`).send({ amount: 1200 })).status, 400);
      r = await finance.post(`/expenses/${claim.id}/approve`).send({ amount: 1200, note: 'Pathao fare is NPR 1,200 for this route' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, 'APPROVED');
      assert.equal(r.body.data.approvedAmount, 1200);
      const sum = (await staff.get('/expenses/summary')).body.data;
      assert.equal(sum.mine.toReceive, 1200);
      const detail = (await staff.get(`/expenses/${claim.id}`)).body.data;
      assert.deepEqual(detail.timeline.map((x) => x.label), ['Submitted', 'Approved by manager', 'Approved for NPR 1,200']);
    });

    it('finance adds it to a payroll month as a non-taxable reimbursement, and can take it back', async () => {
      let r = await finance.post(`/expenses/${claim.id}/pay`).send({ method: 'PAYROLL', period });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, 'SCHEDULED');
      let adj = await db.sys.PayrollAdjustment.findOne({ where: { tenantId: T.id, employeeId: emp.staff.id, period } });
      assert.equal(Number(adj.amount), 1200);
      assert.equal(adj.code, 'REIMBURSEMENT');
      assert.equal(adj.taxable, false);
      r = await finance.post(`/expenses/${claim.id}/unschedule`);
      assert.equal(r.body.data.status, 'APPROVED');
      assert.equal(await db.sys.PayrollAdjustment.count({ where: { tenantId: T.id, employeeId: emp.staff.id } }), 0);
      r = await finance.post(`/expenses/${claim.id}/pay`).send({ method: 'PAYROLL', period });
      assert.equal(r.body.data.status, 'SCHEDULED');
      adj = await db.sys.PayrollAdjustment.findOne({ where: { tenantId: T.id, employeeId: emp.staff.id, period } });
      assert.ok(adj);
    });

    it('a small claim needs no receipt, can be cancelled by the employee, and is paid directly', async () => {
      let r = await staff.post('/expenses').field('category', 'MEALS').field('title', 'Lunch with visiting auditor').field('expenseDate', today).field('amount', '450');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const small = r.body.data;
      assert.equal((await staff.post(`/expenses/${small.id}/cancel`)).body.data.status, 'CANCELLED');
      assert.equal((await staff.post(`/expenses/${small.id}/cancel`)).status, 409);
      r = await staff.post('/expenses').field('category', 'OFFICE').field('title', 'Printer paper').field('expenseDate', today).field('amount', '300');
      const paper = r.body.data;
      assert.equal((await finance.post(`/expenses/${paper.id}/approve`).send({})).body.data.status, 'APPROVED');
      assert.equal((await finance.post(`/expenses/${paper.id}/pay`).send({ method: 'DIRECT', reference: 'PV-0042' })).body.data.status, 'PAID');
      r = await boss.post(`/expenses/${paper.id}/reject`).send({ reason: 'Too late' });
      assert.equal(r.status, 409);
    });

    it('the owner exports claims as CSV; the Basic plan has no expenses', async () => {
      const csv = await owner.get(`/expenses/export?from=${addDays(today, -7)}&to=${today}`);
      assert.equal(csv.status, 200);
      assert.match(csv.headers['content-type'], /text\/csv/);
      assert.match(csv.text, /EXP-1/);
      const B = await makeTenant('basicself', 'BASIC');
      const b = as('basicself', (await login('basicself', B.ownerEmail)).token);
      assert.equal((await b.get('/expenses')).body.error.code, 'FEATURE_NOT_IN_PLAN');
    });
  });

  // ------------------------------------------------------------------ letters
  describe('letter requests', () => {
    let req;
    it('employees request letters; a bank letter needs the bank; one pending request per type', async () => {
      assert.equal((await staff.get('/letters/types')).body.data.length, 5);
      assert.equal((await staff.post('/letters').send({ type: 'BANK', purpose: 'Home loan' })).status, 422);
      const r = await staff.post('/letters').send({ type: 'SALARY', purpose: 'a visa application to Japan' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      req = r.body.data;
      assert.equal((await staff.post('/letters').send({ type: 'SALARY', purpose: 'again' })).status, 409);
      assert.equal((await other.get('/letters?view=mine')).body.data.length, 0);
      assert.equal((await staff.post(`/letters/${req.id}/issue`).send({})).status, 403);
    });

    it('HR cannot issue a salary letter without a salary, then issues it with a reference', async () => {
      let r = await hr.post(`/letters/${req.id}/issue`).send({});
      assert.equal(r.status, 400);
      assert.equal((await owner.post('/payroll/salaries').send({ employeeId: emp.staff.id, effectiveFrom: fy.start, basic: 50000, components: [{ code: 'DEARNESS', amount: 5000 }], ssfEnrolled: true })).status, 201);
      r = await hr.post(`/letters/${req.id}/issue`).send({ signatoryName: 'Sita Sharma', signatoryTitle: 'HR Manager' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.data.reference, /^LTR\/\d{4}\/0001$/);
      const mine = (await staff.get('/letters?view=mine')).body.data[0];
      assert.equal(mine.abilities.download, true);
      const pdf = await binary(staff.get(`/letters/${req.id}/pdf`));
      assert.equal(pdf.status, 200);
      assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
      const row = await db.sys.LetterRequest.findByPk(req.id);
      assert.equal(row.content.salary.gross, 55000);
    });

    it('anyone can verify the letter on the company address, without seeing pay; a withdrawn letter shows as withdrawn', async () => {
      const row = await db.sys.LetterRequest.findByPk(req.id);
      let v = await api().get(`/api/v1/verify/letters/${row.verifyCode}`).set('Host', host('selfco'));
      assert.equal(v.status, 200, JSON.stringify(v.body));
      assert.equal(v.body.data.status, 'VALID');
      assert.equal(v.body.data.employee, 'staff Test');
      assert.ok(!/55[,.]?000/.test(JSON.stringify(v.body)) && !('salary' in v.body.data), 'no salary figures');
      assert.equal((await api().get('/api/v1/verify/letters/AAAA-BBBB-CCCC').set('Host', host('selfco'))).status, 404);
      assert.equal((await api().get(`/api/v1/verify/letters/${row.verifyCode}`).set('Host', host('basicself'))).status, 404);
      assert.equal((await hr.post(`/letters/${req.id}/revoke`).send({ reason: 'Issued with the old salary' })).status, 200);
      v = await api().get(`/api/v1/verify/letters/${row.verifyCode}`).set('Host', host('selfco'));
      assert.equal(v.body.data.status, 'REVOKED');
      assert.equal((await staff.get(`/letters/${req.id}/pdf`)).status, 409);
    });

    it('employees can cancel a pending request; HR saves the letterhead', async () => {
      const r = await staff.post('/letters').send({ type: 'BANK', purpose: 'opening a salary account', addressedTo: 'The Branch Manager\nNabil Bank Ltd.\nNew Road, Kathmandu' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await staff.post(`/letters/${r.body.data.id}/cancel`)).body.data.status, 'CANCELLED');
      const head = { legalName: 'Selfco Pvt. Ltd.', address: 'Baneshwor, Kathmandu', phone: '01-4000000', email: 'hr@selfco.test', website: 'selfco.test', pan: '600000000', signatoryName: 'Sita Sharma', signatoryTitle: 'HR Manager', referencePrefix: 'HR' };
      assert.equal((await hr.put('/letters/settings').send(head)).status, 200);
      assert.equal((await hr.get('/letters/settings')).body.data.legalName, 'Selfco Pvt. Ltd.');
      assert.equal((await staff.put('/letters/settings').send(head)).status, 403);
    });
  });

  // ------------------------------------------------------------------ tax statement + payroll integration
  describe('tax statement', () => {
    it('payroll pays the scheduled expense claim; the employee sees tax paid and the projection', async () => {
      const run = (await finance.post('/payroll/runs').send({ period })).body.data;
      const calc = await finance.post(`/payroll/runs/${run.id}/calculate`);
      assert.equal(calc.status, 200, JSON.stringify(calc.body));
      const item = (await finance.get(`/payroll/runs/${run.id}`)).body.data.items.find((i) => i.employeeId === emp.staff.id);
      assert.ok(item.lines.some((l) => l.code === 'REIMBURSEMENT' && l.amount === 1200 && l.taxable === false));
      // Payroll for this month can no longer take new claims once submitted.
      assert.equal((await finance.post(`/payroll/runs/${run.id}/submit`)).status, 200);
      assert.equal((await checker.post(`/payroll/runs/${run.id}/approve`)).status, 200);
      assert.equal((await staff.get(`/expenses/${claim.id}`)).body.data.status, 'PAID');
      // Not published yet: the employee sees nothing; HR sees it.
      const periodFy = fiscalYear(fromBS(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1));
      assert.equal((await staff.get(`/payroll/tax-statement?fy=${encodeURIComponent(periodFy)}`)).body.data.months.length, 0);
      assert.equal((await finance.get(`/payroll/tax-statement?fy=${encodeURIComponent(periodFy)}&employeeId=${emp.staff.id}`)).body.data.months.length, 1);
      assert.equal((await finance.post(`/payroll/runs/${run.id}/publish`)).status, 200);
      const s = (await staff.get(`/payroll/tax-statement?fy=${encodeURIComponent(periodFy)}`)).body.data;
      assert.equal(s.months.length, 1);
      assert.equal(s.totals.tds, Number(item.tax));
      assert.equal(s.totals.reimbursements, 1200);
      assert.ok(s.projection.annualTax >= s.totals.tds);
      const pdf = await binary(staff.get(`/payroll/tax-statement/pdf?fy=${encodeURIComponent(periodFy)}`));
      assert.equal(pdf.status, 200);
      assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
      assert.equal((await other.get(`/payroll/tax-statement?employeeId=${emp.staff.id}`)).status, 404);
    });
  });

  // ------------------------------------------------------------------ missed punch
  describe('attendance corrections', () => {
    it('with no manager, HR is told; the employee can cancel a pending request', async () => {
      const d = addDays(today, -2);
      const r = await other.post('/attendance/corrections').send({ workDate: d, clockIn: `${d}T04:15:00.000Z`, reason: 'Forgot to clock in after the bank visit' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.ok((await owner.get('/notifications')).body.data.items.some((n) => n.title === 'Attendance correction to review'));
      assert.equal((await staff.post(`/attendance/corrections/${r.body.data.id}/cancel`)).status, 404);
      assert.equal((await other.post(`/attendance/corrections/${r.body.data.id}/cancel`)).body.data.status, 'CANCELLED');
      assert.equal((await other.post(`/attendance/corrections/${r.body.data.id}/cancel`)).status, 409);
    });
  });
});
