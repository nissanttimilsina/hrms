import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { recordInScope } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, fiscalYear, fiscalYearRange, eachDate, weekday, toBS, fromBS, addDays } from '../../services/hr/calendar.js';
import { getPolicy, scheduleFor, scopedEmployeeIds } from '../../services/hr/attendance.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * Default leave types based on Nepal Labour Act 2074 (editable per company):
 * home leave 1 day / 20 worked (~18/yr, cap 90), sick 12/yr (cap 45), maternity 98 days (60 paid),
 * paternity 15, mourning 13. Companies should confirm against current law and their own policy.
 */
export const DEFAULT_LEAVE_TYPES = [
  { code: 'HOME', name: 'Home leave', annualQuota: 18, accrual: 'MONTHLY', carryForwardMax: 90, encashable: true, approvalLevels: 1 },
  { code: 'SICK', name: 'Sick leave', annualQuota: 12, accrual: 'YEARLY', carryForwardMax: 45, encashable: true, minNoticeDays: 0 },
  { code: 'MATERNITY', name: 'Maternity leave (paid)', annualQuota: 60, accrual: 'YEARLY', appliesToGender: 'FEMALE', allowHalfDay: false, approvalLevels: 2 },
  { code: 'MATERNITY_EXT', name: 'Maternity leave (unpaid extension)', annualQuota: 38, accrual: 'YEARLY', isPaid: false, appliesToGender: 'FEMALE', allowHalfDay: false, approvalLevels: 2 },
  { code: 'PATERNITY', name: 'Paternity leave', annualQuota: 15, accrual: 'YEARLY', appliesToGender: 'MALE', allowHalfDay: false },
  { code: 'MOURNING', name: 'Mourning leave', annualQuota: 13, accrual: 'YEARLY', allowHalfDay: false },
  { code: 'UNPAID', name: 'Unpaid leave', annualQuota: 0, accrual: 'NONE', isPaid: false, allowNegative: true, approvalLevels: 2 },
];

export const leaveRouter = Router();
const DATE = z.string().date();
const idParam = { params: z.object({ id: z.string().uuid() }) };
const sum = (rows) => Math.round(rows.reduce((n, r) => n + Number(r.days), 0) * 10) / 10;
const half = (n) => Math.round(n * 2) / 2;

// --------------------------------------------------------------------------- balance engine
/** Make sure allocations, monthly accruals and carry-forward exist for this year (idempotent). */
async function syncEntitlements(t, emp, type, year, today) {
  if (type.accrual === 'NONE') return;
  const { start, end } = fiscalYearRange(year);
  if (emp.joinedOn > end) return;
  const tx = await app.LeaveTransaction.findAll({ where: { employeeId: emp.id, leaveTypeId: type.id, leaveYear: year }, transaction: t });
  const add = (kind, days, note) => app.LeaveTransaction.create({ tenantId: t.tenantId, employeeId: emp.id, leaveTypeId: type.id, leaveYear: year, kind, days, note }, { transaction: t });

  if (!tx.some((x) => x.kind === 'CARRY_FORWARD') && Number(type.carryForwardMax) > 0) {
    const [py] = start.split('-'); // previous fiscal year label
    const prevLabel = fiscalYear(addDays(start, -1));
    const prev = await app.LeaveTransaction.findAll({ where: { employeeId: emp.id, leaveTypeId: type.id, leaveYear: prevLabel }, transaction: t });
    if (prev.length && py) {
      const cf = Math.min(Math.max(0, sum(prev)), Number(type.carryForwardMax));
      await add('CARRY_FORWARD', cf, `from ${prevLabel}`);
    }
  }
  const from = emp.joinedOn > start ? emp.joinedOn : start;
  if (type.accrual === 'YEARLY' && !tx.some((x) => x.kind === 'ALLOCATION')) {
    const total = (new Date(end) - new Date(start)) / 86_400_000 + 1;
    const remain = (new Date(end) - new Date(from)) / 86_400_000 + 1;
    await add('ALLOCATION', half((Number(type.annualQuota) * remain) / total), from > start ? 'prorated from joining date' : 'annual allocation');
  }
  if (type.accrual === 'MONTHLY') {
    // One accrual per completed Nepali month since joining / FY start.
    const done = new Set(tx.filter((x) => x.kind === 'ACCRUAL').map((x) => x.note));
    const fy = Number(year.split('/')[0]);
    for (let i = 0; i < 12; i += 1) {
      const y = i < 9 ? fy : fy + 1; const m = (3 + i) % 12; // Shrawan..Asar
      const mStart = fromBS(y, m, 1);
      const mEnd = addDays(m === 11 ? fromBS(y + 1, 0, 1) : fromBS(y, m + 1, 1), -1);
      if (mEnd >= today || mEnd < from) continue;
      const key = `accrual:${y}-${String(m + 1).padStart(2, '0')}`;
      if (!done.has(key)) await add('ACCRUAL', Math.round((Number(type.annualQuota) / 12) * 100) / 100, key);
    }
  }
}

export async function balances(t, emp, year, tz) {
  const today = localDate(new Date(), tz);
  const types = await app.LeaveType.findAll({ where: { isActive: true }, order: [['code', 'ASC']], transaction: t });
  const out = [];
  for (const type of types) {
    if (type.appliesToGender && emp.gender && emp.gender !== type.appliesToGender) continue;
    await syncEntitlements(t, emp, type, year, today);
    const tx = await app.LeaveTransaction.findAll({ where: { employeeId: emp.id, leaveTypeId: type.id, leaveYear: year }, transaction: t });
    const pending = await app.LeaveRequest.sum('days', { where: { employeeId: emp.id, leaveTypeId: type.id, leaveYear: year, status: 'PENDING' }, transaction: t });
    const credit = sum(tx.filter((x) => Number(x.days) > 0));
    const used = -sum(tx.filter((x) => x.kind === 'USAGE' || x.kind === 'ENCASHMENT'));
    out.push({ leaveTypeId: type.id, code: type.code, name: type.name, isPaid: type.isPaid, tracked: type.accrual !== 'NONE', allowHalfDay: type.allowHalfDay, entitled: credit, used, pending: Number(pending ?? 0), balance: sum(tx), available: Math.round((sum(tx) - Number(pending ?? 0)) * 10) / 10 });
  }
  return out;
}

/** Working days in a range for this employee (excludes weekly offs and holidays). */
async function countDays(t, emp, start, end, halfDay) {
  const policy = await getPolicy(t);
  const sch = await scheduleFor(t, emp, policy);
  const hols = new Set((await app.Holiday.findAll({ where: { date: { [Op.between]: [start, end] }, isOptional: false }, transaction: t }))
    .filter((h) => !h.branchIds.length || h.branchIds.includes(emp.branchId)).map((h) => h.date));
  let n = 0;
  for (const d of eachDate(start, end)) if (!sch.weeklyOffs.includes(weekday(d)) && !hols.has(d)) n += 1;
  return halfDay ? Math.min(n, 0.5) : n;
}

// --------------------------------------------------------------------------- types & holidays (configuration)
const typeBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,20}$/), name: z.string().trim().min(2).max(80), isPaid: z.boolean(),
  annualQuota: z.number().min(0).max(366), accrual: z.enum(['YEARLY', 'MONTHLY', 'NONE']), carryForwardMax: z.number().min(0).max(366),
  encashable: z.boolean(), allowHalfDay: z.boolean(), allowNegative: z.boolean(), maxConsecutiveDays: z.number().int().positive().nullable(),
  minNoticeDays: z.number().int().min(0).max(90), approvalLevels: z.number().int().min(1).max(2), appliesToGender: z.enum(['FEMALE', 'MALE']).nullable(), isActive: z.boolean(),
}).partial().strict();

leaveRouter.get('/types', requirePermission('leave:view'), asyncHandler(async (req, res) => ok(res, await req.tx((t) => app.LeaveType.findAll({ order: [['code', 'ASC']], transaction: t })))));
leaveRouter.post('/types', requirePermission('leave:configure'), validate({ body: typeBody.required({ code: true, name: true }) }), asyncHandler(async (req, res) => {
  const row = await req.tx(async (t) => {
    const r = await app.LeaveType.create({ ...req.body, tenantId: req.auth.tenantId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'leave.type_create', entityType: 'leave_type', entityId: r.id, after: req.body, req });
    return r;
  });
  return created(res, row);
}));
leaveRouter.patch('/types/:id', requirePermission('leave:configure'), validate({ ...idParam, body: typeBody.omit({ code: true }) }), asyncHandler(async (req, res) => {
  const row = await req.tx(async (t) => {
    const r = await app.LeaveType.findByPk(req.params.id, { transaction: t });
    if (!r) throw NotFound('Leave type');
    const before = r.toJSON();
    await r.update(req.body, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'leave.type_update', entityType: 'leave_type', entityId: r.id, before, after: r.toJSON(), req });
    return r;
  });
  return ok(res, row);
}));

leaveRouter.get('/holidays', requirePermission('holidays:view'), validate({ query: z.object({ year: z.string().regex(/^\d{4}\/\d{2}$/).optional() }).strict() }), asyncHandler(async (req, res) => {
  const year = req.query.year ?? fiscalYear(localDate(new Date(), req.auth.ctx.tenant.timezone));
  const { start, end } = fiscalYearRange(year);
  const rows = await req.tx((t) => app.Holiday.findAll({ where: { date: { [Op.between]: [start, end] } }, order: [['date', 'ASC']], transaction: t }));
  return ok(res, rows.map((h) => ({ ...h.toJSON(), bs: toBS(h.date).formatted })));
}));
leaveRouter.post('/holidays', requirePermission('holidays:create'), validate({
  body: z.union([
    z.object({ date: DATE, name: z.string().trim().min(2).max(100), isOptional: z.boolean().default(false), branchIds: z.array(z.string().uuid()).default([]) }).strict(),
    z.object({ holidays: z.array(z.object({ date: DATE, name: z.string().trim().min(2).max(100), isOptional: z.boolean().default(false) }).strict()).min(1).max(100) }).strict(),
  ]),
}), asyncHandler(async (req, res) => {
  const list = req.body.holidays ?? [req.body];
  const rows = await req.tx(async (t) => {
    const r = await app.Holiday.bulkCreate(list.map((h) => ({ branchIds: [], ...h, tenantId: req.auth.tenantId })), { transaction: t, ignoreDuplicates: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'holiday.create', after: list, req });
    return r;
  });
  return created(res, rows);
}));
leaveRouter.delete('/holidays/:id', requirePermission('holidays:delete'), validate(idParam), asyncHandler(async (req, res) => {
  const n = await req.tx((t) => app.Holiday.destroy({ where: { id: req.params.id }, transaction: t }));
  if (!n) throw NotFound('Holiday');
  return ok(res, { deleted: true });
}));

// --------------------------------------------------------------------------- balances
leaveRouter.get('/balances/me', requirePermission('leave:view'), validate({ query: z.object({ year: z.string().regex(/^\d{4}\/\d{2}$/).optional() }).strict() }), asyncHandler(async (req, res) => {
  if (!req.auth.principal.employeeId) throw BadRequest('Your account is not linked to an employee record');
  const tz = req.auth.ctx.tenant.timezone;
  const year = req.query.year ?? fiscalYear(localDate(new Date(), tz));
  return ok(res, { year, balances: await req.tx(async (t) => balances(t, await app.Employee.findByPk(req.auth.principal.employeeId, { transaction: t }), year, tz)) });
}));

leaveRouter.get('/balances/:employeeId', requirePermission('leave:view'), validate({ params: z.object({ employeeId: z.string().uuid() }), query: z.object({ year: z.string().regex(/^\d{4}\/\d{2}$/).optional() }).strict() }), asyncHandler(async (req, res) => {
  const tz = req.auth.ctx.tenant.timezone;
  const year = req.query.year ?? fiscalYear(localDate(new Date(), tz));
  const out = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(req.params.employeeId, { transaction: t });
    if (!emp || !recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Employee');
    return balances(t, emp, year, tz);
  });
  return ok(res, { year, balances: out });
}));

leaveRouter.post('/adjustments', requirePermission('leave:manage'), validate({
  body: z.object({ employeeId: z.string().uuid(), leaveTypeId: z.string().uuid(), days: z.number().min(-366).max(366).refine((d) => d !== 0), note: z.string().trim().min(3).max(300), year: z.string().regex(/^\d{4}\/\d{2}$/).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const year = req.body.year ?? fiscalYear(localDate(new Date(), req.auth.ctx.tenant.timezone));
  const row = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(req.body.employeeId, { transaction: t });
    if (!emp || !recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Employee');
    const r = await app.LeaveTransaction.create({ tenantId: req.auth.tenantId, employeeId: emp.id, leaveTypeId: req.body.leaveTypeId, leaveYear: year, kind: 'ADJUSTMENT', days: req.body.days, note: req.body.note, actorId: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'leave.adjust', entityType: 'employee', entityId: emp.id, after: req.body, req });
    return r;
  });
  return created(res, row);
}));

// --------------------------------------------------------------------------- requests
leaveRouter.post('/requests', requirePermission('leave:create'), validate({
  body: z.object({ leaveTypeId: z.string().uuid(), startDate: DATE, endDate: DATE, halfDay: z.enum(['FIRST_HALF', 'SECOND_HALF']).optional(), reason: z.string().trim().max(1000).optional(), employeeId: z.string().uuid().optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const b = req.body;
  const tz = req.auth.ctx.tenant.timezone;
  const employeeId = b.employeeId ?? req.auth.principal.employeeId;
  if (!employeeId) throw BadRequest('Your account is not linked to an employee record');
  if (b.endDate < b.startDate) throw BadRequest('End date must be on or after start date', [{ path: 'endDate', message: 'Before start date' }]);
  if (b.halfDay && b.startDate !== b.endDate) throw BadRequest('Half-day leave must be a single day', [{ path: 'halfDay', message: 'Single day only' }]);
  const year = fiscalYear(b.startDate);
  if (fiscalYear(b.endDate) !== year) throw BadRequest('Leave cannot span two fiscal years. Please split it into two requests.');

  const reqRow = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(employeeId, { transaction: t });
    if (!emp || !recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Employee');
    const type = await app.LeaveType.findByPk(b.leaveTypeId, { transaction: t });
    if (!type || !type.isActive) throw NotFound('Leave type');
    if (type.appliesToGender && emp.gender !== type.appliesToGender) throw BadRequest(`${type.name} is not applicable for this employee`);
    if (b.halfDay && !type.allowHalfDay) throw BadRequest(`${type.name} cannot be taken as a half day`);
    const today = localDate(new Date(), tz);
    if (type.minNoticeDays && b.startDate < addDays(today, type.minNoticeDays)) throw BadRequest(`${type.name} needs ${type.minNoticeDays} day(s) notice`);
    const overlap = await app.LeaveRequest.count({ where: { employeeId, status: { [Op.in]: ['PENDING', 'APPROVED'] }, startDate: { [Op.lte]: b.endDate }, endDate: { [Op.gte]: b.startDate } }, transaction: t });
    if (overlap) throw Conflict('You already have leave on these dates', 'LEAVE_OVERLAP');
    const days = await countDays(t, emp, b.startDate, b.endDate, !!b.halfDay);
    if (days <= 0) throw BadRequest('The selected dates are all holidays or weekly offs');
    if (type.maxConsecutiveDays && days > type.maxConsecutiveDays) throw BadRequest(`${type.name} allows at most ${type.maxConsecutiveDays} consecutive days`);
    if (type.accrual !== 'NONE' && !type.allowNegative) {
      const bal = (await balances(t, emp, year, tz)).find((x) => x.leaveTypeId === type.id);
      if (!bal || bal.available < days) throw BadRequest(`Insufficient ${type.name} balance: ${bal?.available ?? 0} day(s) available, ${days} requested`, [{ path: 'leaveTypeId', message: 'Insufficient balance' }]);
    }
    const r = await app.LeaveRequest.create({ tenantId: req.auth.tenantId, employeeId, leaveTypeId: type.id, startDate: b.startDate, endDate: b.endDate, halfDay: b.halfDay ?? null, days, leaveYear: year, reason: b.reason, requiredLevels: type.approvalLevels, requestedBy: req.auth.userId }, { transaction: t });
    const manager = await userIdForEmployee(t, emp.managerId);
    const approvers = manager ? [manager] : await usersWithPermission(t, 'leave:approve');
    await notifyUsers(t, approvers.filter((u) => u !== req.auth.userId), { type: 'leave.requested', title: 'Leave request to review', body: `${emp.firstName} ${emp.lastName}: ${type.name}, ${days} day(s) from ${b.startDate}`, link: '/leave/approvals', email: true });
    return r;
  });
  return created(res, reqRow);
}));

leaveRouter.get('/requests', requirePermission('leave:view'), validate({
  query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), mine: z.coerce.boolean().optional(), from: DATE.optional(), to: DATE.optional(), employeeId: z.string().uuid().optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const q = req.query;
  const rows = await req.tx(async (t) => {
    const ids = q.mine ? [req.auth.principal.employeeId] : await scopedEmployeeIds(req, t);
    return app.LeaveRequest.findAll({
      where: {
        ...(q.status && { status: q.status }), ...(ids && { employeeId: ids }), ...(q.employeeId && { employeeId: q.employeeId }),
        ...(q.from && { endDate: { [Op.gte]: q.from } }), ...(q.to && { startDate: { [Op.lte]: q.to } }),
      },
      include: [{ model: app.Employee, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode', 'departmentId'] }, { model: app.LeaveType, as: 'leaveType', attributes: ['code', 'name', 'isPaid'] }, { model: app.LeaveApproval, as: 'approvals' }],
      order: [['startDate', 'DESC']], limit: 500, transaction: t,
    });
  });
  return ok(res, rows);
}));

const decide = (approve) => asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const r = await app.LeaveRequest.findByPk(req.params.id, { include: [{ model: app.LeaveType, as: 'leaveType' }], transaction: t, lock: { level: t.LOCK.UPDATE, of: app.LeaveRequest } });
    if (!r) throw NotFound('Leave request');
    const emp = await app.Employee.findByPk(r.employeeId, { transaction: t });
    if (!recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Leave request');
    if (r.employeeId === req.auth.principal.employeeId) throw Forbidden('You cannot approve your own leave', 'SELF_APPROVAL');
    if (r.status !== 'PENDING') throw Conflict(`Request is already ${r.status.toLowerCase()}`);
    const companyWide = req.scopes.some((s) => s.scope === 'COMPANY');
    if (r.currentLevel > 1 && !companyWide) throw Forbidden('This request now needs HR approval', 'NEEDS_HR');
    await app.LeaveApproval.create({ tenantId: req.auth.tenantId, requestId: r.id, level: r.currentLevel, decision: approve ? 'APPROVED' : 'REJECTED', approverId: req.auth.userId, note: req.body?.note ?? null }, { transaction: t });
    const requester = await userIdForEmployee(t, r.employeeId);
    if (!approve) {
      await r.update({ status: 'REJECTED', decidedAt: new Date() }, { transaction: t });
      await notifyUsers(t, [requester], { type: 'leave.rejected', title: 'Leave request rejected', body: `${r.leaveType.name} from ${r.startDate}${req.body?.note ? `: ${req.body.note}` : ''}`, link: '/me/leave', email: true });
    } else if (r.currentLevel < r.requiredLevels) {
      await r.update({ currentLevel: r.currentLevel + 1 }, { transaction: t });
      await notifyUsers(t, (await usersWithPermission(t, 'leave:approve')).filter((u) => u !== req.auth.userId), { type: 'leave.requested', title: 'Leave awaiting HR approval', body: `${emp.firstName} ${emp.lastName}: ${r.leaveType.name}, ${r.days} day(s)`, link: '/leave/approvals' });
    } else {
      await r.update({ status: 'APPROVED', decidedAt: new Date() }, { transaction: t });
      if (r.leaveType.accrual !== 'NONE') {
        await app.LeaveTransaction.create({ tenantId: req.auth.tenantId, employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, leaveYear: r.leaveYear, kind: 'USAGE', days: -Number(r.days), requestId: r.id, actorId: req.auth.userId }, { transaction: t });
      }
      await notifyUsers(t, [requester], { type: 'leave.approved', title: 'Leave approved', body: `${r.leaveType.name}, ${r.days} day(s) from ${r.startDate}`, link: '/me/leave', email: true });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: `leave.${approve ? 'approve' : 'reject'}`, entityType: 'leave_request', entityId: r.id, after: { level: r.currentLevel, status: r.status }, req });
    return r;
  });
  return ok(res, out);
});
const noteBody = { body: z.object({ note: z.string().max(500).optional() }).strict() };
leaveRouter.post('/requests/:id/approve', requirePermission('leave:approve'), validate({ ...idParam, ...noteBody }), decide(true));
leaveRouter.post('/requests/:id/reject', requirePermission('leave:approve'), validate({ ...idParam, ...noteBody }), decide(false));

/** Employees cancel their own pending/future leave; HR (leave:manage) can cancel any approved leave. Approved cancellations reverse the balance. */
leaveRouter.post('/requests/:id/cancel', requirePermission('leave:view'), validate({ ...idParam, ...noteBody }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const r = await app.LeaveRequest.findByPk(req.params.id, { include: [{ model: app.LeaveType, as: 'leaveType' }], transaction: t, lock: { level: t.LOCK.UPDATE, of: app.LeaveRequest } });
    if (!r) throw NotFound('Leave request');
    const own = r.employeeId === req.auth.principal.employeeId;
    const manager = req.auth.grants.has('leave:manage');
    if (!own && !manager) throw NotFound('Leave request');
    if (!['PENDING', 'APPROVED'].includes(r.status)) throw Conflict(`Request is already ${r.status.toLowerCase()}`);
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    if (r.status === 'APPROVED' && r.startDate <= today && !manager) throw Forbidden('Leave that has started can only be cancelled by HR', 'LEAVE_STARTED');
    if (r.status === 'APPROVED' && r.leaveType.accrual !== 'NONE') {
      await app.LeaveTransaction.create({ tenantId: req.auth.tenantId, employeeId: r.employeeId, leaveTypeId: r.leaveTypeId, leaveYear: r.leaveYear, kind: 'REVERSAL', days: Number(r.days), requestId: r.id, actorId: req.auth.userId, note: req.body?.note }, { transaction: t });
    }
    await r.update({ status: 'CANCELLED', decidedAt: new Date() }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'leave.cancel', entityType: 'leave_request', entityId: r.id, req });
    return r;
  });
  return ok(res, out);
}));

/** Team calendar: approved/pending leave overlapping a range, within scope. */
leaveRouter.get('/calendar', requirePermission('leave:view'), validate({ query: z.object({ from: DATE, to: DATE }).strict() }), asyncHandler(async (req, res) => {
  const rows = await req.tx(async (t) => {
    const ids = await scopedEmployeeIds(req, t);
    return app.LeaveRequest.findAll({
      where: { status: { [Op.in]: ['APPROVED', 'PENDING'] }, startDate: { [Op.lte]: req.query.to }, endDate: { [Op.gte]: req.query.from }, ...(ids && { employeeId: ids }) },
      include: [{ model: app.Employee, as: 'employee', attributes: ['id', 'firstName', 'lastName'] }, { model: app.LeaveType, as: 'leaveType', attributes: ['name'] }], transaction: t,
    });
  });
  return ok(res, rows);
}));
