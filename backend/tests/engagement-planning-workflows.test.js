import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, teardown, db } from './helpers/context.js';
import { company } from './helpers/people.js';
import { addDays } from '../src/services/hr/calendar.js';

describe('Engagement, workforce planning and request workflows', () => {
  let C;
  before(async () => { await resetDatabase(); C = await company('peopleco'); });
  after(teardown);

  describe('surveys', () => {
    let survey;
    it('HR builds a survey from a template and sends it to everyone', async () => {
      const tpl = (await C.hr.get('/engagement/survey-templates')).body.data.find((x) => x.key === 'pulse');
      let r = await C.hr.post('/engagement/surveys').send({ title: tpl.title, description: tpl.description, questions: tpl.questions, closesOn: addDays(C.today, 7) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      survey = r.body.data;
      assert.equal(survey.anonymous, true);
      assert.equal((await C.staff.get(`/engagement/surveys/${survey.id}`)).status, 404, 'drafts are not visible');
      r = await C.hr.post(`/engagement/surveys/${survey.id}/open`).send({});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.invited, 5);
      assert.equal((await C.staff.post('/engagement/surveys').send({ title: 'x', questions: [] })).status, 403);
    });

    it('people answer once; anonymous answers carry no name', async () => {
      const d = (await C.staff.get(`/engagement/surveys/${survey.id}`)).body.data;
      assert.equal(d.canAnswer, true);
      const [enps, q1, q2, q3, txt] = d.questions;
      const answer = (score, rating) => ({ answers: { [enps.id]: score, [q1.id]: rating, [q2.id]: rating, [q3.id]: rating, [txt.id]: 'More training' } });
      assert.equal((await C.staff.post(`/engagement/surveys/${survey.id}/respond`).send({ answers: { [enps.id]: 9 } })).status, 400);
      assert.equal((await C.staff.post(`/engagement/surveys/${survey.id}/respond`).send(answer(10, 5))).status, 201);
      assert.equal((await C.staff.post(`/engagement/surveys/${survey.id}/respond`).send(answer(10, 5))).status, 409);
      let res = (await C.hr.get(`/engagement/surveys/${survey.id}/results`)).body.data;
      assert.equal(res.hidden, true, 'fewer than three answers stay hidden');
      await C.boss.post(`/engagement/surveys/${survey.id}/respond`).send(answer(9, 4));
      await C.other.post(`/engagement/surveys/${survey.id}/respond`).send(answer(3, 2));
      res = (await C.hr.get(`/engagement/surveys/${survey.id}/results`)).body.data;
      assert.equal(res.hidden, false);
      assert.equal(res.responses, 3);
      assert.equal(res.responseRate, 60);
      const e = res.questions.find((q) => q.type === 'ENPS');
      assert.equal(e.enps, 33); // 2 promoters, 1 detractor of 3
      assert.equal(res.questions.find((q) => q.type === 'TEXT').comments.length, 3);
      const rows = await db.sys.SurveyResponse.findAll({ where: { surveyId: survey.id } });
      assert.ok(rows.every((x) => x.employeeId === null));
      assert.equal((await C.staff.get(`/engagement/surveys/${survey.id}/results`)).status, 403);
    });
  });

  describe('recognition', () => {
    it('colleagues recognise each other; not themselves', async () => {
      let r = await C.staff.post('/engagement/kudos').send({ toEmployeeId: C.emp.other.id, value: 'HELPFUL', message: 'Covered my shift at short notice' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await C.staff.post('/engagement/kudos').send({ toEmployeeId: C.emp.staff.id, value: 'HELPFUL', message: 'I am great' })).status, 400);
      const feed = (await C.boss.get('/engagement/kudos')).body.data;
      assert.equal(feed.items.length, 1);
      assert.equal(feed.topThisMonth[0].employee.id, C.emp.other.id);
      assert.equal((await C.hr.post(`/engagement/kudos/${r.body.data.id}/hide`).send({ hidden: true })).status, 200);
      assert.equal((await C.boss.get('/engagement/kudos')).body.data.items.length, 0);
    });
  });

  describe('workforce planning', () => {
    let plan; let designation;
    it('compares a headcount plan with the people employed and the jobs being recruited', async () => {
      designation = (await C.owner.post('/designations').send({ name: 'Sales Executive' })).body.data;
      await C.owner.post('/payroll/salaries').send({ employeeId: C.emp.staff.id, effectiveFrom: C.fy.start, basic: 40000, components: [] });
      let r = await C.hr.post('/workforce/plans').send({ name: 'Plan for the year', fiscalYear: '2083/84' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      plan = r.body.data;
      r = await C.hr.put(`/workforce/plans/${plan.id}/lines`).send({ lines: [{ departmentId: C.sales.id, planned: 8, monthlyCost: 45000 }, { departmentId: C.sales.id, designationId: designation.id, planned: 3 }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      await C.hr.post('/recruitment/jobs').send({ title: 'Sales Executive', departmentId: C.sales.id, designationId: designation.id, positions: 2, description: 'Sell our products to shops across the valley.' })
        .then((x) => C.hr.post(`/recruitment/jobs/${x.body.data.id}/status`).send({ status: 'OPEN' }));
      const d = (await C.hr.get(`/workforce/plans/${plan.id}`)).body.data;
      const broad = d.rows.find((x) => !x.designationId);
      const exec = d.rows.find((x) => x.designationId);
      assert.equal(broad.actual, 5, 'everyone in Sales without that designation');
      assert.equal(broad.gap, 3);
      assert.equal(broad.budget, 360000);
      assert.equal(broad.actualCost, 40000);
      assert.equal(exec.recruiting, 2);
      assert.equal(exec.toRecruit, 1);
      const deptView = (await C.dept.get(`/workforce/plans/${plan.id}`)).body.data;
      assert.equal(deptView.showsPay, false);
      assert.equal(deptView.rows[0].actualCost, null);
    });

    it('approved plans are locked', async () => {
      assert.equal((await C.hr.post(`/workforce/plans/${plan.id}/status`).send({ status: 'APPROVED' })).body.data.status, 'APPROVED');
      assert.equal((await C.hr.put(`/workforce/plans/${plan.id}/lines`).send({ lines: [] })).status, 409);
      const o = (await C.hr.get('/workforce/overview')).body.data;
      assert.equal(o.months.length, 12);
      assert.equal(o.headcount, 5);
    });
  });

  describe('request workflows', () => {
    let def; let reqId;
    it('an admin designs a two-step request form', async () => {
      const tpl = (await C.hr.get('/workflows/templates')).body.data.find((x) => x.name === 'Travel request');
      const r = await C.hr.post('/workflows/definitions').send(tpl);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      def = r.body.data;
      assert.equal((await C.staff.post('/workflows/definitions').send(tpl)).status, 403);
      const list = (await C.staff.get('/workflows/definitions')).body.data;
      assert.equal(list[0].steps[1].label, 'Anyone with the HR Manager role');
    });

    it('the employee submits; the manager then HR approve in turn', async () => {
      const data = { destination: 'Pokhara', from: addDays(C.today, 5), to: addDays(C.today, 7), mode: 'Bus', purpose: 'Distributor meeting' };
      assert.equal((await C.staff.post('/workflows/requests').send({ definitionId: def.id, data: { ...data, purpose: '' } })).status, 400);
      assert.equal((await C.staff.post('/workflows/requests').send({ definitionId: def.id, data: { ...data, to: addDays(C.today, 1) } })).status, 400);
      let r = await C.staff.post('/workflows/requests').send({ definitionId: def.id, data });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      reqId = r.body.data.id;
      assert.equal((await C.hr.post(`/workflows/requests/${reqId}/decide`).send({ approve: true })).status, 403, 'HR waits for the manager');
      assert.equal((await C.boss.get('/workflows/requests?view=approvals')).body.data.length, 1);
      r = await C.boss.post(`/workflows/requests/${reqId}/decide`).send({ approve: true, note: 'OK' });
      assert.equal(r.body.data.currentStep, 1);
      assert.equal((await C.hr.post(`/workflows/requests/${reqId}/decide`).send({ approve: false })).status, 400);
      r = await C.hr.post(`/workflows/requests/${reqId}/decide`).send({ approve: true });
      assert.equal(r.body.data.status, 'APPROVED');
      const d = (await C.staff.get(`/workflows/requests/${reqId}`)).body.data;
      assert.deepEqual(d.steps.map((s) => s.status), ['APPROVED', 'APPROVED']);
      assert.equal((await C.other.get(`/workflows/requests/${reqId}`)).status, 404);
    });

    it('with no manager, the first step goes to the form administrators', async () => {
      const r = await C.dept.post('/workflows/requests').send({ definitionId: def.id, data: { destination: 'Biratnagar', from: C.today, to: C.today, mode: 'Air', purpose: 'Audit' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const d = (await C.hr.get(`/workflows/requests/${r.body.data.id}`)).body.data;
      assert.match(d.steps[0].note, /administrators/);
      assert.equal(d.abilities.decide, true);
      assert.equal((await C.dept.post(`/workflows/requests/${r.body.data.id}/cancel`)).body.data.status, 'CANCELLED');
    });
  });
});
