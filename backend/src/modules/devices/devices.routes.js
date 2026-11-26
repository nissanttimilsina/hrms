/** Company management of biometric devices: registration, status, logs, punches and employee mapping. */
import { Router } from 'express';
import { z } from 'zod';
import { Op, QueryTypes } from 'sequelize';
import { app, appDb } from '../../database/index.js';
import { env } from '../../config/env.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { ONLINE_WINDOW_MS, reprocessUnmapped } from '../../services/biometric/adms.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { Conflict, NotFound } from '../../utils/errors.js';

export const devicesRouter = Router();
const idParam = { params: z.object({ id: z.string().uuid() }) };
const ip = z.string().trim().refine((v) => z.ipv4().safeParse(v).success || z.ipv6().safeParse(v).success, 'Invalid IP address');
const deviceBody = z.object({
  name: z.string().trim().min(2).max(120),
  serialNumber: z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/, 'Serial number: 4–64 letters, digits, - or _'),
  branchId: z.string().uuid().nullish(),
  model: z.string().trim().max(80).nullish(),
  location: z.string().trim().max(200).nullish(),
  allowedIps: z.array(ip).max(20).default([]),
}).strict();

const health = (d) => {
  const online = d.lastSeenAt && Date.now() - new Date(d.lastSeenAt).getTime() < ONLINE_WINDOW_MS;
  return d.status === 'DISABLED' ? 'DISABLED' : !d.lastSeenAt ? 'NEVER_CONNECTED' : online ? 'ONLINE' : 'OFFLINE';
};
const view = (d) => { const j = d.toJSON(); const users = j.deviceInfo?.users ?? {}; delete j.deviceInfo; return { ...j, health: health(d), enrolledUsers: Object.keys(users).length }; };

/** What to type into the device's ADMS / Cloud Server menu. */
devicesRouter.get('/setup', requirePermission('devices:view'), (req, res) => ok(res, {
  serverAddress: `devices.${env.ROOT_DOMAIN}`, port: 443, httpsPort: 443, httpPort: 80, path: '/iclock/',
  notes: [
    'Menu → Comm./Communication → Cloud Server Setting (or ADMS).',
    'Server address: the address above; enable "Domain name"; port 443 with HTTPS if the device supports it, otherwise port 80.',
    'Register the device here with its exact serial number (Menu → System Info → Device Info) before it connects.',
    'Enrol each employee on the device with the same ID you enter as their "Biometric ID" in HRMS.',
  ],
}));

devicesRouter.get('/', requirePermission('devices:view'), asyncHandler(async (req, res) => {
  const rows = await req.tx((t) => app.AttendanceDevice.findAll({ where: { deletedAt: null }, order: [['name', 'ASC']], include: [{ model: app.Branch, as: 'branch', attributes: ['id', 'name'] }], transaction: t }));
  return ok(res, rows.map(view));
}));

devicesRouter.post('/', requirePermission('devices:manage'), validate({ body: deviceBody }), asyncHandler(async (req, res) => {
  const d = await req.tx(async (t) => {
    // Serial numbers are unique across the whole platform; the index check covers other companies too.
    const [{ taken }] = await appDb.query('SELECT serial_taken(:sn) AS taken', { replacements: { sn: req.body.serialNumber }, type: QueryTypes.SELECT, transaction: t });
    if (taken) throw Conflict('This serial number is already registered. If you moved the device, delete it from the other workspace first.', 'SERIAL_TAKEN');
    const row = await app.AttendanceDevice.create({ ...req.body, serialNumber: req.body.serialNumber.toUpperCase(), tenantId: req.auth.tenantId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'device.create', entityType: 'attendance_device', entityId: row.id, after: { name: row.name, serialNumber: row.serialNumber }, req });
    return row;
  });
  return created(res, view(d));
}));

devicesRouter.patch('/:id', requirePermission('devices:manage'), validate({ ...idParam, body: deviceBody.omit({ serialNumber: true }).partial().extend({ status: z.enum(['ACTIVE', 'DISABLED']).optional() }) }), asyncHandler(async (req, res) => {
  const d = await req.tx(async (t) => {
    const row = await app.AttendanceDevice.findOne({ where: { id: req.params.id, deletedAt: null }, transaction: t });
    if (!row) throw NotFound('Device');
    const before = row.toJSON();
    await row.update(req.body, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'device.update', entityType: 'attendance_device', entityId: row.id, before: { status: before.status, allowedIps: before.allowedIps }, after: req.body, req });
    return row;
  });
  return ok(res, view(d));
}));

devicesRouter.delete('/:id', requirePermission('devices:manage'), validate(idParam), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const row = await app.AttendanceDevice.findOne({ where: { id: req.params.id, deletedAt: null }, transaction: t });
    if (!row) throw NotFound('Device');
    await row.update({ deletedAt: new Date(), status: 'DISABLED' }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'device.delete', entityType: 'attendance_device', entityId: row.id, req });
  });
  return ok(res, { deleted: true });
}));

const page = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) });

devicesRouter.get('/:id/logs', requirePermission('devices:view'), validate({ ...idParam, query: page.extend({ level: z.enum(['INFO', 'WARN', 'ERROR']).optional() }) }), asyncHandler(async (req, res) => {
  const { page: p, pageSize, level } = req.query;
  const { rows, count } = await req.tx((t) => app.DeviceLog.findAndCountAll({ where: { deviceId: req.params.id, ...(level && { level }) }, order: [['createdAt', 'DESC']], limit: pageSize, offset: (p - 1) * pageSize, transaction: t }));
  return ok(res, rows, { page: p, pageSize, total: count });
}));

devicesRouter.get('/punches', requirePermission('devices:view'), validate({ query: page.extend({ deviceId: z.string().uuid().optional(), result: z.enum(['APPLIED', 'UNMAPPED', 'IGNORED', 'ERROR']).optional(), from: z.string().date().optional(), to: z.string().date().optional() }) }), asyncHandler(async (req, res) => {
  const { page: p, pageSize, deviceId, result, from, to } = req.query;
  const where = { ...(deviceId && { deviceId }), ...(result && { result }) };
  if (from || to) where.punchedAt = { ...(from && { [Op.gte]: new Date(`${from}T00:00:00+05:45`) }), ...(to && { [Op.lt]: new Date(new Date(`${to}T00:00:00+05:45`).getTime() + 86_400_000) }) };
  const { rows, count } = await req.tx((t) => app.DevicePunch.findAndCountAll({
    where, order: [['punchedAt', 'DESC']], limit: pageSize, offset: (p - 1) * pageSize, transaction: t,
    include: [{ model: app.Employee, as: 'employee', attributes: ['id', 'employeeCode', 'firstName', 'lastName'] }, { model: app.AttendanceDevice, as: 'device', attributes: ['id', 'name'] }],
  }));
  return ok(res, rows, { page: p, pageSize, total: count });
}));

/** Device user IDs that punched but match no employee, with names the device reported. */
devicesRouter.get('/unmapped', requirePermission('devices:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const rows = await appDb.query(
      `SELECT device_user_id AS "deviceUserId", count(*)::int AS punches, max(punched_at) AS "lastPunchAt"
         FROM device_punches WHERE result = 'UNMAPPED' GROUP BY 1 ORDER BY 3 DESC LIMIT 500`, { type: QueryTypes.SELECT, transaction: t });
    const devices = await app.AttendanceDevice.findAll({ where: { deletedAt: null }, attributes: ['deviceInfo'], transaction: t });
    const names = Object.assign({}, ...devices.map((d) => d.deviceInfo?.users ?? {}));
    const mapped = new Set((await app.Employee.findAll({ where: { biometricId: { [Op.ne]: null }, deletedAt: null }, attributes: ['biometricId'], transaction: t })).map((e) => e.biometricId));
    const enrolledOnly = Object.keys(names).filter((pin) => !mapped.has(pin) && !rows.some((r) => r.deviceUserId === pin)).map((pin) => ({ deviceUserId: pin, punches: 0, lastPunchAt: null }));
    return [...rows, ...enrolledOnly].map((r) => ({ ...r, nameOnDevice: names[r.deviceUserId] ?? null }));
  });
  return ok(res, out);
}));

/** Link a device user ID to an employee and apply the punches already received for it. */
devicesRouter.post('/mappings', requirePermission('devices:manage'), validate({ body: z.object({ employeeId: z.string().uuid(), biometricId: z.string().trim().regex(/^[A-Za-z0-9]{1,24}$/) }).strict() }), asyncHandler(async (req, res) => {
  const tz = req.auth.ctx.tenant.timezone;
  const out = await req.tx(async (t) => {
    const emp = await app.Employee.findOne({ where: { id: req.body.employeeId, deletedAt: null }, transaction: t });
    if (!emp) throw NotFound('Employee');
    const clash = await app.Employee.findOne({ where: { biometricId: req.body.biometricId, deletedAt: null, id: { [Op.ne]: emp.id } }, transaction: t });
    if (clash) throw Conflict(`Biometric ID ${req.body.biometricId} already belongs to ${clash.firstName} ${clash.lastName}`, 'BIOMETRIC_ID_TAKEN');
    const before = emp.biometricId;
    await emp.update({ biometricId: req.body.biometricId }, { transaction: t });
    const r = await reprocessUnmapped(t, emp, tz);
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'device.map_employee', entityType: 'employee', entityId: emp.id, before: { biometricId: before }, after: { biometricId: emp.biometricId, ...r }, req });
    return r;
  });
  return ok(res, out);
}));
