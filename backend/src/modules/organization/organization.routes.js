import { Router } from 'express';
import { z } from 'zod';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { assertWithinLimit } from '../../services/subscription.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta, searchWhere } from '../../utils/http.js';
import { NotFound, Conflict } from '../../utils/errors.js';

export const organizationRouter = Router();
const idParam = { params: z.object({ id: z.string().uuid() }) };
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,20}$/, 'Use 1–20 letters, numbers, - or _');

// =========================================================================== branches
const branchBody = z.object({
  code, name: z.string().trim().min(2).max(120), address: z.string().trim().max(500).nullish(),
  isHeadOffice: z.boolean().optional(), isActive: z.boolean().optional(),
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
