import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { recordInScope } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate } from '../../services/hr/calendar.js';
import { getPolicy, scheduleFor, compute, haversineM, scopedEmployeeIds, dailyRegister, rangeSummary, DEFAULT_POLICY } from '../../services/hr/attendance.js';
import { notifyUsers, userIdForEmployee, usersWithPermission } from '../../services/hr/notify.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

export const attendanceRouter = Router();
const DATE = z.string().date();
const idParam = { params: z.object({ id: z.string().uuid() }) };

function myEmployeeId(req) {
  if (!req.auth.principal.employeeId) throw BadRequest('Your account is not linked to an employee record. Ask HR to link it.', [{ path: 'employee', message: 'Not linked' }]);
  return req.auth.principal.employeeId;
}

async function recompute(t, rec, employee, tz) {
  const policy = await getPolicy(t);
  const sch = await scheduleFor(t, employee, policy, rec.workDate);
  Object.assign(rec, compute(rec, sch, policy, tz));
  return rec;
}

// --------------------------------------------------------------------------- self service
attendanceRouter.get('/me/today', requirePermission('attendance:view'), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const tz = req.auth.ctx.tenant.timezone;
  const date = localDate(new Date(), tz);
  const out = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(employeeId, { transaction: t });
    const policy = await getPolicy(t);
    return { date, record: await app.AttendanceRecord.findOne({ where: { employeeId, workDate: date }, transaction: t }), schedule: await scheduleFor(t, emp, policy), requireLocation: policy.requireLocation || policy.geofence.enabled };
  });
  return ok(res, out);
}));

const punchBody = z.object({ lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).max(100_000).optional(), note: z.string().max(300).optional() }).strict();

async function checkPunch(req, policy, body) {
  if (policy.ipAllowlist.length && !policy.ipAllowlist.includes(req.ip)) throw Forbidden('Clock-in is only allowed from the office network', 'IP_NOT_ALLOWED');
  const hasLoc = body.lat != null && body.lng != null;
  if ((policy.requireLocation || policy.geofence.enabled) && !hasLoc) throw BadRequest('Location is required to clock in. Please allow location access.', [{ path: 'location', message: 'Required' }]);
  let distanceM = null;
  if (policy.geofence.enabled && hasLoc) {
    distanceM = haversineM({ lat: body.lat, lng: body.lng }, policy.geofence);
    if (distanceM > policy.geofence.radiusM + Math.min(body.accuracy ?? 0, 100)) throw Forbidden(`You are ${distanceM} m from the workplace. Clock-in is allowed within ${policy.geofence.radiusM} m.`, 'OUTSIDE_GEOFENCE', { distanceM });
  }
  return { source: req.get('x-client') === 'mobile' ? 'MOBILE' : 'WEB', ip: req.ip, ...(hasLoc && { lat: body.lat, lng: body.lng, accuracy: body.accuracy }), distanceM };
}

attendanceRouter.post('/clock-in', requirePermission('attendance:create'), validate({ body: punchBody }), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const tz = req.auth.ctx.tenant.timezone;
  const now = new Date();
  const rec = await req.tx(async (t) => {
    const policy = await getPolicy(t);
    const meta = await checkPunch(req, policy, req.body);
    const workDate = localDate(now, tz);
    if (await app.AttendanceRecord.findOne({ where: { employeeId, workDate }, transaction: t, lock: t.LOCK.UPDATE })) throw Conflict('You have already clocked in today', 'ALREADY_CLOCKED_IN');
    const emp = await app.Employee.findByPk(employeeId, { transaction: t });
    const r = app.AttendanceRecord.build({ tenantId: req.auth.tenantId, employeeId, workDate, clockIn: now, inMeta: meta, source: meta.source, note: req.body.note });
    await recompute(t, r, emp, tz);
    return r.save({ transaction: t });
  });
  return created(res, rec);
}));

attendanceRouter.post('/clock-out', requirePermission('attendance:create'), validate({ body: punchBody }), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const tz = req.auth.ctx.tenant.timezone;
  const now = new Date();
  const rec = await req.tx(async (t) => {
    const policy = await getPolicy(t);
    const meta = await checkPunch(req, policy, req.body);
    // Today's open record, or yesterday's for night shifts.
    const r = await app.AttendanceRecord.findOne({ where: { employeeId, clockOut: null, clockIn: { [Op.gte]: new Date(now - 20 * 3_600_000) } }, order: [['clockIn', 'DESC']], transaction: t, lock: t.LOCK.UPDATE });
    if (!r) throw Conflict('You have not clocked in yet', 'NOT_CLOCKED_IN');
    const emp = await app.Employee.findByPk(employeeId, { transaction: t });
    r.clockOut = now; r.outMeta = meta;
    await recompute(t, r, emp, tz);
    return r.save({ transaction: t });
  });
  return ok(res, rec);
}));

attendanceRouter.get('/me', requirePermission('attendance:view'), validate({ query: z.object({ from: DATE, to: DATE }).strict() }), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const { from, to } = req.query;
  if (from > to) throw BadRequest('from must be before to');
  const out = await req.tx(async (t) => ({
    records: await app.AttendanceRecord.findAll({ where: { employeeId, workDate: { [Op.between]: [from, to] } }, order: [['workDate', 'DESC']], transaction: t }),
    summary: (await rangeSummary(t, { employeeIds: [employeeId], from, to, tz: req.auth.ctx.tenant.timezone, policy: await getPolicy(t) }))[0],
    corrections: await app.AttendanceCorrection.findAll({ where: { employeeId, workDate: { [Op.between]: [from, to] } }, order: [['createdAt', 'DESC']], transaction: t }),
  }));
  return ok(res, out);
}));

// --------------------------------------------------------------------------- managers / HR
attendanceRouter.get('/daily', requirePermission('attendance:view'), validate({ query: z.object({ date: DATE.optional() }).strict() }), asyncHandler(async (req, res) => {
  const date = req.query.date ?? localDate(new Date(), req.auth.ctx.tenant.timezone);
  const rows = await req.tx((t) => dailyRegister(req, t, date));
  const count = (s) => rows.filter((r) => r.status === s).length;
  return ok(res, { date, rows, totals: { employees: rows.length, present: count('PRESENT') + count('LATE') + count('HALF_DAY'), late: count('LATE'), absent: count('ABSENT'), notIn: count('NOT_IN'), onLeave: count('ON_LEAVE') } });
}));

attendanceRouter.get('/summary', requirePermission('attendance:view'), validate({ query: z.object({ from: DATE, to: DATE, format: z.enum(['json', 'csv']).default('json') }).strict() }), asyncHandler(async (req, res) => {
  const { from, to, format } = req.query;
  if (from > to || (new Date(to) - new Date(from)) / 86_400_000 > 62) throw BadRequest('Choose a range of up to 62 days');
  const rows = await req.tx(async (t) => {
    const ids = await scopedEmployeeIds(req, t) ?? (await app.Employee.findAll({ where: { deletedAt: null }, attributes: ['id'], raw: true, transaction: t })).map((e) => e.id);
    return rangeSummary(t, { employeeIds: ids, from, to, tz: req.auth.ctx.tenant.timezone, policy: await getPolicy(t) });
  });
  if (format === 'csv') {
    if (!req.auth.grants.has('attendance:export')) throw Forbidden(undefined, 'FORBIDDEN', { permission: 'attendance:export' });
    const cols = ['code', 'name', 'workingDays', 'present', 'late', 'halfDay', 'absent', 'paidLeave', 'unpaidLeave', 'holidays', 'weeklyOffs', 'lateMinutes', 'overtimeMinutes'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`; // CSV-injection safe
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="attendance-${from}-to-${to}.csv"` });
    return res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
  }
  return ok(res, rows);
}));

attendanceRouter.post('/manual', requirePermission('attendance:create'), validate({
  body: z.object({ employeeId: z.string().uuid(), workDate: DATE, clockIn: z.coerce.date(), clockOut: z.coerce.date().optional(), note: z.string().trim().min(3).max(300) }).strict(),
}), asyncHandler(async (req, res) => {
  const tz = req.auth.ctx.tenant.timezone;
  const rec = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(req.body.employeeId, { transaction: t });
    if (!emp || !recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Employee');
    if (emp.id === req.auth.principal.employeeId && !req.scopes.some((s) => s.scope === 'COMPANY')) throw Forbidden('You cannot enter manual attendance for yourself', 'SELF_APPROVAL');
    if (req.body.clockOut && req.body.clockOut < req.body.clockIn) throw BadRequest('Clock-out must be after clock-in');
    const [r] = await app.AttendanceRecord.findOrCreate({ where: { employeeId: emp.id, workDate: req.body.workDate }, defaults: { tenantId: req.auth.tenantId, clockIn: req.body.clockIn }, transaction: t });
    const before = r.toJSON();
    Object.assign(r, { clockIn: req.body.clockIn, clockOut: req.body.clockOut ?? r.clockOut, source: 'MANUAL', note: req.body.note });
    await recompute(t, r, emp, tz);
    await r.save({ transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'attendance.manual', entityType: 'attendance', entityId: r.id, before, after: r.toJSON(), req });
    return r;
  });
  return ok(res, rec);
}));

// --------------------------------------------------------------------------- corrections
attendanceRouter.post('/corrections', requirePermission('attendance:create'), validate({
  body: z.object({ workDate: DATE, clockIn: z.coerce.date().optional(), clockOut: z.coerce.date().optional(), reason: z.string().trim().min(5).max(500) }).strict()
    .refine((b) => b.clockIn || b.clockOut, 'Provide the correct clock-in or clock-out time'),
}), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  if (req.body.workDate > localDate(new Date(), req.auth.ctx.tenant.timezone)) throw BadRequest('You cannot correct a future date');
  const c = await req.tx(async (t) => {
    if (await app.AttendanceCorrection.count({ where: { employeeId, workDate: req.body.workDate, status: 'PENDING' }, transaction: t })) throw Conflict('A correction for this date is already pending');
    const row = await app.AttendanceCorrection.create({ tenantId: req.auth.tenantId, employeeId, ...req.body, requestedBy: req.auth.userId }, { transaction: t });
    const emp = await app.Employee.findByPk(employeeId, { transaction: t });
    // The manager reviews it; with no manager login, everyone who approves attendance company-wide is told.
    const manager = await userIdForEmployee(t, emp.managerId);
    const reviewers = manager && manager !== req.auth.userId ? [manager] : (await usersWithPermission(t, 'attendance:approve')).filter((u) => u !== req.auth.userId);
    await notifyUsers(t, reviewers, { type: 'attendance.correction', title: 'Attendance correction to review', body: `${emp.firstName} ${emp.lastName} · ${req.body.workDate} · ${req.body.reason}`, link: '/attendance/corrections', email: true });
    return row;
  });
  return created(res, c);
}));

attendanceRouter.get('/corrections', requirePermission('attendance:view'), validate({ query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(), mine: z.coerce.boolean().optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const rows = await req.tx(async (t) => {
      const ids = req.query.mine ? [myEmployeeId(req)] : await scopedEmployeeIds(req, t);
      return app.AttendanceCorrection.findAll({
        where: { ...(req.query.status && { status: req.query.status }), ...(ids && { employeeId: ids }) },
        include: [{ model: app.Employee, as: 'employee', attributes: ['id', 'firstName', 'lastName', 'employeeCode'] }], order: [['createdAt', 'DESC']], limit: 200, transaction: t,
      });
    });
    return ok(res, rows);
  }));

attendanceRouter.post('/corrections/:id/cancel', requirePermission('attendance:create'), validate(idParam), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const c = await req.tx(async (t) => {
    const row = await app.AttendanceCorrection.findOne({ where: { id: req.params.id, employeeId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Correction');
    if (row.status !== 'PENDING') throw Conflict(`Correction is already ${row.status.toLowerCase()}`);
    await row.update({ status: 'CANCELLED' }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'attendance.correction_cancel', entityType: 'attendance_correction', entityId: row.id, req });
    return row;
  });
  return ok(res, c);
}));

const decide = (approve) => asyncHandler(async (req, res) => {
  const tz = req.auth.ctx.tenant.timezone;
  const c = await req.tx(async (t) => {
    const row = await app.AttendanceCorrection.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Correction');
    const emp = await app.Employee.findByPk(row.employeeId, { transaction: t });
    if (!recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Correction');
    if (row.employeeId === req.auth.principal.employeeId) throw Forbidden('You cannot approve your own correction', 'SELF_APPROVAL');
    if (row.status !== 'PENDING') throw Conflict(`Correction is already ${row.status.toLowerCase()}`);
    await row.update({ status: approve ? 'APPROVED' : 'REJECTED', reviewedBy: req.auth.userId, reviewedAt: new Date(), reviewNote: req.body?.note ?? null }, { transaction: t });
    if (approve) {
      const [r] = await app.AttendanceRecord.findOrCreate({ where: { employeeId: row.employeeId, workDate: row.workDate }, defaults: { tenantId: req.auth.tenantId, clockIn: row.clockIn ?? row.clockOut }, transaction: t });
      if (row.clockIn) r.clockIn = row.clockIn;
      if (row.clockOut) r.clockOut = row.clockOut;
      r.source = 'CORRECTION';
      await recompute(t, r, emp, tz);
      await r.save({ transaction: t });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: `attendance.correction_${approve ? 'approve' : 'reject'}`, entityType: 'attendance_correction', entityId: row.id, req });
    await notifyUsers(t, [row.requestedBy], { type: 'attendance.correction_decided', title: `Attendance correction ${approve ? 'approved' : 'rejected'}`, body: row.workDate, link: '/me/attendance' });
    return row;
  });
  return ok(res, c);
});
const noteBody = { body: z.object({ note: z.string().max(500).optional() }).strict() };
attendanceRouter.post('/corrections/:id/approve', requirePermission('attendance:approve'), validate({ ...idParam, ...noteBody }), decide(true));
attendanceRouter.post('/corrections/:id/reject', requirePermission('attendance:approve'), validate({ ...idParam, ...noteBody }), decide(false));

// --------------------------------------------------------------------------- policy
attendanceRouter.get('/policy', requirePermission('attendance:view'), asyncHandler(async (req, res) => ok(res, await req.tx((t) => getPolicy(t)))));
attendanceRouter.put('/policy', requirePermission('attendance:configure'), validate({
  body: z.object({
    workStart: z.string().regex(/^\d{2}:\d{2}$/), workEnd: z.string().regex(/^\d{2}:\d{2}$/), breakMinutes: z.number().int().min(0).max(600),
    graceMinutes: z.number().int().min(0).max(240), halfDayMinutes: z.number().int().min(0).max(720), overtimeAfterMinutes: z.number().int().min(0).max(600),
    weeklyOffs: z.array(z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'])).max(6), allowWeb: z.boolean(), requireLocation: z.boolean(), deductAbsences: z.boolean(),
    lateRule: z.object({ enabled: z.boolean(), everyLateDays: z.number().int().min(1).max(31), deductDays: z.number().min(0).max(5).multipleOf(0.5) }).strict(),
    earlyLeaveGraceMinutes: z.number().int().min(0).max(240), earlyLeaveCountsAsLate: z.boolean(),
    notifyLate: z.boolean(), notifyMissingPunch: z.boolean(), repeatedLateThreshold: z.number().int().min(0).max(31),
    geofence: z.object({ enabled: z.boolean(), lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable(), radiusM: z.number().int().min(20).max(50_000) })
      .refine((g) => !g.enabled || (g.lat != null && g.lng != null), 'Set the workplace location to enable geofencing'),
    ipAllowlist: z.array(z.union([z.ipv4(), z.ipv6()])).max(50),
  }).partial().strict(),
}), asyncHandler(async (req, res) => {
  const value = await req.tx(async (t) => {
    const current = await getPolicy(t);
    const next = { ...current, ...req.body };
    const [row] = await app.TenantSetting.findOrCreate({ where: { key: 'attendance.policy' }, defaults: { tenantId: req.auth.tenantId, value: next }, transaction: t });
    await row.update({ value: next }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'attendance.policy_update', before: current, after: next, req });
    return next;
  });
  return ok(res, value);
}));

export { DEFAULT_POLICY };
