import { Op } from 'sequelize';
import { z } from 'zod';

/** Standard response envelope: { success, data, meta? } */
export const ok = (res, data, meta, status = 200) =>
  res.status(status).json(meta ? { success: true, data, meta } : { success: true, data });

export const created = (res, data) => ok(res, data, undefined, 201);

/** Wrap async route handlers so rejections reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Shared list-query schema: pagination, sorting (whitelisted), free-text search.
 * Usage: const q = listQuery(['createdAt','lastName']).parse(req.query)
 */
export const listQuery = (sortable, extra = {}) =>
  z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      sort: z.enum(sortable).default(sortable[0]),
      order: z.enum(['asc', 'desc']).default('desc'),
      search: z.string().trim().max(100).optional(),
      ...extra,
    })
    .strict();

export const paginate = ({ page, pageSize, sort, order }) => ({
  limit: pageSize,
  offset: (page - 1) * pageSize,
  order: [[sort, order.toUpperCase()]],
});

export const pageMeta = ({ page, pageSize }, total) => ({
  page,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});

/** Case-insensitive search across columns. Input is parameterised by Sequelize. */
export const searchWhere = (search, columns) =>
  search ? { [Op.or]: columns.map((c) => ({ [c]: { [Op.iLike]: `%${search.replace(/[%_\\]/g, '\\$&')}%` } })) } : {};
