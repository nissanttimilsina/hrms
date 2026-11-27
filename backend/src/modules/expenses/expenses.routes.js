import { Router } from 'express';
import { z } from 'zod';
import { Op, QueryTypes } from 'sequelize';
import crypto from 'node:crypto';
import { app, appDb } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { scopeWhere, recordInScope } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, addDays, BS_MONTHS, toBS, fromBS } from '../../services/hr/calendar.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from '../../services/hr/notify.js';
import { upload, checkUpload, saveUpload, sendFile } from '../../services/uploads.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

/**
 * Expense claims.
 *   Employee submits a claim (with a receipt photo or PDF) → their manager approves → finance approves
 *   (and may reduce the amount) → finance pays it with a payroll month (as a non-taxable reimbursement)
 *   or directly (cash / bank transfer, with a reference).
 * "Finance" means holding expenses:approve at COMPANY scope. When the employee has no manager who can
 * approve expenses, the claim goes straight to finance.
 */
export const expensesRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const PERIOD = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a BS year-month, e.g. 2083-08');
const STATUSES = ['SUBMITTED', 'MANAGER_APPROVED', 'APPROVED', 'REJECTED', 'CANCELLED', 'SCHEDULED', 'PAID'];
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const fmt = (n) => `NPR ${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const periodLabel = (p) => { const [y, m] = p.split('-').map(Number); return `${BS_MONTHS[m - 1]} ${y}`; };
const EMP_ATTRS = ['id', 'firstName', 'lastName', 'employeeCode', 'managerId', 'departmentId', 'branchId'];

// --------------------------------------------------------------------------- policy
export const DEFAULT_EXPENSE_POLICY = {
  maxAgeDays: 60,
  receiptRequiredAbove: 500,
  categories: [
    { code: 'TRAVEL', name: 'Travel and transport', limit: null, active: true },
    { code: 'FUEL', name: 'Fuel', limit: null, active: true },
    { code: 'MEALS', name: 'Meals', limit: null, active: true },
    { code: 'LODGING', name: 'Accommodation', limit: null, active: true },
    { code: 'PHONE', name: 'Phone and internet', limit: null, active: true },
    { code: 'OFFICE', name: 'Office supplies', limit: null, active: true },
    { code: 'CLIENT', name: 'Client meetings', limit: null, active: true },
    { code: 'TRAINING', name: 'Training and courses', limit: null, active: true },
    { code: 'MEDICAL', name: 'Medical', limit: null, active: true },
    { code: 'OTHER', name: 'Other', limit: null, active: true },
  ],
};

async function getPolicy(t) {
  const row = await app.TenantSetting.findOne({ where: { key: 'expenses.policy' }, transaction: t });
  return { ...DEFAULT_EXPENSE_POLICY, ...(row?.value ?? {}) };
}

const policyBody = z.object({
  maxAgeDays: z.number().int().min(1).max(365),
  receiptRequiredAbove: z.number().min(0).max(10_000_000),
  categories: z.array(z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, 'Use 2–20 letters, numbers or _'),
    name: z.string().trim().min(2).max(40),
    limit: z.number().positive().max(10_000_000).nullable(),
    active: z.boolean(),
  }).strict()).min(1).max(40)
    .refine((c) => new Set(c.map((x) => x.code)).size === c.length, 'Each category needs its own code')
    .refine((c) => c.some((x) => x.active), 'Keep at least one category active'),
}).strict();

expensesRouter.get('/policy', requirePermission('expenses:view'), asyncHandler(async (req, res) => ok(res, await req.tx((t) => getPolicy(t)))));

expensesRouter.put('/policy', requirePermission('expenses:configure'), validate({ body: policyBody }), asyncHandler(async (req, res) => {
  const value = await req.tx(async (t) => {
    const before = await getPolicy(t);
    // Categories already used on claims cannot disappear; they can only be switched off.
    const used = (await appDb.query('SELECT DISTINCT category FROM expense_claims', { type: QueryTypes.SELECT, transaction: t })).map((r) => r.category);
    const missing = used.filter((c) => !req.body.categories.some((x) => x.code === c));
    if (missing.length) throw BadRequest(`Category ${missing.join(', ')} is used on existing claims. Switch it off instead of removing it.`, [{ path: 'categories', message: 'Category in use' }]);
    const [row] = await app.TenantSetting.findOrCreate({ where: { key: 'expenses.policy' }, defaults: { tenantId: req.auth.tenantId, value: req.body }, transaction: t });
    await row.update({ value: req.body }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'expenses.policy_update', entityType: 'setting', entityId: 'expenses.policy', before, after: req.body, req });
    return req.body;
  });
  return ok(res, value);
}));

// --------------------------------------------------------------------------- helpers
const scopesOf = (req, key) => req.auth.grants.get(key)?.scopes ?? [];
const isCompany = (scopes) => scopes.some((s) => s.scope === 'COMPANY');

function myEmployeeId(req) {
  if (!req.auth.principal.employeeId) throw BadRequest('Your account is not linked to an employee record. Ask HR to link it.', [{ path: 'employee', message: 'Not linked' }]);
  return req.auth.principal.employeeId;
}

/** Employee ids inside a set of scopes; null means every employee (COMPANY). */
async function idsIn(t, req, scopes) {
  if (isCompany(scopes)) return null;
  if (!scopes.length) return [];
  const rows = await app.Employee.findAll({ where: { [Op.and]: [scopeWhere(scopes, req.auth.principal), { deletedAt: null }] }, attributes: ['id'], raw: true, transaction: t });
  return rows.map((r) => r.id);
}

async function nextNumber(t) {
  await appDb.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `expense_claims:${t.tenantId}` }, transaction: t });
  const [{ n }] = await appDb.query('SELECT coalesce(max(number), 0) + 1 AS n FROM expense_claims', { type: QueryTypes.SELECT, transaction: t });
  return Number(n);
}

/** Does this (active) user hold a permission at any scope? */
async function userHolds(t, userId, key) {
  if (!userId) return false;
  const rows = await appDb.query(
    `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id WHERE u.id = :u AND u.status = 'ACTIVE' AND p.key = :k LIMIT 1`,
    { replacements: { u: userId, k: key }, type: QueryTypes.SELECT, transaction: t },
  );
  return rows.length > 0;
}

const financeUsers = async (t, exceptUserId) => (await usersWithPermission(t, 'expenses:approve')).filter((u) => u !== exceptUserId);

function abilities(req, c, emp) {
  const own = !!req.auth.principal.employeeId && c.employeeId === req.auth.principal.employeeId;
  const appr = scopesOf(req, 'expenses:approve');
  const rej = scopesOf(req, 'expenses:reject');
  const finance = isCompany(appr);
  const inScope = (scopes) => scopes.length > 0 && !!emp && recordInScope(scopes, req.auth.principal, emp);
  return {
    approve: !own && inScope(appr) && (finance ? ['SUBMITTED', 'MANAGER_APPROVED'] : ['SUBMITTED']).includes(c.status),
    changeAmount: !own && finance && ['SUBMITTED', 'MANAGER_APPROVED'].includes(c.status),
    reject: !own && inScope(rej) && (isCompany(rej) ? ['SUBMITTED', 'MANAGER_APPROVED'] : ['SUBMITTED']).includes(c.status),
    pay: !own && finance && c.status === 'APPROVED',
    payWithSalary: !own && finance && c.status === 'APPROVED' && req.auth.grants.has('payroll:edit') && req.auth.ctx.features.includes('payroll'),
    unschedule: !own && finance && c.status === 'SCHEDULED' && req.auth.grants.has('payroll:edit'),
    cancel: own && c.status === 'SUBMITTED',
  };
}

function view(c, policy) {
  const cat = policy.categories.find((x) => x.code === c.category);
  const amount = Number(c.amount);
  return {
    id: c.id, key: `EXP-${c.number}`, number: c.number, title: c.title, category: c.category, categoryName: cat?.name ?? c.category,
    expenseDate: c.expenseDate, amount, merchant: c.merchant, description: c.description, hasReceipt: !!c.receiptFileId,
    status: c.status, limit: cat?.limit ?? null, overLimit: cat?.limit != null && amount > cat.limit,
    approvedAmount: c.approvedAmount != null ? Number(c.approvedAmount) : null,
    payable: c.approvedAmount != null ? Number(c.approvedAmount) : amount,
    employee: c.employee ? { id: c.employee.id, name: `${c.employee.firstName} ${c.employee.lastName}`, code: c.employee.employeeCode } : undefined,
    needsManager: !!c.managerUserId, managerDecidedAt: c.managerDecidedAt, managerNote: c.managerNote,
    approvedAt: c.approvedAt, financeNote: c.financeNote, rejectedAt: c.rejectedAt, rejectReason: c.rejectReason,
    payoutMethod: c.payoutMethod, payrollPeriod: c.payrollPeriod, payrollLabel: c.payrollPeriod ? periodLabel(c.payrollPeriod) : null,
    paidAt: c.paidAt, paymentRef: c.paymentRef, createdAt: c.createdAt,
  };
}

/** Load a claim the caller may see: their own, or one inside the scopes passed. */
async function loadClaim(req, t, id, scopes, { lock = false } = {}) {
  // Lock the claim row on its own: PostgreSQL cannot lock rows through the outer join an include creates.
  const c = await app.ExpenseClaim.findByPk(id, { transaction: t, ...(lock && { lock: t.LOCK.UPDATE }) });
  if (!c) throw NotFound('Expense claim');
  c.employee = await app.Employee.findByPk(c.employeeId, { attributes: EMP_ATTRS, transaction: t });
  const own = c.employeeId === req.auth.principal.employeeId;
  if (!own && !(scopes.length && recordInScope(scopes, req.auth.principal, c.employee))) throw NotFound('Expense claim');
  return c;
}

async function names(t, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return {};
  const users = await app.User.findAll({ where: { id: ids }, attributes: ['id', 'fullName'], transaction: t });
  return Object.fromEntries(users.map((u) => [u.id, u.fullName]));
}

/** Payroll for this month is already submitted or approved, so it cannot take new items. */
async function assertPeriodOpen(t, period) {
  const run = await app.PayrollRun.findOne({ where: { period, status: { [Op.in]: ['SUBMITTED', 'APPROVED', 'PAID'] } }, transaction: t });
  if (run) throw Conflict(`Payroll for ${periodLabel(period)} is already ${run.status.toLowerCase()}. Choose a later month or pay directly.`, 'PERIOD_LOCKED');
  return app.PayrollRun.findOne({ where: { period, status: 'CALCULATED' }, transaction: t });
}

// --------------------------------------------------------------------------- list & summary
const listQ = z.object({
  view: z.enum(['mine', 'team', 'queue']).default('mine'),
  status: z.string().optional().transform((s) => (s ? s.split(',').filter((x) => STATUSES.includes(x)) : undefined)),
  employeeId: z.string().uuid().optional(),
  from: z.string().date().optional(), to: z.string().date().optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

expensesRouter.get('/', requirePermission('expenses:view'), validate({ query: listQ }), asyncHandler(async (req, res) => {
  const q = req.query;
  const out = await req.tx(async (t) => {
    const policy = await getPolicy(t);
    const and = [];
    if (q.view === 'mine') {
      if (!req.auth.principal.employeeId) return { rows: [], count: 0, total: 0 };
      and.push({ employeeId: req.auth.principal.employeeId });
    } else if (q.view === 'team') {
      const ids = await idsIn(t, req, req.scopes);
      if (ids) and.push({ employeeId: ids });
    } else {
      // What this person can act on now.
      const appr = scopesOf(req, 'expenses:approve');
      if (!appr.length) return { rows: [], count: 0, total: 0 };
      const ids = await idsIn(t, req, appr);
      if (ids) and.push({ employeeId: ids });
      and.push({ status: isCompany(appr) ? ['SUBMITTED', 'MANAGER_APPROVED', 'APPROVED'] : ['SUBMITTED'] });
      if (req.auth.principal.employeeId) and.push({ employeeId: { [Op.ne]: req.auth.principal.employeeId } });
    }
    if (q.status?.length) and.push({ status: q.status });
    if (q.employeeId) and.push({ employeeId: q.employeeId });
    if (q.from) and.push({ expenseDate: { [Op.gte]: q.from } });
    if (q.to) and.push({ expenseDate: { [Op.lte]: q.to } });
    if (q.search) {
      const s = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`;
      const n = Number(q.search.replace(/^exp-/i, ''));
      and.push({ [Op.or]: [{ title: { [Op.iLike]: s } }, { merchant: { [Op.iLike]: s } }, ...(Number.isInteger(n) && n > 0 ? [{ number: n }] : [])] });
    }
    const where = and.length ? { [Op.and]: and } : {};
    const { rows, count } = await app.ExpenseClaim.findAndCountAll({
      where, include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }],
      order: [['createdAt', 'DESC']], limit: q.pageSize, offset: (q.page - 1) * q.pageSize, transaction: t,
    });
    const total = Number((await app.ExpenseClaim.sum('amount', { where, transaction: t })) ?? 0);
    return { rows: rows.map((c) => ({ ...view(c, policy), abilities: abilities(req, c, c.employee) })), count, total };
  });
  return ok(res, out.rows, { page: q.page, pageSize: q.pageSize, total: out.count, totalPages: Math.ceil(out.count / q.pageSize), totalAmount: r2(out.total) });
}));

expensesRouter.get('/summary', requirePermission('expenses:view'), asyncHandler(async (req, res) => {
  const tz = req.auth.ctx.tenant.timezone;
  const out = await req.tx(async (t) => {
    const me = req.auth.principal.employeeId;
    let mine = null;
    if (me) {
      const bs = toBS(localDate(new Date(), tz));
      const fyStartYear = bs.month >= 3 ? bs.year : bs.year - 1;
      const [row] = await appDb.query(
        `SELECT count(*) FILTER (WHERE status IN ('SUBMITTED','MANAGER_APPROVED'))::int AS pending,
                coalesce(sum(amount) FILTER (WHERE status IN ('SUBMITTED','MANAGER_APPROVED')), 0)::float AS pending_amount,
                coalesce(sum(coalesce(approved_amount, amount)) FILTER (WHERE status IN ('APPROVED','SCHEDULED')), 0)::float AS to_receive,
                coalesce(sum(coalesce(approved_amount, amount)) FILTER (WHERE status = 'PAID' AND expense_date >= :fy), 0)::float AS paid_this_year
           FROM expense_claims WHERE employee_id = :me`,
        { replacements: { me, fy: fromBS(fyStartYear, 3, 1) }, type: QueryTypes.SELECT, transaction: t },
      );
      mine = { pending: row.pending, pendingAmount: r2(row.pending_amount), toReceive: r2(row.to_receive), paidThisYear: r2(row.paid_this_year) };
    }
    const appr = scopesOf(req, 'expenses:approve');
    let queue = null; let toPay = null;
    if (appr.length) {
      const ids = await idsIn(t, req, appr);
      const base = [ids && { employeeId: ids }, me && { employeeId: { [Op.ne]: me } }].filter(Boolean);
      queue = await app.ExpenseClaim.count({ where: { [Op.and]: [...base, { status: isCompany(appr) ? ['SUBMITTED', 'MANAGER_APPROVED'] : ['SUBMITTED'] }] }, transaction: t });
      if (isCompany(appr)) toPay = await app.ExpenseClaim.count({ where: { [Op.and]: [...base, { status: 'APPROVED' }] }, transaction: t });
    }
    return { mine, queue, toPay };
  });
  return ok(res, out);
}));

// --------------------------------------------------------------------------- export
expensesRouter.get('/export', requirePermission('expenses:export'), validate({ query: z.object({ from: z.string().date(), to: z.string().date(), status: z.enum(STATUSES).optional() }).strict() }), asyncHandler(async (req, res) => {
  const { from, to, status } = req.query;
  if (from > to) throw BadRequest('The start date must be before the end date');
  const { rows, policy } = await req.tx(async (t) => {
    const ids = await idsIn(t, req, req.scopes);
    const list = await app.ExpenseClaim.findAll({
      where: { expenseDate: { [Op.between]: [from, to] }, ...(status && { status }), ...(ids && { employeeId: ids }) },
      include: [{ model: app.Employee, as: 'employee', attributes: EMP_ATTRS }], order: [['expenseDate', 'ASC'], ['number', 'ASC']], transaction: t,
    });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'expenses.export', after: { from, to, status, count: list.length }, req });
    return { rows: list, policy: await getPolicy(t) };
  });
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@\t]/, "'$&")}"`;
  const header = ['Claim', 'Employee ID', 'Employee', 'Category', 'Title', 'Merchant', 'Expense date', 'Claimed (NPR)', 'Approved (NPR)', 'Status', 'Paid via', 'Payroll month', 'Paid on', 'Reference'];
  const lines = rows.map((c) => { const v = view(c, policy); return [v.key, v.employee.code, v.employee.name, v.categoryName, v.title, v.merchant, v.expenseDate, v.amount, v.approvedAmount ?? '', v.status.replace(/_/g, ' ').toLowerCase(), v.payoutMethod === 'PAYROLL' ? 'Salary' : v.payoutMethod === 'DIRECT' ? 'Direct payment' : '', v.payrollLabel ?? '', v.paidAt ? localDate(new Date(v.paidAt), req.auth.ctx.tenant.timezone) : '', v.paymentRef ?? '']; });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="expenses-${from}-to-${to}.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(`﻿${[header.map(esc).join(','), ...lines.map((l) => l.map(esc).join(','))].join('\r\n')}`);
}));

// --------------------------------------------------------------------------- submit
const text = (max) => z.string().trim().max(max).optional().transform((v) => v || null);
const claimBody = z.object({
  category: z.string().trim().min(1).max(40),
  title: z.string().trim().min(3, 'Describe the expense in a few words').max(160),
  expenseDate: z.string().date(),
  amount: z.coerce.number().positive('Enter the amount').max(10_000_000),
  merchant: text(120),
  description: text(1000),
}).strict();

expensesRouter.post('/', requirePermission('expenses:create'), upload.single('receipt'), validate({ body: claimBody }), asyncHandler(async (req, res) => {
  const employeeId = myEmployeeId(req);
  const tz = req.auth.ctx.tenant.timezone;
  const today = localDate(new Date(), tz);
  const b = { ...req.body, amount: r2(req.body.amount) };
  if (req.file) checkUpload(req.file, 'receipt');
  const claim = await req.tx(async (t) => {
    const policy = await getPolicy(t);
    const cat = policy.categories.find((c) => c.code === b.category && c.active);
    if (!cat) throw BadRequest('Choose a category', [{ path: 'category', message: 'Choose one of the listed categories' }]);
    if (b.expenseDate > today) throw BadRequest('The expense date cannot be in the future', [{ path: 'expenseDate', message: 'Future date' }]);
    if (b.expenseDate < addDays(today, -policy.maxAgeDays)) throw BadRequest(`Claims must be made within ${policy.maxAgeDays} days of the expense`, [{ path: 'expenseDate', message: `Older than ${policy.maxAgeDays} days` }]);
    if (!req.file && b.amount > policy.receiptRequiredAbove) throw BadRequest(`Attach the receipt. It is required for claims above ${fmt(policy.receiptRequiredAbove)}.`, [{ path: 'receipt', message: 'Receipt required' }]);
    const dup = await app.ExpenseClaim.findOne({ where: { employeeId, expenseDate: b.expenseDate, amount: b.amount, category: b.category, status: { [Op.notIn]: ['REJECTED', 'CANCELLED'] } }, transaction: t });
    if (dup) throw Conflict(`You already claimed ${fmt(b.amount)} for ${cat.name.toLowerCase()} on ${b.expenseDate} (EXP-${dup.number}).`, 'DUPLICATE_CLAIM');

    const emp = await app.Employee.findByPk(employeeId, { transaction: t });
    const managerUser = await userIdForEmployee(t, emp.managerId);
    const managerUserId = managerUser && managerUser !== req.auth.userId && (await userHolds(t, managerUser, 'expenses:approve')) ? managerUser : null;
    const id = crypto.randomUUID();
    const file = req.file ? await saveUpload(req, t, req.file, { ownerType: 'EXPENSE_RECEIPT', ownerId: id, category: 'Expense receipt', folder: 'receipts' }) : null;
    const c = await app.ExpenseClaim.create({
      id, tenantId: req.auth.tenantId, number: await nextNumber(t), employeeId, ...b, receiptFileId: file?.id ?? null,
      status: 'SUBMITTED', managerUserId, createdBy: req.auth.userId,
    }, { transaction: t });
    const who = `${emp.firstName} ${emp.lastName}`;
    await notifyUsers(t, managerUserId ? [managerUserId] : await financeUsers(t, req.auth.userId), {
      type: 'expense.submitted', title: 'Expense claim to review', body: `${who} · ${fmt(b.amount)} · ${b.title}`, link: `/expenses/${id}`, email: true,
    });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'expense.submit', entityType: 'expense_claim', entityId: id, after: { ...b, receipt: !!file }, req });
    c.employee = emp;
    return view(c, policy);
  });
  return created(res, claim);
}));

// --------------------------------------------------------------------------- detail
expensesRouter.get('/:id', requirePermission('expenses:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await loadClaim(req, t, req.params.id, req.scopes);
    const policy = await getPolicy(t);
    const n = await names(t, [c.createdBy, c.managerUserId, c.managerDecidedBy, c.approvedBy, c.rejectedBy]);
    const timeline = [
      { at: c.createdAt, label: 'Submitted', by: n[c.createdBy] },
      c.managerDecidedAt && { at: c.managerDecidedAt, label: 'Approved by manager', by: n[c.managerDecidedBy], note: c.managerNote },
      c.approvedAt && { at: c.approvedAt, label: c.approvedAmount != null && Number(c.approvedAmount) < Number(c.amount) ? `Approved for ${fmt(c.approvedAmount)}` : 'Approved by finance', by: n[c.approvedBy], note: c.financeNote },
      c.rejectedAt && { at: c.rejectedAt, label: 'Rejected', by: n[c.rejectedBy], note: c.rejectReason },
      c.status === 'CANCELLED' && { at: c.updatedAt, label: 'Cancelled by employee' },
      c.status === 'SCHEDULED' && { at: c.updatedAt, label: `To be paid with the ${periodLabel(c.payrollPeriod)} salary` },
      c.paidAt && { at: c.paidAt, label: c.payoutMethod === 'PAYROLL' ? `Paid with the ${periodLabel(c.payrollPeriod)} salary` : 'Paid', note: c.paymentRef },
    ].filter(Boolean);
    const waitingFor = c.status === 'SUBMITTED' ? (c.managerUserId ? `${n[c.managerUserId] ?? 'Manager'} (manager)` : 'Finance') : c.status === 'MANAGER_APPROVED' ? 'Finance' : c.status === 'APPROVED' ? 'Payment by finance' : null;
    return { ...view(c, policy), timeline, waitingFor, abilities: abilities(req, c, c.employee) };
  });
  return ok(res, out);
}));

expensesRouter.get('/:id/receipt', requirePermission('expenses:view'), validate(idParam), asyncHandler(async (req, res) => {
  const f = await req.tx(async (t) => {
    const c = await loadClaim(req, t, req.params.id, req.scopes);
    if (!c.receiptFileId) throw NotFound('Receipt');
    const file = await app.File.findOne({ where: { id: c.receiptFileId, deletedAt: null }, transaction: t });
    if (!file) throw NotFound('Receipt');
    return file;
  });
  return sendFile(res, f);
}));

// --------------------------------------------------------------------------- decisions
expensesRouter.post('/:id/approve', requirePermission('expenses:approve'), validate({ ...idParam, body: z.object({ amount: z.number().positive().max(10_000_000).optional(), note: z.string().trim().max(500).optional() }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await loadClaim(req, t, req.params.id, req.scopes, { lock: true });
    if (c.employeeId === req.auth.principal.employeeId) throw Forbidden('You cannot approve your own claim', 'SELF_APPROVAL');
    if (!recordInScope(req.scopes, req.auth.principal, c.employee)) throw NotFound('Expense claim');
    const finance = isCompany(req.scopes);
    const before = c.toJSON();
    const who = `${c.employee.firstName} ${c.employee.lastName}`;
    if (finance) {
      if (!['SUBMITTED', 'MANAGER_APPROVED'].includes(c.status)) throw Conflict(`This claim is already ${c.status.replace(/_/g, ' ').toLowerCase()}`, 'INVALID_STATE');
      const amount = req.body.amount != null ? r2(req.body.amount) : Number(c.amount);
      if (amount > Number(c.amount)) throw BadRequest('The approved amount cannot be more than the claimed amount', [{ path: 'amount', message: `At most ${fmt(c.amount)}` }]);
      if (amount < Number(c.amount) && !req.body.note) throw BadRequest('Say why the amount was reduced', [{ path: 'note', message: 'Required when you reduce the amount' }]);
      await c.update({ status: 'APPROVED', approvedBy: req.auth.userId, approvedAt: new Date(), approvedAmount: amount, financeNote: req.body.note ?? null }, { transaction: t });
      await notifyUsers(t, [await userIdForEmployee(t, c.employeeId)], {
        type: 'expense.approved', title: `Expense claim EXP-${c.number} approved`, body: amount < Number(c.amount) ? `${fmt(amount)} of ${fmt(c.amount)} approved. ${req.body.note}` : `${fmt(amount)} · ${c.title}`, link: `/me/expenses/${c.id}`, email: true,
      });
    } else {
      if (c.status !== 'SUBMITTED') throw Conflict(`This claim is already ${c.status.replace(/_/g, ' ').toLowerCase()}`, 'INVALID_STATE');
      if (req.body.amount != null) throw BadRequest('Only finance can change the amount. Add a note instead.', [{ path: 'amount', message: 'Finance only' }]);
      await c.update({ status: 'MANAGER_APPROVED', managerDecidedBy: req.auth.userId, managerDecidedAt: new Date(), managerNote: req.body.note ?? null }, { transaction: t });
      await notifyUsers(t, await financeUsers(t, req.auth.userId), { type: 'expense.manager_approved', title: 'Expense claim ready for finance approval', body: `${who} · ${fmt(c.amount)} · ${c.title}`, link: `/expenses/${c.id}`, email: true });
      await notifyUsers(t, [await userIdForEmployee(t, c.employeeId)], { type: 'expense.manager_approved', title: `Your manager approved EXP-${c.number}`, body: 'It now goes to finance.', link: `/me/expenses/${c.id}` });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: finance ? 'expense.approve' : 'expense.manager_approve', entityType: 'expense_claim', entityId: c.id, before: { status: before.status }, after: { status: c.status, approvedAmount: c.approvedAmount, note: req.body.note }, req });
    return view(c, await getPolicy(t));
  });
  return ok(res, out);
}));

expensesRouter.post('/:id/reject', requirePermission('expenses:reject'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3, 'Give a reason the employee can act on').max(500) }).strict() }), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await loadClaim(req, t, req.params.id, req.scopes, { lock: true });
    if (c.employeeId === req.auth.principal.employeeId) throw Forbidden('You cannot reject your own claim. Cancel it instead.', 'SELF_APPROVAL');
    if (!recordInScope(req.scopes, req.auth.principal, c.employee)) throw NotFound('Expense claim');
    const allowed = isCompany(req.scopes) ? ['SUBMITTED', 'MANAGER_APPROVED'] : ['SUBMITTED'];
    if (!allowed.includes(c.status)) throw Conflict(`This claim is ${c.status.replace(/_/g, ' ').toLowerCase()} and can no longer be rejected here`, 'INVALID_STATE');
    await c.update({ status: 'REJECTED', rejectedBy: req.auth.userId, rejectedAt: new Date(), rejectReason: req.body.reason }, { transaction: t });
    await notifyUsers(t, [await userIdForEmployee(t, c.employeeId)], { type: 'expense.rejected', title: `Expense claim EXP-${c.number} rejected`, body: req.body.reason, link: `/me/expenses/${c.id}`, email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'expense.reject', entityType: 'expense_claim', entityId: c.id, after: req.body, req });
    return view(c, await getPolicy(t));
  });
  return ok(res, out);
}));

expensesRouter.post('/:id/cancel', requirePermission('expenses:create'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const c = await loadClaim(req, t, req.params.id, [], { lock: true });
    if (c.status !== 'SUBMITTED') throw Conflict('Only claims that nobody has acted on yet can be cancelled', 'INVALID_STATE');
    await c.update({ status: 'CANCELLED' }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'expense.cancel', entityType: 'expense_claim', entityId: c.id, req });
    return view(c, await getPolicy(t));
  });
  return ok(res, out);
}));

// --------------------------------------------------------------------------- payment
const payBody = z.discriminatedUnion('method', [
  z.object({ method: z.literal('PAYROLL'), period: PERIOD }).strict(),
  z.object({ method: z.literal('DIRECT'), reference: z.string().trim().min(2, 'Enter the cheque, transfer or voucher number').max(120) }).strict(),
]);

expensesRouter.post('/:id/pay', requirePermission('expenses:approve'), validate({ ...idParam, body: payBody }), asyncHandler(async (req, res) => {
  if (!isCompany(req.scopes)) throw Forbidden('Only finance can pay expense claims', 'FINANCE_ONLY');
  const out = await req.tx(async (t) => {
    const c = await loadClaim(req, t, req.params.id, req.scopes, { lock: true });
    if (c.employeeId === req.auth.principal.employeeId) throw Forbidden('Someone else must pay your own claim', 'SELF_APPROVAL');
    if (c.status !== 'APPROVED') throw Conflict('Only approved claims can be paid', 'INVALID_STATE');
    const amount = Number(c.approvedAmount ?? c.amount);
    const userId = await userIdForEmployee(t, c.employeeId);
    let recalculate = false;
    if (req.body.method === 'PAYROLL') {
      if (!req.auth.ctx.features.includes('payroll')) throw Forbidden('Payroll is not part of your plan. Pay the claim directly instead.', 'FEATURE_NOT_IN_PLAN');
      if (!req.auth.grants.has('payroll:edit')) throw Forbidden('You need payroll edit rights to add a claim to salary. Pay it directly, or ask the payroll manager.', 'FORBIDDEN');
      recalculate = !!(await assertPeriodOpen(t, req.body.period));
      const adj = await app.PayrollAdjustment.create({
        tenantId: req.auth.tenantId, employeeId: c.employeeId, period: req.body.period, kind: 'EARNING', code: 'REIMBURSEMENT',
        description: `Expense claim EXP-${c.number}: ${c.title}`.slice(0, 200), amount, taxable: false, createdBy: req.auth.userId,
      }, { transaction: t });
      await c.update({ status: 'SCHEDULED', payoutMethod: 'PAYROLL', payrollPeriod: req.body.period, payrollAdjustmentId: adj.id }, { transaction: t });
      await notifyUsers(t, [userId], { type: 'expense.scheduled', title: `EXP-${c.number} will be paid with your salary`, body: `${fmt(amount)} in the ${periodLabel(req.body.period)} payroll`, link: `/me/expenses/${c.id}` });
    } else {
      await c.update({ status: 'PAID', payoutMethod: 'DIRECT', paidAt: new Date(), paymentRef: req.body.reference }, { transaction: t });
      await notifyUsers(t, [userId], { type: 'expense.paid', title: `EXP-${c.number} has been paid`, body: `${fmt(amount)} · reference ${req.body.reference}`, link: `/me/expenses/${c.id}`, email: true });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'expense.pay', entityType: 'expense_claim', entityId: c.id, after: { ...req.body, amount }, req });
    return { ...view(c, await getPolicy(t)), recalculate };
  });
  return ok(res, out);
}));

expensesRouter.post('/:id/unschedule', requirePermission('expenses:approve'), validate(idParam), asyncHandler(async (req, res) => {
  if (!isCompany(req.scopes) || !req.auth.grants.has('payroll:edit')) throw Forbidden('Only finance with payroll edit rights can do this', 'FINANCE_ONLY');
  const out = await req.tx(async (t) => {
    const c = await loadClaim(req, t, req.params.id, req.scopes, { lock: true });
    if (c.status !== 'SCHEDULED') throw Conflict('This claim is not waiting for a payroll', 'INVALID_STATE');
    await assertPeriodOpen(t, c.payrollPeriod);
    if (c.payrollAdjustmentId) await app.PayrollAdjustment.destroy({ where: { id: c.payrollAdjustmentId }, transaction: t });
    const period = c.payrollPeriod;
    await c.update({ status: 'APPROVED', payoutMethod: null, payrollPeriod: null, payrollAdjustmentId: null }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'expense.unschedule', entityType: 'expense_claim', entityId: c.id, before: { period }, req });
    return view(c, await getPolicy(t));
  });
  return ok(res, out);
}));
