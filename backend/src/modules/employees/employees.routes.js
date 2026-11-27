import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import multer from 'multer';
import crypto from 'node:crypto';
import { app } from '../../database/index.js';
import { env } from '../../config/env.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { assertWithinLimit, assertStorageAvailable, addUsage } from '../../services/subscription.service.js';
import { scopeWhere, recordInScope } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { encryptField } from '../../services/hr/field-crypto.js';
import { storage } from '../../services/storage.service.js';
import { localDate } from '../../services/hr/calendar.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta, searchWhere } from '../../utils/http.js';
import { NotFound, Forbidden, BadRequest, Conflict, ValidationError } from '../../utils/errors.js';

export const employeesRouter = Router();

const STATUSES = ['ACTIVE', 'PROBATION', 'ON_NOTICE', 'SUSPENDED', 'TERMINATED'];
const TYPES = ['PERMANENT', 'PROBATION', 'CONTRACT', 'PART_TIME', 'INTERN', 'DAILY_WAGE'];
const uuidN = z.string().uuid().nullish();
const dateN = z.string().date().nullish();
const bankBody = z.object({ bankName: z.string().trim().max(100), branch: z.string().trim().max(100).optional(), accountName: z.string().trim().max(120), accountNumber: z.string().trim().regex(/^[0-9A-Za-z-]{5,30}$/, 'Invalid account number').optional() }).strict();

const body = z.object({
  employeeCode: z.string().trim().max(30).regex(/^[A-Za-z0-9_-]+$/).optional(),
  firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80),
  workEmail: z.string().trim().toLowerCase().email().max(254).nullish(), personalEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
  phone: z.string().trim().regex(/^\+?[0-9 -]{7,20}$/, 'Invalid phone number').nullish(),
  branchId: uuidN, departmentId: uuidN, managerId: uuidN, designationId: uuidN, shiftId: uuidN,
  status: z.enum(STATUSES).default('ACTIVE'), employmentType: z.enum(TYPES).default('PERMANENT'),
  joinedOn: z.string().date(), dateOfBirth: dateN, contractEndOn: dateN, probationEndOn: dateN,
  gender: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED']).nullish(), maritalStatus: z.enum(['SINGLE', 'MARRIED', 'OTHER']).nullish(),
  pan: z.string().trim().regex(/^\d{9}$/, 'PAN must be 9 digits').nullish(), ssfId: z.string().trim().max(30).nullish(), biometricId: z.string().trim().regex(/^[A-Za-z0-9]{1,24}$/, 'Letters and digits only (max 24)').nullish(), citizenshipNo: z.string().trim().max(40).nullish(),
  address: z.object({ permanent: z.string().max(300), temporary: z.string().max(300), district: z.string().max(60), province: z.string().max(60) }).partial().optional(),
  emergencyContacts: z.array(z.object({ name: z.string().trim().min(1).max(120), relation: z.string().trim().max(40), phone: z.string().trim().max(30) }).strict()).max(5).optional(),
  bank: bankBody.optional(),
  customFields: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional(),
}).strict();
const idParam = { params: z.object({ id: z.string().uuid() }) };

const LIST_ATTRS = ['id', 'employeeCode', 'firstName', 'lastName', 'workEmail', 'phone', 'branchId', 'departmentId', 'managerId', 'designationId', 'shiftId', 'biometricId', 'status', 'employmentType', 'joinedOn', 'exitedOn', 'createdAt'];
const SENSITIVE = ['bank', 'pan', 'ssfId', 'citizenshipNo', 'dateOfBirth', 'personalEmail', 'address', 'emergencyContacts', 'maritalStatus', 'gender'];
const TRACKED = { branchId: 'TRANSFER', departmentId: 'TRANSFER', designationId: 'DESIGNATION_CHANGE', status: 'STATUS_CHANGE', managerId: 'TRANSFER', employmentType: 'STATUS_CHANGE', contractEndOn: 'CONTRACT_RENEWAL' };

/** Bank account numbers are encrypted at rest; API only ever returns the last 4 digits. */
function protectBank(bank) {
  if (!bank) return undefined;
  const { accountNumber, ...rest } = bank;
  return accountNumber ? { ...rest, accountNumberEnc: encryptField(accountNumber), last4: accountNumber.slice(-4) } : rest;
}
export const presentEmployee = (e, canSeeSensitive) => {
  const j = e.toJSON ? e.toJSON() : e;
  const { bank, ...rest } = j;
  const safeBank = bank && { bankName: bank.bankName, branch: bank.branch, accountName: bank.accountName, last4: bank.last4 };
  if (canSeeSensitive) return { ...rest, bank: safeBank };
  return Object.fromEntries(Object.entries({ ...rest, bank: safeBank }).filter(([k]) => !SENSITIVE.includes(k)));
};
const canSeeSensitive = (req, emp) => req.auth.grants.has('employees:manage') || req.auth.grants.has('employees:edit') || emp.id === req.auth.principal.employeeId;

async function nextEmployeeCode(tenantId, t) {
  const setting = await app.TenantSetting.findOne({ where: { key: 'org.employee_id_format' }, transaction: t, lock: t.LOCK.UPDATE });
  const fmt = setting?.value ?? { prefix: 'EMP-', padding: 4, next: 1 };
  for (let n = fmt.next; ; n += 1) {
    const candidate = `${fmt.prefix}${String(n).padStart(fmt.padding, '0')}`;
    if (!(await app.Employee.count({ where: { employeeCode: candidate }, transaction: t }))) {
      if (setting) await setting.update({ value: { ...fmt, next: n + 1 } }, { transaction: t });
      else await app.TenantSetting.create({ tenantId, key: 'org.employee_id_format', value: { ...fmt, next: n + 1 } }, { transaction: t });
      return candidate;
    }
  }
}

const history = (t, req, employeeId, type, effectiveOn, from, to, note) => app.EmployeeHistory.create({ tenantId: req.auth.tenantId, employeeId, type, effectiveOn, fromValue: from, toValue: to, note, actorId: req.auth.userId }, { transaction: t });

export async function createEmployee(req, t, data) {
  if (data.status !== 'TERMINATED') await assertWithinLimit(req.auth.ctx, 'employees', t);
  const employeeCode = data.employeeCode ?? (await nextEmployeeCode(req.auth.tenantId, t));
  if (data.managerId && !(await app.Employee.count({ where: { id: data.managerId }, transaction: t }))) throw BadRequest('Reporting manager not found', [{ path: 'managerId', message: 'Not found' }]);
  const e = await app.Employee.create({ ...data, bank: protectBank(data.bank) ?? {}, employeeCode, tenantId: req.auth.tenantId }, { transaction: t });
  await history(t, req, e.id, 'JOINED', e.joinedOn, {}, { branchId: e.branchId, departmentId: e.departmentId, designationId: e.designationId, employmentType: e.employmentType });
  await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'employee.create', entityType: 'employee', entityId: e.id, after: { employeeCode, name: `${e.firstName} ${e.lastName}` }, req });
  return e;
}

// --------------------------------------------------------------------------- list / read
employeesRouter.get('/', requirePermission('employees:view'),
  validate({ query: listQuery(['createdAt', 'lastName', 'firstName', 'employeeCode', 'joinedOn'], {
    status: z.enum(STATUSES).optional(), branchId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(), designationId: z.string().uuid().optional(), employmentType: z.enum(TYPES).optional(),
  }) }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const where = { [Op.and]: [{ deletedAt: null }, scopeWhere(req.scopes, req.auth.principal), searchWhere(q.search, ['firstName', 'lastName', 'employeeCode', 'workEmail']),
      ...['status', 'branchId', 'departmentId', 'designationId', 'employmentType'].filter((k) => q[k]).map((k) => ({ [k]: q[k] }))] };
    const { rows, count } = await req.tx((t) => app.Employee.findAndCountAll({ where, attributes: LIST_ATTRS, include: [{ model: app.Designation, as: 'designation', attributes: ['name'] }], ...paginate(q), transaction: t }));
    return ok(res, rows, pageMeta(q, count));
  }));

employeesRouter.get('/export', requirePermission('employees:export'), asyncHandler(async (req, res) => {
  const rows = await req.tx((t) => app.Employee.findAll({
    where: { [Op.and]: [{ deletedAt: null }, scopeWhere(req.scopes, req.auth.principal)] },
    include: [{ model: app.Branch, as: 'branch', attributes: ['name'] }, { model: app.Department, as: 'department', attributes: ['name'] }, { model: app.Designation, as: 'designation', attributes: ['name'] }],
    order: [['employeeCode', 'ASC']], transaction: t,
  }));
  const cols = [['employeeCode', 'Employee ID'], ['firstName', 'First name'], ['lastName', 'Last name'], ['workEmail', 'Work email'], ['phone', 'Phone'], ['branch', 'Branch'], ['department', 'Department'], ['designation', 'Designation'], ['employmentType', 'Employment type'], ['status', 'Status'], ['joinedOn', 'Joined on'], ['pan', 'PAN']];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@\t]/, "'$&")}"`;
  const val = (e, k) => (['branch', 'department', 'designation'].includes(k) ? e[k]?.name : e[k]);
  await audit({ tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'employee.export', after: { count: rows.length }, req });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="employees-${localDate()}.csv"` });
  return res.send(`﻿${[cols.map((c) => esc(c[1])).join(','), ...rows.map((e) => cols.map(([k]) => esc(val(e, k))).join(','))].join('\r\n')}`);
}));

employeesRouter.get('/me', asyncHandler(async (req, res) => {
  if (!req.auth.principal.employeeId) throw NotFound('Employee profile');
  const e = await req.tx((t) => app.Employee.findByPk(req.auth.principal.employeeId, {
    include: [{ model: app.Branch, as: 'branch', attributes: ['id', 'name'] }, { model: app.Department, as: 'department', attributes: ['id', 'name'] }, { model: app.Designation, as: 'designation', attributes: ['id', 'name'] }, { model: app.Employee, as: 'manager', attributes: ['id', 'firstName', 'lastName'] }],
    transaction: t,
  }));
  return ok(res, presentEmployee(e, true));
}));

/** Employees may update their own contact/emergency/address details only. */
employeesRouter.patch('/me', validate({ body: body.pick({ phone: true, personalEmail: true, address: true, emergencyContacts: true, maritalStatus: true }).partial().strict() }), asyncHandler(async (req, res) => {
  if (!req.auth.principal.employeeId) throw NotFound('Employee profile');
  const e = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(req.auth.principal.employeeId, { transaction: t, lock: t.LOCK.UPDATE });
    const before = Object.fromEntries(Object.keys(req.body).map((k) => [k, emp[k]]));
    await emp.update(req.body, { transaction: t });
    await history(t, req, emp.id, 'PROFILE_UPDATE', localDate(new Date(), req.auth.ctx.tenant.timezone), before, req.body, 'Self-service update');
    return emp;
  });
  return ok(res, presentEmployee(e, true));
}));

employeesRouter.get('/:id', requirePermission('employees:view'), validate(idParam), asyncHandler(async (req, res) => {
  const emp = await req.tx((t) => app.Employee.findOne({
    where: { [Op.and]: [{ id: req.params.id, deletedAt: null }, scopeWhere(req.scopes, req.auth.principal)] },
    include: [{ model: app.Branch, as: 'branch', attributes: ['id', 'name'] }, { model: app.Department, as: 'department', attributes: ['id', 'name'] }, { model: app.Designation, as: 'designation', attributes: ['id', 'name'] }, { model: app.Employee, as: 'manager', attributes: ['id', 'firstName', 'lastName'] }, { model: app.Shift, as: 'shift', attributes: ['id', 'name'] }],
    transaction: t,
  }));
  if (!emp) throw NotFound('Employee');
  const user = await req.tx((t) => app.User.findOne({ where: { employeeId: emp.id }, attributes: ['id', 'email', 'status'], transaction: t }));
  return ok(res, { ...presentEmployee(emp, canSeeSensitive(req, emp)), user });
}));

employeesRouter.get('/:id/history', requirePermission('employees:view'), validate(idParam), asyncHandler(async (req, res) => {
  const rows = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(req.params.id, { transaction: t });
    if (!emp || !recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Employee');
    return app.EmployeeHistory.findAll({ where: { employeeId: emp.id }, order: [['effectiveOn', 'DESC'], ['createdAt', 'DESC']], transaction: t });
  });
  return ok(res, rows);
}));

// --------------------------------------------------------------------------- create / update
employeesRouter.post('/', requirePermission('employees:create'), validate({ body }), asyncHandler(async (req, res) => {
  if (!recordInScope(req.scopes, req.auth.principal, { ...req.body, id: null })) throw Forbidden('You can only add employees within your own scope', 'OUT_OF_SCOPE');
  const emp = await req.tx((t) => createEmployee(req, t, req.body));
  return created(res, presentEmployee(emp, true));
}));

employeesRouter.patch('/:id', requirePermission('employees:edit'), validate({ ...idParam, body: body.partial().omit({ employeeCode: true }).extend({ effectiveOn: z.string().date().optional(), changeNote: z.string().max(300).optional() }) }),
  asyncHandler(async (req, res) => {
    const { effectiveOn, changeNote, ...patch } = req.body;
    const emp = await req.tx(async (t) => {
      const e = await app.Employee.findOne({ where: { [Op.and]: [{ id: req.params.id, deletedAt: null }, scopeWhere(req.scopes, req.auth.principal)] }, transaction: t, lock: t.LOCK.UPDATE });
      if (!e) throw NotFound('Employee');
      if (patch.managerId === e.id) throw BadRequest('An employee cannot report to themselves', [{ path: 'managerId', message: 'Invalid' }]);
      if (!recordInScope(req.scopes, req.auth.principal, { ...e.toJSON(), ...patch })) throw Forbidden('Change would move the employee outside your scope', 'OUT_OF_SCOPE');
      if (e.status === 'TERMINATED' && patch.status && patch.status !== 'TERMINATED') await assertWithinLimit(req.auth.ctx, 'employees', t);
      const before = e.toJSON();
      if (patch.bank) patch.bank = protectBank(patch.bank);
      await e.update(patch, { transaction: t });
      // Every tracked change is recorded as dated history (nothing is overwritten silently).
      const when = effectiveOn ?? localDate(new Date(), req.auth.ctx.tenant.timezone);
      const byType = {};
      for (const [k, type] of Object.entries(TRACKED)) {
        if (k in patch && String(before[k] ?? '') !== String(patch[k] ?? '')) (byType[type] ??= { from: {}, to: {} }) && Object.assign(byType[type].from, { [k]: before[k] }) && Object.assign(byType[type].to, { [k]: patch[k] });
      }
      for (const [type, v] of Object.entries(byType)) await history(t, req, e.id, type, when, v.from, v.to, changeNote);
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'employee.update', entityType: 'employee', entityId: e.id, before: Object.fromEntries(Object.keys(patch).filter((k) => k !== 'bank').map((k) => [k, before[k]])), after: Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'bank')), req });
      return e;
    });
    return ok(res, presentEmployee(emp, true));
  }));

/** Mark an employee as exited (also used when an offboarding journey completes). */
export async function terminateEmployee(req, t, e, { exitedOn, reason, note }) {
  if (e.status === 'TERMINATED') throw Conflict('Employee has already exited');
  if (exitedOn < e.joinedOn) throw BadRequest('Exit date is before the joining date');
  const before = { status: e.status };
  await e.update({ status: 'TERMINATED', exitedOn }, { transaction: t });
  await history(t, req, e.id, 'TERMINATION', exitedOn, before, { status: 'TERMINATED', reason }, note);
  await app.User.update({ status: 'DISABLED' }, { where: { employeeId: e.id }, transaction: t });
  await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'employee.terminate', entityType: 'employee', entityId: e.id, after: { exitedOn, reason, note }, req });
  return e;
}

/** Termination / resignation: sets exit date, frees the seat, disables login. History is preserved. */
employeesRouter.post('/:id/terminate', requirePermission('employees:manage'), validate({
  ...idParam, body: z.object({ exitedOn: z.string().date(), reason: z.enum(['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'CONTRACT_END', 'DEATH', 'OTHER']), note: z.string().max(1000).optional() }).strict(),
}), asyncHandler(async (req, res) => {
  const emp = await req.tx(async (t) => {
    const e = await app.Employee.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!e || !recordInScope(req.scopes, req.auth.principal, e)) throw NotFound('Employee');
    return terminateEmployee(req, t, e, req.body);
  });
  return ok(res, presentEmployee(emp, true));
}));

/**
 * Delete an employee created by mistake. Refused once they have been through payroll (those are
 * legal records: record an exit instead). Their login is disabled and its email released so the
 * same person can be added again; direct reports lose this manager. Attendance and leave rows stay
 * attached to the deleted record and drop out of lists and reports.
 */
employeesRouter.delete('/:id', requirePermission('employees:manage'), validate(idParam),
  asyncHandler(async (req, res) => {
    await req.tx(async (t) => {
      const e = await app.Employee.findOne({ where: { [Op.and]: [{ id: req.params.id, deletedAt: null }, scopeWhere(req.scopes, req.auth.principal)] }, transaction: t });
      if (!e) throw NotFound('Employee');
      if (e.id === req.auth.principal.employeeId) throw Conflict('You cannot delete your own employee record', 'SELF_DELETE');
      if (await app.PayrollItem.count({ where: { employeeId: e.id }, transaction: t })) {
        throw Conflict('This employee has payroll records, which must be kept. Use "Record exit" instead.', 'HAS_PAYROLL');
      }
      const user = await app.User.findOne({ where: { employeeId: e.id }, transaction: t });
      if (user) {
        if (user.id === req.auth.userId) throw Conflict('You cannot delete your own login', 'SELF_DELETE');
        await app.TenantInvitation.destroy({ where: { email: user.email, acceptedAt: null }, transaction: t });
        await user.update({ status: 'DISABLED', employeeId: null, email: `deleted-${user.id}@deleted.invalid` }, { transaction: t });
      }
      await app.Employee.update({ managerId: null }, { where: { managerId: e.id }, transaction: t });
      await e.update({ deletedAt: new Date(), biometricId: null }, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'employee.delete', entityType: 'employee', entityId: e.id,
        before: { employeeCode: e.employeeCode, name: `${e.firstName} ${e.lastName}`, workEmail: e.workEmail, status: e.status, hadLogin: !!user }, req });
    });
    return ok(res, { deleted: true });
  }));

/** Create a login for an employee (role Employee by default) and email an invitation. */
employeesRouter.post('/:id/invite', requirePermission('users:create'), validate({ ...idParam, body: z.object({ email: z.string().trim().toLowerCase().email().optional(), roleKey: z.string().max(60).default('employee') }).strict() }),
  asyncHandler(async (req, res) => {
    const token = randomToken();
    const result = await req.tx(async (t) => {
      const e = await app.Employee.findByPk(req.params.id, { transaction: t });
      if (!e || !recordInScope(req.scopes ?? [{ scope: 'COMPANY' }], req.auth.principal, e)) throw NotFound('Employee');
      const email = req.body.email ?? e.workEmail ?? e.personalEmail;
      if (!email) throw BadRequest('Add a work email to this employee first', [{ path: 'email', message: 'Required' }]);
      if (await app.User.findOne({ where: { [Op.or]: [{ employeeId: e.id }, { email }] }, transaction: t })) throw Conflict('This employee or email already has a login', 'USER_EXISTS');
      await assertWithinLimit(req.auth.ctx, 'users', t);
      const role = await app.Role.findOne({ where: { key: req.body.roleKey }, include: [{ model: app.RolePermission, as: 'grants', include: [{ model: app.Permission, as: 'permission' }] }], transaction: t });
      if (!role) throw NotFound('Role');
      for (const g of role.grants) {
        const mine = req.auth.grants.get(g.permission.key);
        if (!mine) throw Forbidden(`You cannot grant ${g.permission.key}`, 'ESCALATION_DENIED');
      }
      const u = await app.User.create({ tenantId: req.auth.tenantId, email, fullName: `${e.firstName} ${e.lastName}`, employeeId: e.id, status: 'INVITED' }, { transaction: t });
      await app.TenantInvitation.create({ tenantId: req.auth.tenantId, email, roleId: role.id, tokenHash: sha256(token), invitedById: req.auth.userId, expiresAt: new Date(Date.now() + 7 * 86_400_000) }, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'user.invite', entityType: 'user', entityId: u.id, after: { email, role: role.key, employeeId: e.id }, req });
      return { user: u, email };
    });
    await enqueueEmail({ tenantId: req.auth.tenantId, to: result.email, template: 'user.invitation', data: { token, companyName: req.auth.ctx.tenant.name, workspaceUrl: `https://${req.auth.ctx.tenant.slug}.${env.ROOT_DOMAIN}` } });
    return created(res, { userId: result.user.id, email: result.email, status: 'INVITED' });
  }));

// --------------------------------------------------------------------------- bulk import
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const HEADER_MAP = { 'employee id': 'employeeCode', 'first name': 'firstName', 'last name': 'lastName', 'work email': 'workEmail', phone: 'phone', branch: 'branch', department: 'department', designation: 'designation', 'employment type': 'employmentType', 'joined on': 'joinedOn', pan: 'pan', gender: 'gender', 'date of birth': 'dateOfBirth' };

/** CSV import (Excel → "Save as CSV UTF-8"). dryRun=true validates every row without saving. All-or-nothing. */
employeesRouter.post('/import', requirePermission('employees:import'), upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw BadRequest('Attach a CSV file', [{ path: 'file', message: 'Required' }]);
  const dryRun = req.query.dryRun === 'true';
  const [header, ...lines] = parseCsv(req.file.buffer.toString('utf8').replace(/^﻿/, ''));
  if (!header) throw BadRequest('The file is empty');
  const keys = header.map((h) => HEADER_MAP[h.trim().toLowerCase()]);
  if (!keys.includes('firstName') || !keys.includes('lastName') || !keys.includes('joinedOn')) throw BadRequest('Required columns: First name, Last name, Joined on (download the template)');
  if (lines.length > 2000) throw BadRequest('Import up to 2,000 employees per file');
  const result = await req.tx(async (t) => {
    const [branches, depts, desigs] = [await app.Branch.findAll({ where: { deletedAt: null }, transaction: t }), await app.Department.findAll({ where: { deletedAt: null }, transaction: t }), await app.Designation.findAll({ where: { deletedAt: null }, transaction: t })];
    const byName = (list, v) => list.find((x) => x.name.toLowerCase() === String(v).trim().toLowerCase() || x.code?.toLowerCase() === String(v).trim().toLowerCase());
    const errors = []; const parsed = [];
    lines.forEach((cells, i) => {
      const raw = Object.fromEntries(keys.map((k, j) => [k, cells[j]?.trim()]).filter(([k, v]) => k && v));
      const rowNo = i + 2;
      const data = { ...raw };
      for (const [k, list] of [['branch', branches], ['department', depts], ['designation', desigs]]) {
        if (raw[k]) { const m = byName(list, raw[k]); if (!m) errors.push({ row: rowNo, field: k, message: `Unknown ${k} "${raw[k]}"` }); else data[`${k}Id`] = m.id; }
        delete data[k];
      }
      if (data.employmentType) data.employmentType = data.employmentType.toUpperCase().replace(/[ -]/g, '_');
      if (data.gender) data.gender = data.gender.toUpperCase();
      const p = body.safeParse(data);
      if (!p.success) p.error.issues.forEach((x) => errors.push({ row: rowNo, field: x.path.join('.'), message: x.message }));
      else parsed.push(p.data);
    });
    const limit = req.auth.ctx.limits.employees;
    if (limit != null) {
      const current = await app.Employee.count({ where: { deletedAt: null, status: { [Op.ne]: 'TERMINATED' } }, transaction: t });
      if (current + parsed.length > limit) errors.push({ row: 0, field: 'file', message: `Your plan allows ${limit} employees; you have ${current} and are importing ${parsed.length}. Upgrade to import all.` });
    }
    if (errors.length) throw ValidationError(errors.slice(0, 200).map((e) => ({ path: `row ${e.row}: ${e.field}`, message: e.message })));
    if (dryRun) return { valid: parsed.length, imported: 0 };
    for (const d of parsed) await createEmployee(req, t, d);
    return { valid: parsed.length, imported: parsed.length };
  });
  return ok(res, result);
}));

employeesRouter.get('/import/template', requirePermission('employees:import'), (_req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="employee-import-template.csv"' });
  res.send('﻿Employee ID,First name,Last name,Work email,Phone,Branch,Department,Designation,Employment type,Joined on,PAN,Gender,Date of birth\r\n,Sita,Sharma,sita@company.com,9841000000,Head Office,,,Permanent,2026-01-15,123456789,Female,1995-04-10\r\n');
});

// --------------------------------------------------------------------------- documents (private storage)
const ALLOWED_MIME = { 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff] };
const sniffOk = (buf, mime) => (ALLOWED_MIME[mime] ?? []).every((b, i) => buf[i] === b) && !!ALLOWED_MIME[mime];

employeesRouter.get('/:id/documents', requirePermission('documents:view'), validate(idParam), asyncHandler(async (req, res) => {
  const rows = await req.tx(async (t) => {
    const e = await app.Employee.findByPk(req.params.id, { transaction: t });
    if (!e || !recordInScope(req.scopes, req.auth.principal, e)) throw NotFound('Employee');
    return app.File.findAll({ where: { ownerType: 'EMPLOYEE_DOCUMENT', ownerId: e.id, deletedAt: null }, attributes: { exclude: ['storageKey'] }, order: [['createdAt', 'DESC']], transaction: t });
  });
  return ok(res, rows);
}));

employeesRouter.post('/:id/documents', requirePermission('documents:create'), upload.single('file'), validate({ ...idParam, body: z.object({ category: z.string().trim().max(60).optional(), expiresOn: z.string().date().optional() }).strict() }),
  asyncHandler(async (req, res) => {
    const f = req.file;
    if (!f) throw BadRequest('Attach a file', [{ path: 'file', message: 'Required' }]);
    if (!sniffOk(f.buffer, f.mimetype)) throw BadRequest('Only PDF, PNG or JPEG files are allowed', [{ path: 'file', message: 'Unsupported file type' }]);
    const id = crypto.randomUUID();
    const key = `tenants/${req.auth.tenantId}/documents/${id}`;
    const row = await req.tx(async (t) => {
      const e = await app.Employee.findByPk(req.params.id, { transaction: t });
      if (!e || !recordInScope(req.scopes, req.auth.principal, e)) throw NotFound('Employee');
      await assertStorageAvailable(req.auth.ctx, f.size, t);
      await storage.put(key, f.buffer, f.mimetype); // malware-scanning hook: plug a ClamAV scan here before persisting
      const r = await app.File.create({ id, tenantId: req.auth.tenantId, ownerType: 'EMPLOYEE_DOCUMENT', ownerId: e.id, storageKey: key, filename: f.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 200), mimeType: f.mimetype, sizeBytes: f.size, sha256: crypto.createHash('sha256').update(f.buffer).digest('hex'), category: req.body.category, expiresOn: req.body.expiresOn, uploadedBy: req.auth.userId }, { transaction: t });
      await addUsage(req.auth.tenantId, 'storage_bytes', f.size, t);
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'document.upload', entityType: 'file', entityId: r.id, after: { employeeId: e.id, filename: r.filename }, req });
      return r;
    });
    const { storageKey, ...safe } = row.toJSON();
    return created(res, safe);
  }));

employeesRouter.get('/:id/documents/:fileId', requirePermission('documents:view'), validate({ params: z.object({ id: z.string().uuid(), fileId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const f = await req.tx(async (t) => {
    const e = await app.Employee.findByPk(req.params.id, { transaction: t });
    if (!e || !recordInScope(req.scopes, req.auth.principal, e)) throw NotFound('Employee');
    const file = await app.File.findOne({ where: { id: req.params.fileId, ownerId: e.id, deletedAt: null }, transaction: t });
    if (!file) throw NotFound('Document');
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'document.download', entityType: 'file', entityId: file.id, req });
    return file;
  });
  res.set({ 'Content-Type': f.mimeType, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  (await storage.stream(f.storageKey)).pipe(res);
}));

employeesRouter.delete('/:id/documents/:fileId', requirePermission('documents:delete'), validate({ params: z.object({ id: z.string().uuid(), fileId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const file = await app.File.findOne({ where: { id: req.params.fileId, ownerId: req.params.id, deletedAt: null }, transaction: t });
    if (!file) throw NotFound('Document');
    await file.update({ deletedAt: new Date() }, { transaction: t }); // soft delete; bytes purged by retention job
    await addUsage(req.auth.tenantId, 'storage_bytes', -Number(file.sizeBytes), t);
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'document.delete', entityType: 'file', entityId: file.id, req });
  });
  return ok(res, { deleted: true });
}));
