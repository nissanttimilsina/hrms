import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, teardown, api, host, db, makeTenant } from './helpers/context.js';
import { company } from './helpers/people.js';
import { addDays } from '../src/services/hr/calendar.js';

const binary = (req) => req.buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]);
const pub = (slug) => ({
  get: (p) => api().get(`/api/v1/careers${p}`).set('Host', host(slug)),
  apply: (p) => api().post(`/api/v1/careers${p}`).set('Host', host(slug)),
});

describe('Recruitment and HR helpdesk', () => {
  let C; let job; let cand; let interview;
  before(async () => { await resetDatabase(); C = await company('hireco'); });
  after(teardown);

  describe('recruitment', () => {
    it('HR creates and opens a job; it appears on the public careers page', async () => {
      let r = await C.hr.post('/recruitment/jobs').send({ title: 'Sales Officer', departmentId: C.sales.id, branchId: C.hq.id, location: 'Kathmandu', positions: 1, description: 'Visit retailers in the valley, take orders and grow sales in your area.', salaryMin: 30000, salaryMax: 40000, showSalary: true, hiringManagerId: C.emp.boss.id });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      job = r.body.data;
      assert.equal(job.slug, 'sales-officer');
      assert.equal((await pub('hireco').get('/')).body.data.jobs.length, 0, 'drafts are not public');
      assert.equal((await C.hr.post(`/recruitment/jobs/${job.id}/status`).send({ status: 'OPEN' })).status, 200);
      const list = (await pub('hireco').get('/')).body.data;
      assert.equal(list.jobs.length, 1);
      assert.deepEqual(list.jobs[0].salary, { min: 30000, max: 40000 });
      assert.equal((await pub('hireco').get('/sales-officer')).body.data.job.title, 'Sales Officer');
      assert.equal((await C.staff.post('/recruitment/jobs').send({ title: 'x', description: 'y'.repeat(30) })).status, 403);
    });

    it('people apply with a PDF CV; duplicates and other file types are refused', async () => {
      const form = (req, email) => req.field('firstName', 'Asha').field('lastName', 'Gurung').field('email', email).field('phone', '9800000000').field('experienceYears', '3').field('expectedSalary', '').field('consent', 'true');
      let r = await form(pub('hireco').apply('/sales-officer/apply'), 'asha@example.com').attach('cv', pdf, { filename: 'asha-cv.pdf', contentType: 'application/pdf' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      r = await form(pub('hireco').apply('/sales-officer/apply'), 'ASHA@example.com').attach('cv', pdf, { filename: 'cv.pdf', contentType: 'application/pdf' });
      assert.equal(r.status, 409);
      r = await form(pub('hireco').apply('/sales-officer/apply'), 'b@example.com').attach('cv', Buffer.from('\x89PNG....'), { filename: 'cv.png', contentType: 'image/png' });
      assert.equal(r.status, 400);
      r = await form(pub('hireco').apply('/sales-officer/apply'), 'c@example.com');
      assert.equal(r.body.error.details[0].path, 'cv');
      const cands = (await C.hr.get(`/recruitment/candidates?jobId=${job.id}`)).body.data;
      assert.equal(cands.length, 1);
      cand = cands[0];
      assert.equal(cand.source, 'CAREERS');
      assert.equal(cand.expectedSalary, null);
      assert.ok((await C.boss.get('/notifications')).body.data.items.some((n) => n.title === 'New applicant for Sales Officer'), 'the hiring manager hears about it');
      const cv = await binary(C.hr.get(`/recruitment/candidates/${cand.id}/cv`));
      assert.equal(cv.body.subarray(0, 4).toString(), '%PDF');
    });

    it('schedules an interview; the interviewer (no recruitment rights) sees it and scores it', async () => {
      const bossUser = await db.sys.User.findOne({ where: { email: 'boss@hireco.test' } });
      let r = await C.hr.post(`/recruitment/candidates/${cand.id}/interviews`).send({ round: 'First interview', scheduledAt: new Date(Date.now() + 86_400_000).toISOString(), mode: 'IN_PERSON', location: 'Head office', interviewerIds: [bossUser.id] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      interview = r.body.data;
      assert.equal((await C.hr.get(`/recruitment/candidates/${cand.id}`)).body.data.stage, 'INTERVIEW');
      assert.equal((await C.boss.get('/recruitment/candidates')).status, 403);
      const mine = (await C.boss.get('/recruitment/interviews')).body.data;
      assert.equal(mine.length, 1);
      assert.equal((await C.staff.get(`/recruitment/interviews/${interview.id}`)).status, 404);
      r = await C.boss.put(`/recruitment/interviews/${interview.id}/feedback`).send({ rating: 4, recommendation: 'YES', scores: { communication: 4, skills: 3 }, notes: 'Knows the market' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await C.staff.put(`/recruitment/interviews/${interview.id}/feedback`).send({ rating: 1, recommendation: 'NO' })).status, 404);
      const d = (await C.hr.get(`/recruitment/candidates/${cand.id}`)).body.data;
      assert.equal(d.interviews[0].feedback[0].rating, 4);
    });

    it('makes an offer with a printable letter, then hires into a new employee and onboarding', async () => {
      let r = await C.hr.post(`/recruitment/candidates/${cand.id}/offer`).send({ salary: 38000, joiningDate: addDays(C.today, 14), expiresOn: addDays(C.today, 5), probationMonths: 3 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.stage, 'OFFER');
      const letter = await binary(C.hr.get(`/recruitment/candidates/${cand.id}/offer.pdf`));
      assert.equal(letter.status, 200);
      assert.equal(letter.body.subarray(0, 4).toString(), '%PDF');
      r = await C.hr.post(`/recruitment/candidates/${cand.id}/hire`).send({ joinedOn: addDays(C.today, 14), branchId: C.hq.id });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.jobFilled, true);
      assert.ok(r.body.data.journeyId);
      const e = await db.sys.Employee.findByPk(r.body.data.employeeId);
      assert.equal(e.firstName, 'Asha');
      assert.equal(e.departmentId, C.sales.id);
      assert.equal(e.managerId, C.emp.boss.id);
      assert.equal((await pub('hireco').get('/')).body.data.jobs.length, 0, 'a filled job leaves the careers page');
    });

    it('rejection needs a reason; companies without recruitment have no careers page', async () => {
      const j2 = (await C.hr.post('/recruitment/jobs').send({ title: 'Accountant', description: 'Keep the books, prepare VAT returns and monthly reports.' })).body.data;
      const c2 = (await C.hr.post('/recruitment/candidates').field('jobId', j2.id).field('firstName', 'Ram').field('lastName', 'K').field('email', 'ram@example.com').field('source', 'REFERRAL')).body.data;
      assert.equal((await C.hr.post(`/recruitment/candidates/${c2.id}/stage`).send({ stage: 'REJECTED' })).status, 400);
      assert.equal((await C.hr.post(`/recruitment/candidates/${c2.id}/stage`).send({ stage: 'REJECTED', reason: 'No accounting degree' })).body.data.stage, 'REJECTED');
      await makeTenant('basichire', 'BASIC');
      assert.equal((await pub('basichire').get('/')).status, 404);
    });
  });

  describe('helpdesk', () => {
    let tk; let secret;
    it('an employee raises a ticket; HR sees it unassigned', async () => {
      const cfg = (await C.staff.get('/helpdesk/config')).body.data;
      assert.ok(cfg.categories.some((c) => c.code === 'PAYROLL'));
      const r = await C.staff.post('/helpdesk/tickets').field('category', 'PAYROLL').field('subject', 'Overtime missing in Kartik payslip').field('body', 'I worked 6 hours overtime on 12 Kartik but it is not on my payslip.');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      tk = r.body.data;
      assert.equal(tk.key, 'HR-1');
      assert.ok(tk.dueAt);
      assert.equal((await C.officer.get('/helpdesk/tickets?view=unassigned')).body.data.length, 1);
      assert.equal((await C.other.get(`/helpdesk/tickets/${tk.id}`)).status, 404);
      assert.equal((await C.other.get('/helpdesk/tickets?view=open')).body.data.length, 0);
    });

    it('HR replies (taking the ticket) and adds an internal note the employee never sees', async () => {
      assert.equal((await C.officer.post(`/helpdesk/tickets/${tk.id}/messages`).field('body', 'Checking with payroll now.')).status, 201);
      assert.equal((await C.officer.post(`/helpdesk/tickets/${tk.id}/messages`).field('body', 'Attendance shows 6h OT approved.').field('internal', 'true')).status, 201);
      assert.equal((await C.staff.post(`/helpdesk/tickets/${tk.id}/messages`).field('body', 'note').field('internal', 'true')).status, 403);
      const mine = (await C.staff.get(`/helpdesk/tickets/${tk.id}`)).body.data;
      assert.equal(mine.status, 'IN_PROGRESS');
      assert.equal(mine.messages.length, 2);
      assert.ok(mine.messages.every((m) => !m.internal));
      const theirs = (await C.officer.get(`/helpdesk/tickets/${tk.id}`)).body.data;
      assert.equal(theirs.messages.length, 3);
      assert.ok(theirs.firstResponseAt);
      assert.ok(theirs.assignee);
    });

    it('HR resolves; the employee closes it with a rating', async () => {
      assert.equal((await C.officer.patch(`/helpdesk/tickets/${tk.id}`).send({ status: 'RESOLVED' })).body.data.status, 'RESOLVED');
      assert.equal((await C.staff.post(`/helpdesk/tickets/${tk.id}/close`).send({ satisfaction: 5, note: 'Quick, thanks' })).status, 200);
      assert.equal((await C.staff.post(`/helpdesk/tickets/${tk.id}/messages`).field('body', 'one more')).status, 409);
      const s = (await C.hr.get('/helpdesk/summary')).body.data;
      assert.equal(s.satisfaction, 5);
    });

    it('confidential grievances are hidden from ordinary agents', async () => {
      const r = await C.staff.post('/helpdesk/tickets').send({ category: 'GRIEVANCE', subject: 'Behaviour of a colleague', body: 'I want to report something that happened in the store last week.' });
      secret = r.body.data;
      assert.equal(secret.confidential, true);
      assert.equal((await C.officer.get(`/helpdesk/tickets/${secret.id}`)).status, 404);
      assert.equal((await C.officer.get('/helpdesk/tickets?view=all')).body.data.some((x) => x.id === secret.id), false);
      assert.equal((await C.hr.get(`/helpdesk/tickets/${secret.id}`)).status, 200);
      const officerUser = await db.sys.User.findOne({ where: { email: 'officer@hireco.test' } });
      assert.equal((await C.hr.patch(`/helpdesk/tickets/${secret.id}`).send({ assigneeId: officerUser.id })).status, 400);
    });
  });
});
