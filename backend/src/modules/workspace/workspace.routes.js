import { Router } from 'express';
import { z } from 'zod';
import { Op, QueryTypes } from 'sequelize';
import { app, appDb } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, addDays, toBS } from '../../services/hr/calendar.js';
import { dailyRegister } from '../../services/hr/attendance.js';
import { scopeWhere } from '../../services/rbac.service.js';
import { notifyUsers } from '../../services/hr/notify.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { NotFound } from '../../utils/errors.js';

/** Workspace-wide endpoints: dashboard, announcements, notifications, company settings. */
export const workspaceRouter = Router();

// --------------------------------------------------------------------------- dashboard (adapts to role/scope)
workspaceRouter.get('/dashboard', asyncHandler(async (req, res) => {
  const tz = req.auth.ctx.tenant.timezone;
  const today = localDate(new Date(), tz);
  const has = (p) => req.auth.grants.has(p);
  const feat = (f) => req.auth.ctx.features.includes(f);
  const out = await req.tx(async (t) => {
    const d = { today, todayBS: toBS(today).formatted, widgets: [] };
    if (has('employees:view')) {
      const scopes = req.auth.grants.get('employees:view').scopes;
      const where = { [Op.and]: [{ deletedAt: null }, scopeWhere(scopes, req.auth.principal)] };
      const emps = await app.Employee.findAll({ where, attributes: ['id', 'firstName', 'lastName', 'status', 'departmentId', 'joinedOn', 'dateOfBirth', 'exitedOn'], transaction: t });
      const active = emps.filter((e) => e.status !== 'TERMINATED');
      d.headcount = { total: active.length, probation: active.filter((e) => e.status === 'PROBATION').length, onNotice: active.filter((e) => e.status === 'ON_NOTICE').length, joinedThisMonth: active.filter((e) => e.joinedOn >= addDays(today, -30)).length, exitedThisMonth: emps.filter((e) => e.exitedOn && e.exitedOn >= addDays(today, -30)).length };
      const md = (s) => s?.slice(5);
      const next30 = new Set([...Array(30)].map((_, i) => md(addDays(today, i))));
      d.birthdays = active.filter((e) => e.dateOfBirth && next30.has(md(e.dateOfBirth))).map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, date: md(e.dateOfBirth) })).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
      d.anniversaries = active.filter((e) => e.joinedOn < addDays(today, -300) && next30.has(md(e.joinedOn))).map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`, date: md(e.joinedOn), years: Number(today.slice(0, 4)) - Number(e.joinedOn.slice(0, 4)) })).slice(0, 8);
      const depts = await app.Department.findAll({ where: { deletedAt: null }, attributes: ['id', 'name'], transaction: t });
      d.byDepartment = depts.map((x) => ({ name: x.name, count: active.filter((e) => e.departmentId === x.id).length })).filter((x) => x.count).sort((a, b) => b.count - a.count);
      const unassigned = active.filter((e) => !e.departmentId).length;
      if (unassigned) d.byDepartment.push({ name: 'Unassigned', count: unassigned });
    }
    if (feat('attendance') && has('attendance:view') && req.auth.grants.get('attendance:view').scopes.some((s) => s.scope !== 'OWN')) {
      req.scopes = req.auth.grants.get('attendance:view').scopes;
      const reg = await dailyRegister(req, t, today);
      const c = (s) => reg.filter((r) => r.status === s).length;
      d.attendanceToday = { present: c('PRESENT') + c('LATE') + c('HALF_DAY'), late: c('LATE'), onLeave: c('ON_LEAVE'), notIn: c('NOT_IN') + c('ABSENT'), total: reg.length };
      const trend = await appDb.query(
        `SELECT work_date::text AS date, count(*)::int AS present, count(*) FILTER (WHERE status = 'LATE')::int AS late
           FROM attendance_records WHERE work_date BETWEEN :from AND :to GROUP BY work_date ORDER BY work_date`,
        { replacements: { from: addDays(today, -13), to: today }, type: QueryTypes.SELECT, transaction: t },
      );
      d.attendanceTrend = trend;
    }
    if (feat('leave') && has('leave:approve')) {
      d.pendingLeave = await app.LeaveRequest.count({ where: { status: 'PENDING', employeeId: { [Op.ne]: req.auth.principal.employeeId ?? '00000000-0000-0000-0000-000000000000' } }, transaction: t });
      d.pendingCorrections = await app.AttendanceCorrection.count({ where: { status: 'PENDING' }, transaction: t });
    }
    if (feat('leave') && has('leave:view')) {
      d.onLeaveToday = (await app.LeaveRequest.findAll({ where: { status: 'APPROVED', startDate: { [Op.lte]: today }, endDate: { [Op.gte]: today } }, include: [{ model: app.Employee, as: 'employee', attributes: ['firstName', 'lastName'] }, { model: app.LeaveType, as: 'leaveType', attributes: ['name'] }], limit: 10, transaction: t }))
        .map((l) => ({ name: `${l.employee.firstName} ${l.employee.lastName}`, type: l.leaveType.name, until: l.endDate }));
    }
    d.upcomingHolidays = (await app.Holiday.findAll({ where: { date: { [Op.gte]: today } }, order: [['date', 'ASC']], limit: 5, transaction: t })).map((h) => ({ ...h.toJSON(), bs: toBS(h.date).formatted }));
    d.announcements = await app.Announcement.findAll({ where: { publishedAt: { [Op.lte]: new Date() }, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }] }, order: [['pinned', 'DESC'], ['publishedAt', 'DESC']], limit: 5, transaction: t });
    if (has('audit:view')) d.recentActivity = await app.AuditLog.findAll({ order: [['createdAt', 'DESC']], limit: 8, attributes: ['action', 'createdAt', 'entityType'], transaction: t });
    return d;
  });
  return ok(res, out);
}));

// --------------------------------------------------------------------------- announcements
workspaceRouter.get('/announcements', requirePermission('announcements:view'), asyncHandler(async (req, res) =>
  ok(res, await req.tx((t) => app.Announcement.findAll({ where: { publishedAt: { [Op.lte]: new Date() } }, order: [['pinned', 'DESC'], ['publishedAt', 'DESC']], limit: 100, transaction: t })))));
workspaceRouter.post('/announcements', requirePermission('announcements:create'), validate({
  body: z.object({ title: z.string().trim().min(3).max(200), body: z.string().trim().min(3).max(20_000), pinned: z.boolean().default(false), expiresAt: z.coerce.date().optional(), notify: z.boolean().default(true) }).strict(),
}), asyncHandler(async (req, res) => {
  const { notify, ...b } = req.body;
  const a = await req.tx(async (t) => {
    const r = await app.Announcement.create({ ...b, tenantId: req.auth.tenantId, authorId: req.auth.userId }, { transaction: t });
    if (notify) {
      const users = await app.User.findAll({ where: { status: 'ACTIVE' }, attributes: ['id'], transaction: t });
      await notifyUsers(t, users.map((u) => u.id).filter((u) => u !== req.auth.userId), { type: 'announcement', title: b.title, body: b.body.slice(0, 200), link: '/announcements' });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'announcement.create', entityType: 'announcement', entityId: r.id, req });
    return r;
  });
  return created(res, a);
}));
workspaceRouter.delete('/announcements/:id', requirePermission('announcements:delete'), validate({ params: z.object({ id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  if (!(await req.tx((t) => app.Announcement.destroy({ where: { id: req.params.id }, transaction: t })))) throw NotFound('Announcement');
  return ok(res, { deleted: true });
}));

// --------------------------------------------------------------------------- notifications (always own)
workspaceRouter.get('/notifications', asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => ({
    items: await app.Notification.findAll({ where: { userId: req.auth.userId }, order: [['createdAt', 'DESC']], limit: 50, transaction: t }),
    unread: await app.Notification.count({ where: { userId: req.auth.userId, readAt: null }, transaction: t }),
  }));
  return ok(res, out);
}));
workspaceRouter.post('/notifications/read', validate({ body: z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).strict() }), asyncHandler(async (req, res) => {
  await req.tx((t) => app.Notification.update({ readAt: new Date() }, { where: { userId: req.auth.userId, readAt: null, ...(req.body.ids && { id: req.body.ids }) }, transaction: t }));
  return ok(res, { read: true });
}));

// --------------------------------------------------------------------------- company settings
const SETTING_KEYS = ['org.financial_year_start', 'org.work_week', 'org.employee_id_format', 'branding', 'security.session_idle_minutes', 'locale.preferences'];
workspaceRouter.get('/settings', requirePermission('settings:view'), asyncHandler(async (req, res) => {
  const rows = await req.tx((t) => app.TenantSetting.findAll({ where: { key: SETTING_KEYS }, transaction: t }));
  const tenant = await req.tx((t) => app.Tenant.findByPk(req.auth.tenantId, { attributes: ['name', 'legalName', 'timezone', 'currency', 'locale', 'calendar', 'industry'], transaction: t }));
  return ok(res, { company: tenant, settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
}));
workspaceRouter.put('/settings/:key', requirePermission('settings:configure'), validate({ params: z.object({ key: z.enum(SETTING_KEYS) }), body: z.object({ value: z.any() }).strict() }), asyncHandler(async (req, res) => {
  const v = req.body.value;
  const schemas = {
    'org.employee_id_format': z.object({ prefix: z.string().max(10).regex(/^[A-Za-z0-9_-]*$/), padding: z.number().int().min(1).max(8), next: z.number().int().min(1) }).strict(),
    'org.work_week': z.array(z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'])).min(1),
    branding: z.object({ primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), logoFileId: z.string().uuid().nullable() }).partial().strict(),
    'security.session_idle_minutes': z.number().int().min(5).max(1440),
    'locale.preferences': z.object({ calendar: z.enum(['BS', 'AD']), language: z.enum(['en', 'ne']) }).partial().strict(),
    'org.financial_year_start': z.object({ calendar: z.enum(['BS', 'AD']), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(32) }).strict(),
  };
  const value = schemas[req.params.key].parse(v);
  await req.tx(async (t) => {
    const [row] = await app.TenantSetting.findOrCreate({ where: { key: req.params.key }, defaults: { tenantId: req.auth.tenantId, value }, transaction: t });
    await row.update({ value }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'settings.update', entityType: 'setting', entityId: req.params.key, after: value, req });
  });
  return ok(res, { key: req.params.key, value });
}));
