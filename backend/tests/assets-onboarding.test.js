import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, teardown, db } from './helpers/context.js';
import { company } from './helpers/people.js';
import { addDays } from '../src/services/hr/calendar.js';

describe('Assets and onboarding / offboarding', () => {
  let C; let laptop; let phone;
  before(async () => { await resetDatabase(); C = await company('assetco'); });
  after(teardown);

  describe('assets', () => {
    it('HR registers items; tags must be unique', async () => {
      let r = await C.owner.post('/assets').send({ name: 'Dell Latitude 5440', category: 'Laptop', assetTag: 'LT-001', serialNo: 'SN123', purchaseCost: 145000, warrantyUntil: addDays(C.today, 30) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      laptop = r.body.data;
      assert.equal(laptop.key, 'AST-1');
      assert.equal(laptop.status, 'AVAILABLE');
      r = await C.owner.post('/assets').send({ name: 'Another', category: 'Laptop', assetTag: 'lt-001' });
      assert.equal(r.status, 409);
      phone = (await C.owner.post('/assets').send({ name: 'Samsung A15', category: 'Mobile phone' })).body.data;
      assert.equal((await C.staff.post('/assets').send({ name: 'Mine', category: 'Laptop' })).status, 403);
    });

    it('hands an item over; the holder sees it and others do not', async () => {
      let r = await C.owner.post(`/assets/${laptop.id}/assign`).send({ employeeId: C.emp.staff.id, note: 'For field visits' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.status, 'ASSIGNED');
      assert.equal(r.body.data.holder.id, C.emp.staff.id);
      assert.equal((await C.owner.post(`/assets/${laptop.id}/assign`).send({ employeeId: C.emp.other.id })).status, 409);
      const mine = (await C.staff.get('/assets/mine')).body.data;
      assert.equal(mine.current.length, 1);
      assert.equal((await C.staff.get(`/assets/${laptop.id}`)).body.data.abilities.report, true);
      assert.equal((await C.other.get(`/assets/${laptop.id}`)).status, 404);
      assert.equal((await C.other.get('/assets')).body.data.length, 0);
      assert.equal((await C.boss.get('/assets')).body.data.length, 1, 'the manager sees items held by the team');
      assert.equal((await C.staff.post(`/assets/${laptop.id}/return`).send({ condition: 'GOOD' })).status, 403);
    });

    it('the holder reports a problem; HR takes a damaged item back into repair', async () => {
      assert.equal((await C.staff.post(`/assets/${laptop.id}/report`).send({ note: 'The screen flickers' })).status, 200);
      assert.equal((await C.other.post(`/assets/${laptop.id}/report`).send({ note: 'Not mine but broken' })).status, 404);
      assert.ok((await C.owner.get('/notifications')).body.data.items.some((n) => n.title.includes('Problem with Dell')));
      const r = await C.owner.post(`/assets/${laptop.id}/return`).send({ condition: 'DAMAGED', note: 'Screen cable loose' });
      assert.equal(r.body.data.status, 'IN_REPAIR');
      const d = (await C.owner.get(`/assets/${laptop.id}`)).body.data;
      assert.deepEqual(d.history.map((h) => h.type).reverse(), ['CREATED', 'ASSIGNED', 'ISSUE', 'RETURNED', 'IN_REPAIR']);
      assert.equal((await C.staff.get('/assets/mine')).body.data.history.length, 1);
    });

    it('retiring needs a reason; the summary and export work', async () => {
      assert.equal((await C.owner.post(`/assets/${phone.id}/status`).send({ status: 'RETIRED' })).status, 400);
      assert.equal((await C.owner.post(`/assets/${phone.id}/status`).send({ status: 'RETIRED', note: 'Water damage' })).body.data.status, 'RETIRED');
      const s = (await C.owner.get('/assets/summary')).body.data;
      assert.equal(s.total, 2);
      assert.equal(s.byStatus.IN_REPAIR, 1);
      assert.equal(s.warrantyExpiring, 1);
      const csv = await C.owner.get('/assets/export');
      assert.match(csv.text, /AST-1/);
    });
  });

  describe('onboarding', () => {
    let journey; let newbie;
    it('starts a joining checklist from the default template and notifies the owners', async () => {
      newbie = (await C.owner.post('/employees').send({ firstName: 'Nabin', lastName: 'New', joinedOn: addDays(C.today, 7), branchId: C.hq.id, managerId: C.emp.boss.id })).body.data;
      assert.equal((await C.owner.get('/onboarding/templates')).body.data.length, 2);
      const r = await C.owner.post('/onboarding/journeys').send({ kind: 'ONBOARDING', employeeId: newbie.id });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      journey = (await C.owner.get(`/onboarding/journeys/${r.body.data.id}`)).body.data;
      assert.equal(journey.tasksTotal, 10);
      assert.equal(journey.tasks.find((x) => x.owner === 'IT').dueDate, addDays(newbie.joinedOn, -1));
      assert.equal((await C.owner.post('/onboarding/journeys').send({ kind: 'ONBOARDING', employeeId: newbie.id })).status, 409);
      assert.ok((await C.boss.get('/notifications')).body.data.items.some((n) => n.title.startsWith('Joining checklist')));
    });

    it('only task owners tick tasks; the manager sees their tasks', async () => {
      const mgrTask = journey.tasks.find((x) => x.owner === 'MANAGER');
      const hrTask = journey.tasks.find((x) => x.owner === 'HR');
      const tasks = (await C.boss.get('/onboarding/my-tasks')).body.data;
      assert.ok(tasks.length >= 3 && tasks.every((x) => x.owner === 'MANAGER'));
      assert.equal((await C.boss.post(`/onboarding/journeys/${journey.id}/tasks/${hrTask.id}`).send({ done: true })).status, 403);
      assert.equal((await C.boss.post(`/onboarding/journeys/${journey.id}/tasks/${mgrTask.id}`).send({ done: true })).status, 200);
      assert.equal((await C.other.get(`/onboarding/journeys/${journey.id}`)).status, 404);
    });

    it('cannot be completed while tasks are open; HR finishes it', async () => {
      let r = await C.owner.post(`/onboarding/journeys/${journey.id}/complete`).send({});
      assert.equal(r.body.error.code, 'TASKS_OPEN');
      for (const task of journey.tasks) await C.owner.post(`/onboarding/journeys/${journey.id}/tasks/${task.id}`).send({ done: true });
      r = await C.owner.post(`/onboarding/journeys/${journey.id}/complete`).send({});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.employeeExited, false);
    });
  });

  describe('offboarding', () => {
    let j;
    it('starts an exit checklist with dates from the last working day', async () => {
      const lwd = addDays(C.today, 20);
      let r = await C.owner.post('/onboarding/journeys').send({ kind: 'OFFBOARDING', employeeId: C.emp.other.id });
      assert.equal(r.status, 400);
      r = await C.owner.post('/onboarding/journeys').send({ kind: 'OFFBOARDING', employeeId: C.emp.other.id, exitType: 'RESIGNATION', lastWorkingDay: lwd, noticeDate: C.today, exitReason: 'Higher studies abroad' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      j = (await C.owner.get(`/onboarding/journeys/${r.body.data.id}`)).body.data;
      assert.equal(j.tasks.find((x) => x.title.startsWith('Close email')).dueDate, lwd);
      assert.equal(j.abilities.exitInterview, true);
      assert.equal((await C.other.get(`/onboarding/journeys/${j.id}`)).body.data.abilities.exitInterview, true);
    });

    it('the leaver fills in the exit interview, which ticks its task', async () => {
      const r = await C.other.put(`/onboarding/journeys/${j.id}/exit-interview`).send({ mainReason: 'STUDIES', ratings: { role: 4, manager: 5, growth: 3, pay: 2, culture: 4 }, recommend: true, liked: 'The team', improve: 'Salary reviews' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await C.staff.put(`/onboarding/journeys/${j.id}/exit-interview`).send({ mainReason: 'OTHER', ratings: { role: 1, manager: 1, growth: 1, pay: 1, culture: 1 }, recommend: false })).status, 404);
      const d = (await C.owner.get(`/onboarding/journeys/${j.id}`)).body.data;
      assert.ok(d.tasks.find((x) => x.title === 'Complete the exit interview').doneAt);
      assert.equal(d.exitInterview.mainReason, 'STUDIES');
    });

    it('company items must come back before the exit is completed; completing marks the employee as exited', async () => {
      const ph = (await C.owner.post('/assets').send({ name: 'iPhone 13', category: 'Mobile phone' })).body.data;
      await C.owner.post(`/assets/${ph.id}/assign`).send({ employeeId: C.emp.other.id });
      for (const task of j.tasks) await C.owner.post(`/onboarding/journeys/${j.id}/tasks/${task.id}`).send({ done: true });
      const d = (await C.owner.get(`/onboarding/journeys/${j.id}`)).body.data;
      assert.equal(d.assetsHeld.length, 1);
      let r = await C.owner.post(`/onboarding/journeys/${j.id}/complete`).send({});
      assert.equal(r.body.error.code, 'ASSETS_HELD');
      await C.owner.post(`/assets/${ph.id}/return`).send({ condition: 'GOOD' });
      r = await C.owner.post(`/onboarding/journeys/${j.id}/complete`).send({ rehireEligible: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.data.employeeExited, true);
      const e = await db.sys.Employee.findByPk(C.emp.other.id);
      assert.equal(e.status, 'TERMINATED');
      assert.equal(e.exitedOn, addDays(C.today, 20));
      const u = await db.sys.User.findOne({ where: { employeeId: C.emp.other.id } });
      assert.equal(u.status, 'DISABLED');
    });
  });
});
