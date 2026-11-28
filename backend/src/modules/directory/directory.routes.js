import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { validate } from '../../middleware/common.js';
import { like } from '../../services/module-kit.js';
import { asyncHandler, ok } from '../../utils/http.js';

/**
 * Colleague directory for pickers (recognition, 360° feedback, interviewers…): current employees with name,
 * code, department and designation only. Every signed-in user of the company can search it.
 */
export const directoryRouter = Router();

directoryRouter.get('/', validate({ query: z.object({ search: z.string().trim().max(80).optional(), ids: z.string().max(4000).optional(), withLogin: z.coerce.boolean().optional() }).strict() }), asyncHandler(async (req, res) => {
  const { search, ids, withLogin } = req.query;
  const out = await req.tx(async (t) => {
    const where = { deletedAt: null, status: { [Op.ne]: 'TERMINATED' } };
    if (ids) where.id = ids.split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 100);
    if (search) where[Op.or] = [{ firstName: { [Op.iLike]: like(search) } }, { lastName: { [Op.iLike]: like(search) } }, { employeeCode: { [Op.iLike]: like(search) } }];
    const rows = await app.Employee.findAll({
      where, attributes: ['id', 'firstName', 'lastName', 'employeeCode'],
      include: [{ model: app.Department, as: 'department', attributes: ['name'] }, { model: app.Designation, as: 'designation', attributes: ['name'] }],
      order: [['firstName', 'ASC'], ['lastName', 'ASC']], limit: ids ? 100 : 30, transaction: t,
    });
    const users = withLogin ? await app.User.findAll({ where: { employeeId: rows.map((r) => r.id), status: 'ACTIVE' }, attributes: ['id', 'employeeId'], transaction: t }) : [];
    return rows.map((e) => ({
      id: e.id, name: `${e.firstName} ${e.lastName}`, code: e.employeeCode, department: e.department?.name ?? null, designation: e.designation?.name ?? null,
      ...(withLogin && { userId: users.find((u) => u.employeeId === e.id)?.id ?? null }),
    }));
  });
  return ok(res, out);
}));
