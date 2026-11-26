import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { assertWithinLimit } from '../../services/subscription.service.js';
import { scopeWhere, recordInScope } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta, searchWhere } from '../../utils/http.js';
import { NotFound, Forbidden } from '../../utils/errors.js';

/**
 * Employee foundation (Phase 1): enough to exercise limits, data scopes and
 * isolation end-to-end. Full lifecycle (history, transfers, contracts, salary)
 * is Phase 4 and will build on these tables without breaking this API.
 */
export const employeesRouter = Router();

const STATUSES = ['ACTIVE', 'PROBATION', 'ON_NOTICE', 'SUSPENDED', 'TERMINATED'];
const body = z.object({
  employeeCode: z.string().trim().max(30).regex(/^[A-Za-z0-9_-]+$/).optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  workEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
  phone: z.string().trim().regex(/^\+?[0-9 -]{7,20}$/, 'Invalid phone number').nullish(),
  branchId: z.string().uuid().nullish(),
  departmentId: z.string().uuid().nullish(),
  managerId: z.string().uuid().nullish(),
  status: z.enum(STATUSES).default('ACTIVE'),
  joinedOn: z.string().date(),
}).strict();
const idParam = { params: z.object({ id: z.string().uuid() }) };

const PUBLIC_ATTRS = ['id', 'employeeCode', 'firstName', 'lastName', 'workEmail', 'phone', 'branchId', 'departmentId', 'managerId', 'status', 'joinedOn', 'exitedOn', 'createdAt', 'updatedAt'];

/** Next code from the tenant's configurable format; row-locked so codes never collide. */
async function nextEmployeeCode(tenantId, t) {
  const setting = await app.TenantSetting.findOne({ where: { key: 'org.employee_id_format' }, transaction: t, lock: t.LOCK.UPDATE });
  const fmt = setting?.value ?? { prefix: 'EMP-', padding: 4, next: 1 };
  for (let n = fmt.next; ; n += 1) {
    const candidate = `${fmt.prefix}${String(n).padStart(fmt.padding, '0')}`;
    const taken = await app.Employee.count({ where: { employeeCode: candidate }, transaction: t });
    if (!taken) {
      if (setting) await setting.update({ value: { ...fmt, next: n + 1 } }, { transaction: t });
      else await app.TenantSetting.create({ tenantId, key: 'org.employee_id_format', value: { ...fmt, next: n + 1 } }, { transaction: t });
      return candidate;
    }
  }
}

employeesRouter.get('/', requirePermission('employees:view'),
  validate({ query: listQuery(['createdAt', 'lastName', 'firstName', 'employeeCode', 'joinedOn'], {
    status: z.enum(STATUSES).optional(), branchId: z.string().uuid().optional(), departmentId: z.string().uuid().optional(),
  }) }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const where = {
      [Op.and]: [
        { deletedAt: null },
        scopeWhere(req.scopes, req.auth.principal),
        searchWhere(q.search, ['firstName', 'lastName', 'employeeCode', 'workEmail']),
        ...(q.status ? [{ status: q.status }] : []),
        ...(q.branchId ? [{ branchId: q.branchId }] : []),
        ...(q.departmentId ? [{ departmentId: q.departmentId }] : []),
      ],
    };
    const { rows, count } = await req.tx((t) => app.Employee.findAndCountAll({ where, attributes: PUBLIC_ATTRS, ...paginate(q), transaction: t }));
    return ok(res, rows, pageMeta(q, count));
  }));

employeesRouter.get('/:id', requirePermission('employees:view'), validate(idParam), asyncHandler(async (req, res) => {
  const emp = await req.tx((t) => app.Employee.findOne({
    where: { [Op.and]: [{ id: req.params.id, deletedAt: null }, scopeWhere(req.scopes, req.auth.principal)] },
    attributes: PUBLIC_ATTRS,
    include: [{ model: app.Branch, as: 'branch', attributes: ['id', 'name'] }, { model: app.Department, as: 'department', attributes: ['id', 'name'] }],
    transaction: t,
  }));
  if (!emp) throw NotFound('Employee'); // out-of-scope looks identical to missing
  return ok(res, emp);
}));

employeesRouter.post('/', requirePermission('employees:create'), validate({ body }), asyncHandler(async (req, res) => {
  if (!recordInScope(req.scopes, req.auth.principal, { ...req.body, id: null })) {
    throw Forbidden('You can only add employees within your own scope', 'OUT_OF_SCOPE');
  }
  const emp = await req.tx(async (t) => {
    if (req.body.status !== 'TERMINATED') await assertWithinLimit(req.auth.ctx, 'employees', t);
    const employeeCode = req.body.employeeCode ?? (await nextEmployeeCode(req.auth.tenantId, t));
    const e = await app.Employee.create({ ...req.body, employeeCode, tenantId: req.auth.tenantId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'employee.create', entityType: 'employee', entityId: e.id, after: e.toJSON(), req });
    return e;
  });
  return created(res, emp);
}));

employeesRouter.patch('/:id', requirePermission('employees:edit'), validate({ ...idParam, body: body.partial().omit({ employeeCode: true }) }),
  asyncHandler(async (req, res) => {
    const emp = await req.tx(async (t) => {
      const e = await app.Employee.findOne({
        where: { [Op.and]: [{ id: req.params.id, deletedAt: null }, scopeWhere(req.scopes, req.auth.principal)] },
        transaction: t, lock: t.LOCK.UPDATE,
      });
      if (!e) throw NotFound('Employee');
      const next = { ...e.toJSON(), ...req.body };
      if (!recordInScope(req.scopes, req.auth.principal, next)) throw Forbidden('Change would move the employee outside your scope', 'OUT_OF_SCOPE');
      // Re-activating a terminated employee consumes a seat.
      if (e.status === 'TERMINATED' && req.body.status && req.body.status !== 'TERMINATED') {
        await assertWithinLimit(req.auth.ctx, 'employees', t);
      }
      const before = e.toJSON();
      await e.update(req.body, { transaction: t });
      await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'employee.update', entityType: 'employee', entityId: e.id, before, after: e.toJSON(), req });
      return e;
    });
    return ok(res, emp);
  }));
