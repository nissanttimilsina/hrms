import { Router } from 'express';
import { z } from 'zod';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { assertWithinLimit } from '../../services/subscription.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta, searchWhere } from '../../utils/http.js';
import { NotFound, Conflict } from '../../utils/errors.js';
import { Op } from 'sequelize';

export const organizationRouter = Router();
const idParam = { params: z.object({ id: z.string().uuid() }) };
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/, 'Use 1–20 letters, numbers, - or _');

// =========================================================================== branches
const branchBody = z.object({
  code, name: z.string().trim().min(2).max(120), address: z.string().trim().max(500).nullish(),
  isHeadOffice: z.boolean().optional(), isActive: z.boolean().optional(),
  defaultShiftId: z.string().uuid().nullish(), // the branch's working schedule unless an employee has their own shift
}).strict();

organizationRouter.get('/branches', requirePermission('branches:view'),
  validate({ query: listQuery(['name', 'code', 'createdAt'], { includeInactive: z.coerce.boolean().default(false) }) }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const where = { deletedAt: null, ...(!q.includeInactive && { isActive: true }), ...searchWhere(q.search, ['name', 'code']) };
    const { rows, count } = await req.tx((t) => app.Branch.findAndCountAll({ where, ...paginate(q), transaction: t }));
    return ok(res, rows, pageMeta(q, count));
  }));

organizationRouter.post('/branches', requirePermission('branches:create'), validate({ body: branchBody }),
  asyncHandler(async (req, res) => {
    const branch = await req.tx(async (t) => {
      await assertWithinLimit(req.auth.ctx, 'branches', t);
      const b = await app.Branch.create({ ...req.body, tenantId: req.auth.tenantId }, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'branch.create', entityType: 'branch', entityId: b.id, after: b.toJSON(), req });
      return b;
    });
    return created(res, branch);
  }));

organizationRouter.patch('/branches/:id', requirePermission('branches:edit'), validate({ ...idParam, body: branchBody.partial() }),
  asyncHandler(async (req, res) => {
    const branch = await req.tx(async (t) => {
      const b = await app.Branch.findOne({ where: { id: req.params.id, deletedAt: null }, transaction: t, lock: t.LOCK.UPDATE });
      if (!b) throw NotFound('Branch');
      const before = b.toJSON();
      await b.update(req.body, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'branch.update', entityType: 'branch', entityId: b.id, before, after: b.toJSON(), req });
      return b;
    });
    return ok(res, branch);
  }));

organizationRouter.delete('/branches/:id', requirePermission('branches:delete'), validate(idParam),
  asyncHandler(async (req, res) => {
    await req.tx(async (t) => {
      const b = await app.Branch.findOne({ where: { id: req.params.id, deletedAt: null }, transaction: t, lock: t.LOCK.UPDATE });
      if (!b) throw NotFound('Branch');
      if (b.isHeadOffice) throw Conflict('The head office cannot be removed', 'HEAD_OFFICE');
      const inUse = await app.Employee.count({ where: { branchId: b.id, deletedAt: null }, transaction: t });
      if (inUse) throw Conflict(`Move the ${inUse} employee(s) in this branch first`, 'BRANCH_IN_USE');
      await b.update({ deletedAt: new Date(), isActive: false }, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'branch.delete', entityType: 'branch', entityId: b.id, req });
    });
    return ok(res, { deleted: true });
  }));

// =========================================================================== departments
const deptBody = z.object({
  code, name: z.string().trim().min(2).max(120),
  branchId: z.string().uuid().nullish(), parentId: z.string().uuid().nullish(),
}).strict();

organizationRouter.get('/departments', requirePermission('departments:view'),
  validate({ query: listQuery(['name', 'code', 'createdAt'], { branchId: z.string().uuid().optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const where = { deletedAt: null, ...(q.branchId && { branchId: q.branchId }), ...searchWhere(q.search, ['name', 'code']) };
    const { rows, count } = await req.tx((t) => app.Department.findAndCountAll({ where, ...paginate(q), transaction: t }));
    return ok(res, rows, pageMeta(q, count));
  }));

organizationRouter.post('/departments', requirePermission('departments:create'), validate({ body: deptBody }),
  asyncHandler(async (req, res) => {
    const dept = await req.tx(async (t) => {
      const d = await app.Department.create({ ...req.body, tenantId: req.auth.tenantId }, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'department.create', entityType: 'department', entityId: d.id, after: d.toJSON(), req });
      return d;
    });
    return created(res, dept);
  }));

organizationRouter.patch('/departments/:id', requirePermission('departments:edit'), validate({ ...idParam, body: deptBody.partial() }),
  asyncHandler(async (req, res) => {
    const dept = await req.tx(async (t) => {
      const d = await app.Department.findOne({ where: { id: req.params.id, deletedAt: null }, transaction: t, lock: t.LOCK.UPDATE });
      if (!d) throw NotFound('Department');
      const before = d.toJSON();
      await d.update(req.body, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'department.update', entityType: 'department', entityId: d.id, before, after: d.toJSON(), req });
      return d;
    });
    return ok(res, dept);
  }));

organizationRouter.delete('/departments/:id', requirePermission('departments:delete'), validate(idParam),
  asyncHandler(async (req, res) => {
    await req.tx(async (t) => {
      const d = await app.Department.findOne({ where: { id: req.params.id, deletedAt: null }, transaction: t, lock: t.LOCK.UPDATE });
      if (!d) throw NotFound('Department');
      const inUse = await app.Employee.count({ where: { departmentId: d.id, deletedAt: null }, transaction: t });
      if (inUse) throw Conflict(`Move the ${inUse} employee(s) in this department first`, 'DEPARTMENT_IN_USE');
      await d.update({ deletedAt: new Date() }, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'department.delete', entityType: 'department', entityId: d.id, req });
    });
    return ok(res, { deleted: true });
  }));

// =========================================================================== designations
const desigBody = z.object({ name: z.string().trim().min(2).max(120), level: z.number().int().min(0).max(100).nullish() }).strict();
organizationRouter.get('/designations', requirePermission('departments:view'), asyncHandler(async (req, res) =>
  ok(res, await req.tx((t) => app.Designation.findAll({ where: { deletedAt: null }, order: [['level', 'ASC NULLS LAST'], ['name', 'ASC']], transaction: t })))));
organizationRouter.post('/designations', requirePermission('departments:create'), validate({ body: desigBody }), asyncHandler(async (req, res) =>
  created(res, await req.tx((t) => app.Designation.create({ ...req.body, tenantId: req.auth.tenantId }, { transaction: t })))));
organizationRouter.patch('/designations/:id', requirePermission('departments:edit'), validate({ ...idParam, body: desigBody.partial() }), asyncHandler(async (req, res) => {
  const d = await req.tx(async (t) => { const r = await app.Designation.findByPk(req.params.id, { transaction: t }); if (!r) throw NotFound('Designation'); return r.update(req.body, { transaction: t }); });
  return ok(res, d);
}));
organizationRouter.delete('/designations/:id', requirePermission('departments:delete'), validate(idParam), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const r = await app.Designation.findByPk(req.params.id, { transaction: t });
    if (!r) throw NotFound('Designation');
    if (await app.Employee.count({ where: { designationId: r.id, deletedAt: null }, transaction: t })) throw Conflict('Designation is in use', 'IN_USE');
    await r.update({ deletedAt: new Date() }, { transaction: t });
  });
  return ok(res, { deleted: true });
}));

// =========================================================================== shifts
const shiftBody = z.object({
  name: z.string().trim().min(2).max(80), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/),
  breakMinutes: z.number().int().min(0).max(600).default(60), graceMinutes: z.number().int().min(0).max(240).default(10),
  weeklyOffs: z.array(z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'])).max(6).default(['SAT']), isDefault: z.boolean().default(false),
  // Different hours on some weekdays, e.g. { FRI: { start: '10:00', end: '15:00', breakMinutes: 0 } }
  dayHours: z.partialRecord(z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']), z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), breakMinutes: z.number().int().min(0).max(600).optional(),
  }).strict()).default({}),
}).strict();
organizationRouter.get('/shifts', requirePermission('shifts:view'), asyncHandler(async (req, res) =>
  ok(res, await req.tx((t) => app.Shift.findAll({ where: { deletedAt: null }, order: [['name', 'ASC']], transaction: t })))));
organizationRouter.post('/shifts', requirePermission('shifts:create'), validate({ body: shiftBody }), asyncHandler(async (req, res) => {
  const s = await req.tx(async (t) => {
    if (req.body.isDefault) await app.Shift.update({ isDefault: false }, { where: { isDefault: true }, transaction: t });
    const r = await app.Shift.create({ ...req.body, tenantId: req.auth.tenantId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'shift.create', entityType: 'shift', entityId: r.id, after: req.body, req });
    return r;
  });
  return created(res, s);
}));
organizationRouter.patch('/shifts/:id', requirePermission('shifts:edit'), validate({ ...idParam, body: shiftBody.partial() }), asyncHandler(async (req, res) => {
  const s = await req.tx(async (t) => {
    const r = await app.Shift.findByPk(req.params.id, { transaction: t });
    if (!r) throw NotFound('Shift');
    if (req.body.isDefault) await app.Shift.update({ isDefault: false }, { where: { isDefault: true, id: { [Op.ne]: r.id } }, transaction: t });
    return r.update(req.body, { transaction: t });
  });
  return ok(res, s);
}));
organizationRouter.post('/shifts/:id/assign', requirePermission('shifts:manage'), validate({ ...idParam, body: z.object({ employeeIds: z.array(z.string().uuid()).min(1).max(1000) }).strict() }), asyncHandler(async (req, res) => {
  const n = await req.tx(async (t) => {
    if (!(await app.Shift.count({ where: { id: req.params.id, deletedAt: null }, transaction: t }))) throw NotFound('Shift');
    const [count] = await app.Employee.update({ shiftId: req.params.id }, { where: { id: req.body.employeeIds }, transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'shift.assign', entityType: 'shift', entityId: req.params.id, after: { employees: req.body.employeeIds.length }, req });
    return count;
  });
  return ok(res, { assigned: n });
}));
