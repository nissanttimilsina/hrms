// Demo data for the CI browser check of employee self-service (.github/workflows/ui-check.yml).
// Not a test file (the test runner only picks up tests/*.test.js). Run after migrate + seed:
//   NODE_ENV=test ROOT_DOMAIN=hrms.test node tests/ui/fixtures.js /tmp/ui-fixtures.json
// It provisions the "demo" workspace, people with logins, expense claims at every stage,
// HR letters (one issued), published payroll for this fiscal year and two weeks of attendance.
import { writeFileSync } from 'node:fs';
import request from 'supertest';
import * as db from '../../src/database/index.js';
import { createApp } from '../../src/app.js';
import { provisionTenant } from '../../src/services/provisioning.service.js';
import { hashPassword } from '../../src/services/password.service.js';
import { closeRedis } from '../../src/services/redis.js';
import { closeQueues } from '../../src/jobs/queues.js';
import { localDate, addDays, weekday, toBS, fiscalYear, fiscalYearRange } from '../../src/services/hr/calendar.js';

const PASSWORD = 'Str0ngPassw0rd!';
const SLUG = 'demo';
const HOST = `${SLUG}.${process.env.ROOT_DOMAIN}`;
const app = createApp();
const today = localDate(new Date(), 'Asia/Kathmandu');
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

const must = (res, what) => {
  if (res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data;
};
async function as(email) {
  const r = await request(app).post('/api/v1/auth/login').set('Host', HOST).send({ email, password: PASSWORD });
  const token = must(r, `login ${email}`).accessToken;
  const wrap = (m) => (path) => request(app)[m](`/api/v1${path}`).set('Host', HOST).set('Authorization', `Bearer ${token}`);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch') };
}
async function makeUser(tenantId, email, fullName, roles, employeeId = null) {
  const user = await db.sys.User.create({ tenantId, email, fullName, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', employeeId });
  const rows = await db.sys.Role.findAll({ where: { tenantId, key: roles } });
  await db.sys.UserRole.bulkCreate(rows.map((r) => ({ tenantId, userId: user.id, roleId: r.id })));
}

try {
  const t = await provisionTenant({
    slug: SLUG, name: 'Himal Traders Pvt. Ltd.', planCode: 'PROFESSIONAL', trial: true,
    owner: { email: 'owner@demo.test', fullName: 'Anil Gurung', password: PASSWORD },
  });
  const T = t.tenant.id;
  const owner = await as('owner@demo.test');
  const hq = must(await owner.get('/branches'), 'branches')[0];
  const fyLabel = fiscalYear(today);
  const fy = fiscalYearRange(fyLabel);

  const emp = {};
  const mk = async (k, body) => { emp[k] = must(await owner.post('/employees').send({ joinedOn: fy.start, branchId: hq.id, ...body }), `employee ${k}`); };
  await mk('ram', { firstName: 'Ram', lastName: 'Shrestha', gender: 'MALE' });
  await mk('sita', { firstName: 'Sita', lastName: 'Karki', gender: 'FEMALE', managerId: emp.ram.id, joinedOn: '2023-04-17' });
  await mk('hari', { firstName: 'Hari', lastName: 'Thapa', gender: 'MALE', managerId: emp.ram.id });
  await makeUser(T, 'ram@demo.test', 'Ram Shrestha', ['team_leader', 'employee'], emp.ram.id);
  await makeUser(T, 'sita@demo.test', 'Sita Karki', ['employee'], emp.sita.id);
  await makeUser(T, 'hari@demo.test', 'Hari Thapa', ['employee'], emp.hari.id);
  await makeUser(T, 'hr@demo.test', 'Gita Adhikari', ['hr_manager']);
  await makeUser(T, 'finance@demo.test', 'Bikash Rai', ['payroll_manager']);
  await makeUser(T, 'checker@demo.test', 'Puja Lama', ['payroll_manager']);
  const [ram, sita, hari, hr, finance, checker] = await Promise.all(['ram', 'sita', 'hari', 'hr', 'finance', 'checker'].map((u) => as(`${u}@demo.test`)));

  // Salaries from the start of the fiscal year.
  must(await owner.post('/payroll/salaries').send({ employeeId: emp.sita.id, effectiveFrom: fy.start, basic: 62000, components: [{ code: 'DEARNESS', amount: 6000 }], ssfEnrolled: true }), 'salary sita');
  must(await owner.post('/payroll/salaries').send({ employeeId: emp.ram.id, effectiveFrom: fy.start, basic: 85000, components: [{ code: 'DEARNESS', amount: 8000 }], ssfEnrolled: true }), 'salary ram');

  // Expense claims at each stage.
  const claim = async (who, f, receipt = true) => {
    let r = who.post('/expenses');
    for (const [k, v] of Object.entries(f)) r = r.field(k, String(v));
    if (receipt) r = r.attach('receipt', png, { filename: 'receipt.png', contentType: 'image/png' });
    return must(await r, `claim ${f.title}`);
  };
  const taxi = await claim(sita, { category: 'TRAVEL', title: 'Taxi to client meeting in Lalitpur', expenseDate: addDays(today, -6), amount: 1500, merchant: 'Pathao' });
  must(await ram.post(`/expenses/${taxi.id}/approve`).send({ note: 'Client visit confirmed' }), 'mgr approve taxi');
  must(await finance.post(`/expenses/${taxi.id}/approve`).send({ amount: 1200, note: 'Pathao fare is NPR 1,200 for this route' }), 'fin approve taxi');
  const hotel = await claim(sita, { category: 'TRAVEL', title: 'Hotel in Pokhara for the two-day distributor training and product launch', expenseDate: addDays(today, -3), amount: 9800, merchant: 'Hotel Barahi', description: 'Two nights, shared room with Hari.' });
  await claim(sita, { category: 'MEALS', title: 'Team lunch after stock count', expenseDate: addDays(today, -1), amount: 450 }, false);
  const paper = await claim(hari, { category: 'OFFICE', title: 'Printer paper and toner', expenseDate: addDays(today, -9), amount: 3200, merchant: 'Bhatbhateni' });
  must(await ram.post(`/expenses/${paper.id}/approve`).send({}), 'mgr approve paper');
  must(await finance.post(`/expenses/${paper.id}/approve`).send({}), 'fin approve paper');
  must(await finance.post(`/expenses/${paper.id}/pay`).send({ method: 'DIRECT', reference: 'PV-0042' }), 'pay paper');
  const fuel = await claim(hari, { category: 'TRAVEL', title: 'Fuel for site visit', expenseDate: addDays(today, -4), amount: 2600 });
  must(await ram.post(`/expenses/${fuel.id}/reject`).send({ reason: 'Use the company vehicle log for fuel.' }), 'reject fuel');

  // Letters.
  must(await hr.put('/letters/settings').send({ legalName: 'Himal Traders Pvt. Ltd.', address: 'Baneshwor-10, Kathmandu, Nepal', phone: '01-4781234', email: 'hr@himaltraders.com.np', website: 'himaltraders.com.np', pan: '609876543', signatoryName: 'Gita Adhikari', signatoryTitle: 'HR Manager', referencePrefix: 'HT' }), 'letterhead');
  const sal = must(await sita.post('/letters').send({ type: 'SALARY', purpose: 'a visa application to Japan' }), 'salary letter');
  must(await hr.post(`/letters/${sal.id}/issue`).send({}), 'issue salary letter');
  must(await sita.post('/letters').send({ type: 'BANK', purpose: 'opening a salary account', addressedTo: 'The Branch Manager\nNabil Bank Ltd.\nNew Road, Kathmandu' }), 'bank letter');
  must(await ram.post('/letters').send({ type: 'EMPLOYMENT', purpose: 'renting an apartment in Lalitpur' }), 'employment letter');
  const issued = await db.sys.LetterRequest.findByPk(sal.id);

  // Payroll for every finished month of this fiscal year, published.
  const startBS = toBS(fy.start); const nowBS = toBS(today);
  const periods = [];
  for (let y = startBS.year, m = startBS.month; y < nowBS.year || (y === nowBS.year && m < nowBS.month);) {
    periods.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  const lastPeriod = periods.at(-1);
  if (lastPeriod) must(await finance.post(`/expenses/${taxi.id}/pay`).send({ method: 'PAYROLL', period: lastPeriod }), 'schedule taxi');
  for (const period of periods) {
    const run = must(await finance.post('/payroll/runs').send({ period }), `run ${period}`);
    must(await finance.post(`/payroll/runs/${run.id}/calculate`), `calc ${period}`);
    must(await finance.post(`/payroll/runs/${run.id}/submit`), `submit ${period}`);
    must(await checker.post(`/payroll/runs/${run.id}/approve`), `approve ${period}`);
    must(await finance.post(`/payroll/runs/${run.id}/publish`), `publish ${period}`);
  }

  // Two weeks of attendance for Sita: mostly on time, one late day, one late half day.
  for (let i = 14; i >= 1; i -= 1) {
    const d = addDays(today, -i);
    if (weekday(d) === 'SAT') continue;
    const late = i === 5 ? 25 : i === 2 ? 70 : 0;
    const inAt = new Date(`${d}T${late === 25 ? '10:25' : late === 70 ? '11:10' : '09:55'}:00+05:45`);
    const outAt = new Date(`${d}T${i === 2 ? '14:00' : '18:05'}:00+05:45`);
    const worked = Math.round((outAt - inAt) / 60000);
    await db.sys.AttendanceRecord.create({ tenantId: T, employeeId: emp.sita.id, workDate: d, clockIn: inAt, clockOut: i === 8 ? null : outAt, status: i === 2 ? 'HALF_DAY' : late ? 'LATE' : 'PRESENT', lateMinutes: late, workedMinutes: i === 8 ? 0 : worked, source: 'WEB' });
  }
  const d8 = addDays(today, -8);
  must(await sita.post('/attendance/corrections').send({ workDate: d8, clockOut: `${d8}T12:20:00.000Z`, reason: 'Forgot to clock out after the evening stock count' }), 'correction');
  const d3 = addDays(today, -3);
  const c2 = must(await hari.post('/attendance/corrections').send({ workDate: d3, clockIn: `${d3}T04:15:00.000Z`, reason: 'Phone battery was flat' }), 'correction hari');
  must(await hari.post(`/attendance/corrections/${c2.id}/cancel`), 'cancel correction');

  const out = { host: HOST, password: PASSWORD, verifyCode: issued.verifyCode, taxiId: taxi.id, hotelId: hotel.id, periods, fiscalYear: fyLabel };
  writeFileSync(process.argv[2] ?? '/tmp/ui-fixtures.json', JSON.stringify(out, null, 2));
  console.log('fixtures ready', out);
} finally {
  await closeQueues();
  await closeRedis();
  await db.closeDatabase();
}
