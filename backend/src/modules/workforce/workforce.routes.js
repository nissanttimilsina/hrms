import { Router } from 'express';
import { z } from 'zod';
import { QueryTypes } from 'sequelize';
import { app, appDb } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { localDate, fiscalYear, fiscalYearRange } from '../../services/hr/calendar.js';
import { isCompany, scopesOf, holds, optText, toCsv } from '../../services/module-kit.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, NotFound } from '../../utils/errors.js';

/**
 * Workforce planning: headcount plans per fiscal year (by department, designation and branch) compared with the
 * people actually employed, the positions being recruited, and the budgeted versus actual monthly salary cost.
 * Salary figures are shown only to people who can see company payroll (or approve plans).
 *   workforce:view · edit (draft plans) · approve
 */
export const workforceRouter = Router();

const idParam = { params: z.object({ id: z.string().uuid() }) };
const num = (v) => (v == null ? null : Number(v));
const seesPay = (req) => isCompany(scopesOf(req, 'payroll:view')) || holds(req, 'workforce:approve');

const planView = (p, extra = {}) => ({ id: p.id, name: p.name, fiscalYear: p.fiscalYear, status: p.status, notes: p.notes, approvedAt: p.approvedAt, createdAt: p.createdAt, updatedAt: p.updatedAt, ...extra });

workforceRouter.get('/plans', requirePermission('workforce:view'), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const plans = await app.HeadcountPlan.findAll({ order: [['fiscalYear', 'DESC'], ['createdAt', 'DESC']], transaction: t });
    const lines = await app.HeadcountPlanLine.findAll({ where: { planId: plans.map((p) => p.id) }, attributes: ['planId', 'planned'], raw: true, transaction: t });
    return plans.map((p) => planView(p, { planned: lines.filter((l) => l.planId === p.id).reduce((n, l) => n + l.planned, 0), lines: lines.filter((l) => l.planId === p.id).length }));
  });
  return ok(res, out);
}));

const planBody = z.object({ name: z.string().trim().min(3).max(120), fiscalYear: z.string().regex(/^\d{4}\/\d{2}$/, 'Use a fiscal year like 2083/84'), notes: optText(z, 2000) }).strict();

workforceRouter.post('/plans', requirePermission('workforce:edit'), validate({ body: planBody.extend({ copyFromId: z.string().uuid().optional() }) }), asyncHandler(async (req, res) => {
  const p = await req.tx(async (t) => {
    const { copyFromId, ...b } = req.body;
    const row = await app.HeadcountPlan.create({ ...b, tenantId: req.auth.tenantId, status: 'DRAFT', createdBy: req.auth.userId }, { transaction: t });
    if (copyFromId) {
      const src = await app.HeadcountPlanLine.findAll({ where: { planId: copyFromId }, raw: true, transaction: t });
      await app.HeadcountPlanLine.bulkCreate(src.map(({ id, planId, ...l }) => ({ ...l, planId: row.id })), { transaction: t });
    }
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'workforce.plan_create', entityType: 'headcount_plan', entityId: row.id, after: req.body, req });
    return row;
  });
  return created(res, planView(p));
}));

workforceRouter.patch('/plans/:id', requirePermission('workforce:edit'), validate({ ...idParam, body: planBody.partial() }), asyncHandler(async (req, res) => {
  const p = await req.tx(async (t) => {
    const row = await app.HeadcountPlan.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Plan');
    if (row.status !== 'DRAFT' && ('fiscalYear' in req.body)) throw Conflict('An approved plan cannot move to another year.');
    await row.update(req.body, { transaction: t });
    return row;
  });
  return ok(res, planView(p));
}));

const lineSchema = z.object({
  departmentId: z.string().uuid().nullish(), designationId: z.string().uuid().nullish(), branchId: z.string().uuid().nullish(),
  planned: z.number().int().min(0).max(100000), monthlyCost: z.number().min(0).max(1e9).nullish(), neededBy: z.string().date().nullish(), note: optText(z, 500),
}).strict();

workforceRouter.put('/plans/:id/lines', requirePermission('workforce:edit'), validate({ ...idParam, body: z.object({ lines: z.array(lineSchema).max(500) }).strict() }), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const row = await app.HeadcountPlan.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Plan');
    if (row.status !== 'DRAFT') throw Conflict('Approved plans are locked. Make a copy to change the numbers.', 'LOCKED');
    const keys = req.body.lines.map((l) => [l.departmentId ?? '', l.designationId ?? '', l.branchId ?? ''].join('|'));
    if (new Set(keys).size !== keys.length) throw BadRequest('Two rows have the same department, designation and branch. Combine them.', [{ path: 'lines', message: 'Duplicate row' }]);
    await app.HeadcountPlanLine.destroy({ where: { planId: row.id }, transaction: t });
    await app.HeadcountPlanLine.bulkCreate(req.body.lines.map((l) => ({ ...l, tenantId: req.auth.tenantId, planId: row.id })), { transaction: t });
    row.changed('updatedAt', true);
    await row.save({ transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'workforce.plan_lines', entityType: 'headcount_plan', entityId: row.id, after: { lines: req.body.lines.length, planned: req.body.lines.reduce((n, l) => n + l.planned, 0) }, req });
  });
  return ok(res, { saved: true });
}));

workforceRouter.post('/plans/:id/status', requirePermission('workforce:approve'), validate({ ...idParam, body: z.object({ status: z.enum(['DRAFT', 'APPROVED', 'ARCHIVED']) }).strict() }), asyncHandler(async (req, res) => {
  const p = await req.tx(async (t) => {
    const row = await app.HeadcountPlan.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw NotFound('Plan');
    if (row.status === req.body.status) throw Conflict(`The plan is already ${row.status.toLowerCase()}.`);
    if (req.body.status === 'APPROVED' && !(await app.HeadcountPlanLine.count({ where: { planId: row.id }, transaction: t }))) throw BadRequest('Add at least one row before approving the plan.');
    await row.update({ status: req.body.status, ...(req.body.status === 'APPROVED' ? { approvedBy: req.auth.userId, approvedAt: new Date() } : req.body.status === 'DRAFT' ? { approvedBy: null, approvedAt: null } : {}) }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'workforce.plan_status', entityType: 'headcount_plan', entityId: row.id, after: req.body, req });
    return row;
  });
  return ok(res, planView(p));
}));

// --------------------------------------------------------------------------- plan versus actual
/** Each employee / opening counts in the most specific plan row that matches it (or as unplanned). */
function bestLine(lines, rec) {
  let best = null; let bestScore = -1;
  for (const l of lines) {
    if ((l.departmentId && l.departmentId !== rec.departmentId) || (l.designationId && l.designationId !== rec.designationId) || (l.branchId && l.branchId !== rec.branchId)) continue;
    const s = (l.departmentId ? 4 : 0) + (l.designationId ? 2 : 0) + (l.branchId ? 1 : 0);
    if (s > bestScore) { best = l; bestScore = s; }
  }
  return best;
}

async function compare(req, t, plan) {
  const lines = await app.HeadcountPlanLine.findAll({ where: { planId: plan.id }, raw: true, transaction: t });
  const emps = await appDb.query(
    `SELECT e.id, e.department_id AS "departmentId", e.designation_id AS "designationId", e.branch_id AS "branchId",
            (SELECT s.basic + coalesce((SELECT sum((c->>'amount')::numeric) FROM jsonb_array_elements(s.components) c), 0)
               FROM employee_salaries s WHERE s.employee_id = e.id AND s.effective_from <= :today ORDER BY s.effective_from DESC LIMIT 1)::float AS gross
       FROM employees e WHERE e.deleted_at IS NULL AND e.status <> 'TERMINATED'`,
    { replacements: { today: localDate(new Date(), req.auth.ctx.tenant.timezone) }, type: QueryTypes.SELECT, transaction: t },
  );
  const jobs = await app.JobOpening.findAll({ where: { status: ['OPEN', 'ON_HOLD'] }, attributes: ['id', 'departmentId', 'designationId', 'branchId', 'positions', 'title'], raw: true, transaction: t });
  const hired = await app.Candidate.findAll({ where: { jobId: jobs.map((j) => j.id), stage: 'HIRED' }, attributes: ['jobId'], raw: true, transaction: t });
  const stats = new Map(lines.map((l) => [l.id, { actual: 0, cost: 0, withPay: 0, recruiting: 0, openings: [] }]));
  const unplanned = new Map();
  for (const e of emps) {
    const l = bestLine(lines, e);
    if (l) { const s = stats.get(l.id); s.actual += 1; if (e.gross != null) { s.cost += e.gross; s.withPay += 1; } } else {
      const k = [e.departmentId, e.designationId].join('|');
      const u = unplanned.get(k) ?? { departmentId: e.departmentId, designationId: e.designationId, actual: 0 };
      u.actual += 1; unplanned.set(k, u);
    }
  }
  for (const j of jobs) {
    const l = bestLine(lines, j);
    if (!l) continue;
    const left = Math.max(0, j.positions - hired.filter((h) => h.jobId === j.id).length);
    const s = stats.get(l.id); s.recruiting += left; s.openings.push({ id: j.id, title: j.title, open: left });
  }
  const pay = seesPay(req);
  const depts = Object.fromEntries((await app.Department.findAll({ attributes: ['id', 'name'], raw: true, transaction: t })).map((d) => [d.id, d.name]));
  const desig = Object.fromEntries((await app.Designation.findAll({ attributes: ['id', 'name'], raw: true, transaction: t })).map((d) => [d.id, d.name]));
  const branches = Object.fromEntries((await app.Branch.findAll({ attributes: ['id', 'name'], raw: true, transaction: t })).map((d) => [d.id, d.name]));
  const rows = lines.map((l) => {
    const s = stats.get(l.id);
    const gap = l.planned - s.actual;
    return {
      id: l.id, departmentId: l.departmentId, department: depts[l.departmentId] ?? null, designationId: l.designationId, designation: desig[l.designationId] ?? null,
      branchId: l.branchId, branch: branches[l.branchId] ?? null, planned: l.planned, actual: s.actual, recruiting: s.recruiting, openings: s.openings,
      gap, toRecruit: Math.max(0, gap - s.recruiting), over: Math.max(0, -gap), neededBy: l.neededBy, note: l.note,
      monthlyCost: num(l.monthlyCost), budget: l.monthlyCost != null ? Math.round(num(l.monthlyCost) * l.planned) : null,
      actualCost: pay ? Math.round(s.cost) : null, missingPay: pay ? s.actual - s.withPay : null,
    };
  }).sort((a, b) => String(a.department ?? 'zz').localeCompare(String(b.department ?? 'zz')) || String(a.designation ?? '').localeCompare(String(b.designation ?? '')));
  const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
  return {
    rows,
    totals: { planned: sum('planned'), actual: sum('actual'), recruiting: sum('recruiting'), toRecruit: sum('toRecruit'), over: sum('over'), budget: rows.some((r) => r.budget != null) ? sum('budget') : null, actualCost: pay ? sum('actualCost') : null },
    unplanned: [...unplanned.values()].map((u) => ({ ...u, department: depts[u.departmentId] ?? 'No department', designation: desig[u.designationId] ?? null })).sort((a, b) => b.actual - a.actual),
    showsPay: pay,
  };
}

workforceRouter.get('/plans/:id', requirePermission('workforce:view'), validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const p = await app.HeadcountPlan.findByPk(req.params.id, { transaction: t });
    if (!p) throw NotFound('Plan');
    return planView(p, { ...(await compare(req, t, p)), abilities: { edit: holds(req, 'workforce:edit') && p.status === 'DRAFT', approve: holds(req, 'workforce:approve'), recruit: req.auth.ctx.features.includes('recruitment') && holds(req, 'recruitment:create') } });
  });
  return ok(res, out);
}));

workforceRouter.get('/plans/:id/export', requirePermission('workforce:view'), validate(idParam), asyncHandler(async (req, res) => {
  const { p, c } = await req.tx(async (t) => {
    const plan = await app.HeadcountPlan.findByPk(req.params.id, { transaction: t });
    if (!plan) throw NotFound('Plan');
    return { p: plan, c: await compare(req, t, plan) };
  });
  const header = ['Department', 'Designation', 'Branch', 'Planned', 'Employed', 'Being recruited', 'Still to recruit', 'Over plan', 'Needed by', 'Budget per head (NPR/month)', 'Budget (NPR/month)', ...(c.showsPay ? ['Actual salaries (NPR/month)'] : []), 'Note'];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="headcount-plan-${p.fiscalYear.replace('/', '-')}.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(toCsv(header, c.rows.map((r) => [r.department ?? 'All departments', r.designation ?? 'All designations', r.branch ?? 'All branches', r.planned, r.actual, r.recruiting, r.toRecruit, r.over, r.neededBy ?? '', r.monthlyCost ?? '', r.budget ?? '', ...(c.showsPay ? [r.actualCost] : []), r.note ?? ''])));
}));

/** Headcount over the last 12 months, joiners and leavers, and turnover. */
workforceRouter.get('/overview', requirePermission('workforce:view'), asyncHandler(async (req, res) => {
  const today = localDate(new Date(), req.auth.ctx.tenant.timezone);
  const out = await req.tx(async (t) => {
    const months = [];
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i);
      const start = d.toISOString().slice(0, 10);
      const e = new Date(d); e.setUTCMonth(e.getUTCMonth() + 1); e.setUTCDate(0);
      months.push({ start, finish: e.toISOString().slice(0, 10) > today ? today : e.toISOString().slice(0, 10) });
    }
    const rows = await appDb.query(
      `SELECT m.start, m.finish,
              (SELECT count(*) FROM employees e WHERE e.deleted_at IS NULL AND e.joined_on <= m.finish::date AND (e.exited_on IS NULL OR e.exited_on > m.finish::date))::int AS headcount,
              (SELECT count(*) FROM employees e WHERE e.deleted_at IS NULL AND e.joined_on BETWEEN m.start::date AND m.finish::date)::int AS joined,
              (SELECT count(*) FROM employees e WHERE e.deleted_at IS NULL AND e.exited_on BETWEEN m.start::date AND m.finish::date)::int AS exited
         FROM jsonb_to_recordset(CAST(:months AS jsonb)) AS m(start text, finish text) ORDER BY m.start`,
      { replacements: { months: JSON.stringify(months) }, type: QueryTypes.SELECT, transaction: t },
    );
    const exits = rows.reduce((n, r) => n + r.exited, 0);
    const avg = rows.reduce((n, r) => n + r.headcount, 0) / (rows.length || 1);
    const byDept = await appDb.query(
      `SELECT coalesce(d.name, 'No department') AS name, count(*)::int AS n FROM employees e LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.deleted_at IS NULL AND e.status <> 'TERMINATED' GROUP BY 1 ORDER BY 2 DESC`, { type: QueryTypes.SELECT, transaction: t });
    const fy = fiscalYear(today);
    return {
      months: rows.map((r) => ({ month: r.start.slice(0, 7), headcount: r.headcount, joined: r.joined, exited: r.exited })),
      headcount: rows.at(-1)?.headcount ?? 0, joined12m: rows.reduce((n, r) => n + r.joined, 0), exited12m: exits,
      turnover12m: avg > 0 ? Math.round((exits / avg) * 1000) / 10 : null, byDepartment: byDept, fiscalYear: fy, fiscalYearRange: fiscalYearRange(fy),
    };
  });
  return ok(res, out);
}));
