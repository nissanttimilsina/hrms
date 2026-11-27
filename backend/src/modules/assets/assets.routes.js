import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, addDays } from '../../services/hr/calendar.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { EMP_ATTRS, empRef, scopesOf, isCompany, myEmployeeId, employeeIdsIn, employeeInScope, nextNumber, userNames, like, toCsv, optText } from '../../services/module-kit.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, NotFound } from '../../utils/errors.js';

/**
 * Asset management: a register of company equipment (laptops, phones, vehicles, ID cards…), who holds what,
 * and a dated history of every hand-over, return, repair and problem report.
 *   assets:view (scoped by holder), assets:create (register), assets:edit (details, hand over, take back, status),
 *   assets:export. Employees see their own items under My assets and can report a problem.
 */
export const assetsRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const STATUSES = ['AVAILABLE', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'LOST'];
const CONDITIONS = ['NEW', 'GOOD', 'FAIR', 'POOR', 'DAMAGED'];
export const ASSET_CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Mobile phone', 'Tablet', 'SIM card', 'ID card', 'Access card', 'Vehicle', 'Furniture', 'Tools', 'Other'];
const NONE = ['00000000-0000-0000-0000-000000000000']; // matches no row
const num = (v) => (v == null ? null : Number(v));

function view(a, extra = {}) {
  return {
    id: a.id, key: `AST-${a.number}`, number: a.number, name: a.name, category: a.category, assetTag: a.assetTag, serialNo: a.serialNo,
    brandModel: a.brandModel, branchId: a.branchId, branch: a.branch ? a.branch.name : undefined, purchaseDate: a.purchaseDate,
    purchaseCost: num(a.purchaseCost), vendor: a.vendor, warrantyUntil: a.warrantyUntil, condition: a.condition, status: a.status,
    holder: a.holder ? empRef(a.holder) : null, assignedAt: a.assignedAt, dueBackOn: a.dueBackOn, notes: a.notes, createdAt: a.createdAt, ...extra,
  };
}

async function loadAsset(req, t, id, { lock = false, scopes = req.scopes } = {}) {
  const a = await app.Asset.findByPk(id, { transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!a) throw NotFound('Asset');
  a.holder = a.assignedEmployeeId ? await app.Employee.findByPk(a.assignedEmployeeId, { attributes: EMP_ATTRS, transaction: t }) : null;
  if (!isCompany(scopes) && !employeeInScope(req, scopes, a.holder)) throw NotFound('Asset');
  return a;
}

const event = (req, t, assetId, type, data = {}) => app.AssetEvent.create({ tenantId: req.auth.tenantId, assetId, type, authorId: req.auth.userId, ...data }, { transaction: t });
const managers = (t) => usersWithPermission(t, 'assets:edit');

// --------------------------------------------------------------------------- list, summary, mine
const listQ = z.object({
  status: z.enum(STATUSES).optional(), category: z.string().max(40).optional(), employeeId: z.string().uuid().optional(), branchId: z.string().uuid().optional(),
  warranty: z.enum(['expiring', 'expired']).optional(), search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

assetsRouter.get('/', requirePermission('assets:view'), validate({ query: listQ }), asyncHandler(async (req, res) => {
  const q = req.query;
  const tz = req.auth.ctx.tenant.timezone;
  const out = await req.tx(async (t) => {
    const and = [];
    const ids = await employeeIdsIn(t, req, req.scopes);
    if (ids) and.push({ assignedEmployeeId: ids.length ? ids : NONE });
    for (const k of ['status', 'category', 'branchId']) if (q[k]) and.push({ [k]: q[k] });
    if (q.employeeId) and.push({ assignedEmployeeId: q.employeeId });
    const today = localDate(new Date(), tz);
    if (q.warranty === 'expiring') and.push({ warrantyUntil: { [Op.between]: [today, addDays(today, 60)] }, status: { [Op.notIn]: ['RETIRED', 'LOST'] } });
    if (q.warranty === 'expired') and.push({ warrantyUntil: { [Op.lt]: today }, status: { [Op.notIn]: ['RETIRED', 'LOST'] } });
    if (q.search) {
      const s = like(q.search);
      const n = Number(q.search.replace(/^ast-/i, ''));
      and.push({ [Op.or]: [{ name: { [Op.iLike]: s } }, { assetTag: { [Op.iLike]: s } }, { serialNo: { [Op.iLike]: s } }, { brandModel: { [Op.iLike]: s } }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])] });
    }
    const { rows, count } = await app.Asset.findAndCountAll({
      where: and.length ? { [Op.and]: and } : {},
      include: [{ model: app.Employee, as: 'holder', attributes: EMP_ATTRS }, { model: app.Branch, as: 'branch', attributes: ['name'] }],
      order: [['number', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, transaction: t,
    });
    return { rows: rows.map((a) => view(a)), count };
  });
  return ok(res, out.rows, { page: q.page, pageSize: q.pageSize, total: out.count, totalPages: Math.ceil(out.count / q.pageSize) });
}));

assetsRouter.get('/summary', requirePermission('assets:view'), asyncHandler(async (req, res) => {
  const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
  const out = await req.tx(async (t) => {
    const ids = await employeeIdsIn(t, req, req.scopes);
    const base = ids ? { assignedEmployeeId: ids.length ? ids : NONE } : {};
    const rows = await app.Asset.findAll({ where: base, attributes: ['status', 'purchaseCost', 'warrantyUntil', 'dueBackOn'], raw: true, transaction: t });
    const by = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let value = 0; let expiring = 0; let overdue = 0;
    for (const r of rows) {
      by[r.status] += 1;
      if (!['RETIRED', 'LOST'].includes(r.status)) value += Number(r.purchaseCost ?? 0);
      if (r.warrantyUntil && r.warrantyUntil >= today && r.warrantyUntil <= addDays(today, 60) && !['RETIRED', 'LOST'].includes(r.status)) expiring += 1;
      if (r.status === 'ASSIGNED' && r.dueBackOn && r.dueBackOn < today) overdue += 1;
    }
    return { total: rows.length, byStatus: by, inUseValue: Math.round(value * 100) / 100, warrantyExpiring: expiring, overdueReturns: overdue };
  });
  return ok(res, out);
}));

assetsRouter.get('/categories', requirePermission('assets:view'), asyncHandler(async (req, res) => {
  const used = await req.tx((t) => app.Asset.findAll({ attributes: ['category'], group: ['category'], raw: true, transaction: t }));
  return ok(res, [...new Set([...ASSET_CATEGORIES, ...used.map((u) => u.category)])]);
}));

/** What I hold now, and what I held before. */
assetsRouter.get('/mine', requirePermission('assets:view'), asyncHandler(async (req, res) => {
  const me = req.auth.principal.employeeId;
  if (!me) return ok(res, { current: [], history: [] });
  const out = await req.tx(async (t) => {
    const current = await app.Asset.findAll({ where: { assignedEmployeeId: me }, order: [['assignedAt', 'DESC']], transaction: t });
    const past = await app.AssetEvent.findAll({ where: { employeeId: me, type: 'RETURNED' }, order: [['createdAt', 'DESC']], limit: 20, transaction: t });
    const assets = await app.Asset.findAll({ where: { id: [...new Set(past.map((e) => e.assetId))] }, attributes: ['id', 'number', 'name', 'category'], transaction: t });
    const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
    return {
      current: current.map((a) => view(a)),
      history: past.map((e) => ({ assetId: e.assetId, key: `AST-${byId[e.assetId]?.number}`, name: byId[e.assetId]?.name, category: byId[e.assetId]?.category, returnedAt: e.createdAt, condition: e.condition })),
    };
  });
  return ok(res, out);
}));

assetsRouter.get('/export', requirePermission('assets:export'), asyncHandler(async (req, res) => {
  const rows = await req.tx(async (t) => {
    const ids = await employeeIdsIn(t, req, req.scopes);
    const list = await app.Asset.findAll({ where: ids ? { assignedEmployeeId: ids.length ? ids : NONE } : {}, include: [{ model: app.Employee, as: 'holder', attributes: EMP_ATTRS }, { model: app.Branch, as: 'branch', attributes: ['name'] }], order: [['number', 'ASC']], transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'assets.export', after: { count: list.length }, req });
    return list.map((a) => view(a));
  });
  const header = ['Asset', 'Name', 'Category', 'Tag', 'Serial number', 'Brand / model', 'Branch', 'Status', 'Condition', 'Held by', 'Employee ID', 'Since', 'Purchase date', 'Cost (NPR)', 'Vendor', 'Warranty until'];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="assets.csv"', 'Cache-Control': 'private, no-store' });
  res.send(toCsv(header, rows.map((a) => [a.key, a.name, a.category, a.assetTag, a.serialNo, a.brandModel, a.branch, a.status.replace('_', ' ').toLowerCase(), a.condition.toLowerCase(), a.holder?.name, a.holder?.code, a.assignedAt ? String(a.assignedAt.toISOString?.() ?? a.assignedAt).slice(0, 10) : '', a.purchaseDate, a.purchaseCost, a.vendor, a.warrantyUntil])));
}));

// --------------------------------------------------------------------------- register and edit
const assetBody = z.object({
  name: z.string().trim().min(2, 'Name the item').max(120),
  category: z.string().trim().min(1, 'Choose a category').max(40),
  assetTag: optText(z, 60), serialNo: optText(z, 80), brandModel: optText(z, 120),
  branchId: z.string().uuid().nullish(),
  purchaseDate: z.string().date().nullish(), purchaseCost: z.number().min(0).max(1e10).nullish(), vendor: optText(z, 120),
  warrantyUntil: z.string().date().nullish(),
  condition: z.enum(CONDITIONS).default('GOOD'),
  notes: optText(z, 1000),
}).strict();
const assetPatch = z.object({
  name: z.string().trim().min(2).max(120), category: z.string().trim().min(1).max(40),
  assetTag: optText(z, 60), serialNo: optText(z, 80), brandModel: optText(z, 120), branchId: z.string().uuid().nullish(),
  purchaseDate: z.string().date().nullish(), purchaseCost: z.number().min(0).max(1e10).nullish(), vendor: optText(z, 120),
  warrantyUntil: z.string().date().nullish(), condition: z.enum(CONDITIONS), notes: optText(z, 1000),
}).partial().strict();

async function assertTagFree(t, tag, exceptId) {
  if (!tag) return;
  const dup = await app.Asset.findOne({ where: { assetTag: { [Op.iLike]: tag.replace(/[%_\\]/g, '\\$&') }, ...(exceptId && { id: { [Op.ne]: exceptId } }) }, transaction: t });
  if (dup) throw Conflict(`Tag ${tag} is already used by AST-${dup.number} (${dup.name}).`, 'DUPLICATE_TAG');
}

assetsRouter.post('/', requirePermission('assets:create'), validate({ body: assetBody }), asyncHandler(async (req, res) => {
  const a = await req.tx(async (t) => {
    await assertTagFree(t, req.body.assetTag);
    const row = await app.Asset.create({ ...req.body, tenantId: req.auth.tenantId, number: await nextNumber(t, 'assets'), status: 'AVAILABLE', createdBy: req.auth.userId }, { transaction: t });
    await event(req, t, row.id, 'CREATED', { condition: row.condition });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'asset.create', entityType: 'asset', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, view(a));
}));

assetsRouter.get('/:id', requirePermission('assets:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const scopes = scopesOf(req, 'assets:view');
    const a = await loadAsset(req, t, req.params.id, { scopes });
    if (a.branchId) a.branch = await app.Branch.findByPk(a.branchId, { attributes: ['name'], transaction: t });
    const events = await app.AssetEvent.findAll({ where: { assetId: a.id }, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }], order: [['createdAt', 'DESC']], transaction: t });
    const names = await userNames(t, events.map((e) => e.authorId));
    const canEdit = isCompany(scopesOf(req, 'assets:edit'));
    const mine = a.assignedEmployeeId && a.assignedEmployeeId === req.auth.principal.employeeId;
    return view(a, {
      history: events.map((e) => ({ id: e.id, type: e.type, at: e.createdAt, employee: empRef(e.employee), condition: e.condition, note: e.note, by: names[e.authorId] ?? null })),
      abilities: {
        edit: canEdit, assign: canEdit && a.status === 'AVAILABLE', return: canEdit && a.status === 'ASSIGNED',
        setStatus: canEdit && a.status !== 'ASSIGNED', report: !!mine,
      },
    });
  });
  return ok(res, out);
}));

assetsRouter.patch('/:id', requirePermission('assets:edit'), validate({ ...idParam, body: assetPatch }), asyncHandler(async (req, res) => {
  const a = await req.tx(async (t) => {
    const row = await loadAsset(req, t, req.params.id, { lock: true });
    if ('assetTag' in req.body) await assertTagFree(t, req.body.assetTag, row.id);
    const before = row.toJSON();
    await row.update(req.body, { transaction: t });
    const changed = Object.keys(req.body).filter((k) => String(before[k] ?? '') !== String(req.body[k] ?? ''));
    if (changed.length) await event(req, t, row.id, 'UPDATED', { note: `Changed ${changed.join(', ')}`, condition: 'condition' in req.body ? req.body.condition : null });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'asset.update', entityType: 'asset', entityId: row.id, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, req.body[k]])), req });
    return row;
  });
  return ok(res, view(a));
}));

// --------------------------------------------------------------------------- hand over, take back, status, problem report
assetsRouter.post('/:id/assign', requirePermission('assets:edit'), validate({
  ...idParam, body: z.object({ employeeId: z.string().uuid(), dueBackOn: z.string().date().nullish(), condition: z.enum(CONDITIONS).optional(), note: optText(z, 1000) }).strict(),
}), asyncHandler(async (req, res) => {
  const a = await req.tx(async (t) => {
    const row = await loadAsset(req, t, req.params.id, { lock: true });
    if (row.status !== 'AVAILABLE') throw Conflict(row.status === 'ASSIGNED' ? 'This item is already with someone. Take it back first.' : `This item is ${row.status.replace('_', ' ').toLowerCase()} and cannot be handed over.`, 'NOT_AVAILABLE');
    const emp = await app.Employee.findOne({ where: { id: req.body.employeeId, deletedAt: null }, attributes: EMP_ATTRS, transaction: t });
    if (!emp || emp.status === 'TERMINATED') throw BadRequest('Choose a current employee', [{ path: 'employeeId', message: 'Not a current employee' }]);
    const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
    if (req.body.dueBackOn && req.body.dueBackOn < today) throw BadRequest('The return date is in the past', [{ path: 'dueBackOn', message: 'Past date' }]);
    await row.update({ status: 'ASSIGNED', assignedEmployeeId: emp.id, assignedAt: new Date(), dueBackOn: req.body.dueBackOn ?? null, ...(req.body.condition && { condition: req.body.condition }) }, { transaction: t });
    await event(req, t, row.id, 'ASSIGNED', { employeeId: emp.id, condition: row.condition, note: req.body.note });
    const u = await userIdForEmployee(t, emp.id);
    await notifyUsers(t, [u], { type: 'asset.assigned', title: `${row.name} (AST-${row.number}) handed over to you`, body: req.body.note ?? 'It is now listed under My assets. Report a problem there if anything is wrong with it.', link: '/me/assets' });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'asset.assign', entityType: 'asset', entityId: row.id, after: req.body, req });
    row.holder = emp;
    return row;
  });
  return ok(res, view(a));
}));

assetsRouter.post('/:id/return', requirePermission('assets:edit'), validate({
  ...idParam, body: z.object({ condition: z.enum(CONDITIONS), note: optText(z, 1000), toRepair: z.boolean().default(false) }).strict(),
}), asyncHandler(async (req, res) => {
  const a = await req.tx(async (t) => {
    const row = await loadAsset(req, t, req.params.id, { lock: true });
    if (row.status !== 'ASSIGNED') throw Conflict('This item is not with anyone.', 'NOT_ASSIGNED');
    const from = row.assignedEmployeeId;
    const next = req.body.toRepair || req.body.condition === 'DAMAGED' ? 'IN_REPAIR' : 'AVAILABLE';
    await row.update({ status: next, assignedEmployeeId: null, assignedAt: null, dueBackOn: null, condition: req.body.condition }, { transaction: t });
    await event(req, t, row.id, 'RETURNED', { employeeId: from, condition: req.body.condition, note: req.body.note });
    if (next === 'IN_REPAIR') await event(req, t, row.id, 'IN_REPAIR', { condition: req.body.condition, note: 'Sent for repair on return' });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'asset.return', entityType: 'asset', entityId: row.id, after: { from, ...req.body }, req });
    row.holder = null;
    return row;
  });
  return ok(res, view(a));
}));

assetsRouter.post('/:id/status', requirePermission('assets:edit'), validate({
  ...idParam, body: z.object({ status: z.enum(['AVAILABLE', 'IN_REPAIR', 'RETIRED', 'LOST']), note: optText(z, 1000) }).strict(),
}), asyncHandler(async (req, res) => {
  const a = await req.tx(async (t) => {
    const row = await loadAsset(req, t, req.params.id, { lock: true });
    if (row.status === 'ASSIGNED') throw Conflict('Take the item back before changing its status.', 'ASSIGNED');
    if (row.status === req.body.status) throw Conflict(`The item is already ${row.status.replace('_', ' ').toLowerCase()}.`);
    if (['RETIRED', 'LOST'].includes(req.body.status) && !req.body.note) throw BadRequest('Say why', [{ path: 'note', message: 'Give a reason' }]);
    await row.update({ status: req.body.status }, { transaction: t });
    await event(req, t, row.id, req.body.status, { note: req.body.note });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'asset.status', entityType: 'asset', entityId: row.id, after: req.body, req });
    return row;
  });
  return ok(res, view(a));
}));

/** The holder reports a problem (broken, lost, needs replacing). Asset managers are notified. */
assetsRouter.post('/:id/report', requirePermission('assets:view'), validate({ ...idParam, body: z.object({ note: z.string().trim().min(5, 'Describe the problem').max(1000), lost: z.boolean().default(false) }).strict() }), asyncHandler(async (req, res) => {
  const me = myEmployeeId(req);
  await req.tx(async (t) => {
    const row = await app.Asset.findByPk(req.params.id, { transaction: t });
    if (!row || row.assignedEmployeeId !== me) throw NotFound('Asset');
    await event(req, t, row.id, 'ISSUE', { employeeId: me, note: `${req.body.lost ? 'Reported lost: ' : ''}${req.body.note}` });
    const emp = await app.Employee.findByPk(me, { attributes: EMP_ATTRS, transaction: t });
    await notifyUsers(t, await managers(t), { type: 'asset.issue', title: `${req.body.lost ? 'Lost' : 'Problem with'} ${row.name} (AST-${row.number})`, body: `${emp.firstName} ${emp.lastName}: ${req.body.note}`, link: `/assets/${row.id}`, email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'asset.issue', entityType: 'asset', entityId: row.id, after: req.body, req });
  });
  return ok(res, { reported: true });
}));

/** Items an employee still holds (used by offboarding). */
export async function assetsHeldBy(t, employeeId) {
  return (await app.Asset.findAll({ where: { assignedEmployeeId: employeeId }, order: [['number', 'ASC']], transaction: t })).map((a) => view(a));
}
