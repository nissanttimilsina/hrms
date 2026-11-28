import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { EMP_ATTRS, empRef, empName, holds, myEmployeeId, employeeIdsIn, nextNumber, userNames, toCsv, optText } from '../../services/module-kit.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * Custom request workflows. Admins design request forms (work from home, purchase, travel, equipment…) with their
 * own fields and an approval chain of one or more steps. Each step is decided by the requester's manager, their
 * manager's manager, everyone holding a role, or a named person. Employees submit requests and follow them; approvers
 * decide from one inbox. A request keeps a copy of the form and chain as they were when it was submitted.
 *   workflows:configure (design forms) · requests:view/create (own and in scope) · requests:export
 */
export const workflowsRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const FIELD_TYPES = ['TEXT', 'TEXTAREA', 'NUMBER', 'AMOUNT', 'DATE', 'SELECT', 'CHECKBOX'];
const APPROVERS = ['MANAGER', 'MANAGERS_MANAGER', 'ROLE', 'USER'];
const canConfigure = (req) => holds(req, 'workflows:configure');

export const WORKFLOW_TEMPLATES = [
  { name: 'Work from home', icon: 'Home', description: 'Ask to work from home for one or more days.', fields: [
    { key: 'from', label: 'From', type: 'DATE', required: true }, { key: 'to', label: 'To', type: 'DATE', required: true },
    { key: 'reason', label: 'Reason', type: 'TEXTAREA', required: true }, { key: 'reachable', label: 'I will be reachable by phone during office hours', type: 'CHECKBOX', required: true },
  ], steps: [{ name: 'Manager approval', approver: 'MANAGER' }] },
  { name: 'Purchase request', icon: 'ShoppingCart', description: 'Ask to buy something for work before spending.', fields: [
    { key: 'item', label: 'What do you need?', type: 'TEXT', required: true }, { key: 'quantity', label: 'Quantity', type: 'NUMBER', required: true },
    { key: 'amount', label: 'Estimated cost (NPR)', type: 'AMOUNT', required: true }, { key: 'vendor', label: 'Preferred vendor', type: 'TEXT', required: false },
    { key: 'why', label: 'Why is it needed?', type: 'TEXTAREA', required: true },
  ], steps: [{ name: 'Manager approval', approver: 'MANAGER' }, { name: 'Finance approval', approver: 'ROLE', roleKey: 'accountant' }] },
  { name: 'Travel request', icon: 'Plane', description: 'Get approval for official travel before booking.', fields: [
    { key: 'destination', label: 'Destination', type: 'TEXT', required: true }, { key: 'from', label: 'Leaving on', type: 'DATE', required: true },
    { key: 'to', label: 'Returning on', type: 'DATE', required: true }, { key: 'mode', label: 'Travel by', type: 'SELECT', options: ['Bus', 'Air', 'Company vehicle', 'Own vehicle'], required: true },
    { key: 'advance', label: 'Advance needed (NPR)', type: 'AMOUNT', required: false }, { key: 'purpose', label: 'Purpose', type: 'TEXTAREA', required: true },
  ], steps: [{ name: 'Manager approval', approver: 'MANAGER' }, { name: 'HR approval', approver: 'ROLE', roleKey: 'hr_manager' }] },
  { name: 'Overtime pre-approval', icon: 'Clock', description: 'Agree overtime with your manager before you work it.', fields: [
    { key: 'date', label: 'Date', type: 'DATE', required: true }, { key: 'hours', label: 'Hours', type: 'NUMBER', required: true },
    { key: 'work', label: 'Work to be done', type: 'TEXTAREA', required: true },
  ], steps: [{ name: 'Manager approval', approver: 'MANAGER' }] },
];

// =========================================================================== definitions
const field = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,29}$/, 'Use lowercase letters, numbers or _'), label: z.string().trim().min(2).max(120),
  type: z.enum(FIELD_TYPES), required: z.boolean().default(false), options: z.array(z.string().trim().min(1).max(80)).max(20).optional(), hint: optText(z, 200),
}).strict().refine((f) => f.type !== 'SELECT' || (f.options?.length ?? 0) >= 2, { message: 'A list needs at least two options', path: ['options'] });
const step = z.object({
  name: z.string().trim().min(2).max(80), approver: z.enum(APPROVERS), roleKey: z.string().max(60).optional(), userId: z.string().uuid().optional(),
}).strict().refine((s) => s.approver !== 'ROLE' || !!s.roleKey, { message: 'Choose the role', path: ['roleKey'] })
  .refine((s) => s.approver !== 'USER' || !!s.userId, { message: 'Choose the person', path: ['userId'] });
const defBody = z.object({
  name: z.string().trim().min(3).max(80), description: optText(z, 500), icon: z.string().max(30).default('FileText'),
  fields: z.array(field).min(1, 'Add at least one field').max(30).refine((f) => new Set(f.map((x) => x.key)).size === f.length, 'Each field needs its own key'),
  steps: z.array(step).min(1, 'Add at least one approval step').max(6), active: z.boolean().default(true),
}).strict();

const defView = (d, extra = {}) => ({ id: d.id, name: d.name, description: d.description, icon: d.icon, fields: d.fields, steps: d.steps, active: d.active, updatedAt: d.updatedAt, ...extra });

workflowsRouter.get('/templates', requirePermission('workflows:configure'), asyncHandler(async (req, res) => ok(res, WORKFLOW_TEMPLATES)));

workflowsRouter.get('/roles', requirePermission('workflows:configure'), asyncHandler(async (req, res) => {
  const roles = await req.tx((t) => app.Role.findAll({ attributes: ['key', 'name'], order: [['name', 'ASC']], transaction: t }));
  return ok(res, roles.map((r) => ({ key: r.key, name: r.name })));
}));

workflowsRouter.get('/definitions', requirePermission('requests:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const rows = await app.WorkflowDefinition.findAll({ where: canConfigure(req) ? {} : { active: true }, order: [['active', 'DESC'], ['name', 'ASC']], transaction: t });
    const used = canConfigure(req) ? await app.WorkflowRequest.findAll({ attributes: ['definitionId', [app.WorkflowRequest.sequelize.fn('count', '*'), 'n']], group: ['definitionId'], raw: true, transaction: t }) : [];
    const roles = await app.Role.findAll({ attributes: ['key', 'name'], raw: true, transaction: t });
    const names = canConfigure(req) ? await userNames(t, rows.flatMap((d) => d.steps.map((s) => s.userId))) : {};
    return rows.map((d) => defView(d, {
      requests: Number(used.find((u) => u.definitionId === d.id)?.n ?? 0),
      steps: d.steps.map((s) => ({ ...s, label: s.approver === 'MANAGER' ? 'Their manager' : s.approver === 'MANAGERS_MANAGER' ? "Their manager's manager" : s.approver === 'ROLE' ? `Anyone with the ${roles.find((r) => r.key === s.roleKey)?.name ?? s.roleKey} role` : names[s.userId] ?? 'A named person' })),
    }));
  });
  return ok(res, out);
}));

async function checkDefinition(t, b) {
  for (const s of b.steps) {
    if (s.approver === 'ROLE' && !(await app.Role.count({ where: { key: s.roleKey }, transaction: t }))) throw BadRequest(`The role "${s.roleKey}" does not exist`, [{ path: 'steps', message: 'Unknown role' }]);
    if (s.approver === 'USER' && !(await app.User.count({ where: { id: s.userId, status: 'ACTIVE' }, transaction: t }))) throw BadRequest('Choose a person with an active login for each named step', [{ path: 'steps', message: 'Unknown person' }]);
  }
}

workflowsRouter.post('/definitions', requirePermission('workflows:configure'), validate({ body: defBody }), asyncHandler(async (req, res) => {
  const d = await req.tx(async (t) => {
    await checkDefinition(t, req.body);
    const row = await app.WorkflowDefinition.create({ ...req.body, tenantId: req.auth.tenantId, createdBy: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'workflow.create', entityType: 'workflow_definition', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, defView(d));
}));

workflowsRouter.put('/definitions/:id', requirePermission('workflows:configure'), validate({ ...idParam, body: defBody }), asyncHandler(async (req, res) => {
  const d = await req.tx(async (t) => {
    const row = await app.WorkflowDefinition.findByPk(req.params.id, { transaction: t });
    if (!row) throw NotFound('Request type');
    await checkDefinition(t, req.body);
    const before = row.toJSON();
    await row.update(req.body, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'workflow.update', entityType: 'workflow_definition', entityId: row.id, before: { fields: before.fields, steps: before.steps, active: before.active }, after: req.body, req });
    return row;
  });
  return ok(res, defView(d));
}));

// =========================================================================== resolving approvers
async function usersWithRole(t, roleKey) {
  const role = await app.Role.findOne({ where: { key: roleKey }, transaction: t });
  if (!role) return [];
  const rows = await app.UserRole.findAll({ where: { roleId: role.id }, attributes: ['userId'], raw: true, transaction: t });
  const active = await app.User.findAll({ where: { id: rows.map((r) => r.userId), status: 'ACTIVE' }, attributes: ['id'], transaction: t });
  return active.map((u) => u.id);
}

async function resolveStep(t, s, emp, requesterId) {
  let ids = [];
  if (s.approver === 'MANAGER' && emp.managerId) ids = [await userIdForEmployee(t, emp.managerId)];
  if (s.approver === 'MANAGERS_MANAGER' && emp.managerId) {
    const m = await app.Employee.findByPk(emp.managerId, { attributes: ['managerId'], transaction: t });
    if (m?.managerId) ids = [await userIdForEmployee(t, m.managerId)];
  }
  if (s.approver === 'ROLE') ids = await usersWithRole(t, s.roleKey);
  if (s.approver === 'USER') ids = (await app.User.count({ where: { id: s.userId, status: 'ACTIVE' }, transaction: t })) ? [s.userId] : [];
  ids = [...new Set(ids.filter((u) => u && u !== requesterId))];
  // Nobody can decide this step (no manager, empty role, the requester themself): the form's administrators decide it.
  let fallback = false;
  if (!ids.length) { ids = (await usersWithPermission(t, 'workflows:configure')).filter((u) => u !== requesterId); fallback = true; }
  return { ids, fallback };
}

function validateData(fields, data) {
  const out = {};
  for (const f of fields) {
    let v = data[f.key];
    const empty = v == null || v === '' || (f.type === 'CHECKBOX' && v === false);
    if (empty) { if (f.required) throw BadRequest(`Fill in: ${f.label}`, [{ path: f.key, message: 'Required' }]); continue; }
    if (['NUMBER', 'AMOUNT'].includes(f.type)) { v = Number(v); if (!Number.isFinite(v) || v < 0 || v > 1e10) throw BadRequest(`${f.label} must be a number`, [{ path: f.key, message: 'Invalid number' }]); }
    if (f.type === 'DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw BadRequest(`${f.label} must be a date`, [{ path: f.key, message: 'Invalid date' }]);
    if (f.type === 'SELECT' && !f.options.includes(v)) throw BadRequest(`Choose an option for ${f.label}`, [{ path: f.key, message: 'Invalid option' }]);
    if (f.type === 'CHECKBOX') v = v === true || v === 'true';
    if (['TEXT', 'TEXTAREA'].includes(f.type)) { v = String(v).trim(); if (v.length > (f.type === 'TEXT' ? 300 : 3000)) throw BadRequest(`${f.label} is too long`, [{ path: f.key, message: 'Too long' }]); }
    out[f.key] = v;
  }
  // Common sense check for date ranges named from/to.
  if (out.from && out.to && out.to < out.from) throw BadRequest('The end date is before the start date', [{ path: 'to', message: 'Before the start' }]);
  return out;
}

// =========================================================================== requests
function reqView(r, names = {}, extra = {}) {
  const steps = (r.steps ?? []).sort((a, b) => a.stepIndex - b.stepIndex);
  return {
    id: r.id, key: `REQ-${r.number}`, number: r.number, definitionId: r.definitionId, name: r.snapshot.name, icon: r.snapshot.icon, fields: r.snapshot.fields, data: r.data,
    status: r.status, currentStep: r.currentStep, employee: r.employee ? empRef(r.employee) : undefined, createdAt: r.createdAt, decidedAt: r.decidedAt,
    steps: steps.map((s) => ({ index: s.stepIndex, name: s.name, status: s.status, approvers: s.approverIds.map((u) => names[u] ?? 'Former user'), decidedBy: names[s.decidedBy] ?? null, decidedAt: s.decidedAt, note: s.note })),
    ...extra,
  };
}

workflowsRouter.post('/requests', requirePermission('requests:create'), validate({ body: z.object({ definitionId: z.string().uuid(), data: z.record(z.string().max(30), z.union([z.string().max(3000), z.number(), z.boolean(), z.null()])) }).strict() }), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const out = await req.tx(async (t) => {
    const d = await app.WorkflowDefinition.findByPk(req.body.definitionId, { transaction: t });
    if (!d || !d.active) throw NotFound('Request type');
    const data = validateData(d.fields, req.body.data);
    const emp = await app.Employee.findByPk(employeeId, { attributes: EMP_ATTRS, transaction: t });
    const r = await app.WorkflowRequest.create({
      tenantId: req.auth.tenantId, number: await nextNumber(t, 'workflow_requests'), definitionId: d.id, snapshot: { name: d.name, icon: d.icon, fields: d.fields, steps: d.steps },
      employeeId, requesterId: req.auth.userId, data, status: 'PENDING', currentStep: 0,
    }, { transaction: t });
    for (const [i, s] of d.steps.entries()) {
      const { ids, fallback } = i === 0 ? await resolveStep(t, s, emp, req.auth.userId) : { ids: [], fallback: false };
      await app.WorkflowRequestStep.create({ tenantId: req.auth.tenantId, requestId: r.id, stepIndex: i, name: s.name, approverIds: ids, status: i === 0 ? 'PENDING' : 'WAITING', note: fallback ? 'Sent to the form administrators: no approver was found for this step.' : null }, { transaction: t });
      if (i === 0) await notifyUsers(t, ids, { type: 'request.approve', title: `${d.name} from ${empName(emp)}`, body: `REQ-${r.number} needs your approval (${s.name}).`, link: `/requests/${r.id}`, email: true });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'request.submit', entityType: 'workflow_request', entityId: r.id, after: { type: d.name, data }, req });
    return { id: r.id, key: `REQ-${r.number}` };
  });
  return created(res, out);
}));

const listQ = z.object({
  view: z.enum(['mine', 'approvals', 'decided', 'all']).default('mine'), status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
  definitionId: z.string().uuid().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

workflowsRouter.get('/requests', requirePermission('requests:view'), validate({ query: listQ }), asyncHandler(async (req, res) => {
  const q = req.query;
  const out = await req.tx(async (t) => {
    const and = [];
    if (q.view === 'mine') and.push({ requesterId: req.auth.userId });
    if (q.view === 'approvals' || q.view === 'decided') {
      const steps = await app.WorkflowRequestStep.findAll({
        where: q.view === 'approvals' ? { status: 'PENDING', approverIds: { [Op.contains]: [req.auth.userId] } } : { decidedBy: req.auth.userId },
        attributes: ['requestId'], raw: true, transaction: t,
      });
      and.push({ id: steps.map((s) => s.requestId) });
      if (q.view === 'approvals') and.push({ status: 'PENDING' });
    }
    if (q.view === 'all') {
      if (!canConfigure(req)) { const ids = await employeeIdsIn(t, req, req.scopes.filter((s) => s.scope !== 'OWN')); if (ids) and.push({ employeeId: ids.length ? ids : [] }); }
    }
    if (q.status) and.push({ status: q.status });
    if (q.definitionId) and.push({ definitionId: q.definitionId });
    const { rows, count } = await app.WorkflowRequest.findAndCountAll({
      where: { [Op.and]: and }, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }, { model: app.WorkflowRequestStep, as: 'steps' }],
      order: [['createdAt', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, distinct: true, transaction: t,
    });
    const names = await userNames(t, rows.flatMap((r) => r.steps.flatMap((s) => [...s.approverIds, s.decidedBy])));
    return { rows: rows.map((r) => reqView(r, names)), count };
  });
  return ok(res, out.rows, { page: q.page, pageSize: q.pageSize, total: out.count, totalPages: Math.ceil(out.count / q.pageSize) });
}));

async function loadRequest(req, t, id, { lock = false } = {}) {
  const r = await app.WorkflowRequest.findByPk(id, { transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!r) throw NotFound('Request');
  r.steps = await app.WorkflowRequestStep.findAll({ where: { requestId: r.id }, order: [['stepIndex', 'ASC']], transaction: t });
  r.employee = await app.Employee.findByPk(r.employeeId, { attributes: EMP_ATTRS, transaction: t });
  const own = r.requesterId === req.auth.userId;
  const approver = r.steps.some((s) => s.approverIds.includes(req.auth.userId) || s.decidedBy === req.auth.userId);
  const inScope = (await employeeIdsIn(t, req, req.scopes.filter((s) => s.scope !== 'OWN')));
  if (!own && !approver && !canConfigure(req) && !(inScope === null || inScope.includes(r.employeeId))) throw NotFound('Request');
  return { r, own };
}

workflowsRouter.get('/requests/:id', requirePermission('requests:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { r, own } = await loadRequest(req, t, req.params.id);
    const names = await userNames(t, r.steps.flatMap((s) => [...s.approverIds, s.decidedBy]));
    const cur = r.steps.find((s) => s.stepIndex === r.currentStep);
    return reqView(r, names, { abilities: { decide: r.status === 'PENDING' && !!cur && cur.status === 'PENDING' && cur.approverIds.includes(req.auth.userId) && !own, cancel: own && r.status === 'PENDING' } });
  });
  return ok(res, out);
}));

workflowsRouter.post('/requests/:id/decide', requirePermission('requests:view'), validate({ ...idParam, body: z.object({ approve: z.boolean(), note: optText(z, 1000) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const { r, own } = await loadRequest(req, t, req.params.id, { lock: true });
    const cur = r.steps.find((s) => s.stepIndex === r.currentStep);
    if (r.status !== 'PENDING' || !cur || cur.status !== 'PENDING') throw Conflict('This request is already decided.', 'DECIDED');
    if (own || !cur.approverIds.includes(req.auth.userId)) throw Forbidden('This step is not yours to decide.', 'NOT_APPROVER');
    if (!req.body.approve && !req.body.note) throw BadRequest('Say why you are rejecting it', [{ path: 'note', message: 'Give a reason' }]);
    await cur.update({ status: req.body.approve ? 'APPROVED' : 'REJECTED', decidedBy: req.auth.userId, decidedAt: new Date(), note: req.body.note ?? cur.note }, { transaction: t });
    const name = r.snapshot.name;
    if (!req.body.approve) {
      await r.update({ status: 'REJECTED', decidedAt: new Date() }, { transaction: t });
      await app.WorkflowRequestStep.update({ status: 'SKIPPED' }, { where: { requestId: r.id, status: 'WAITING' }, transaction: t });
      await notifyUsers(t, [r.requesterId], { type: 'request.rejected', title: `${name} REQ-${r.number} was not approved`, body: req.body.note, link: `/requests/${r.id}`, email: true });
    } else {
      const next = r.steps.find((s) => s.stepIndex === r.currentStep + 1);
      if (!next) {
        await r.update({ status: 'APPROVED', decidedAt: new Date() }, { transaction: t });
        await notifyUsers(t, [r.requesterId], { type: 'request.approved', title: `${name} REQ-${r.number} is approved`, body: req.body.note, link: `/requests/${r.id}`, email: true });
      } else {
        const def = r.snapshot.steps[next.stepIndex];
        const { ids, fallback } = await resolveStep(t, def, r.employee, r.requesterId);
        await next.update({ status: 'PENDING', approverIds: ids, ...(fallback && { note: 'Sent to the form administrators: no approver was found for this step.' }) }, { transaction: t });
        await r.update({ currentStep: next.stepIndex }, { transaction: t });
        await notifyUsers(t, ids, { type: 'request.approve', title: `${name} from ${empName(r.employee)}`, body: `REQ-${r.number} needs your approval (${next.name}).`, link: `/requests/${r.id}`, email: true });
        await notifyUsers(t, [r.requesterId], { type: 'request.progress', title: `${name} REQ-${r.number}: ${cur.name} approved`, body: `Now with: ${next.name}.`, link: `/requests/${r.id}` });
      }
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: req.body.approve ? 'request.approve' : 'request.reject', entityType: 'workflow_request', entityId: r.id, after: { step: cur.name, note: req.body.note }, req });
    return { status: r.status, currentStep: r.currentStep };
  });
  return ok(res, out);
}));

workflowsRouter.post('/requests/:id/cancel', requirePermission('requests:view'), validate(idParam), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const { r, own } = await loadRequest(req, t, req.params.id, { lock: true });
    if (!own) throw Forbidden('Only the person who made the request can cancel it.');
    if (r.status !== 'PENDING') throw Conflict('This request is already decided.');
    await r.update({ status: 'CANCELLED', decidedAt: new Date() }, { transaction: t });
    await app.WorkflowRequestStep.update({ status: 'SKIPPED' }, { where: { requestId: r.id, status: ['PENDING', 'WAITING'] }, transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'request.cancel', entityType: 'workflow_request', entityId: r.id, req });
  });
  return ok(res, { status: 'CANCELLED' });
}));

workflowsRouter.get('/requests-export', requirePermission('requests:export'), validate({ query: z.object({ definitionId: z.string().uuid(), from: z.string().date(), to: z.string().date() }).strict() }), asyncHandler(async (req, res) => {
  const { d, rows } = await req.tx(async (t) => {
    const def = await app.WorkflowDefinition.findByPk(req.query.definitionId, { transaction: t });
    if (!def) throw NotFound('Request type');
    const ids = await employeeIdsIn(t, req, req.scopes);
    const list = await app.WorkflowRequest.findAll({ where: { definitionId: def.id, createdAt: { [Op.between]: [new Date(`${req.query.from}T00:00:00+05:45`), new Date(`${req.query.to}T23:59:59+05:45`)] }, ...(ids && { employeeId: ids }) }, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }], order: [['number', 'ASC']], transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'request.export', entityType: 'workflow_definition', entityId: def.id, after: { ...req.query, count: list.length }, req });
    return { d: def, rows: list };
  });
  const header = ['Request', 'Submitted', 'Employee ID', 'Employee', 'Status', ...d.fields.map((f) => f.label)];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${d.name.replace(/[^\w-]+/g, '-').toLowerCase()}-requests.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(toCsv(header, rows.map((r) => [`REQ-${r.number}`, new Date(r.createdAt).toISOString().slice(0, 10), r.employee.employeeCode, empName(r.employee), r.status.toLowerCase(), ...d.fields.map((f) => (typeof r.data[f.key] === 'boolean' ? (r.data[f.key] ? 'yes' : 'no') : r.data[f.key] ?? ''))])));
}));
