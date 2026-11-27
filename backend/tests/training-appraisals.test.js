import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, teardown } from './helpers/context.js';
import { company } from './helpers/people.js';
import { addDays } from '../src/services/hr/calendar.js';

const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 32)]);

describe('Training and appraisals', () => {
  let C;
  before(async () => { await resetDatabase(); C = await company('growco'); });
  after(teardown);

  describe('training', () => {
    let course; let session; let req1;
    it('HR builds the catalogue and schedules a session', async () => {
      let r = await C.hr.post('/training/courses').send({ title: 'Fire safety and first aid', category: 'Safety', delivery: 'IN_PERSON', durationHours: 4, certificateValidMonths: 12, mandatory: true, costPerPerson: 1500 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      course = r.body.data;
      assert.equal((await C.staff.post('/training/courses').send({ title: 'My course' })).status, 403);
      r = await C.hr.post(`/training/courses/${course.id}/sessions`).send({ startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 3 * 86_400_000 + 4 * 3600_000).toISOString(), location: 'Training room', trainer: 'Nepal Red Cross', capacity: 1 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      session = r.body.data;
      const list = (await C.staff.get('/training/courses')).body.data;
      assert.equal(list[0].nextSessions.length, 1);
    });

    it('an employee asks for a place; their manager approves it', async () => {
      let r = await C.staff.post('/training/enrollments').send({ courseId: course.id, sessionId: session.id, note: 'Needed for the store' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await C.staff.post('/training/enrollments').send({ courseId: course.id })).status, 409);
      const q = (await C.boss.get('/training/enrollments?view=requests')).body.data;
      assert.equal(q.length, 1);
      req1 = q[0];
      assert.equal(req1.abilities.decide, true);
      assert.equal((await C.other.post(`/training/enrollments/${req1.id}/decide`).send({ approve: true })).status, 404);
      r = await C.boss.post(`/training/enrollments/${req1.id}/decide`).send({ approve: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, 'ENROLLED');
    });

    it('a full session refuses more people; HR enrols the rest without a session', async () => {
      let r = await C.hr.post('/training/enrollments').send({ courseId: course.id, sessionId: session.id, employeeIds: [C.emp.other.id] });
      assert.equal(r.body.error.code, 'SESSION_FULL');
      r = await C.hr.post('/training/enrollments').send({ courseId: course.id, employeeIds: [C.emp.other.id, C.emp.staff.id] });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.data.enrolled, 1);
      assert.deepEqual(r.body.data.skipped, ['Staff Test']);
      assert.equal((await C.boss.post('/training/enrollments').send({ courseId: course.id, employeeIds: [C.emp.hr.id] })).status, 400, 'a team leader enrols only their team');
    });

    it('completion sets the certificate expiry; the employee rates the training', async () => {
      const r = await C.hr.post(`/training/enrollments/${req1.id}/complete`).field('outcome', 'COMPLETED').field('completedOn', C.today).field('score', '88')
        .attach('certificate', pdf, { filename: 'certificate.pdf', contentType: 'application/pdf' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, 'COMPLETED');
      assert.equal(r.body.data.certificateExpiresOn.slice(0, 4), String(Number(C.today.slice(0, 4)) + 1));
      assert.equal((await C.staff.post(`/training/enrollments/${req1.id}/feedback`).send({ rating: 5, comment: 'Practical' })).status, 200);
      assert.equal((await C.staff.post(`/training/enrollments/${req1.id}/feedback`).send({ rating: 4 })).status, 403);
      const s = (await C.staff.get('/training/summary')).body.data.mine;
      assert.equal(s.hoursThisYear, 4);
    });

    it('the compliance view shows who still needs mandatory training', async () => {
      const c = (await C.hr.get('/training/compliance')).body.data;
      const row = (id) => c.rows.find((x) => x.employee.id === id).courses[course.id].state;
      assert.equal(row(C.emp.staff.id), 'DONE');
      assert.equal(row(C.emp.other.id), 'ENROLLED');
      assert.equal(row(C.emp.boss.id), 'MISSING');
      assert.equal((await C.staff.get('/training/compliance')).status, 403);
    });
  });

  describe('goals and appraisals', () => {
    let cycle; let appr; let goal;
    it('managers set weighted goals; employees update progress but not the agreed target', async () => {
      let r = await C.boss.post('/appraisals/goals').send({ employeeId: C.emp.staff.id, title: 'Grow monthly sales in Lalitpur', measure: 'Monthly sales (NPR)', target: '15 lakh', weight: 60, dueDate: C.fy.end });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      goal = r.body.data;
      assert.equal((await C.boss.post('/appraisals/goals').send({ employeeId: C.emp.staff.id, title: 'Too heavy', weight: 50 })).status, 400);
      assert.equal((await C.staff.post('/appraisals/goals').send({ title: 'Learn the new POS system', weight: 40 })).status, 201);
      assert.equal((await C.staff.patch(`/appraisals/goals/${goal.id}`).send({ target: '5 lakh' })).status, 403);
      assert.equal((await C.staff.patch(`/appraisals/goals/${goal.id}`).send({ progress: 70, actual: '11 lakh' })).body.data.progress, 70);
      assert.equal((await C.other.post('/appraisals/goals').send({ employeeId: C.emp.staff.id, title: 'Not my report' })).status, 403);
    });

    it('HR launches a cycle; the employee writes and submits the self review', async () => {
      let r = await C.hr.post('/appraisals/cycles').send({ name: `Annual review ${C.fy.start.slice(0, 4)}`, periodStart: C.fy.start, periodEnd: C.fy.end, selfReviewDue: addDays(C.today, 10), goalWeight: 60 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      cycle = r.body.data;
      assert.equal(cycle.competencies.length, 7);
      r = await C.hr.post(`/appraisals/cycles/${cycle.id}/launch`).send({ employeeIds: [C.emp.staff.id, C.emp.other.id] });
      assert.equal(r.body.data.added, 2);
      appr = (await C.staff.get('/appraisals?view=mine')).body.data[0];
      assert.equal(appr.status, 'SELF_REVIEW');
      assert.equal(appr.reviewer.id, C.emp.boss.id);
      const d = (await C.staff.get(`/appraisals/${appr.id}`)).body.data;
      assert.equal(d.goals.length, 2, 'goals of the period join the review');
      const ratings = (n) => Object.fromEntries(d.competencies.map((c) => [c.key, { rating: n }]));
      assert.equal((await C.staff.put(`/appraisals/${appr.id}/self`).send({ goals: {}, competencies: ratings(4), submit: true })).status, 400);
      r = await C.staff.put(`/appraisals/${appr.id}/self`).send({ goals: Object.fromEntries(d.goals.map((g) => [g.id, { rating: 4 }])), competencies: ratings(4), summary: 'Good year', submit: true });
      assert.equal(r.body.data.status, 'MANAGER_REVIEW');
    });

    it('the manager asks a colleague for 360° feedback and writes the review', async () => {
      let r = await C.boss.post(`/appraisals/${appr.id}/feedback-requests`).send({ employeeIds: [C.emp.hr.id] });
      assert.equal(r.body.data.requested, 1);
      const fb = (await C.hr.get('/appraisals/feedback/mine')).body.data[0];
      assert.equal(fb.open, true);
      assert.equal((await C.hr.put(`/appraisals/feedback/${fb.id}`).send({ rating: 4, strengths: 'Reliable with customers' })).status, 200);
      const d = (await C.boss.get(`/appraisals/${appr.id}`)).body.data;
      assert.equal(d.selfReview.summary, 'Good year');
      assert.equal(d.peerFeedback[0].strengths, 'Reliable with customers');
      const goals = Object.fromEntries(d.goals.map((g) => [g.id, { rating: g.id === goal.id ? 5 : 3 }]));
      r = await C.boss.put(`/appraisals/${appr.id}/manager`).send({ goals, competencies: Object.fromEntries(d.competencies.map((c) => [c.key, { rating: 3 }])), strengths: 'Sales', recommendation: 'INCREMENT', submit: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      // goals: (5*60 + 3*40)/100 = 4.2; competencies 3; overall 4.2*0.6 + 3*0.4 = 3.72
      assert.equal(r.body.data.calculatedRating, 3.72);
      const own = (await C.staff.get(`/appraisals/${appr.id}`)).body.data;
      assert.equal(own.managerReview, null, 'the employee sees the manager review only after sign-off');
    });

    it('HR calibrates with a note and signs off; the employee acknowledges', async () => {
      assert.equal((await C.hr.post(`/appraisals/${appr.id}/finalize`).send({ finalRating: 4 })).status, 400);
      const r = await C.hr.post(`/appraisals/${appr.id}/finalize`).send({ finalRating: 4, calibrationNote: 'Top seller in the region' });
      assert.equal(r.body.data.finalRating, 4);
      const own = (await C.staff.get(`/appraisals/${appr.id}`)).body.data;
      assert.equal(own.managerReview.strengths, 'Sales');
      assert.equal(own.peerFeedback.length, 0, 'peer feedback stays with the reviewer and HR');
      assert.equal((await C.staff.post(`/appraisals/${appr.id}/acknowledge`).send({ comment: 'Thank you' })).status, 200);
      const csv = await C.hr.get(`/appraisals/cycles/${cycle.id}/export`);
      assert.match(csv.text, /Staff Test/);
    });
  });
});
