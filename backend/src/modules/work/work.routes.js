import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { recordInScope } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { notifyUsers } from '../../services/hr/notify.js';
import { localDate, addDays, weekday } from '../../services/hr/calendar.js';
import {
  TASK_STATUSES, OPEN, PRIORITIES, employeeIdsInScope, wideScopes, loadEmployee, taskAbilities, label, nextTaskNumber,
  logActivity, recomputeLoggedHours, reviewerUserIds, notifyTaskPeople, performance, weeklyTrend,
} from '../../services/work.service.js';
import { asyncHandler, ok, created, pageMeta } from '../../utils/http.js';
import { NotFound, Forbidden, BadRequest, Conflict } from '../../utils/errors.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idParam = { params: z.object({ id: z.string().uuid() }) };
const today = (req) => localDate(new Date(), req.auth.ctx.tenant.timezone);
const name = (e) => (e ? `${e.firstName} ${e.lastName}` : null);
const EMP = ['id', 'firstName', 'lastName', 'employeeCode', 'managerId', 'departmentId', 'branchId'];

function presentTask(k, extra = {}) {
  const j = k.toJSON ? k.toJSON() : k;
  return {
    id: j.id, key: `T-${j.number}`, number: j.number, title: j.title, description: j.description, priority: j.priority, status: j.status,
    progress: j.progress, requiresReview: j.requiresReview, startOn: j.startOn, dueOn: j.dueOn, estimateHours: j.estimateHours != null ? Number(j.estimateHours) : null,
    loggedHours: Number(j.loggedHours ?? 0), tags: j.tags ?? [], blockedReason: j.blockedReason, completedAt: j.completedAt, createdAt: j.createdAt, updatedAt: j.updatedAt,
    assignee: j.assignee ? { id: j.assignee.id, name: name(j.assignee), employeeCode: j.assignee.employeeCode } : { id: j.assigneeId },
    project: j.project ? { id: j.project.id, name: j.project.name, color: j.project.color } : null,
    createdBy: j.creator ? { id: j.creator.id, name: j.creator.fullName } : { id: j.createdBy },
    ...extra,
  };
}

// ============================================================================ tasks
export const tasksRouter = Router();

const taskList = z.object({
  view: z.enum(['all', 'mine', 'created', 'team']).default('all'),
  status: z.string().max(80).optional(),          // comma separated, or "open"
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  due: z.enum(['overdue', 'today', 'week', 'none']).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['dueOn', 'priority', 'createdAt', 'updatedAt', 'number', 'progress']).default('dueOn'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

/** WHERE for tasks the user may see (assignee in tasks:view scope, or created by them). */
async function visibleWhere(req, t) {
  const ids = await employeeIdsInScope(t, req.auth.grants.get('tasks:view')?.scopes, req.auth.principal);
  const base = { deletedAt: null };
  if (ids === null) return base;
  return { ...base, [Op.or]: [{ assigneeId: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'] }, { createdBy: req.auth.userId }] };
}
const include = () => [
  { model: app.Employee, as: 'assignee', attributes: EMP },
  { model: app.Project, as: 'project', attributes: ['id', 'name', 'color'] },
  { model: app.User, as: 'creator', attributes: ['id', 'fullName'] },
];
const PRIORITY_ORDER = "CASE \"Task\".\"priority\" WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END";

tasksRouter.get('/', requirePermission('tasks:view'), validate({ query: taskList }), asyncHandler(async (req, res) => {
  const q = req.query;
  const td = today(req);
  const out = await req.tx(async (t) => {
    const and = [await visibleWhere(req, t)];
    const me = req.auth.principal.employeeId;
    if (q.view === 'mine') and.push({ assigneeId: me ?? null });
    if (q.view === 'created') and.push({ createdBy: req.auth.userId });
    if (q.view === 'team') and.push({ assigneeId: { [Op.ne]: me ?? '00000000-0000-0000-0000-000000000000' } });
    if (q.status) and.push({ status: q.status === 'open' ? OPEN : q.status.split(',').filter((s) => TASK_STATUSES.includes(s)) });
    if (q.priority) and.push({ priority: q.priority });
    if (q.assigneeId) and.push({ assigneeId: q.assigneeId });
    if (q.projectId) and.push({ projectId: q.projectId });
    if (q.due === 'overdue') and.push({ dueOn: { [Op.lt]: td }, status: OPEN });
    if (q.due === 'today') and.push({ dueOn: td });
    if (q.due === 'week') and.push({ dueOn: { [Op.between]: [td, addDays(td, 7)] } });
    if (q.due === 'none') and.push({ dueOn: null });
    if (q.search) {
      const n = Number(q.search.replace(/^t-/i, ''));
      and.push({ [Op.or]: [{ title: { [Op.iLike]: `%${q.search}%` } }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])] });
    }
    const order = q.sort === 'priority' ? [[app.Task.sequelize.literal(PRIORITY_ORDER), q.order.toUpperCase()], ['dueOn', 'ASC NULLS LAST']]
      : q.sort === 'dueOn' ? [['dueOn', `${q.order.toUpperCase()} NULLS LAST`], [app.Task.sequelize.literal(PRIORITY_ORDER), 'ASC']]
        : [[q.sort, q.order.toUpperCase()]];
    const { rows, count } = await app.Task.findAndCountAll({ where: { [Op.and]: and }, include: include(), order, limit: q.pageSize, offset: (q.page - 1) * q.pageSize, distinct: true, transaction: t });
    return { rows: rows.map((k) => presentTask(k, { overdue: OPEN.includes(k.status) && !!k.dueOn && k.dueOn < td })), count };
  });
  return ok(res, out.rows, pageMeta(q, out.count));
}));

/** Counts for dashboards and the task board header. */
tasksRouter.get('/summary', requirePermission('tasks:view'), validate({ query: z.object({ view: z.enum(['mine', 'team', 'all']).default('mine') }).strict() }), asyncHandler(async (req, res) => {
  const td = today(req);
  let wk = td; while (weekday(wk) !== 'SUN') wk = addDays(wk, -1);
  const out = await req.tx(async (t) => {
    const and = [await visibleWhere(req, t)];
    const me = req.auth.principal.employeeId;
    if (req.query.view === 'mine') and.push({ assigneeId: me ?? null });
    if (req.query.view === 'team') and.push({ assigneeId: { [Op.ne]: me ?? '00000000-0000-0000-0000-000000000000' } });
    const rows = await app.Task.findAll({ where: { [Op.and]: and }, attributes: ['id', 'status', 'priority', 'dueOn', 'completedAt', 'assigneeId'], raw: true, transaction: t });
    const open = rows.filter((r) => OPEN.includes(r.status));
    const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
    const doneThisWeek = rows.filter((r) => r.status === 'DONE' && r.completedAt && localDate(new Date(r.completedAt), req.auth.ctx.tenant.timezone) >= wk).length;
    return {
      byStatus, open: open.length,
      overdue: open.filter((r) => r.dueOn && r.dueOn < td).length,
      dueToday: open.filter((r) => r.dueOn === td).length,
      dueThisWeek: open.filter((r) => r.dueOn && r.dueOn >= td && r.dueOn <= addDays(td, 7)).length,
      urgent: open.filter((r) => r.priority === 'URGENT' || r.priority === 'HIGH').length,
      doneThisWeek,
    };
  });
  return ok(res, out);
}));

/** People the current user may assign tasks to. */
tasksRouter.get('/assignees', requirePermission('tasks:create'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const ids = await employeeIdsInScope(t, req.scopes, req.auth.principal);
    const where = { deletedAt: null, status: { [Op.ne]: 'TERMINATED' }, ...(ids === null ? {} : { id: ids }) };
    return (await app.Employee.findAll({ where, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], order: [['firstName', 'ASC']], transaction: t }))
      .map((e) => ({ id: e.id, name: name(e), employeeCode: e.employeeCode }));
  });
  return ok(res, out);
}));

const taskBody = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(10_000).optional().nullable(),
  assigneeId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  startOn: DATE.nullable().optional(),
  dueOn: DATE.nullable().optional(),
  estimateHours: z.coerce.number().min(0).max(999).nullable().optional(),
  requiresReview: z.boolean().default(false),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
}).strict();

tasksRouter.post('/', requirePermission('tasks:create'), validate({ body: taskBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const assigneeId = b.assigneeId ?? req.auth.principal.employeeId;
  if (!assigneeId) throw BadRequest('Choose who the task is for', [{ path: 'assigneeId', message: 'Required' }]);
  if (b.startOn && b.dueOn && b.dueOn < b.startOn) throw BadRequest('Due date is before the start date', [{ path: 'dueOn', message: 'Must be on or after the start date' }]);
  const task = await req.tx(async (t) => {
    const assignee = await loadEmployee(t, assigneeId);
    if (!assignee) throw BadRequest('Employee not found', [{ path: 'assigneeId', message: 'Not found' }]);
    if (!recordInScope(req.scopes, req.auth.principal, assignee)) throw Forbidden('You can only assign tasks to people you manage', 'OUT_OF_SCOPE');
    if (b.projectId && !(await app.Project.count({ where: { id: b.projectId, deletedAt: null }, transaction: t }))) throw BadRequest('Project not found', [{ path: 'projectId', message: 'Not found' }]);
    const k = await app.Task.create({ ...b, assigneeId, tenantId: req.auth.tenantId, createdBy: req.auth.userId, number: await nextTaskNumber(t, req.auth.tenantId), status: 'TODO', progress: 0 }, { transaction: t });
    await logActivity(t, req, k, 'CREATED', { to: { assignee: name(assignee), dueOn: b.dueOn ?? null, priority: b.priority } });
    await notifyTaskPeople(t, req, k, { to: ['assignee'], title: `New task: ${label(k)} ${k.title}`.slice(0, 200), body: [b.dueOn && `Due ${b.dueOn}`, `Priority ${b.priority.toLowerCase()}`].filter(Boolean).join(' · '), email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'task.create', entityType: 'task', entityId: k.id, after: { title: k.title, assigneeId }, req });
    return app.Task.findByPk(k.id, { include: include(), transaction: t });
  });
  return created(res, presentTask(task));
}));

async function loadTask(req, t) {
  const k = await app.Task.findOne({ where: { id: req.params.id, deletedAt: null }, include: include(), transaction: t });
  if (!k) throw NotFound('Task');
  const ab = taskAbilities(req, k, k.assignee);
  if (!ab.canView) throw NotFound('Task');
  return { k, ab };
}

tasksRouter.get('/:id', requirePermission('tasks:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { k, ab } = await loadTask(req, t);
    const activity = await app.TaskActivity.findAll({ where: { taskId: k.id }, include: [{ model: app.User, as: 'author', attributes: ['id', 'fullName'] }], order: [['createdAt', 'ASC']], transaction: t });
    const reportEntries = await app.WorkReportItem.count({ where: { taskId: k.id }, transaction: t });
    return presentTask(k, {
      overdue: OPEN.includes(k.status) && !!k.dueOn && k.dueOn < today(req),
      abilities: { canManage: ab.canManage, canUpdate: ab.canUpdate, canDelete: ab.canDelete, isAssignee: ab.isAssignee },
      activity: activity.map((a) => ({ id: a.id, kind: a.kind, body: a.body, from: a.fromValue, to: a.toValue, at: a.createdAt, author: a.author ? { id: a.author.id, name: a.author.fullName } : null })),
      reportEntries,
    });
  });
  return ok(res, out);
}));

const patchBody = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(10_000).optional().nullable(),
  assigneeId: z.string().uuid().optional(),
  projectId: z.string().uuid().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  startOn: DATE.nullable().optional(),
  dueOn: DATE.nullable().optional(),
  estimateHours: z.coerce.number().min(0).max(999).nullable().optional(),
  requiresReview: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
}).extend({
  status: z.enum(TASK_STATUSES).optional(),
  progress: z.coerce.number().int().min(0).max(100).optional(),
  blockedReason: z.string().trim().max(1000).nullable().optional(),
  note: z.string().trim().max(2000).optional(),   // optional comment recorded with a status/progress change
}).strict();
const MANAGER_FIELDS = ['title', 'description', 'assigneeId', 'projectId', 'priority', 'startOn', 'dueOn', 'estimateHours', 'requiresReview', 'tags'];

tasksRouter.patch('/:id', requirePermission('tasks:edit'), validate({ ...idParam, body: patchBody }), asyncHandler(async (req, res) => {
  const b = req.body;
  const task = await req.tx(async (t) => {
    const { k, ab } = await loadTask(req, t);
    if (!ab.canUpdate) throw Forbidden('You cannot update this task');
    const norm = (f, v) => (f === 'estimateHours' ? (v == null ? null : Number(v)) : f === 'tags' ? (v ?? []) : (v ?? null));
    const managerChange = MANAGER_FIELDS.filter((f) => b[f] !== undefined && JSON.stringify(norm(f, b[f])) !== JSON.stringify(norm(f, k[f])));
    if (managerChange.length && !ab.canManage) throw Forbidden('Only the person who assigned this task or a manager can change its details', 'NOT_TASK_MANAGER');
    const patch = {};
    for (const f of managerChange) patch[f] = b[f];
    if (patch.assigneeId) {
      const emp = await loadEmployee(t, patch.assigneeId);
      if (!emp || !recordInScope(req.auth.grants.get('tasks:create')?.scopes ?? [], req.auth.principal, emp)) throw Forbidden('You can only assign tasks to people you manage', 'OUT_OF_SCOPE');
    }
    const startOn = patch.startOn !== undefined ? patch.startOn : k.startOn;
    const dueOn = patch.dueOn !== undefined ? patch.dueOn : k.dueOn;
    if (startOn && dueOn && dueOn < startOn) throw BadRequest('Due date is before the start date', [{ path: 'dueOn', message: 'Must be on or after the start date' }]);

    // status / progress
    let status = b.status ?? k.status;
    let progress = b.progress ?? k.progress;
    if (b.status && b.status !== k.status) {
      if (!ab.canManage) {
        if (k.status === 'DONE' || k.status === 'CANCELLED') throw Forbidden('Ask the person who assigned this task to reopen it', 'REOPEN_NEEDS_MANAGER');
        if (b.status === 'CANCELLED') throw Forbidden('Only the person who assigned this task can cancel it', 'NOT_TASK_MANAGER');
        if (b.status === 'DONE' && k.requiresReview) status = 'IN_REVIEW'; // needs sign-off
      }
      if (status === 'BLOCKED' && !(b.blockedReason ?? k.blockedReason)) throw BadRequest('Say what is blocking the task', [{ path: 'blockedReason', message: 'Required when blocked' }]);
    }
    if (status === 'DONE') progress = 100;
    if (b.progress !== undefined && b.status === undefined && progress === 100 && OPEN.includes(k.status)) status = k.requiresReview && !ab.canManage ? 'IN_REVIEW' : 'DONE';
    if (b.progress !== undefined && b.status === undefined && k.status === 'TODO' && progress > 0 && progress < 100) status = 'IN_PROGRESS';
    patch.status = status; patch.progress = progress;
    patch.completedAt = status === 'DONE' ? (k.completedAt ?? new Date()) : null;
    patch.blockedReason = status === 'BLOCKED' ? (b.blockedReason ?? k.blockedReason) : null;

    const before = { status: k.status, progress: k.progress, assigneeId: k.assigneeId, dueOn: k.dueOn, priority: k.priority };
    await k.update(patch, { transaction: t });
    if (before.status !== status) await logActivity(t, req, k, 'STATUS', { from: { status: before.status, progress: before.progress }, to: { status, progress }, body: b.note ?? (status === 'BLOCKED' ? patch.blockedReason : null) });
    else if (before.progress !== progress) await logActivity(t, req, k, 'PROGRESS', { from: { progress: before.progress }, to: { progress }, body: b.note ?? null });
    else if (b.note) await logActivity(t, req, k, 'COMMENT', { body: b.note });
    if (patch.assigneeId && patch.assigneeId !== before.assigneeId) {
      const emp = await loadEmployee(t, patch.assigneeId);
      await logActivity(t, req, k, 'ASSIGNED', { to: { assignee: name(emp) } });
      await notifyTaskPeople(t, req, k, { to: ['assignee'], title: `Task assigned to you: ${label(k)} ${k.title}`.slice(0, 200), body: k.dueOn ? `Due ${k.dueOn}` : null, email: true });
    }
    const edited = managerChange.filter((f) => f !== 'assigneeId');
    if (edited.length) await logActivity(t, req, k, 'EDITED', { body: `Changed ${edited.join(', ')}`, from: Object.fromEntries(edited.map((f) => [f, before[f] ?? null])), to: Object.fromEntries(edited.map((f) => [f, patch[f]])) });

    // notify the other side about meaningful changes
    if (before.status !== status) {
      if (status === 'IN_REVIEW') await notifyTaskPeople(t, req, k, { to: ['creator'], title: `Ready for review: ${label(k)} ${k.title}`.slice(0, 200), body: b.note ?? null, email: true });
      else if (status === 'DONE') await notifyTaskPeople(t, req, k, { to: ['creator', 'assignee'], title: `Completed: ${label(k)} ${k.title}`.slice(0, 200) });
      else if (status === 'BLOCKED') await notifyTaskPeople(t, req, k, { to: ['creator'], title: `Blocked: ${label(k)} ${k.title}`.slice(0, 200), body: patch.blockedReason, email: true });
      else if (before.status === 'IN_REVIEW' && status === 'IN_PROGRESS') await notifyTaskPeople(t, req, k, { to: ['assignee'], title: `Changes requested: ${label(k)} ${k.title}`.slice(0, 200), body: b.note ?? null, email: true });
      else if (status === 'CANCELLED') await notifyTaskPeople(t, req, k, { to: ['assignee'], title: `Cancelled: ${label(k)} ${k.title}`.slice(0, 200) });
    } else if (edited.includes('dueOn')) {
      await notifyTaskPeople(t, req, k, { to: ['assignee'], title: `New due date for ${label(k)}: ${patch.dueOn ?? 'none'}`, body: k.title });
    }
    return app.Task.findByPk(k.id, { include: include(), transaction: t });
  });
  return ok(res, presentTask(task, { overdue: OPEN.includes(task.status) && !!task.dueOn && task.dueOn < today(req) }));
}));

tasksRouter.post('/:id/comments', requirePermission('tasks:view'), validate({ ...idParam, body: z.object({ body: z.string().trim().min(1).max(5000) }).strict() }), asyncHandler(async (req, res) => {
  const a = await req.tx(async (t) => {
    const { k, ab } = await loadTask(req, t);
    if (!ab.canUpdate && !ab.canView) throw Forbidden();
    const row = await logActivity(t, req, k, 'COMMENT', { body: req.body.body });
    await notifyTaskPeople(t, req, k, { to: ['assignee', 'creator'], title: `${req.auth.user.fullName} commented on ${label(k)}`, body: req.body.body.slice(0, 200) });
    return row;
  });
  return created(res, { id: a.id, kind: a.kind, body: a.body, at: a.createdAt });
}));

tasksRouter.delete('/:id', requirePermission('tasks:delete'), validate(idParam), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { k, ab } = await loadTask(req, t);
    if (!ab.canDelete) throw Forbidden('Only the person who created this task or a manager can delete it');
    await k.update({ deletedAt: new Date() }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'task.delete', entityType: 'task', entityId: k.id, before: { title: k.title, number: k.number }, req });
  });
  return ok(res, { deleted: true });
}));

// ============================================================================ projects
export const projectsRouter = Router();
const projectBody = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2453d6'),
  status: z.enum(['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).default('ACTIVE'),
  leadEmployeeId: z.string().uuid().nullable().optional(),
  startsOn: DATE.nullable().optional(),
  endsOn: DATE.nullable().optional(),
}).strict();

projectsRouter.get('/', requirePermission('projects:view'), validate({ query: z.object({ status: z.string().max(60).optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const where = { deletedAt: null, ...(req.query.status && { status: req.query.status.split(',') }) };
    const rows = await app.Project.findAll({ where, include: [{ model: app.Employee, as: 'lead', attributes: ['id', 'firstName', 'lastName'] }], order: [['status', 'ASC'], ['name', 'ASC']], transaction: t });
    const counts = await app.Task.findAll({ where: { deletedAt: null, projectId: { [Op.ne]: null } }, attributes: ['projectId', 'status', [app.Task.sequelize.fn('count', '*'), 'n']], group: ['projectId', 'status'], raw: true, transaction: t });
    return rows.map((p) => {
      const c = counts.filter((x) => x.projectId === p.id);
      const total = c.reduce((s, x) => s + Number(x.n), 0);
      const done = c.filter((x) => x.status === 'DONE').reduce((s, x) => s + Number(x.n), 0);
      const cancelled = c.filter((x) => x.status === 'CANCELLED').reduce((s, x) => s + Number(x.n), 0);
      return { ...p.toJSON(), lead: p.lead ? { id: p.lead.id, name: name(p.lead) } : null, tasks: { total, done, open: total - done - cancelled, percent: total - cancelled > 0 ? Math.round((done / (total - cancelled)) * 100) : 0 } };
    });
  });
  return ok(res, out);
}));
projectsRouter.post('/', requirePermission('projects:create'), validate({ body: projectBody }), asyncHandler(async (req, res) => {
  const p = await req.tx(async (t) => {
    if (req.body.code && await app.Project.count({ where: { code: req.body.code, deletedAt: null }, transaction: t })) throw Conflict('A project with this code already exists', 'DUPLICATE', [{ path: 'code', message: 'Already used' }]);
    const row = await app.Project.create({ ...req.body, tenantId: req.auth.tenantId, createdBy: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'project.create', entityType: 'project', entityId: row.id, after: { name: row.name }, req });
    return row;
  });
  return created(res, p);
}));
projectsRouter.patch('/:id', requirePermission('projects:edit'), validate({ ...idParam, body: projectBody.partial().strict() }), asyncHandler(async (req, res) => {
  const p = await req.tx(async (t) => {
    const row = await app.Project.findOne({ where: { id: req.params.id, deletedAt: null }, transaction: t });
    if (!row) throw NotFound('Project');
    if (req.body.code && req.body.code !== row.code && await app.Project.count({ where: { code: req.body.code, deletedAt: null }, transaction: t })) throw Conflict('A project with this code already exists', 'DUPLICATE', [{ path: 'code', message: 'Already used' }]);
    await row.update(req.body, { transaction: t });
    return row;
  });
  return ok(res, p);
}));

// ============================================================================ daily work reports
export const workReportsRouter = Router();

function presentReport(r, extra = {}) {
  const j = r.toJSON ? r.toJSON() : r;
  return {
    id: j.id, date: j.reportDate, status: j.status, summary: j.summary, challenges: j.challenges, planNext: j.planNext, hours: Number(j.hours ?? 0),
    submittedAt: j.submittedAt, reviewedAt: j.reviewedAt, rating: j.rating, feedback: j.feedback,
    reviewer: j.reviewer ? { id: j.reviewer.id, name: j.reviewer.fullName } : null,
    employee: j.employee ? { id: j.employee.id, name: name(j.employee), employeeCode: j.employee.employeeCode } : { id: j.employeeId },
    items: (j.items ?? []).sort((a, b) => a.sortOrder - b.sortOrder).map((i) => ({
      id: i.id, description: i.description, hours: Number(i.hours), progress: i.progress, completed: i.completed,
      task: i.task ? { id: i.task.id, key: `T-${i.task.number}`, title: i.task.title, status: i.task.status, progress: i.task.progress } : null,
    })),
    ...extra,
  };
}
const reportInclude = () => [
  { model: app.Employee, as: 'employee', attributes: EMP },
  { model: app.User, as: 'reviewer', attributes: ['id', 'fullName'] },
  { model: app.WorkReportItem, as: 'items', include: [{ model: app.Task, as: 'task', attributes: ['id', 'number', 'title', 'status', 'progress'] }] },
];

/** My report for a date, plus what is needed to fill it in (open tasks, attendance). */
workReportsRouter.get('/mine', requirePermission('work_reports:create'), validate({ query: z.object({ date: DATE.optional() }).strict() }), asyncHandler(async (req, res) => {
  const emp = req.auth.principal.employeeId;
  if (!emp) throw BadRequest('Your login is not linked to an employee record');
  const date = req.query.date ?? today(req);
  const out = await req.tx(async (t) => {
    const r = await app.WorkReport.findOne({ where: { employeeId: emp, reportDate: date }, include: reportInclude(), transaction: t });
    const tasks = await app.Task.findAll({ where: { deletedAt: null, assigneeId: emp, [Op.or]: [{ status: OPEN }, { completedAt: { [Op.gte]: new Date(Date.now() - 2 * 86_400_000) } }] }, include: [{ model: app.Project, as: 'project', attributes: ['id', 'name', 'color'] }], order: [['dueOn', 'ASC NULLS LAST']], transaction: t });
    const att = await app.AttendanceRecord.findOne({ where: { employeeId: emp, workDate: date }, attributes: ['status', 'clockIn', 'clockOut', 'workedMinutes', 'lateMinutes'], transaction: t });
    const recent = await app.WorkReport.findAll({ where: { employeeId: emp, reportDate: { [Op.lt]: date } }, attributes: ['id', 'reportDate', 'status', 'rating', 'feedback', 'hours', 'reviewedAt'], order: [['reportDate', 'DESC']], limit: 10, transaction: t });
    return {
      date, report: r ? presentReport(r) : null, editable: !r || ['DRAFT', 'CHANGES_REQUESTED'].includes(r.status),
      tasks: tasks.map((k) => presentTask(k)), attendance: att,
      recent: recent.map((x) => ({ id: x.id, date: x.reportDate, status: x.status, rating: x.rating, feedback: x.feedback, hours: Number(x.hours) })),
    };
  });
  return ok(res, out);
}));

const itemBody = z.object({
  taskId: z.string().uuid().nullable().optional(),
  description: z.string().trim().min(1).max(2000),
  hours: z.coerce.number().min(0).max(24).default(0),
  progress: z.coerce.number().int().min(0).max(100).nullable().optional(),
  completed: z.boolean().default(false),
}).strict();
const reportBody = z.object({
  summary: z.string().trim().max(10_000).nullable().optional(),
  challenges: z.string().trim().max(5000).nullable().optional(),
  planNext: z.string().trim().max(5000).nullable().optional(),
  hours: z.coerce.number().min(0).max(24).optional(),
  items: z.array(itemBody).max(40).default([]),
  submit: z.boolean().default(false),
}).strict();

workReportsRouter.put('/mine/:date', requirePermission('work_reports:create'), validate({ params: z.object({ date: DATE }), body: reportBody }), asyncHandler(async (req, res) => {
  const emp = req.auth.principal.employeeId;
  if (!emp) throw BadRequest('Your login is not linked to an employee record');
  const { date } = req.params;
  const td = today(req);
  if (date > td) throw BadRequest('You cannot write a report for a future date');
  if (date < addDays(td, -14)) throw BadRequest('Reports can only be written for the last 14 days');
  const b = req.body;
  const itemHours = b.items.reduce((s, i) => s + i.hours, 0);
  const hours = b.items.length ? Math.round(itemHours * 100) / 100 : (b.hours ?? 0);
  if (hours > 24) throw BadRequest('Total hours cannot be more than 24', [{ path: 'hours', message: 'Too many hours' }]);
  if (b.submit && !b.items.length && !b.summary) throw BadRequest('Add the work you did before submitting', [{ path: 'summary', message: 'Describe what you completed, or add tasks' }]);

  const report = await req.tx(async (t) => {
    let r = await app.WorkReport.findOne({ where: { employeeId: emp, reportDate: date }, transaction: t });
    if (r && !['DRAFT', 'CHANGES_REQUESTED'].includes(r.status)) throw Conflict(r.status === 'APPROVED' ? 'This report has been approved and is locked' : 'This report is waiting for review. It can be changed if your manager asks for changes.', 'REPORT_LOCKED');
    const taskIds = b.items.map((i) => i.taskId).filter(Boolean);
    const tasks = taskIds.length ? await app.Task.findAll({ where: { id: taskIds, deletedAt: null }, transaction: t }) : [];
    for (const id of taskIds) {
      const k = tasks.find((x) => x.id === id);
      if (!k || k.assigneeId !== emp) throw BadRequest('You can only report on tasks assigned to you', [{ path: 'items', message: 'Unknown task' }]);
    }
    const fields = { summary: b.summary ?? null, challenges: b.challenges ?? null, planNext: b.planNext ?? null, hours };
    const wasResubmit = r?.status === 'CHANGES_REQUESTED';
    if (!r) r = await app.WorkReport.create({ tenantId: req.auth.tenantId, employeeId: emp, reportDate: date, status: 'DRAFT', ...fields }, { transaction: t });
    else await r.update(fields, { transaction: t });
    const oldTaskIds = (await app.WorkReportItem.findAll({ where: { reportId: r.id }, attributes: ['taskId'], raw: true, transaction: t })).map((x) => x.taskId);
    await app.WorkReportItem.destroy({ where: { reportId: r.id }, transaction: t });
    await app.WorkReportItem.bulkCreate(b.items.map((i, n) => ({ tenantId: req.auth.tenantId, reportId: r.id, taskId: i.taskId ?? null, description: i.description, hours: i.hours, progress: i.progress ?? null, completed: i.completed, sortOrder: n })), { transaction: t });

    if (b.submit) {
      await r.update({ status: 'SUBMITTED', submittedAt: new Date(), ...(wasResubmit ? {} : { rating: null, reviewerId: null, reviewedAt: null }) }, { transaction: t });
      // carry the day's progress into the tasks
      for (const i of b.items.filter((x) => x.taskId)) {
        const k = tasks.find((x) => x.id === i.taskId);
        if (!OPEN.includes(k.status)) continue;
        const before = { status: k.status, progress: k.progress };
        const progress = i.completed ? 100 : (i.progress ?? k.progress);
        let status = k.status;
        if (i.completed) status = k.requiresReview ? 'IN_REVIEW' : 'DONE';
        else if (k.status === 'TODO' && (progress > 0 || i.hours > 0)) status = 'IN_PROGRESS';
        await k.update({ progress, status, completedAt: status === 'DONE' ? new Date() : null }, { transaction: t });
        await logActivity(t, req, k, 'REPORT', { body: `${i.hours ? `${i.hours} h on ${date}: ` : `${date}: `}${i.description}`, from: before, to: { status, progress } });
        if (status !== before.status && (status === 'DONE' || status === 'IN_REVIEW')) {
          await notifyTaskPeople(t, req, k, { to: ['creator'], title: `${status === 'DONE' ? 'Completed' : 'Ready for review'}: ${label(k)} ${k.title}`.slice(0, 200), body: i.description.slice(0, 200), email: status === 'IN_REVIEW' });
        }
      }
      await recomputeLoggedHours(t, [...taskIds, ...oldTaskIds]);
      const employee = await loadEmployee(t, emp);
      const reviewers = (await reviewerUserIds(t, employee)).filter((u) => u !== req.auth.userId);
      await notifyUsers(t, reviewers, { type: 'work_report', title: `${wasResubmit ? 'Updated daily report' : 'Daily report'} from ${name(employee)} (${date})`, body: (b.summary || b.items.map((i) => i.description).join('; ')).slice(0, 200), link: `/work-reports/${r.id}` });
    }
    return app.WorkReport.findByPk(r.id, { include: reportInclude(), transaction: t });
  });
  return ok(res, presentReport(report));
}));

/** Team reports (drafts are private to their author). */
workReportsRouter.get('/', requirePermission('work_reports:view'), validate({
  query: z.object({
    from: DATE.optional(), to: DATE.optional(), status: z.enum(['SUBMITTED', 'CHANGES_REQUESTED', 'APPROVED', 'ALL']).default('ALL'),
    employeeId: z.string().uuid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }).strict(),
}), asyncHandler(async (req, res) => {
  const q = req.query;
  const td = today(req);
  const out = await req.tx(async (t) => {
    const ids = await employeeIdsInScope(t, req.scopes, req.auth.principal);
    const where = {
      reportDate: { [Op.between]: [q.from ?? addDays(td, -30), q.to ?? td] },
      [Op.or]: [{ status: { [Op.ne]: 'DRAFT' } }, { employeeId: req.auth.principal.employeeId ?? null }],
      ...(q.status !== 'ALL' && { status: q.status }),
      ...(ids !== null && { employeeId: ids }),
      ...(q.employeeId && { employeeId: ids === null || ids.includes(q.employeeId) ? q.employeeId : null }),
    };
    const { rows, count } = await app.WorkReport.findAndCountAll({ where, include: reportInclude(), order: [['reportDate', 'DESC'], ['submittedAt', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, distinct: true, transaction: t });
    return { rows: rows.map((r) => presentReport(r)), count };
  });
  return ok(res, out.rows, pageMeta(q, out.count));
}));

/** People in my scope who were at work on a day but have not submitted a report. */
workReportsRouter.get('/missing', requirePermission('work_reports:approve'), validate({ query: z.object({ date: DATE.optional() }).strict() }), asyncHandler(async (req, res) => {
  const date = req.query.date ?? today(req);
  const out = await req.tx(async (t) => {
    const ids = await employeeIdsInScope(t, wideScopes(req.scopes), req.auth.principal);
    const present = await app.AttendanceRecord.findAll({ where: { workDate: date, status: ['PRESENT', 'LATE', 'HALF_DAY'], ...(ids !== null && { employeeId: ids }) }, attributes: ['employeeId', 'clockIn'], transaction: t });
    const submitted = new Set((await app.WorkReport.findAll({ where: { reportDate: date, status: { [Op.ne]: 'DRAFT' } }, attributes: ['employeeId'], transaction: t })).map((r) => r.employeeId));
    const missing = present.filter((p) => !submitted.has(p.employeeId) && p.employeeId !== req.auth.principal.employeeId);
    const emps = missing.length ? await app.Employee.findAll({ where: { id: missing.map((m) => m.employeeId) }, attributes: ['id', 'firstName', 'lastName', 'employeeCode'], transaction: t }) : [];
    return { date, employees: emps.map((e) => ({ id: e.id, name: name(e), employeeCode: e.employeeCode })) };
  });
  return ok(res, out);
}));

async function loadReport(req, t) {
  const r = await app.WorkReport.findByPk(req.params.id, { include: reportInclude(), transaction: t });
  if (!r) throw NotFound('Report');
  const own = r.employeeId === req.auth.principal.employeeId;
  const viewScopes = req.auth.grants.get('work_reports:view')?.scopes ?? [];
  if (!own && (r.status === 'DRAFT' || !recordInScope(viewScopes, req.auth.principal, r.employee))) throw NotFound('Report');
  const canReview = !own && r.status !== 'DRAFT' && recordInScope(wideScopes(req.auth.grants.get('work_reports:approve')?.scopes ?? []), req.auth.principal, r.employee);
  return { r, own, canReview };
}

workReportsRouter.get('/:id', requirePermission('work_reports:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { r, own, canReview } = await loadReport(req, t);
    const att = await app.AttendanceRecord.findOne({ where: { employeeId: r.employeeId, workDate: r.reportDate }, attributes: ['status', 'clockIn', 'clockOut', 'workedMinutes', 'lateMinutes'], transaction: t });
    const openTasks = await app.Task.count({ where: { assigneeId: r.employeeId, deletedAt: null, status: OPEN }, transaction: t });
    const overdue = await app.Task.count({ where: { assigneeId: r.employeeId, deletedAt: null, status: OPEN, dueOn: { [Op.lt]: today(req) } }, transaction: t });
    return presentReport(r, { attendance: att, own, canReview, context: { openTasks, overdue } });
  });
  return ok(res, out);
}));

workReportsRouter.post('/:id/review', requirePermission('work_reports:approve'), validate({
  ...idParam,
  body: z.object({ decision: z.enum(['APPROVE', 'REQUEST_CHANGES']), rating: z.coerce.number().int().min(1).max(5).optional(), feedback: z.string().trim().max(5000).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const b = req.body;
  if (b.decision === 'REQUEST_CHANGES' && !b.feedback) throw BadRequest('Say what needs to change', [{ path: 'feedback', message: 'Required when asking for changes' }]);
  if (b.decision === 'APPROVE' && !b.rating) throw BadRequest('Give a rating from 1 to 5', [{ path: 'rating', message: 'Required' }]);
  const report = await req.tx(async (t) => {
    const { r, canReview } = await loadReport(req, t);
    if (!canReview) throw Forbidden('You cannot review this report');
    if (!['SUBMITTED', 'APPROVED'].includes(r.status)) throw Conflict('This report is not waiting for review', 'NOT_SUBMITTED');
    await r.update({ status: b.decision === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', rating: b.decision === 'APPROVE' ? b.rating : r.rating, feedback: b.feedback ?? null, reviewerId: req.auth.userId, reviewedAt: new Date() }, { transaction: t });
    const uid = (await app.User.findOne({ where: { employeeId: r.employeeId }, attributes: ['id'], transaction: t }))?.id;
    if (uid) {
      await notifyUsers(t, [uid], b.decision === 'APPROVE'
        ? { type: 'work_report', title: `Your report for ${r.reportDate} was reviewed: ${'★'.repeat(b.rating)}${'☆'.repeat(5 - b.rating)}`, body: b.feedback ?? null, link: `/work-reports/${r.id}`, email: !!b.feedback }
        : { type: 'work_report', title: `Changes requested on your report for ${r.reportDate}`, body: b.feedback, link: `/my-work/report?date=${r.reportDate}`, email: true });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'work_report.review', entityType: 'work_report', entityId: r.id, after: { decision: b.decision, rating: b.rating ?? null }, req });
    return app.WorkReport.findByPk(r.id, { include: reportInclude(), transaction: t });
  });
  return ok(res, presentReport(report));
}));

// ============================================================================ performance
export const performanceRouter = Router();
const range = z.object({ from: DATE.optional(), to: DATE.optional(), departmentId: z.string().uuid().optional(), branchId: z.string().uuid().optional() }).strict();

performanceRouter.get('/', requirePermission('work_reports:view'), validate({ query: range }), asyncHandler(async (req, res) => {
  const td = today(req);
  const from = req.query.from ?? addDays(td, -29);
  const to = req.query.to ?? td;
  const out = await req.tx(async (t) => {
    let ids = await employeeIdsInScope(t, req.scopes, req.auth.principal);
    if (req.query.departmentId || req.query.branchId) {
      const filtered = await app.Employee.findAll({ where: { deletedAt: null, ...(req.query.departmentId && { departmentId: req.query.departmentId }), ...(req.query.branchId && { branchId: req.query.branchId }), ...(ids !== null && { id: ids }) }, attributes: ['id'], raw: true, transaction: t });
      ids = filtered.map((e) => e.id);
    }
    const rows = await performance(t, { ids, from, to, tz: req.auth.ctx.tenant.timezone, today: td });
    const scored = rows.filter((r) => r.score != null);
    return {
      from, to, rows,
      totals: {
        employees: rows.length,
        avgScore: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null,
        completed: rows.reduce((s, r) => s + r.tasks.completed, 0),
        overdue: rows.reduce((s, r) => s + r.tasks.overdue, 0),
        reportsSubmitted: rows.reduce((s, r) => s + r.reports.submitted, 0),
        awaitingReview: rows.reduce((s, r) => s + r.reports.awaitingReview, 0),
      },
    };
  });
  return ok(res, out);
}));

/** One employee: indicators, weekly trend and recent feedback. Own record always allowed. */
performanceRouter.get('/employees/:id', validate({ ...idParam, query: range.pick({ from: true, to: true }) }), asyncHandler(async (req, res) => {
  const td = today(req);
  const from = req.query.from ?? addDays(td, -29);
  const to = req.query.to ?? td;
  const out = await req.tx(async (t) => {
    const emp = await loadEmployee(t, req.params.id);
    if (!emp) throw NotFound('Employee');
    const own = emp.id === req.auth.principal.employeeId;
    if (!own && !recordInScope(req.auth.grants.get('work_reports:view')?.scopes ?? [], req.auth.principal, emp)) throw NotFound('Employee');
    const tz = req.auth.ctx.tenant.timezone;
    const [row] = await performance(t, { ids: [emp.id], from, to, tz, today: td });
    const trend = await weeklyTrend(t, emp.id, { weeks: 8, today: td, tz });
    const feedback = await app.WorkReport.findAll({ where: { employeeId: emp.id, reviewedAt: { [Op.ne]: null } }, include: [{ model: app.User, as: 'reviewer', attributes: ['id', 'fullName'] }], order: [['reviewedAt', 'DESC']], limit: 8, transaction: t });
    return { from, to, ...(row ?? {}), trend, feedback: feedback.map((f) => ({ id: f.id, date: f.reportDate, status: f.status, rating: f.rating, feedback: f.feedback, reviewer: f.reviewer?.fullName ?? null, at: f.reviewedAt })) };
  });
  return ok(res, out);
}));
