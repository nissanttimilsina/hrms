import { Router } from 'express';
import { z } from 'zod';
import { app } from '../../database/index.js';
import { env } from '../../config/env.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { getSetting } from '../../services/settings.service.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta } from '../../utils/http.js';
import { NotFound, Conflict } from '../../utils/errors.js';

/** Company → Lishnu Tech support tickets (mounted with allowWhenReadOnly so locked-out customers can still get help). */
export const tenantSupportRouter = Router();
const idParam = { params: z.object({ id: z.string().uuid() }) };

tenantSupportRouter.get('/', requirePermission('support:view'), validate({ query: listQuery(['createdAt', 'updatedAt'], { status: z.string().max(30).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows, count } = await req.tx((t) => app.SupportTicket.findAndCountAll({ where: q.status ? { status: q.status } : {}, ...paginate(q), transaction: t }));
    return ok(res, rows, pageMeta(q, count));
  }));

tenantSupportRouter.post('/', requirePermission('support:create'), validate({
  body: z.object({
    subject: z.string().trim().min(5).max(200), body: z.string().trim().min(10).max(10_000),
    category: z.enum(['GENERAL', 'BILLING', 'TECHNICAL', 'FEATURE_REQUEST', 'BUG', 'ACCOUNT']).default('GENERAL'),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  }).strict(),
}), asyncHandler(async (req, res) => {
  const sla = await getSetting('support.sla_hours');
  const ticket = await req.tx(async (t) => {
    const tk = await app.SupportTicket.create({
      tenantId: req.auth.tenantId, subject: req.body.subject, category: req.body.category, priority: req.body.priority,
      createdBy: req.auth.userId, firstResponseDueAt: new Date(Date.now() + (sla[req.body.priority] ?? 24) * 3_600_000),
    }, { transaction: t, fields: ['tenantId', 'subject', 'category', 'priority', 'createdBy', 'firstResponseDueAt'] });
    await app.SupportMessage.create({ tenantId: req.auth.tenantId, ticketId: tk.id, authorType: 'TENANT_USER', authorId: req.auth.userId, body: req.body.body }, { transaction: t });
    return tk.reload({ transaction: t });
  });
  if (env.SALES_NOTIFY_EMAIL) {
    await enqueueEmail({ to: env.SALES_NOTIFY_EMAIL, template: 'support.new_ticket', data: { id: ticket.id, number: ticket.number, subject: ticket.subject, priority: ticket.priority, tenant: req.auth.ctx.tenant.name } });
  }
  return created(res, ticket);
}));

tenantSupportRouter.get('/:id', requirePermission('support:view'), validate(idParam), asyncHandler(async (req, res) => {
  const tk = await req.tx((t) => app.SupportTicket.findByPk(req.params.id, {
    include: [{ model: app.SupportMessage, as: 'messages', separate: true, order: [['createdAt', 'ASC']] }], transaction: t,
  }));
  if (!tk) throw NotFound('Ticket'); // internal notes are filtered out by RLS policy
  return ok(res, tk);
}));

tenantSupportRouter.post('/:id/messages', requirePermission('support:create'), validate({ ...idParam, body: z.object({ body: z.string().trim().min(1).max(10_000) }).strict() }),
  asyncHandler(async (req, res) => {
    const msg = await req.tx(async (t) => {
      const tk = await app.SupportTicket.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (!tk) throw NotFound('Ticket');
      if (tk.status === 'CLOSED') throw Conflict('This ticket is closed. Please open a new one.');
      if (['WAITING_ON_CUSTOMER', 'RESOLVED'].includes(tk.status)) await tk.update({ status: 'OPEN' }, { transaction: t });
      return app.SupportMessage.create({ tenantId: req.auth.tenantId, ticketId: tk.id, authorType: 'TENANT_USER', authorId: req.auth.userId, body: req.body.body }, { transaction: t });
    });
    return created(res, msg);
  }));

tenantSupportRouter.post('/:id/rate', requirePermission('support:create'), validate({ ...idParam, body: z.object({ satisfaction: z.number().int().min(1).max(5) }).strict() }),
  asyncHandler(async (req, res) => {
    await req.tx(async (t) => {
      const tk = await app.SupportTicket.findByPk(req.params.id, { transaction: t });
      if (!tk) throw NotFound('Ticket');
      if (!['RESOLVED', 'CLOSED'].includes(tk.status)) throw Conflict('You can rate a ticket once it is resolved');
      await tk.update({ satisfaction: req.body.satisfaction }, { transaction: t });
    });
    return ok(res, { rated: true });
  }));

