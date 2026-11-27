import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, addDays } from '../../services/hr/calendar.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { EMP_ATTRS, empRef, empName, scopesOf, isCompany, holds, employeeIdsIn, employeeInScope, nextNumber, userNames, optText } from '../../services/module-kit.js';
import { terminateEmployee } from '../employees/employees.routes.js';
import { assetsHeldBy } from '../assets/assets.routes.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * Onboarding and offboarding journeys: a checklist per joiner or leaver, with tasks owned by HR, the manager,
 * the employee, IT or finance. Offboarding adds notice dates, an exit interview, the assets the person still
 * holds, and (optionally) marks the employee as exited when the journey is completed.
 */
export const onboardingRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const OWNERS = ['HR', 'MANAGER', 'EMPLOYEE', 'IT', 'FINANCE'];
const EXIT_TYPES = ['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'CONTRACT_END', 'OTHER'];
export const OWNER_LABEL = { HR: 'HR', MANAGER: 'Manager', EMPLOYEE: 'Employee', IT: 'IT', FINANCE: 'Finance' };

// Due days: onboarding counts from the joining date; offboarding from the last working day.
export const DEFAULT_TEMPLATES = [
  { kind: 'ONBOARDING', name: 'Standard joining checklist', description: 'For new employees joining any team.', isDefault: true, items: [
    { title: 'Send the appointment letter and contract for signature', owner: 'HR', dueDays: -7 },
    { title: 'Collect citizenship, PAN, SSF ID, photo and academic documents', owner: 'HR', dueDays: -3, description: 'Upload them to the employee profile under Documents.' },
    { title: 'Prepare laptop, email account and system access', owner: 'IT', dueDays: -1 },
    { title: 'Plan the first week and choose a buddy', owner: 'MANAGER', dueDays: -1 },
    { title: 'Welcome, introductions and office tour', owner: 'HR', dueDays: 0 },
    { title: 'Read the company policies and code of conduct', owner: 'EMPLOYEE', dueDays: 0 },
    { title: 'Complete your profile: emergency contact and bank details', owner: 'EMPLOYEE', dueDays: 2 },
    { title: 'Set up salary, SSF and tax details in payroll', owner: 'FINANCE', dueDays: 5 },
    { title: 'Agree the first goals', owner: 'MANAGER', dueDays: 14 },
    { title: 'First-month check-in', owner: 'MANAGER', dueDays: 30 },
  ] },
  { kind: 'OFFBOARDING', name: 'Standard exit checklist', description: 'For resignations, retirements and contract ends.', isDefault: true, items: [
    { title: 'Confirm the resignation and the last working day in writing', owner: 'HR', dueDays: -25 },
    { title: 'Plan the handover of work and clients', owner: 'MANAGER', dueDays: -20 },
    { title: 'Hand over files, passwords and ongoing work', owner: 'EMPLOYEE', dueDays: -2 },
    { title: 'Complete the exit interview', owner: 'EMPLOYEE', dueDays: -2 },
    { title: 'Collect laptop, ID card and other company items', owner: 'IT', dueDays: -1, description: 'Take each item back under Assets so the register stays correct.' },
    { title: 'Close email and system access', owner: 'IT', dueDays: 0 },
    { title: 'Clear advances, loans and pending expense claims', owner: 'FINANCE', dueDays: 0 },
    { title: 'Final settlement: last salary, leave encashment and gratuity', owner: 'FINANCE', dueDays: 7 },
    { title: 'Issue the experience letter', owner: 'HR', dueDays: 7 },
  ] },
];

const itemSchema = z.object({
  title: z.string().trim().min(2).max(160), description: optText(z, 1000), owner: z.enum(OWNERS), dueDays: z.number().int().min(-120).max(365).nullish(),
}).strict();
const templateBody = z.object({
  kind: z.enum(['ONBOARDING', 'OFFBOARDING']), name: z.string().trim().min(2).max(120), description: optText(z, 500),
  items: z.array(itemSchema).min(1, 'Add at least one task').max(60), isDefault: z.boolean().default(false), active: z.boolean().default(true),
}).strict();

async function ensureTemplates(req, t) {
  if (await app.ChecklistTemplate.count({ transaction: t })) return;
  await app.ChecklistTemplate.bulkCreate(DEFAULT_TEMPLATES.map((x) => ({ ...x, tenantId: req.auth.tenantId, active: true })), { transaction: t });
}
const templateView = (x) => ({ id: x.id, kind: x.kind, name: x.name, description: x.description, items: x.items, isDefault: x.isDefault, active: x.active, updatedAt: x.updatedAt });

// --------------------------------------------------------------------------- templates
onboardingRouter.get('/templates', requirePermission('onboarding:view'), validate({ query: z.object({ kind: z.enum(['ONBOARDING', 'OFFBOARDING']).optional() }).strict() }), asyncHandler(async (req, res) => {
  const rows = await req.tx(async (t) => {
    await ensureTemplates(req, t);
    return app.ChecklistTemplate.findAll({ where: req.query.kind ? { kind: req.query.kind } : {}, order: [['kind', 'ASC'], ['isDefault', 'DESC'], ['name', 'ASC']], transaction: t });
  });
  return ok(res, rows.map(templateView));
}));

async function saveTemplate(req, t, row) {
  const b = req.body;
  if (b.isDefault) await app.ChecklistTemplate.update({ isDefault: false }, { where: { kind: b.kind, ...(row && { id: { [Op.ne]: row.id } }) }, transaction: t });
  const out = row ? await row.update(b, { transaction: t }) : await app.ChecklistTemplate.create({ ...b, tenantId: req.auth.tenantId }, { transaction: t });
  await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: row ? 'onboarding.template_update' : 'onboarding.template_create', entityType: 'checklist_template', entityId: out.id, after: b, req });
  return out;
}
onboardingRouter.post('/templates', requirePermission('onboarding:configure'), validate({ body: templateBody }), asyncHandler(async (req, res) => {
  const x = await req.tx(async (t) => { await ensureTemplates(req, t); return saveTemplate(req, t, null); });
  return created(res, templateView(x));
}));
onboardingRouter.put('/templates/:id', requirePermission('onboarding:configure'), validate({ ...idParam, body: templateBody }), asyncHandler(async (req, res) => {
  const x = await req.tx(async (t) => {
    const row = await app.ChecklistTemplate.findByPk(req.params.id, { transaction: t });
    if (!row) throw NotFound('Checklist');
    if (row.kind !== req.body.kind) throw BadRequest('A checklist cannot change between joining and exit');
    return saveTemplate(req, t, row);
  });
  return ok(res, templateView(x));
}));

// --------------------------------------------------------------------------- who may tick a task
async function taskRights(req, t, journey, emp) {
  const hr = isCompany(scopesOf(req, 'onboarding:manage'));
  const me = req.auth.principal.employeeId;
  const editScopes = scopesOf(req, 'onboarding:edit');
  const isManager = !!me && emp.managerId === me;
  return {
    hr,
    can: (owner) => {
      if (journey.status !== 'OPEN') return false;
      if (hr) return true;
      if (owner === 'EMPLOYEE') return !!me && emp.id === me && editScopes.length > 0;
      if (owner === 'MANAGER') return isManager || (editScopes.length > 0 && !isCompany(editScopes) && employeeInScope(req, editScopes, emp) && emp.id !== me);
      if (owner === 'IT') return holds(req, 'assets:edit');
      if (owner === 'FINANCE') return holds(req, 'payroll:edit') || isCompany(scopesOf(req, 'expenses:approve'));
      return false;
    },
  };
}

/** People to tell about tasks they own in a journey. */
async function ownersToNotify(t, emp, owners) {
  const out = new Set();
  if (owners.has('HR')) (await usersWithPermission(t, 'onboarding:manage')).forEach((u) => out.add(u));
  if (owners.has('IT')) (await usersWithPermission(t, 'assets:edit')).forEach((u) => out.add(u));
  if (owners.has('FINANCE')) (await usersWithPermission(t, 'payroll:edit')).forEach((u) => out.add(u));
  if (owners.has('MANAGER') && emp.managerId) out.add(await userIdForEmployee(t, emp.managerId));
  return [...out].filter(Boolean);
}

function journeyView(j, emp, extra = {}) {
  const tasks = j.tasks ?? [];
  const done = tasks.filter((x) => x.doneAt).length;
  return {
    id: j.id, key: `${j.kind === 'ONBOARDING' ? 'ON' : 'OFF'}-${j.number}`, kind: j.kind, status: j.status, startDate: j.startDate,
    employee: emp ? { ...empRef(emp), joinedOn: emp.joinedOn } : null, exitType: j.exitType, noticeDate: j.noticeDate, lastWorkingDay: j.lastWorkingDay,
    exitReason: j.exitReason, rehireEligible: j.rehireEligible, terminateEmployee: j.terminateEmployee, hasExitInterview: !!j.exitInterview,
    tasksDone: done, tasksTotal: tasks.length, percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    completedAt: j.completedAt, createdAt: j.createdAt, ...extra,
  };
}

// --------------------------------------------------------------------------- list and "tasks for me"
const listQ = z.object({
  kind: z.enum(['ONBOARDING', 'OFFBOARDING']).optional(), status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

onboardingRouter.get('/journeys', requirePermission('onboarding:view'), validate({ query: listQ }), asyncHandler(async (req, res) => {
  const q = req.query;
  const out = await req.tx(async (t) => {
    const ids = await employeeIdsIn(t, req, req.scopes);
    const where = { ...(ids && { employeeId: ids }), ...(q.kind && { kind: q.kind }), ...(q.status && { status: q.status }) };
    const { rows, count } = await app.Journey.findAndCountAll({
      where, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }, { model: app.JourneyTask, as: 'tasks', attributes: ['id', 'doneAt', 'dueDate'] }],
      order: [['status', 'DESC'], ['startDate', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, distinct: true, transaction: t,
    });
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    return { rows: rows.map((j) => journeyView(j, j.employee, { overdue: j.status === 'OPEN' ? j.tasks.filter((x) => !x.doneAt && x.dueDate && x.dueDate < today).length : 0 })), count };
  });
  return ok(res, out.rows, { page: q.page, pageSize: q.pageSize, total: out.count, totalPages: Math.ceil(out.count / q.pageSize) });
}));

/** Open tasks across journeys that this person can complete (as HR, manager, employee, IT or finance). */
onboardingRouter.get('/my-tasks', requirePermission('onboarding:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const open = await app.Journey.findAll({ where: { status: 'OPEN' }, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }, { model: app.JourneyTask, as: 'tasks' }], transaction: t });
    const list = [];
    const me = req.auth.principal.employeeId;
    const hr = isCompany(scopesOf(req, 'onboarding:manage'));
    const it = holds(req, 'assets:edit');
    const finance = holds(req, 'payroll:edit') || isCompany(scopesOf(req, 'expenses:approve'));
    for (const j of open) {
      for (const task of j.tasks) {
        if (task.doneAt) continue;
        const mine = (task.owner === 'HR' && hr) || (task.owner === 'IT' && it) || (task.owner === 'FINANCE' && finance)
          || (task.owner === 'MANAGER' && !!me && j.employee.managerId === me) || (task.owner === 'EMPLOYEE' && !!me && j.employeeId === me);
        if (mine) list.push({ id: task.id, title: task.title, owner: task.owner, dueDate: task.dueDate, journeyId: j.id, kind: j.kind, employee: empRef(j.employee) });
      }
    }
    return list.sort((a, b) => String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999')));
  });
  return ok(res, out);
}));

/** The signed-in employee's own open journey, if any (welcome / exit page). */
onboardingRouter.get('/mine', requirePermission('onboarding:view'), asyncHandler(async (req, res) => {
  const me = req.auth.principal.employeeId;
  if (!me) return ok(res, null);
  const j = await req.tx((t) => app.Journey.findOne({ where: { employeeId: me, status: { [Op.ne]: 'CANCELLED' } }, order: [['status', 'DESC'], ['createdAt', 'DESC']], transaction: t }));
  return ok(res, j ? { id: j.id, kind: j.kind, status: j.status } : null);
}));

// --------------------------------------------------------------------------- start a journey
const startBody = z.object({
  kind: z.enum(['ONBOARDING', 'OFFBOARDING']), employeeId: z.string().uuid(), templateId: z.string().uuid().nullish(),
  startDate: z.string().date().optional(),
  exitType: z.enum(EXIT_TYPES).optional(), noticeDate: z.string().date().optional(), lastWorkingDay: z.string().date().optional(),
  exitReason: optText(z, 1000), terminateEmployee: z.boolean().default(true),
}).strict();

export async function startJourney(req, t, b) {
  const emp = await app.Employee.findOne({ where: { id: b.employeeId, deletedAt: null }, attributes: EMP_ATTRS, transaction: t });
  if (!emp) throw NotFound('Employee');
  if (!employeeInScope(req, scopesOf(req, 'onboarding:manage'), emp)) throw NotFound('Employee');
  if (emp.status === 'TERMINATED') throw Conflict(`${empName(emp)} has already left.`, 'EXITED');
  if (await app.Journey.count({ where: { employeeId: emp.id, kind: b.kind, status: 'OPEN' }, transaction: t })) throw Conflict(`${empName(emp)} already has an open ${b.kind === 'ONBOARDING' ? 'joining' : 'exit'} checklist.`, 'JOURNEY_OPEN');
  const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
  let base; let startDate;
  if (b.kind === 'ONBOARDING') {
    startDate = b.startDate ?? emp.joinedOn ?? today; base = startDate;
  } else {
    if (!b.exitType) throw BadRequest('Choose the type of exit', [{ path: 'exitType', message: 'Required' }]);
    if (!b.lastWorkingDay) throw BadRequest('Enter the last working day', [{ path: 'lastWorkingDay', message: 'Required' }]);
    if (emp.joinedOn && b.lastWorkingDay < emp.joinedOn) throw BadRequest('The last working day is before the joining date', [{ path: 'lastWorkingDay', message: 'Before joining' }]);
    startDate = b.noticeDate ?? today; base = b.lastWorkingDay;
    if (b.noticeDate && b.noticeDate > b.lastWorkingDay) throw BadRequest('The notice date is after the last working day', [{ path: 'noticeDate', message: 'After the last day' }]);
  }
  await ensureTemplates(req, t);
  const tpl = b.templateId
    ? await app.ChecklistTemplate.findOne({ where: { id: b.templateId, kind: b.kind }, transaction: t })
    : await app.ChecklistTemplate.findOne({ where: { kind: b.kind, active: true }, order: [['isDefault', 'DESC'], ['createdAt', 'ASC']], transaction: t });
  if (b.templateId && !tpl) throw BadRequest('Choose a checklist of the right kind', [{ path: 'templateId', message: 'Not found' }]);
  const j = await app.Journey.create({
    tenantId: req.auth.tenantId, number: await nextNumber(t, 'journeys'), kind: b.kind, employeeId: emp.id, templateId: tpl?.id ?? null, status: 'OPEN', startDate,
    ...(b.kind === 'OFFBOARDING' && { exitType: b.exitType, noticeDate: b.noticeDate ?? null, lastWorkingDay: b.lastWorkingDay, exitReason: b.exitReason, terminateEmployee: b.terminateEmployee }),
    createdBy: req.auth.userId,
  }, { transaction: t });
  const items = tpl?.items ?? [];
  await app.JourneyTask.bulkCreate(items.map((it, i) => ({
    tenantId: req.auth.tenantId, journeyId: j.id, sort: i, title: it.title, description: it.description ?? null, owner: it.owner,
    dueDate: it.dueDays == null ? null : addDays(base, it.dueDays),
  })), { transaction: t });
  const owners = new Set(items.map((x) => x.owner));
  const who = empName(emp);
  const what = b.kind === 'ONBOARDING' ? `Joining checklist for ${who}` : `Exit checklist for ${who}`;
  await notifyUsers(t, (await ownersToNotify(t, emp, owners)).filter((u) => u !== req.auth.userId), { type: `${b.kind.toLowerCase()}.started`, title: what, body: b.kind === 'ONBOARDING' ? `Joining on ${startDate}. You have tasks on the checklist.` : `Last working day ${b.lastWorkingDay}. You have tasks on the checklist.`, link: `/onboarding/${j.id}`, email: true });
  if (owners.has('EMPLOYEE')) {
    const u = await userIdForEmployee(t, emp.id);
    await notifyUsers(t, [u], { type: `${b.kind.toLowerCase()}.started`, title: b.kind === 'ONBOARDING' ? 'Welcome! Your first-days checklist is ready' : 'Your exit checklist', body: 'A few steps need you. Open the checklist to see them.', link: `/onboarding/${j.id}` });
  }
  await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: `${b.kind.toLowerCase()}.start`, entityType: 'journey', entityId: j.id, after: { ...b, template: tpl?.name }, req });
  return j;
}

onboardingRouter.post('/journeys', requirePermission('onboarding:manage'), validate({ body: startBody }), asyncHandler(async (req, res) => {
  const j = await req.tx((t) => startJourney(req, t, req.body));
  return created(res, { id: j.id });
}));

// --------------------------------------------------------------------------- detail
async function loadJourney(req, t, id, { lock = false } = {}) {
  const j = await app.Journey.findByPk(id, { transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!j) throw NotFound('Checklist');
  const emp = await app.Employee.findByPk(j.employeeId, { attributes: EMP_ATTRS, transaction: t });
  const rights = await taskRights(req, t, j, emp);
  const visible = rights.hr || employeeInScope(req, scopesOf(req, 'onboarding:view'), emp) || ['IT', 'FINANCE'].some((o) => rights.can(o));
  if (!visible) throw NotFound('Checklist');
  return { j, emp, rights };
}

onboardingRouter.get('/journeys/:id', requirePermission('onboarding:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { j, emp, rights } = await loadJourney(req, t, req.params.id);
    const tasks = await app.JourneyTask.findAll({ where: { journeyId: j.id }, order: [['sort', 'ASC'], ['createdAt', 'ASC']], transaction: t });
    j.tasks = tasks;
    const names = await userNames(t, [...tasks.map((x) => x.doneBy), j.completedBy]);
    const manager = emp.managerId ? await app.Employee.findByPk(emp.managerId, { attributes: EMP_ATTRS, transaction: t }) : null;
    const isSelf = emp.id === req.auth.principal.employeeId;
    const assets = j.kind === 'OFFBOARDING' && req.auth.ctx.features.includes('assets') && (rights.hr || holds(req, 'assets:view')) ? await assetsHeldBy(t, emp.id) : null;
    const tpl = j.templateId ? await app.ChecklistTemplate.findByPk(j.templateId, { attributes: ['name'], transaction: t }) : null;
    return journeyView(j, emp, {
      manager: empRef(manager), template: tpl?.name ?? null, completedBy: names[j.completedBy] ?? null,
      exitInterview: j.exitInterview && (rights.hr || isSelf) ? j.exitInterview : null,
      tasks: tasks.map((x) => ({ id: x.id, title: x.title, description: x.description, owner: x.owner, dueDate: x.dueDate, doneAt: x.doneAt, doneBy: names[x.doneBy] ?? null, note: x.note, canTick: rights.can(x.owner) })),
      assetsHeld: assets,
      abilities: {
        manage: rights.hr && j.status === 'OPEN',
        complete: rights.hr && j.status === 'OPEN',
        exitInterview: j.kind === 'OFFBOARDING' && j.status === 'OPEN' && (isSelf || rights.hr),
      },
    });
  });
  return ok(res, out);
}));

// --------------------------------------------------------------------------- tasks
onboardingRouter.post('/journeys/:id/tasks/:taskId', requirePermission('onboarding:view'), validate({
  params: z.object({ id: z.string().uuid(), taskId: z.string().uuid() }), body: z.object({ done: z.boolean(), note: optText(z, 1000) }).strict(),
}), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { j, emp, rights } = await loadJourney(req, t, req.params.id);
    const task = await app.JourneyTask.findOne({ where: { id: req.params.taskId, journeyId: j.id }, transaction: t, lock: t.LOCK.UPDATE });
    if (!task) throw NotFound('Task');
    if (!rights.can(task.owner)) throw Forbidden(j.status !== 'OPEN' ? 'This checklist is closed.' : `This task belongs to ${task.owner === 'MANAGER' ? 'the manager' : task.owner === 'EMPLOYEE' ? 'the employee' : task.owner}.`, 'NOT_TASK_OWNER');
    await task.update(req.body.done ? { doneAt: new Date(), doneBy: req.auth.userId, note: req.body.note ?? task.note } : { doneAt: null, doneBy: null, note: req.body.note ?? task.note }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: req.body.done ? 'journey.task_done' : 'journey.task_reopened', entityType: 'journey', entityId: j.id, after: { task: task.title, note: req.body.note }, req });
    const left = await app.JourneyTask.count({ where: { journeyId: j.id, doneAt: null }, transaction: t });
    if (req.body.done && left === 0) {
      await notifyUsers(t, (await usersWithPermission(t, 'onboarding:manage')).filter((u) => u !== req.auth.userId), { type: 'journey.ready', title: `All tasks done for ${empName(emp)}`, body: 'The checklist can be completed.', link: `/onboarding/${j.id}` });
    }
    return { id: task.id, doneAt: task.doneAt, left };
  });
  return ok(res, out);
}));

onboardingRouter.post('/journeys/:id/tasks', requirePermission('onboarding:manage'), validate({ ...idParam, body: itemSchema.extend({ dueDate: z.string().date().nullish() }).omit({ dueDays: true }) }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { j, emp, rights } = await loadJourney(req, t, req.params.id);
    if (!rights.hr || j.status !== 'OPEN') throw Forbidden('Only HR can add tasks to an open checklist.');
    const sort = (await app.JourneyTask.max('sort', { where: { journeyId: j.id }, transaction: t })) ?? 0;
    const task = await app.JourneyTask.create({ tenantId: req.auth.tenantId, journeyId: j.id, sort: sort + 1, ...req.body }, { transaction: t });
    const to = await ownersToNotify(t, emp, new Set([req.body.owner]));
    if (req.body.owner === 'EMPLOYEE') to.push(await userIdForEmployee(t, emp.id));
    await notifyUsers(t, to.filter((u) => u && u !== req.auth.userId), { type: 'journey.task', title: `New checklist task: ${task.title}`, body: `${j.kind === 'ONBOARDING' ? 'Joining' : 'Exit'} checklist for ${empName(emp)}`, link: `/onboarding/${j.id}` });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'journey.task_add', entityType: 'journey', entityId: j.id, after: req.body, req });
    return task;
  });
  return created(res, { id: out.id });
}));

onboardingRouter.delete('/journeys/:id/tasks/:taskId', requirePermission('onboarding:manage'), validate({ params: z.object({ id: z.string().uuid(), taskId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { j, rights } = await loadJourney(req, t, req.params.id);
    if (!rights.hr || j.status !== 'OPEN') throw Forbidden('Only HR can remove tasks from an open checklist.');
    const task = await app.JourneyTask.findOne({ where: { id: req.params.taskId, journeyId: j.id }, transaction: t });
    if (!task) throw NotFound('Task');
    await task.destroy({ transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'journey.task_remove', entityType: 'journey', entityId: j.id, before: { task: task.title }, req });
  });
  return ok(res, { removed: true });
}));

// --------------------------------------------------------------------------- exit interview
const RATING = z.number().int().min(1).max(5);
const exitBody = z.object({
  mainReason: z.enum(['BETTER_PAY', 'CAREER_GROWTH', 'MANAGER', 'WORKLOAD', 'CULTURE', 'RELOCATION', 'STUDIES', 'FAMILY', 'HEALTH', 'ABROAD', 'OTHER']),
  ratings: z.object({ role: RATING, manager: RATING, growth: RATING, pay: RATING, culture: RATING }).strict(),
  recommend: z.boolean(),
  liked: optText(z, 2000), improve: optText(z, 2000),
}).strict();

onboardingRouter.put('/journeys/:id/exit-interview', requirePermission('onboarding:view'), validate({ ...idParam, body: exitBody }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { j, emp, rights } = await loadJourney(req, t, req.params.id, { lock: true });
    const isSelf = emp.id === req.auth.principal.employeeId;
    if (j.kind !== 'OFFBOARDING' || j.status !== 'OPEN' || !(isSelf || rights.hr)) throw Forbidden('Only the leaving employee or HR can fill in the exit interview.');
    await j.update({ exitInterview: { ...req.body, submittedAt: new Date().toISOString(), by: isSelf ? 'EMPLOYEE' : 'HR' } }, { transaction: t });
    await app.JourneyTask.update({ doneAt: new Date(), doneBy: req.auth.userId }, { where: { journeyId: j.id, doneAt: null, title: { [Op.iLike]: '%exit interview%' } }, transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'offboarding.exit_interview', entityType: 'journey', entityId: j.id, req });
  });
  return ok(res, { saved: true });
}));

// --------------------------------------------------------------------------- complete or cancel
onboardingRouter.post('/journeys/:id/complete', requirePermission('onboarding:manage'), validate({ ...idParam, body: z.object({ note: optText(z, 500), rehireEligible: z.boolean().optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { j, rights } = await loadJourney(req, t, req.params.id, { lock: true });
    if (!rights.hr) throw Forbidden('Only HR can complete a checklist.');
    if (j.status !== 'OPEN') throw Conflict('This checklist is already closed.');
    const left = await app.JourneyTask.count({ where: { journeyId: j.id, doneAt: null }, transaction: t });
    if (left) throw Conflict(`${left} task${left === 1 ? ' is' : 's are'} still open. Tick them off or remove them first.`, 'TASKS_OPEN');
    if (j.kind === 'OFFBOARDING') {
      const held = await app.Asset.count({ where: { assignedEmployeeId: j.employeeId }, transaction: t });
      if (held) throw Conflict(`The employee still holds ${held} company item${held === 1 ? '' : 's'}. Take them back under Assets first.`, 'ASSETS_HELD');
    }
    await j.update({ status: 'COMPLETED', completedAt: new Date(), completedBy: req.auth.userId, ...(req.body.rehireEligible != null && { rehireEligible: req.body.rehireEligible }) }, { transaction: t });
    let exited = false;
    if (j.kind === 'OFFBOARDING' && j.terminateEmployee) {
      const e = await app.Employee.findByPk(j.employeeId, { transaction: t, lock: t.LOCK.UPDATE });
      if (e.status !== 'TERMINATED') {
        await terminateEmployee(req, t, e, { exitedOn: j.lastWorkingDay, reason: j.exitType, note: req.body.note ?? `Exit checklist OFF-${j.number} completed` });
        exited = true;
      }
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: `${j.kind.toLowerCase()}.complete`, entityType: 'journey', entityId: j.id, after: { exited, ...req.body }, req });
    return { status: 'COMPLETED', employeeExited: exited };
  });
  return ok(res, out);
}));

onboardingRouter.post('/journeys/:id/cancel', requirePermission('onboarding:manage'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3, 'Give a reason').max(500) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { j, rights } = await loadJourney(req, t, req.params.id, { lock: true });
    if (!rights.hr) throw Forbidden('Only HR can cancel a checklist.');
    if (j.status !== 'OPEN') throw Conflict('This checklist is already closed.');
    await j.update({ status: 'CANCELLED' }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: `${j.kind.toLowerCase()}.cancel`, entityType: 'journey', entityId: j.id, after: req.body, req });
  });
  return ok(res, { status: 'CANCELLED' });
}));
