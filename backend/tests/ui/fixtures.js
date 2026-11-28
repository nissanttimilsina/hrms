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
    slug: SLUG, name: 'Himal Traders Pvt. Ltd.', planCode: 'BUSINESS', trial: true,
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

  // ------------------------------------------------------------------ roadmap modules
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 32)]);
  const at = (days, hm) => new Date(`${addDays(today, days)}T${hm}:00+05:45`).toISOString();
  const sales = must(await owner.post('/departments').send({ code: 'SALES', name: 'Sales', branchId: hq.id }), 'dept');
  const accounts = must(await owner.post('/departments').send({ code: 'ACC', name: 'Accounts', branchId: hq.id }), 'dept2');
  const officer = must(await owner.post('/designations').send({ name: 'Sales Officer' }), 'designation');
  for (const [k, d] of [['ram', sales], ['sita', sales], ['hari', accounts]]) must(await owner.patch(`/employees/${emp[k].id}`).send({ departmentId: d.id }), `dept ${k}`);

  // Assets
  const laptop = must(await hr.post('/assets').send({ name: 'Dell Latitude 5440', category: 'Laptop', assetTag: 'HT-LT-014', serialNo: '7XK2Q93', brandModel: 'Dell Latitude 5440, i5, 16 GB', purchaseDate: addDays(today, -400), purchaseCost: 142500, vendor: 'Neoteric Nepal', warrantyUntil: addDays(today, 40) }), 'asset');
  must(await hr.post(`/assets/${laptop.id}/assign`).send({ employeeId: emp.sita.id, note: 'With charger and laptop bag' }), 'assign laptop');
  const phone = must(await hr.post('/assets').send({ name: 'Samsung Galaxy A15', category: 'Mobile phone', assetTag: 'HT-MB-031', purchaseCost: 24999 }), 'phone');
  must(await hr.post(`/assets/${phone.id}/assign`).send({ employeeId: emp.ram.id }), 'assign phone');
  const card = must(await hr.post('/assets').send({ name: 'Staff ID card', category: 'ID card', assetTag: 'HT-ID-003' }), 'card');
  must(await hr.post(`/assets/${card.id}/assign`).send({ employeeId: emp.hari.id }), 'assign card');
  must(await hr.post('/assets').send({ name: 'Epson projector EB-X51', category: 'Other', assetTag: 'HT-PJ-001', purchaseCost: 68000 }), 'projector');
  const printer = must(await hr.post('/assets').send({ name: 'Canon LBP2900 printer', category: 'Other', assetTag: 'HT-PR-002' }), 'printer');
  must(await hr.post(`/assets/${printer.id}/status`).send({ status: 'IN_REPAIR', note: 'Paper jam sensor broken' }), 'repair');
  must(await sita.post(`/assets/${laptop.id}/report`).send({ note: 'The battery lasts less than an hour now' }), 'report');

  // Onboarding and exit
  emp.bishal = must(await owner.post('/employees').send({ firstName: 'Bishal', lastName: 'Magar', joinedOn: addDays(today, 5), branchId: hq.id, departmentId: sales.id, managerId: emp.ram.id }), 'bishal');
  const onb = must(await hr.post('/onboarding/journeys').send({ kind: 'ONBOARDING', employeeId: emp.bishal.id }), 'onboarding');
  const onbD = must(await hr.get(`/onboarding/journeys/${onb.id}`), 'onb detail');
  for (const task of onbD.tasks.slice(0, 2)) must(await hr.post(`/onboarding/journeys/${onb.id}/tasks/${task.id}`).send({ done: true }), 'tick');
  const off = must(await hr.post('/onboarding/journeys').send({ kind: 'OFFBOARDING', employeeId: emp.hari.id, exitType: 'RESIGNATION', noticeDate: addDays(today, -10), lastWorkingDay: addDays(today, 20), exitReason: 'Moving to Pokhara for family reasons' }), 'offboarding');
  must(await hari.put(`/onboarding/journeys/${off.id}/exit-interview`).send({ mainReason: 'FAMILY', ratings: { role: 4, manager: 5, growth: 3, pay: 3, culture: 4 }, recommend: true, liked: 'Supportive team and clear processes', improve: 'Regular salary reviews' }), 'exit interview');

  // Recruitment
  const job = must(await hr.post('/recruitment/jobs').send({ title: 'Sales Officer', departmentId: sales.id, branchId: hq.id, designationId: officer.id, location: 'Kathmandu valley', positions: 2, description: 'Visit retailers across Kathmandu, Lalitpur and Bhaktapur, take orders on the mobile app and grow sales in your route. You report to the area sales manager and work with the distribution team.', requirements: '+2 or bachelor\'s degree. Two-wheeler licence. At least one year in FMCG sales is preferred.', salaryMin: 28000, salaryMax: 38000, showSalary: true, closesOn: addDays(today, 20), hiringManagerId: emp.ram.id }), 'job');
  must(await hr.post(`/recruitment/jobs/${job.id}/status`).send({ status: 'OPEN' }), 'open job');
  must(await hr.post('/recruitment/jobs').send({ title: 'Accounts Assistant', departmentId: accounts.id, description: 'Record daily sales and purchases, prepare VAT returns and help with month-end closing.' }), 'job2');
  const applicants = [['Asha', 'Gurung', 'Sales Executive at Chaudhary Group', '3'], ['Prakash', 'Shah', 'Field sales, CG Foods', '2'], ['Nisha', 'Tamang', 'Recent BBS graduate', '0'], ['Rohan', 'Basnet', 'Retail supervisor', '4']];
  for (const [fn, ln, title, yrs] of applicants) {
    const r = await request(app).post(`/api/v1/careers/${job.slug}/apply`).set('Host', HOST).field('firstName', fn).field('lastName', ln).field('email', `${fn.toLowerCase()}@example.com`).field('phone', '9801234567').field('currentTitle', title).field('experienceYears', yrs).field('consent', 'true').attach('cv', pdf, { filename: `${fn}-cv.pdf`, contentType: 'application/pdf' });
    if (r.status !== 201) throw new Error(`apply ${fn}: ${JSON.stringify(r.body)}`);
  }
  const cands = must(await hr.get(`/recruitment/candidates?jobId=${job.id}`), 'cands');
  const byName = (n) => cands.find((c) => c.firstName === n);
  const ramUser = await db.sys.User.findOne({ where: { email: 'ram@demo.test' } });
  must(await hr.post(`/recruitment/candidates/${byName('Prakash').id}/stage`).send({ stage: 'SCREENING' }), 'screen');
  const iv = must(await hr.post(`/recruitment/candidates/${byName('Asha').id}/interviews`).send({ round: 'First interview', scheduledAt: at(1, '11:00'), mode: 'IN_PERSON', location: 'Head office, Baneshwor', interviewerIds: [ramUser.id], notifyCandidate: false }), 'interview');
  const iv2 = must(await hr.post(`/recruitment/candidates/${byName('Rohan').id}/interviews`).send({ round: 'First interview', scheduledAt: at(-2, '14:00'), mode: 'VIDEO', location: 'https://meet.example.com/abc', interviewerIds: [ramUser.id], notifyCandidate: false }), 'interview2');
  must(await ram.put(`/recruitment/interviews/${iv2.id}/feedback`).send({ rating: 4, recommendation: 'YES', scores: { skills: 4, experience: 4, communication: 3, attitude: 5, culture: 4 }, notes: 'Knows the retailers in Lalitpur well. Needs to learn our app.' }), 'feedback');
  must(await hr.post(`/recruitment/candidates/${byName('Rohan').id}/offer`).send({ salary: 35000, joiningDate: addDays(today, 15), expiresOn: addDays(today, 6), probationMonths: 3, terms: 'Fuel allowance of NPR 3,000 a month.' }), 'offer');
  must(await hr.post(`/recruitment/candidates/${byName('Nisha').id}/stage`).send({ stage: 'REJECTED', reason: 'No field sales experience yet', notifyCandidate: false }), 'reject');

  // Helpdesk
  const tk = must(await sita.post('/helpdesk/tickets').field('category', 'PAYROLL').field('subject', 'Overtime missing from my Kartik payslip').field('body', 'I worked 6 hours of overtime on 12 Kartik during the stock count, but it is not on my payslip. Can you check?'), 'ticket');
  must(await hr.post(`/helpdesk/tickets/${tk.id}/messages`).field('body', 'Thanks Sita. I am checking the attendance record with payroll and will reply by tomorrow.'), 'reply');
  must(await hr.post(`/helpdesk/tickets/${tk.id}/messages`).field('body', 'OT approved by Ram on 13 Kartik. Add to Mangsir run.').field('internal', 'true'), 'note');
  must(await sita.post('/helpdesk/tickets').send({ category: 'DOCUMENTS', subject: 'Need a copy of my appointment letter', body: 'For a bank loan application, please share a signed copy.' }), 'ticket2');
  must(await hari.post('/helpdesk/tickets').send({ category: 'TAX', subject: 'How is my SSF contribution calculated?', body: 'My SSF deduction changed this month. What is the rule?', priority: 'LOW' }), 'ticket3');

  // Training
  const fire = must(await hr.post('/training/courses').send({ title: 'Fire safety and first aid', category: 'Safety', delivery: 'IN_PERSON', provider: 'Nepal Red Cross Society', durationHours: 4, costPerPerson: 1500, certificateValidMonths: 12, mandatory: true }), 'course');
  const sess = must(await hr.post(`/training/courses/${fire.id}/sessions`).send({ startsAt: at(6, '10:00'), endsAt: at(6, '14:00'), location: 'Training hall, head office', trainer: 'Nepal Red Cross', capacity: 20 }), 'session');
  must(await hr.post('/training/courses').send({ title: 'Advanced Excel for reports', category: 'Software', delivery: 'ONLINE', durationHours: 8, costPerPerson: 3500, description: 'Pivot tables, lookups and charts for monthly sales and stock reports.' }), 'course2');
  must(await hr.post('/training/courses').send({ title: 'Retail selling skills', category: 'Sales', delivery: 'IN_PERSON', durationHours: 6, description: 'Opening a call, handling objections and closing orders with shopkeepers.' }), 'course3');
  must(await sita.post('/training/enrollments').send({ courseId: fire.id, sessionId: sess.id, note: 'I run the store opening shift' }), 'request training');
  must(await hr.post('/training/enrollments').send({ courseId: fire.id, employeeIds: [emp.hari.id] }), 'enrol hari');
  const hariE = must(await hr.get(`/training/enrollments?view=team&courseId=${fire.id}`), 'list').find((e) => e.employee.id === emp.hari.id);
  must(await hr.post(`/training/enrollments/${hariE.id}/complete`).field('outcome', 'COMPLETED').field('completedOn', addDays(today, -30)).field('score', '86').attach('certificate', pdf, { filename: 'certificate.pdf', contentType: 'application/pdf' }), 'complete');

  // Goals and appraisals
  must(await ram.post('/appraisals/goals').send({ employeeId: emp.sita.id, title: 'Grow monthly sales in Lalitpur', measure: 'Monthly sales (NPR)', target: '15 lakh', weight: 50, dueDate: fy.end }), 'goal1');
  must(await ram.post('/appraisals/goals').send({ employeeId: emp.sita.id, title: 'Add 25 new retailers to the route', measure: 'New active retailers', target: '25', weight: 30, dueDate: fy.end }), 'goal2');
  const g3 = must(await sita.post('/appraisals/goals').send({ title: 'Learn the new order app fully', weight: 20, dueDate: addDays(today, 60) }), 'goal3');
  must(await sita.patch(`/appraisals/goals/${g3.id}`).send({ progress: 60, actual: 'Using it for all orders' }), 'progress');
  const cyc = must(await hr.post('/appraisals/cycles').send({ name: `Annual review ${fyLabel}`, periodStart: fy.start, periodEnd: fy.end, selfReviewDue: addDays(today, 10), managerReviewDue: addDays(today, 20), goalWeight: 60 }), 'cycle');
  must(await hr.post(`/appraisals/cycles/${cyc.id}/launch`).send({ employeeIds: [emp.sita.id, emp.hari.id] }), 'launch');
  const sitaAppr = must(await sita.get('/appraisals?view=mine'), 'appr')[0];
  const ad = must(await sita.get(`/appraisals/${sitaAppr.id}`), 'appr detail');
  must(await sita.put(`/appraisals/${sitaAppr.id}/self`).send({ goals: Object.fromEntries(ad.goals.map((g, i) => [g.id, { rating: [4, 3, 4][i] ?? 3, comment: i === 0 ? 'Reached 13.8 lakh in Kartik' : undefined }])), competencies: Object.fromEntries(ad.competencies.map((c) => [c.key, { rating: 4 }])), summary: 'A good year. I opened 19 new retailers and want to lead a route next year.', submit: true }), 'self');
  must(await ram.post(`/appraisals/${sitaAppr.id}/feedback-requests`).send({ employeeIds: [emp.hari.id] }), 'peer ask');

  // Engagement
  const tpl = must(await hr.get('/engagement/survey-templates'), 'tpl').find((x) => x.key === 'pulse');
  const survey = must(await hr.post('/engagement/surveys').send({ title: tpl.title, description: tpl.description, questions: tpl.questions, closesOn: addDays(today, 7), minGroup: 2 }), 'survey');
  must(await hr.post(`/engagement/surveys/${survey.id}/open`).send({}), 'open survey');
  const sv = must(await ram.get(`/engagement/surveys/${survey.id}`), 'sv');
  const ans = (e, r, t) => Object.fromEntries(sv.questions.map((q) => [q.id, q.type === 'ENPS' ? e : q.type === 'TEXT' ? t : r]));
  must(await ram.post(`/engagement/surveys/${survey.id}/respond`).send({ answers: ans(9, 4, 'More product training before launches') }), 'answer1');
  must(await hari.post(`/engagement/surveys/${survey.id}/respond`).send({ answers: ans(6, 3, 'Faster salary reviews') }), 'answer2');
  must(await sita.post('/engagement/kudos').send({ toEmployeeId: emp.ram.id, value: 'LEADERSHIP', message: 'Stayed with the team until midnight to finish the year-end stock count.' }), 'kudos1');
  must(await ram.post('/engagement/kudos').send({ toEmployeeId: emp.sita.id, value: 'CUSTOMER_FIRST', message: 'Drove to Godawari on a holiday to deliver an urgent order for a key retailer.' }), 'kudos2');
  must(await hari.post('/engagement/kudos').send({ toEmployeeId: emp.sita.id, value: 'HELPFUL', message: 'Taught me the new order app in one afternoon.' }), 'kudos3');

  // Workforce planning
  const plan = must(await hr.post('/workforce/plans').send({ name: `Headcount plan ${fyLabel}`, fiscalYear: fyLabel, notes: 'Two new sales routes in Bhaktapur from Poush.' }), 'plan');
  must(await hr.put(`/workforce/plans/${plan.id}/lines`).send({ lines: [
    { departmentId: sales.id, planned: 4, monthlyCost: 55000 }, { departmentId: sales.id, designationId: officer.id, planned: 3, monthlyCost: 35000, neededBy: addDays(today, 45) },
    { departmentId: accounts.id, planned: 2, monthlyCost: 45000 },
  ] }), 'lines');

  // Request workflows
  const tpls = must(await hr.get('/workflows/templates'), 'wtpl');
  const travel = must(await hr.post('/workflows/definitions').send(tpls.find((x) => x.name === 'Travel request')), 'travel');
  must(await hr.post('/workflows/definitions').send(tpls.find((x) => x.name === 'Work from home')), 'wfh');
  const wreq = must(await sita.post('/workflows/requests').send({ definitionId: travel.id, data: { destination: 'Pokhara', from: addDays(today, 5), to: addDays(today, 7), mode: 'Bus', advance: 8000, purpose: 'Distributor meeting and product training for the western region' } }), 'request');

  const out = {
    host: HOST, password: PASSWORD, verifyCode: issued.verifyCode, taxiId: taxi.id, hotelId: hotel.id, periods, fiscalYear: fyLabel,
    assetId: laptop.id, onboardingId: onb.id, offboardingId: off.id, jobId: job.id, jobSlug: job.slug, candidateId: byName('Rohan').id,
    interviewId: iv.id, ticketId: tk.id, courseId: fire.id, appraisalId: sitaAppr.id, cycleId: cyc.id, surveyId: survey.id, planId: plan.id, requestId: wreq.id,
  };
  writeFileSync(process.argv[2] ?? '/tmp/ui-fixtures.json', JSON.stringify(out, null, 2));
  console.log('fixtures ready', out);
} finally {
  await closeQueues();
  await closeRedis();
  await db.closeDatabase();
}
