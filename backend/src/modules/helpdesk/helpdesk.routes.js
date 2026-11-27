import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { notifyUsers, usersWithPermission } from '../../services/hr/notify.js';
import { upload, checkUpload, saveUpload, sendFile } from '../../services/uploads.js';
import { EMP_ATTRS, empRef, scopesOf, isCompany, myEmployeeId, nextNumber, userNames, like, getSetting, putSetting, toCsv } from '../../services/module-kit.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * HR helpdesk: employees raise questions and requests to HR (payroll queries, documents, policies, grievances…)
 * and follow them to resolution. HR agents (helpdesk:manage) assign, reply, add internal notes and resolve.
 * Confidential tickets (e.g. grievances) are visible only to the requester, the assignee and helpdesk:configure holders.
 * Each category has a target resolution time, used to flag overdue tickets.
 */
export const helpdeskRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];
const OPEN = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export const DEFAULT_HELPDESK = {
  categories: [
    { code: 'PAYROLL', name: 'Salary and payslips', targetHours: 48, confidential: false, active: true },
    { code: 'TAX', name: 'Tax, SSF and PF', targetHours: 72, confidential: false, active: true },
    { code: 'LEAVE', name: 'Leave and attendance', targetHours: 24, confidential: false, active: true },
    { code: 'DOCUMENTS', name: 'Documents and letters', targetHours: 48, confidential: false, active: true },
    { code: 'POLICY', name: 'Policies and benefits', targetHours: 72, confidential: false, active: true },
    { code: 'IT', name: 'Equipment and access', targetHours: 24, confidential: false, active: true },
    { code: 'GRIEVANCE', name: 'Grievance or complaint', targetHours: 72, confidential: true, active: true },
    { code: 'OTHER', name: 'Something else', targetHours: 72, confidential: false, active: true },
  ],
};
const getConfig = (t) => getSetting(t, 'helpdesk.config', DEFAULT_HELPDESK);

const configBody = z.object({
  categories: z.array(z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, 'Use 2–20 letters, numbers or _'), name: z.string().trim().min(2).max(40),
    targetHours: z.number().int().min(1).max(720), confidential: z.boolean(), active: z.boolean(),
  }).strict()).min(1).max(30)
    .refine((c) => new Set(c.map((x) => x.code)).size === c.length, 'Each category needs its own code')
    .refine((c) => c.some((x) => x.active), 'Keep at least one category active'),
}).strict();

helpdeskRouter.get('/config', requirePermission('helpdesk:view'), asyncHandler(async (req, res) => ok(res, await req.tx((t) => getConfig(t)))));
helpdeskRouter.put('/config', requirePermission('helpdesk:configure'), validate({ body: configBody }), asyncHandler(async (req, res) => {
  const v = await req.tx(async (t) => {
    const before = await getConfig(t);
    const used = (await app.HrTicket.findAll({ attributes: ['category'], group: ['category'], raw: true, transaction: t })).map((r) => r.category);
    const missing = used.filter((c) => !req.body.categories.some((x) => x.code === c));
    if (missing.length) throw BadRequest(`Category ${missing.join(', ')} is used on tickets. Switch it off instead of removing it.`, [{ path: 'categories', message: 'In use' }]);
    await putSetting(t, req.auth.tenantId, 'helpdesk.config', req.body);
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'helpdesk.config', entityType: 'setting', entityId: 'helpdesk.config', before, after: req.body, req });
    return req.body;
  });
  return ok(res, v);
}));

// --------------------------------------------------------------------------- visibility
const isAgent = (req) => isCompany(scopesOf(req, 'helpdesk:manage'));
const isLead = (req) => isCompany(scopesOf(req, 'helpdesk:configure'));
function canSee(req, tk) {
  const own = tk.requesterId === req.auth.userId || (!!req.auth.principal.employeeId && tk.employeeId === req.auth.principal.employeeId);
  if (own) return true;
  if (tk.confidential) return tk.assigneeId === req.auth.userId || isLead(req);
  return isAgent(req) || isCompany(scopesOf(req, 'helpdesk:view'));
}
const agents = async (t) => usersWithPermission(t, 'helpdesk:manage');

function view(tk, cfg, extra = {}) {
  const cat = cfg.categories.find((c) => c.code === tk.category);
  return {
    id: tk.id, key: `HR-${tk.number}`, number: tk.number, subject: tk.subject, category: tk.category, categoryName: cat?.name ?? tk.category,
    priority: tk.priority, status: tk.status, confidential: tk.confidential, assigneeId: tk.assigneeId, dueAt: tk.dueAt,
    overdue: OPEN.includes(tk.status) && !!tk.dueAt && new Date(tk.dueAt) < new Date(),
    firstResponseAt: tk.firstResponseAt, resolvedAt: tk.resolvedAt, closedAt: tk.closedAt, satisfaction: tk.satisfaction,
    employee: tk.employee ? empRef(tk.employee) : undefined, createdAt: tk.createdAt, updatedAt: tk.updatedAt, ...extra,
  };
}

// --------------------------------------------------------------------------- list and summary
const listQ = z.object({
  view: z.enum(['mine', 'assigned', 'unassigned', 'open', 'all']).default('mine'), status: z.enum(STATUSES).optional(), category: z.string().max(20).optional(),
  search: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

helpdeskRouter.get('/tickets', requirePermission('helpdesk:view'), validate({ query: listQ }), asyncHandler(async (req, res) => {
  const q = req.query;
  const out = await req.tx(async (t) => {
    const cfg = await getConfig(t);
    const and = [];
    if (q.view === 'mine') and.push({ requesterId: req.auth.userId });
    else {
      if (!isAgent(req) && !isCompany(req.scopes)) return { rows: [], count: 0 };
      if (!isLead(req)) and.push({ [Op.or]: [{ confidential: false }, { assigneeId: req.auth.userId }] });
      if (q.view === 'assigned') and.push({ assigneeId: req.auth.userId, status: OPEN });
      if (q.view === 'unassigned') and.push({ assigneeId: null, status: OPEN });
      if (q.view === 'open') and.push({ status: OPEN });
    }
    if (q.status) and.push({ status: q.status });
    if (q.category) and.push({ category: q.category });
    if (q.search) {
      const n = Number(q.search.replace(/^hr-/i, ''));
      and.push({ [Op.or]: [{ subject: { [Op.iLike]: like(q.search) } }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])] });
    }
    const { rows, count } = await app.HrTicket.findAndCountAll({
      where: and.length ? { [Op.and]: and } : {}, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }],
      order: [['status', 'ASC'], ['updatedAt', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, transaction: t,
    });
    const names = await userNames(t, rows.map((r) => r.assigneeId));
    return { rows: rows.map((r) => view(r, cfg, { assignee: names[r.assigneeId] ?? null })), count };
  });
  return ok(res, out.rows, { page: q.page, pageSize: q.pageSize, total: out.count, totalPages: Math.ceil(out.count / q.pageSize) });
}));

helpdeskRouter.get('/summary', requirePermission('helpdesk:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const mine = await app.HrTicket.count({ where: { requesterId: req.auth.userId, status: OPEN }, transaction: t });
    if (!isAgent(req)) return { myOpen: mine };
    const vis = isLead(req) ? {} : { [Op.or]: [{ confidential: false }, { assigneeId: req.auth.userId }] };
    const [open, unassigned, assigned, overdue] = await Promise.all([
      app.HrTicket.count({ where: { ...vis, status: OPEN }, transaction: t }),
      app.HrTicket.count({ where: { ...vis, status: OPEN, assigneeId: null }, transaction: t }),
      app.HrTicket.count({ where: { status: OPEN, assigneeId: req.auth.userId }, transaction: t }),
      app.HrTicket.count({ where: { ...vis, status: OPEN, dueAt: { [Op.lt]: new Date() } }, transaction: t }),
    ]);
    const rated = await app.HrTicket.findAll({ where: { satisfaction: { [Op.ne]: null }, updatedAt: { [Op.gte]: new Date(Date.now() - 90 * 86_400_000) } }, attributes: ['satisfaction'], raw: true, transaction: t });
    const csat = rated.length ? Math.round((rated.reduce((a, r) => a + r.satisfaction, 0) / rated.length) * 10) / 10 : null;
    return { myOpen: mine, open, unassigned, assignedToMe: assigned, overdue, satisfaction: csat, ratedCount: rated.length };
  });
  return ok(res, out);
}));

helpdeskRouter.get('/agents', requirePermission('helpdesk:manage'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => { const ids = await agents(t); const n = await userNames(t, ids); return ids.map((id) => ({ id, name: n[id] })).sort((a, b) => a.name.localeCompare(b.name)); });
  return ok(res, out);
}));

helpdeskRouter.get('/export', requirePermission('helpdesk:export'), validate({ query: z.object({ from: z.string().date(), to: z.string().date() }).strict() }), asyncHandler(async (req, res) => {
  const { rows, cfg, names } = await req.tx(async (t) => {
    const list = await app.HrTicket.findAll({ where: { createdAt: { [Op.between]: [new Date(`${req.query.from}T00:00:00+05:45`), new Date(`${req.query.to}T23:59:59+05:45`)] }, ...(!isLead(req) && { confidential: false }) }, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }], order: [['number', 'ASC']], transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'helpdesk.export', after: { ...req.query, count: list.length }, req });
    return { rows: list, cfg: await getConfig(t), names: await userNames(t, list.map((x) => x.assigneeId)) };
  });
  const hrs = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / 3600_000) * 10) / 10 : '');
  const header = ['Ticket', 'Created', 'Employee', 'Category', 'Subject', 'Priority', 'Status', 'Assignee', 'First response (hours)', 'Resolution (hours)', 'Overdue', 'Satisfaction'];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="hr-helpdesk-${req.query.from}-to-${req.query.to}.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(toCsv(header, rows.map((x) => { const v = view(x, cfg); return [v.key, new Date(x.createdAt).toISOString().slice(0, 10), v.employee?.name, v.categoryName, x.confidential ? '(confidential)' : v.subject, v.priority.toLowerCase(), v.status.replace('_', ' ').toLowerCase(), names[x.assigneeId] ?? '', hrs(x.createdAt, x.firstResponseAt), hrs(x.createdAt, x.resolvedAt), x.resolvedAt && x.dueAt && new Date(x.resolvedAt) > new Date(x.dueAt) ? 'yes' : '', x.satisfaction ?? '']; })));
}));

// --------------------------------------------------------------------------- raise a ticket
helpdeskRouter.post('/tickets', requirePermission('helpdesk:create'), upload.single('attachment'), validate({ body: z.object({
  category: z.string().trim().min(1).max(20), subject: z.string().trim().min(3, 'Write a short subject').max(160),
  body: z.string().trim().min(5, 'Describe your question or request').max(5000), priority: z.enum(PRIORITIES).default('NORMAL'),
  confidential: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).optional(),
}).strict() }), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  if (req.file) checkUpload(req.file, 'attachment');
  const out = await req.tx(async (t) => {
    const cfg = await getConfig(t);
    const cat = cfg.categories.find((c) => c.code === req.body.category && c.active);
    if (!cat) throw BadRequest('Choose a category', [{ path: 'category', message: 'Choose one of the listed categories' }]);
    const confidential = cat.confidential || !!req.body.confidential;
    const tk = await app.HrTicket.create({
      tenantId: req.auth.tenantId, number: await nextNumber(t, 'hr_tickets'), employeeId, requesterId: req.auth.userId, category: cat.code, subject: req.body.subject,
      priority: req.body.priority, status: 'OPEN', confidential, dueAt: new Date(Date.now() + cat.targetHours * 3600_000),
    }, { transaction: t });
    const file = req.file ? await saveUpload(req, t, req.file, { ownerType: 'HELPDESK_ATTACHMENT', ownerId: tk.id, category: 'Helpdesk attachment', folder: 'helpdesk' }) : null;
    await app.HrTicketMessage.create({ tenantId: req.auth.tenantId, ticketId: tk.id, authorId: req.auth.userId, body: req.body.body, internal: false, attachmentFileId: file?.id ?? null }, { transaction: t });
    const emp = await app.Employee.findByPk(employeeId, { attributes: EMP_ATTRS, transaction: t });
    const to = confidential ? await usersWithPermission(t, 'helpdesk:configure') : await agents(t);
    await notifyUsers(t, to.filter((u) => u !== req.auth.userId), { type: 'helpdesk.new', title: `New HR request HR-${tk.number}${confidential ? ' (confidential)' : ''}`, body: `${emp.firstName} ${emp.lastName} · ${cat.name}${confidential ? '' : ` · ${req.body.subject}`}`, link: `/helpdesk/${tk.id}`, email: req.body.priority === 'URGENT' || confidential });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'helpdesk.create', entityType: 'hr_ticket', entityId: tk.id, after: { category: cat.code, priority: req.body.priority, confidential }, req });
    tk.employee = emp;
    return view(tk, cfg);
  });
  return created(res, out);
}));

// --------------------------------------------------------------------------- detail
async function loadTicket(req, t, id, { lock = false } = {}) {
  const tk = await app.HrTicket.findByPk(id, { transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!tk || !canSee(req, tk)) throw NotFound('Ticket');
  return tk;
}

helpdeskRouter.get('/tickets/:id', requirePermission('helpdesk:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const cfg = await getConfig(t);
    const tk = await loadTicket(req, t, req.params.id);
    tk.employee = await app.Employee.findByPk(tk.employeeId, { attributes: EMP_ATTRS, transaction: t });
    const agent = isAgent(req) && tk.requesterId !== req.auth.userId;
    const msgs = await app.HrTicketMessage.findAll({ where: { ticketId: tk.id, ...(!agent && { internal: false }) }, order: [['createdAt', 'ASC']], transaction: t });
    const names = await userNames(t, [...msgs.map((m) => m.authorId), tk.assigneeId]);
    const files = await app.File.findAll({ where: { id: msgs.map((m) => m.attachmentFileId).filter(Boolean) }, attributes: ['id', 'filename'], transaction: t });
    const fname = Object.fromEntries(files.map((f) => [f.id, f.filename]));
    const own = tk.requesterId === req.auth.userId;
    return view(tk, cfg, {
      assignee: names[tk.assigneeId] ?? null,
      messages: msgs.map((m) => ({ id: m.id, body: m.body, internal: m.internal, at: m.createdAt, by: names[m.authorId] ?? 'Former user', fromRequester: m.authorId === tk.requesterId, attachment: m.attachmentFileId ? { id: m.attachmentFileId, name: fname[m.attachmentFileId] } : null })),
      abilities: {
        reply: (own || agent) && tk.status !== 'CLOSED', note: agent, manage: agent && tk.status !== 'CLOSED',
        resolve: agent && OPEN.includes(tk.status), reopen: (own || agent) && tk.status === 'RESOLVED', close: own && tk.status === 'RESOLVED',
        rate: own && ['RESOLVED', 'CLOSED'].includes(tk.status) && !tk.satisfaction,
      },
    });
  });
  return ok(res, out);
}));

helpdeskRouter.get('/tickets/:id/attachments/:fileId', requirePermission('helpdesk:view'), validate({ params: z.object({ id: z.string().uuid(), fileId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const file = await req.tx(async (t) => {
    const tk = await loadTicket(req, t, req.params.id);
    const m = await app.HrTicketMessage.findOne({ where: { ticketId: tk.id, attachmentFileId: req.params.fileId }, transaction: t });
    if (!m || (m.internal && !(isAgent(req) && tk.requesterId !== req.auth.userId))) throw NotFound('Attachment');
    return app.File.findByPk(m.attachmentFileId, { transaction: t });
  });
  return sendFile(res, file);
}));

// --------------------------------------------------------------------------- reply, note, status
helpdeskRouter.post('/tickets/:id/messages', requirePermission('helpdesk:view'), upload.single('attachment'), validate({ ...idParam, body: z.object({
  body: z.string().trim().min(1, 'Write a message').max(5000), internal: z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]).default(false),
}).strict() }), asyncHandler(async (req, res) => {
  if (req.file) checkUpload(req.file, 'attachment');
  await req.tx(async (t) => {
    const tk = await loadTicket(req, t, req.params.id, { lock: true });
    const own = tk.requesterId === req.auth.userId;
    const agent = isAgent(req) && !own;
    if (!own && !agent) throw Forbidden('Only the employee and HR can reply.');
    if (tk.status === 'CLOSED') throw Conflict('This ticket is closed. Raise a new one if you need more help.', 'CLOSED');
    if (req.body.internal && !agent) throw Forbidden('Only HR can add internal notes.');
    const file = req.file ? await saveUpload(req, t, req.file, { ownerType: 'HELPDESK_ATTACHMENT', ownerId: tk.id, category: 'Helpdesk attachment', folder: 'helpdesk' }) : null;
    await app.HrTicketMessage.create({ tenantId: req.auth.tenantId, ticketId: tk.id, authorId: req.auth.userId, body: req.body.body, internal: req.body.internal, attachmentFileId: file?.id ?? null }, { transaction: t });
    const patch = {};
    if (agent && !req.body.internal) {
      if (!tk.firstResponseAt) patch.firstResponseAt = new Date();
      if (!tk.assigneeId) patch.assigneeId = req.auth.userId;
      if (tk.status === 'OPEN') patch.status = 'IN_PROGRESS';
      await notifyUsers(t, [tk.requesterId], { type: 'helpdesk.reply', title: `HR replied to HR-${tk.number}`, body: tk.confidential ? 'Open the ticket to read the reply.' : req.body.body.slice(0, 160), link: `/me/helpdesk/${tk.id}`, email: true });
    }
    if (own) {
      if (['WAITING', 'RESOLVED'].includes(tk.status)) patch.status = 'IN_PROGRESS';
      if (tk.status === 'RESOLVED') patch.resolvedAt = null;
      const to = tk.assigneeId ? [tk.assigneeId] : tk.confidential ? await usersWithPermission(t, 'helpdesk:configure') : await agents(t);
      await notifyUsers(t, to.filter((u) => u !== req.auth.userId), { type: 'helpdesk.reply', title: `New reply on HR-${tk.number}`, body: tk.confidential ? 'Confidential ticket' : tk.subject, link: `/helpdesk/${tk.id}` });
    }
    await app.HrTicket.update({ status: tk.status, ...patch }, { where: { id: tk.id }, transaction: t });
  });
  return created(res, { sent: true });
}));

helpdeskRouter.patch('/tickets/:id', requirePermission('helpdesk:manage'), validate({ ...idParam, body: z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED']), priority: z.enum(PRIORITIES), assigneeId: z.string().uuid().nullable(), category: z.string().trim().min(1).max(20),
}).partial().strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const cfg = await getConfig(t);
    const tk = await loadTicket(req, t, req.params.id, { lock: true });
    if (tk.requesterId === req.auth.userId) throw Forbidden('Someone else in HR should handle your own ticket.');
    if (tk.status === 'CLOSED') throw Conflict('This ticket is closed.');
    const b = req.body; const patch = { ...b };
    if (b.assigneeId) {
      const ok2 = (await agents(t)).includes(b.assigneeId);
      if (!ok2) throw BadRequest('Choose someone who works on HR tickets', [{ path: 'assigneeId', message: 'Not an HR agent' }]);
      if (tk.confidential && !((await usersWithPermission(t, 'helpdesk:configure')).includes(b.assigneeId))) throw BadRequest('Confidential tickets can only go to HR leads', [{ path: 'assigneeId', message: 'Not allowed' }]);
      if (b.assigneeId !== tk.assigneeId && b.assigneeId !== req.auth.userId) await notifyUsers(t, [b.assigneeId], { type: 'helpdesk.assigned', title: `HR-${tk.number} assigned to you`, body: tk.confidential ? 'Confidential ticket' : tk.subject, link: `/helpdesk/${tk.id}`, email: true });
    }
    if (b.category) {
      const cat = cfg.categories.find((c) => c.code === b.category);
      if (!cat) throw BadRequest('Choose a category', [{ path: 'category', message: 'Unknown' }]);
      patch.dueAt = new Date(new Date(tk.createdAt).getTime() + cat.targetHours * 3600_000);
      if (cat.confidential) patch.confidential = true;
    }
    if (b.status === 'RESOLVED' && tk.status !== 'RESOLVED') {
      patch.resolvedAt = new Date();
      await notifyUsers(t, [tk.requesterId], { type: 'helpdesk.resolved', title: `HR-${tk.number} is resolved`, body: 'If it is not sorted, reply to reopen it. Otherwise close it and tell us how we did.', link: `/me/helpdesk/${tk.id}`, email: true });
    }
    if (b.status && b.status !== 'RESOLVED') patch.resolvedAt = null;
    if (b.status === 'WAITING' && tk.status !== 'WAITING') await notifyUsers(t, [tk.requesterId], { type: 'helpdesk.waiting', title: `HR needs something from you on HR-${tk.number}`, link: `/me/helpdesk/${tk.id}` });
    const before = tk.toJSON();
    await tk.update(patch, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'helpdesk.update', entityType: 'hr_ticket', entityId: tk.id, before: Object.fromEntries(Object.keys(b).map((k) => [k, before[k]])), after: b, req });
    return view(tk, cfg);
  });
  return ok(res, out);
}));

/** The employee closes a resolved ticket, optionally rating the help they got. */
helpdeskRouter.post('/tickets/:id/close', requirePermission('helpdesk:view'), validate({ ...idParam, body: z.object({ satisfaction: z.number().int().min(1).max(5).optional(), note: z.string().trim().max(500).optional() }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const tk = await loadTicket(req, t, req.params.id, { lock: true });
    if (tk.requesterId !== req.auth.userId) throw Forbidden('Only the person who raised the ticket can close it.');
    if (!['RESOLVED', 'CLOSED'].includes(tk.status)) throw Conflict('HR has not resolved this ticket yet.');
    await tk.update({ status: 'CLOSED', closedAt: tk.closedAt ?? new Date(), ...(req.body.satisfaction && !tk.satisfaction && { satisfaction: req.body.satisfaction, satisfactionNote: req.body.note ?? null }) }, { transaction: t });
    if (req.body.satisfaction && tk.assigneeId) await notifyUsers(t, [tk.assigneeId], { type: 'helpdesk.rated', title: `HR-${tk.number} rated ${req.body.satisfaction}/5`, body: req.body.note, link: `/helpdesk/${tk.id}` });
  });
  return ok(res, { status: 'CLOSED' });
}));
