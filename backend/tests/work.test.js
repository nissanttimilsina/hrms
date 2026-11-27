import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, makeUser } from './helpers/context.js';
import { localDate, addDays } from '../src/services/hr/calendar.js';

const today = localDate(new Date(), 'Asia/Kathmandu');

describe('Tasks, daily reports, reviews and performance', () => {
  let owner; let lead; let dev; let other; const emp = {};
  let taskA; let report;

  before(async () => {
    await resetDatabase();
    const T = await makeTenant('workco', 'BASIC');
    owner = as('workco', (await login('workco', T.ownerEmail)).token);
    const hq = (await owner.get('/branches')).body.data[0];
    const mk = async (k, extra = {}) => { emp[k] = (await owner.post('/employees').send({ firstName: k, lastName: 'Test', joinedOn: '2024-01-01', branchId: hq.id, ...extra })).body.data; };
    await mk('lead'); await mk('dev', { managerId: emp.lead.id }); await mk('other');
    await makeUser(T.id, { email: 'lead@workco.test', roles: ['team_leader', 'employee'], employeeId: emp.lead.id });
    await makeUser(T.id, { email: 'dev@workco.test', roles: ['employee'], employeeId: emp.dev.id });
    await makeUser(T.id, { email: 'other@workco.test', roles: ['employee'], employeeId: emp.other.id });
    lead = as('workco', (await login('workco', 'lead@workco.test')).token);
    dev = as('workco', (await login('workco', 'dev@workco.test')).token);
    other = as('workco', (await login('workco', 'other@workco.test')).token);
  });
  after(teardown);

  it('is available on the Basic plan', async () => {
    assert.equal((await dev.get('/tasks/summary')).status, 200);
  });

  it('a team leader assigns tasks to their report, and only to them', async () => {
    const assignable = (await lead.get('/tasks/assignees')).body.data.map((e) => e.id).sort();
    assert.deepEqual(assignable, [emp.lead.id, emp.dev.id].sort());
    let r = await lead.post('/tasks').send({ title: 'Prepare Mangsir sales report', assigneeId: emp.dev.id, dueOn: addDays(today, 2), priority: 'HIGH', estimateHours: 6 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    taskA = r.body.data;
    assert.equal(taskA.key, 'T-1');
    r = await lead.post('/tasks').send({ title: 'Not my team', assigneeId: emp.other.id });
    assert.equal(r.status, 403);
    r = await lead.post('/tasks').send({ title: 'Late one', assigneeId: emp.dev.id, dueOn: addDays(today, -1) });
    assert.equal(r.body.data.key, 'T-2');
  });

  it('the employee sees and updates their own tasks, but not task details or other people\'s tasks', async () => {
    const mine = (await dev.get('/tasks?view=mine&status=open')).body.data;
    assert.equal(mine.length, 2);
    assert.equal(mine.find((k) => k.key === 'T-2').overdue, true);
    assert.equal((await other.get(`/tasks/${taskA.id}`)).status, 404);
    assert.equal((await other.get('/tasks')).body.data.length, 0);
    let r = await dev.patch(`/tasks/${taskA.id}`).send({ dueOn: addDays(today, 10) });
    assert.equal(r.status, 403);
    r = await dev.patch(`/tasks/${taskA.id}`).send({ progress: 40, note: 'Collected branch figures' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'IN_PROGRESS');
    r = await dev.patch(`/tasks/${taskA.id}`).send({ status: 'BLOCKED' });
    assert.equal(r.status, 400);
    r = await dev.post(`/tasks/${taskA.id}/comments`).send({ body: 'Waiting for Pokhara numbers' });
    assert.equal(r.status, 201);
    const detail = (await lead.get(`/tasks/${taskA.id}`)).body.data;
    assert.deepEqual(detail.activity.map((a) => a.kind), ['CREATED', 'STATUS', 'COMMENT']);
    assert.equal(detail.activity[1].to.progress, 40);
    assert.equal(detail.abilities.canManage, true);
    const notes = (await lead.get('/notifications')).body.data.items.map((n) => n.title);
    assert.ok(notes.some((t) => t.includes('commented on T-1')));
  });

  it('employees can create personal tasks for themselves only', async () => {
    let r = await dev.post('/tasks').send({ title: 'Learn the new POS system' });
    assert.equal(r.status, 201);
    assert.equal(r.body.data.assignee.id, emp.dev.id);
    r = await dev.post('/tasks').send({ title: 'For someone else', assigneeId: emp.other.id });
    assert.equal(r.status, 403);
  });

  it('a submitted daily report moves task progress and notifies the manager', async () => {
    const ctx = (await dev.get('/work-reports/mine')).body.data;
    assert.equal(ctx.report, null);
    assert.ok(ctx.tasks.length >= 2);
    let r = await dev.put(`/work-reports/mine/${today}`).send({
      summary: 'Finished the sales report draft', challenges: 'Pokhara branch sent figures late', planNext: 'Review with the team lead',
      items: [{ taskId: taskA.id, description: 'Compiled all branch numbers', hours: 5, completed: true }, { description: 'Team meeting', hours: 1 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.status, 'DRAFT');
    assert.equal(r.body.data.hours, 6);
    r = await dev.put(`/work-reports/mine/${today}`).send({ summary: 'Finished the sales report draft', items: [{ taskId: taskA.id, description: 'Compiled all branch numbers', hours: 5, completed: true }, { description: 'Team meeting', hours: 1 }], submit: true });
    assert.equal(r.body.data.status, 'SUBMITTED');
    report = r.body.data;
    const k = (await dev.get(`/tasks/${taskA.id}`)).body.data;
    assert.equal(k.status, 'DONE');
    assert.equal(k.progress, 100);
    assert.equal(k.loggedHours, 5);
    assert.ok(k.activity.some((a) => a.kind === 'REPORT'));
    const notes = (await lead.get('/notifications')).body.data.items.map((n) => n.title);
    assert.ok(notes.some((t) => t.startsWith('Daily report from dev Test')));
    r = await dev.put(`/work-reports/mine/${today}`).send({ summary: 'edit', submit: false });
    assert.equal(r.status, 409);
    r = await dev.put(`/work-reports/mine/${addDays(today, 1)}`).send({ summary: 'future' });
    assert.equal(r.status, 400);
  });

  it('the manager reviews: request changes, resubmit, then approve with a rating', async () => {
    assert.equal((await other.get(`/work-reports/${report.id}`)).status, 404);
    assert.equal((await dev.post(`/work-reports/${report.id}/review`).send({ decision: 'APPROVE', rating: 5 })).status, 403);
    const list = (await lead.get('/work-reports?status=SUBMITTED')).body.data;
    assert.equal(list.length, 1);
    let r = await lead.post(`/work-reports/${report.id}/review`).send({ decision: 'REQUEST_CHANGES' });
    assert.equal(r.status, 400);
    r = await lead.post(`/work-reports/${report.id}/review`).send({ decision: 'REQUEST_CHANGES', feedback: 'Add the hours for the meeting notes' });
    assert.equal(r.body.data.status, 'CHANGES_REQUESTED');
    r = await dev.put(`/work-reports/mine/${today}`).send({ summary: 'Finished the sales report draft, meeting notes shared', items: [{ taskId: taskA.id, description: 'Compiled all branch numbers', hours: 5, completed: true }, { description: 'Team meeting and notes', hours: 1.5 }], submit: true });
    assert.equal(r.body.data.status, 'SUBMITTED');
    r = await lead.post(`/work-reports/${report.id}/review`).send({ decision: 'APPROVE', rating: 4, feedback: 'Good, clear report' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, 'APPROVED');
    const notes = (await dev.get('/notifications')).body.data.items.map((n) => n.title);
    assert.ok(notes.some((t) => t.includes('was reviewed')));
  });

  it('performance shows delivery, report and rating indicators within scope', async () => {
    const team = (await lead.get('/performance')).body.data;
    const names = team.rows.map((r) => r.employee.name).sort();
    assert.deepEqual(names, ['dev Test', 'lead Test']);
    const d = team.rows.find((r) => r.employee.name === 'dev Test');
    assert.equal(d.tasks.completed, 1);
    assert.equal(d.tasks.onTime, 1);
    assert.equal(d.tasks.overdue, 1);
    assert.equal(d.reports.submitted, 1);
    assert.equal(d.reports.avgRating, 4);
    assert.ok(d.score >= 0 && d.score <= 100);
    const mine = (await dev.get(`/performance/employees/${emp.dev.id}`)).body.data;
    assert.equal(mine.trend.length, 8);
    assert.equal(mine.feedback[0].rating, 4);
    assert.equal((await other.get(`/performance/employees/${emp.dev.id}`)).status, 404);
  });

  it('performance and task register reports are available to managers', async () => {
    const perf = (await owner.get('/reports/performance')).body.data;
    assert.equal(perf.title, 'Employee performance');
    assert.ok(perf.table.rows.some((r) => r.employee === 'dev Test' && r.completed === 1));
    const reg = (await owner.get('/reports/tasks')).body.data;
    assert.ok(reg.table.rows.some((r) => r.key === 'T-1' && r.on_time === 'Yes'));
    assert.ok(reg.table.rows.some((r) => r.key === 'T-2' && r.on_time === 'Overdue'));
    assert.equal((await dev.get('/reports/tasks')).status, 403);
  });

  it('only the creator or a manager can delete a task', async () => {
    assert.equal((await dev.delete(`/tasks/${taskA.id}`)).status, 403);
    assert.equal((await lead.delete(`/tasks/${taskA.id}`)).status, 200);
    assert.equal((await dev.get(`/tasks/${taskA.id}`)).status, 404);
  });

  it('projects group tasks and show progress', async () => {
    const p = (await owner.post('/projects').send({ name: 'Website relaunch', code: 'WEB' })).body.data;
    await owner.post('/tasks').send({ title: 'Write copy', assigneeId: emp.dev.id, projectId: p.id });
    const list = (await dev.get('/projects')).body.data;
    assert.equal(list[0].tasks.total, 1);
    assert.equal((await dev.post('/projects').send({ name: 'Nope' })).status, 403);
  });
});
