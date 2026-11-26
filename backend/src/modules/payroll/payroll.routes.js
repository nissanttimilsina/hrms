import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import PDFDocument from 'pdfkit';
import { app } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { recordInScope } from '../../services/rbac.service.js';
import { scopedEmployeeIds } from '../../services/hr/attendance.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { bsMonthRange, fiscalYear, fiscalYearRange, BS_MONTHS } from '../../services/hr/calendar.js';
import { getPolicy, rangeSummary } from '../../services/hr/attendance.js';
import { calculateItem } from '../../services/hr/payroll-calc.js';
import { notifyUsers, usersWithPermission } from '../../services/hr/notify.js';
import { asyncHandler, ok, created } from '../../utils/http.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../utils/errors.js';

export const payrollRouter = Router();
export const DEFAULT_COMPONENTS = [
  { code: 'DEARNESS', name: 'Dearness allowance', kind: 'EARNING', taxable: true, prorated: true, sortOrder: 1 },
  { code: 'TRANSPORT', name: 'Transport allowance', kind: 'EARNING', taxable: true, prorated: true, sortOrder: 2 },
  { code: 'COMMUNICATION', name: 'Communication allowance', kind: 'EARNING', taxable: true, prorated: true, sortOrder: 3 },
  { code: 'FESTIVAL', name: 'Festival allowance (Dashain)', kind: 'EARNING', taxable: true, prorated: false, sortOrder: 4 },
  { code: 'ADVANCE', name: 'Salary advance recovery', kind: 'DEDUCTION', taxable: false, prorated: false, sortOrder: 10 },
];
const PERIOD = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use BS year-month, e.g. 2083-08');
const idParam = { params: z.object({ id: z.string().uuid() }) };
const money = z.number().min(0).max(100_000_000);
const r2 = (n) => Math.round(n * 100) / 100;

const periodInfo = (period) => {
  const [y, m] = period.split('-').map(Number);
  const { start, end } = bsMonthRange(y, m - 1);
  return { start, end, fiscalYear: fiscalYear(start), label: `${BS_MONTHS[m - 1]} ${y}` };
};

// --------------------------------------------------------------------------- configuration
payrollRouter.get('/rules', requirePermission('payroll:view'), asyncHandler(async (req, res) => ok(res, await req.tx((t) => app.TaxRuleSet.findAll({ where: { status: 'ACTIVE' }, order: [['effectiveFrom', 'DESC']], transaction: t })))));

payrollRouter.get('/components', requirePermission('payroll:view'), asyncHandler(async (req, res) => ok(res, await req.tx((t) => app.SalaryComponent.findAll({ order: [['sortOrder', 'ASC']], transaction: t })))));
const compBody = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,20}$/), name: z.string().trim().min(2).max(80), kind: z.enum(['EARNING', 'DEDUCTION']), taxable: z.boolean().default(true), prorated: z.boolean().default(true), isActive: z.boolean().default(true), sortOrder: z.number().int().default(0) }).strict();
payrollRouter.post('/components', requirePermission('payroll:configure'), validate({ body: compBody }), asyncHandler(async (req, res) =>
  created(res, await req.tx((t) => app.SalaryComponent.create({ ...req.body, tenantId: req.auth.tenantId }, { transaction: t })))));
payrollRouter.patch('/components/:id', requirePermission('payroll:configure'), validate({ ...idParam, body: compBody.omit({ code: true, kind: true }).partial() }), asyncHandler(async (req, res) => {
  const c = await req.tx(async (t) => { const r = await app.SalaryComponent.findByPk(req.params.id, { transaction: t }); if (!r) throw NotFound('Component'); return r.update(req.body, { transaction: t }); });
  return ok(res, c);
}));

// --------------------------------------------------------------------------- salaries (versioned)
payrollRouter.get('/salaries/:employeeId', requirePermission('payroll:view'), validate({ params: z.object({ employeeId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const rows = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(req.params.employeeId, { transaction: t });
    if (!emp || !recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Employee');
    return app.EmployeeSalary.findAll({ where: { employeeId: emp.id }, order: [['effectiveFrom', 'DESC']], transaction: t });
  });
  return ok(res, rows);
}));

payrollRouter.post('/salaries', requirePermission('payroll:edit'), validate({
  body: z.object({
    employeeId: z.string().uuid(), effectiveFrom: z.string().date(), basic: money, components: z.array(z.object({ code: z.string(), amount: money }).strict()).max(30).default([]),
    ssfEnrolled: z.boolean().default(true), pfPercent: z.number().min(0).max(20).default(0), citMonthly: money.default(0),
    taxProfile: z.object({ lifeInsurance: money, healthInsurance: money, femaleRebate: z.boolean(), coupleAssessment: z.boolean() }).partial().strict().default({}), reason: z.string().max(300).optional(),
  }).strict(),
}), asyncHandler(async (req, res) => {
  const row = await req.tx(async (t) => {
    const emp = await app.Employee.findByPk(req.body.employeeId, { transaction: t });
    if (!emp || !recordInScope(req.scopes, req.auth.principal, emp)) throw NotFound('Employee');
    const codes = new Set((await app.SalaryComponent.findAll({ transaction: t })).map((c) => c.code));
    const bad = req.body.components.find((c) => !codes.has(c.code));
    if (bad) throw BadRequest(`Unknown salary component ${bad.code}`, [{ path: 'components', message: 'Unknown component' }]);
    const locked = await app.PayrollRun.findOne({ where: { status: { [Op.in]: ['APPROVED', 'PAID'] }, periodEnd: { [Op.gte]: req.body.effectiveFrom } }, transaction: t });
    if (locked) throw Conflict(`Payroll for ${locked.period} is already approved. Use an effective date after ${locked.periodEnd}, or add a retroactive adjustment.`, 'PERIOD_LOCKED');
    const prev = await app.EmployeeSalary.findOne({ where: { employeeId: emp.id }, order: [['effectiveFrom', 'DESC']], transaction: t });
    const r = await app.EmployeeSalary.create({ ...req.body, tenantId: req.auth.tenantId, createdBy: req.auth.userId }, { transaction: t });
    await app.EmployeeHistory.create({ tenantId: req.auth.tenantId, employeeId: emp.id, type: prev ? 'PROMOTION' : 'JOINED', effectiveOn: req.body.effectiveFrom, fromValue: prev ? { basic: prev.basic } : {}, toValue: { basic: req.body.basic }, note: req.body.reason ?? (prev ? 'Salary revision' : 'Initial salary'), actorId: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: prev ? 'salary.revise' : 'salary.set', entityType: 'employee', entityId: emp.id, before: prev && { basic: prev.basic }, after: { basic: req.body.basic, effectiveFrom: req.body.effectiveFrom }, req });
    return r;
  });
  return created(res, row);
}));

payrollRouter.post('/adjustments', requirePermission('payroll:edit'), validate({
  body: z.object({ employeeId: z.string().uuid(), period: PERIOD, kind: z.enum(['EARNING', 'DEDUCTION']), description: z.string().trim().min(3).max(200), amount: money.refine((x) => x > 0), taxable: z.boolean().default(true) }).strict(),
}), asyncHandler(async (req, res) => {
  const row = await req.tx(async (t) => {
    const locked = await app.PayrollRun.findOne({ where: { period: req.body.period, status: { [Op.in]: ['SUBMITTED', 'APPROVED', 'PAID'] } }, transaction: t });
    if (locked) throw Conflict(`Payroll for ${req.body.period} is ${locked.status.toLowerCase()}. Add the adjustment to the next period.`, 'PERIOD_LOCKED');
    const r = await app.PayrollAdjustment.create({ ...req.body, tenantId: req.auth.tenantId, createdBy: req.auth.userId }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.adjustment', entityType: 'employee', entityId: req.body.employeeId, after: req.body, req });
    return r;
  });
  return created(res, row);
}));

// --------------------------------------------------------------------------- runs
/** Run-level views are for payroll staff; employees with OWN scope only ever see their own payslips. */
const requireWideScope = (req, _res, next) => (req.scopes.every((s) => s.scope === 'OWN')
  ? next(Forbidden('Use My payslips to view your own pay', 'FORBIDDEN')) : next());

payrollRouter.get('/runs', requirePermission('payroll:view'), requireWideScope, asyncHandler(async (req, res) => ok(res, await req.tx((t) => app.PayrollRun.findAll({ order: [['period', 'DESC']], limit: 60, transaction: t })))));

payrollRouter.post('/runs', requirePermission('payroll:create'), validate({ body: z.object({ period: PERIOD, notes: z.string().max(500).optional() }).strict() }), asyncHandler(async (req, res) => {
  const p = periodInfo(req.body.period);
  const run = await req.tx(async (t) => {
    if (await app.PayrollRun.findOne({ where: { period: req.body.period, status: { [Op.ne]: 'VOID' } }, transaction: t })) throw Conflict(`A payroll for ${p.label} already exists`, 'RUN_EXISTS');
    const rs = await app.TaxRuleSet.findOne({ where: { fiscalYear: p.fiscalYear, status: 'ACTIVE' }, transaction: t });
    if (!rs) throw BadRequest(`Statutory rules for FY ${p.fiscalYear} are not configured yet. Please contact support.`);
    const r = await app.PayrollRun.create({ tenantId: req.auth.tenantId, period: req.body.period, periodStart: p.start, periodEnd: p.end, fiscalYear: p.fiscalYear, ruleSetId: rs.id, createdBy: req.auth.userId, notes: req.body.notes }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.create', entityType: 'payroll_run', entityId: r.id, after: { period: r.period }, req });
    return r;
  });
  return created(res, { ...run.toJSON(), label: p.label });
}));

async function loadRun(t, id, statuses) {
  const run = await app.PayrollRun.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!run) throw NotFound('Payroll run');
  if (statuses && !statuses.includes(run.status)) throw Conflict(`Payroll is ${run.status.toLowerCase()}; this action is not allowed`, 'INVALID_STATE');
  return run;
}

/** (Re)calculate every eligible employee from salary, attendance, leave, adjustments and the FY rule set. */
payrollRouter.post('/runs/:id/calculate', requirePermission('payroll:create'), validate(idParam), asyncHandler(async (req, res) => {
  const tz = req.auth.ctx.tenant.timezone;
  const out = await req.tx(async (t) => {
    const run = await loadRun(t, req.params.id, ['DRAFT', 'CALCULATED']);
    const rules = (await app.TaxRuleSet.findByPk(run.ruleSetId, { transaction: t })).rules;
    const components = await app.SalaryComponent.findAll({ transaction: t });
    const emps = await app.Employee.findAll({ where: { deletedAt: null, joinedOn: { [Op.lte]: run.periodEnd }, [Op.or]: [{ exitedOn: null }, { exitedOn: { [Op.gte]: run.periodStart } }] }, transaction: t });
    const policy = await getPolicy(t);
    const att = await rangeSummary(t, { employeeIds: emps.map((e) => e.id), from: run.periodStart, to: run.periodEnd, tz, policy });
    const fy = fiscalYearRange(run.fiscalYear);
    const priorRuns = await app.PayrollRun.findAll({ where: { fiscalYear: run.fiscalYear, status: { [Op.in]: ['APPROVED', 'PAID'] }, periodEnd: { [Op.lt]: run.periodStart } }, attributes: ['id'], transaction: t });
    const priorItems = priorRuns.length ? await app.PayrollItem.findAll({ where: { runId: priorRuns.map((r) => r.id) }, attributes: ['employeeId', 'tax', 'taxDetail'], transaction: t }) : [];
    const adjustments = await app.PayrollAdjustment.findAll({ where: { period: run.period }, transaction: t });
    const m = Number(run.period.split('-')[1]);
    const monthsRemaining = 12 - ((m - 4 + 12) % 12); // Shrawan (BS month 4) is month 1 of the fiscal year
    const periodDays = (new Date(run.periodEnd) - new Date(run.periodStart)) / 86_400_000 + 1;

    await app.PayrollItem.destroy({ where: { runId: run.id }, transaction: t });
    const items = []; const skipped = [];
    for (const e of emps) {
      const salary = await app.EmployeeSalary.findOne({ where: { employeeId: e.id, effectiveFrom: { [Op.lte]: run.periodEnd } }, order: [['effectiveFrom', 'DESC']], transaction: t });
      if (!salary) { skipped.push({ employeeId: e.id, name: `${e.firstName} ${e.lastName}`, reason: 'No salary configured' }); continue; }
      const a = att.find((x) => x.employeeId === e.id);
      // Days outside employment are unpaid, plus unpaid leave; absences only when the company opts in.
      const outside = periodDays - a.calendarDays;
      const unpaidDays = r2(outside + a.unpaidLeave + (policy.deductAbsences ? a.absent : 0));
      const mine = priorItems.filter((i) => i.employeeId === e.id);
      const ytd = { assessable: mine.reduce((n, i) => n + Number(i.taxDetail.assessableMonth ?? 0), 0), retirement: mine.reduce((n, i) => n + Number(i.taxDetail.retirementMonth ?? 0), 0), tax: mine.reduce((n, i) => n + Number(i.tax), 0) };
      const c = calculateItem({
        salary, components, rules, ytd, monthsRemaining,
        att: { calendarDays: periodDays, unpaidDays: Math.min(periodDays, unpaidDays), overtimeMinutes: a.overtimeMinutes, workingDaysInPeriod: a.workingDays },
        adjustments: adjustments.filter((x) => x.employeeId === e.id), employee: { gender: e.gender, maritalStatus: e.maritalStatus, pan: e.pan, bank: e.bank },
      });
      const prevItem = mine.length ? await app.PayrollItem.findOne({ where: { employeeId: e.id, runId: priorRuns.map((r) => r.id) }, order: [['createdAt', 'DESC']], transaction: t }) : null;
      if (prevItem && Number(prevItem.net) > 0 && Math.abs(c.net - Number(prevItem.net)) / Number(prevItem.net) > 0.3) c.anomalies.push('Net pay changed by more than 30% from last month');
      items.push(await app.PayrollItem.create({
        tenantId: req.auth.tenantId, runId: run.id, employeeId: e.id, lines: c.lines, taxDetail: c.taxDetail, anomalies: c.anomalies,
        attendance: { periodDays, ...a, unpaidDays: Math.min(periodDays, unpaidDays), fyStart: fy.start },
        snapshot: { salary: salary.toJSON(), employee: { code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, pan: e.pan, ssfId: e.ssfId, bank: { bankName: e.bank?.bankName, accountName: e.bank?.accountName, last4: e.bank?.last4, accountNumberEnc: e.bank?.accountNumberEnc }, branchId: e.branchId, departmentId: e.departmentId } },
        gross: c.gross, deductions: c.deductions, tax: c.tax, ssfEmployee: c.ssfEmployee, ssfEmployer: c.ssfEmployer, net: c.net,
      }, { transaction: t }));
    }
    const sum = (k) => r2(items.reduce((n, i) => n + Number(i[k]), 0));
    const totals = { employees: items.length, gross: sum('gross'), deductions: sum('deductions'), tax: sum('tax'), ssfEmployee: sum('ssfEmployee'), ssfEmployer: sum('ssfEmployer'), net: sum('net'), employerCost: r2(sum('gross') + sum('ssfEmployer')), skipped };
    await run.update({ status: 'CALCULATED', totals, anomalies: items.filter((i) => i.anomalies.length).length + skipped.length, calculatedAt: new Date() }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.calculate', entityType: 'payroll_run', entityId: run.id, after: totals, req });
    return run;
  });
  return ok(res, out);
}));

payrollRouter.get('/runs/:id', requirePermission('payroll:view'), requireWideScope, validate(idParam), asyncHandler(async (req, res) => {
  const out = await req.tx(async (t) => {
    const run = await app.PayrollRun.findByPk(req.params.id, { transaction: t });
    if (!run) throw NotFound('Payroll run');
    const ids = await scopedEmployeeIds(req, t);
    const items = await app.PayrollItem.findAll({ where: { runId: run.id, ...(ids && { employeeId: ids }) }, attributes: { exclude: ['snapshot'] }, include: [{ model: app.Employee, as: 'employee', attributes: ['id', 'employeeCode', 'firstName', 'lastName'] }], order: [[{ model: app.Employee, as: 'employee' }, 'employeeCode', 'ASC']], transaction: t });
    return { run: { ...run.toJSON(), label: periodInfo(run.period).label }, items };
  });
  return ok(res, out);
}));

payrollRouter.post('/runs/:id/submit', requirePermission('payroll:create'), validate(idParam), asyncHandler(async (req, res) => {
  const run = await req.tx(async (t) => {
    const r = await loadRun(t, req.params.id, ['CALCULATED']);
    await r.update({ status: 'SUBMITTED', submittedBy: req.auth.userId, submittedAt: new Date() }, { transaction: t });
    await notifyUsers(t, (await usersWithPermission(t, 'payroll:approve')).filter((u) => u !== req.auth.userId), { type: 'payroll.submitted', title: `Payroll ${periodInfo(r.period).label} awaiting approval`, body: `Net pay NPR ${r.totals.net}`, link: `/payroll/runs/${r.id}`, email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.submit', entityType: 'payroll_run', entityId: r.id, req });
    return r;
  });
  return ok(res, run);
}));

/** Maker–checker: the approver must be a different person from the submitter (also enforced by a DB constraint). */
payrollRouter.post('/runs/:id/approve', requirePermission('payroll:approve'), validate(idParam), asyncHandler(async (req, res) => {
  const run = await req.tx(async (t) => {
    const r = await loadRun(t, req.params.id, ['SUBMITTED']);
    if (r.submittedBy === req.auth.userId) throw Forbidden('Payroll must be approved by someone other than the person who submitted it', 'MAKER_CHECKER');
    await r.update({ status: 'APPROVED', approvedBy: req.auth.userId, approvedAt: new Date() }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.approve', entityType: 'payroll_run', entityId: r.id, after: r.totals, req });
    return r;
  });
  return ok(res, run);
}));
payrollRouter.post('/runs/:id/reject', requirePermission('payroll:approve'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict() }), asyncHandler(async (req, res) => {
  const run = await req.tx(async (t) => {
    const r = await loadRun(t, req.params.id, ['SUBMITTED']);
    await r.update({ status: 'CALCULATED', submittedBy: null, submittedAt: null, notes: `Returned: ${req.body.reason}` }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.reject', entityType: 'payroll_run', entityId: r.id, after: req.body, req });
    return r;
  });
  return ok(res, run);
}));
payrollRouter.post('/runs/:id/publish', requirePermission('payroll:manage'), validate(idParam), asyncHandler(async (req, res) => {
  const run = await req.tx(async (t) => {
    const r = await loadRun(t, req.params.id, ['APPROVED', 'PAID']);
    if (r.publishedAt) throw Conflict('Payslips are already published');
    await r.update({ publishedAt: new Date() }, { transaction: t });
    const items = await app.PayrollItem.findAll({ where: { runId: r.id }, attributes: ['employeeId'], transaction: t });
    const users = await app.User.findAll({ where: { employeeId: items.map((i) => i.employeeId), status: 'ACTIVE' }, attributes: ['id'], transaction: t });
    await notifyUsers(t, users.map((u) => u.id), { type: 'payroll.payslip', title: `Your payslip for ${periodInfo(r.period).label} is ready`, link: '/me/payslips', email: true });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.publish', entityType: 'payroll_run', entityId: r.id, req });
    return r;
  });
  return ok(res, run);
}));
payrollRouter.post('/runs/:id/mark-paid', requirePermission('payroll:manage'), validate({ ...idParam, body: z.object({ paymentRef: z.string().trim().min(2).max(120) }).strict() }), asyncHandler(async (req, res) => {
  const run = await req.tx(async (t) => {
    const r = await loadRun(t, req.params.id, ['APPROVED']);
    await r.update({ status: 'PAID', paidAt: new Date(), paymentRef: req.body.paymentRef }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.paid', entityType: 'payroll_run', entityId: r.id, after: req.body, req });
    return r;
  });
  return ok(res, run);
}));
payrollRouter.post('/runs/:id/void', requirePermission('payroll:manage'), validate({ ...idParam, body: z.object({ reason: z.string().trim().min(3).max(500) }).strict() }), asyncHandler(async (req, res) => {
  const run = await req.tx(async (t) => {
    const r = await loadRun(t, req.params.id, ['DRAFT', 'CALCULATED', 'SUBMITTED']);
    await r.update({ status: 'VOID', notes: `Voided: ${req.body.reason}` }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'payroll.void', entityType: 'payroll_run', entityId: r.id, after: req.body, req });
    return r;
  });
  return ok(res, run);
}));

// --------------------------------------------------------------------------- reports
const csv = (res, name, header, rows) => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^[=+\-@\t]/, "'$&")}"`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"`, 'Cache-Control': 'private, no-store' });
  res.send(`﻿${[header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n')}`);
};
payrollRouter.get('/runs/:id/reports/:kind', requirePermission('payroll:export'), validate({ params: z.object({ id: z.string().uuid(), kind: z.enum(['salary-sheet', 'bank-transfer', 'tds', 'ssf']) }) }), asyncHandler(async (req, res) => {
  const { decryptField } = await import('../../services/hr/field-crypto.js');
  const { run, items } = await req.tx(async (t) => {
    const r = await app.PayrollRun.findByPk(req.params.id, { transaction: t });
    if (!r) throw NotFound('Payroll run');
    if (req.params.kind === 'bank-transfer' && !['APPROVED', 'PAID'].includes(r.status)) throw Conflict('Bank transfer files are available after approval', 'NOT_APPROVED');
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: `payroll.report_${req.params.kind}`, entityType: 'payroll_run', entityId: r.id, req });
    return { run: r, items: await app.PayrollItem.findAll({ where: { runId: r.id }, transaction: t }) };
  });
  const name = `${req.params.kind}-${run.period}`;
  const emp = (i) => i.snapshot.employee;
  const line = (i, code) => i.lines.filter((l) => l.code === code).reduce((n, l) => n + l.amount, 0);
  if (req.params.kind === 'salary-sheet') {
    const codes = [...new Set(items.flatMap((i) => i.lines.filter((l) => l.kind === 'EARNING').map((l) => l.code)))];
    return csv(res, name, ['Employee ID', 'Name', 'Payable days', ...codes, 'Gross', 'SSF (employee)', 'PF', 'CIT', 'TDS', 'Total deductions', 'Net pay', 'SSF (employer)'],
      items.map((i) => [emp(i).code, emp(i).name, r2(i.attendance.periodDays - i.attendance.unpaidDays), ...codes.map((c) => line(i, c)), i.gross, i.ssfEmployee, line(i, 'PF'), line(i, 'CIT'), i.tax, i.deductions, i.net, i.ssfEmployer]));
  }
  if (req.params.kind === 'bank-transfer') {
    return csv(res, name, ['Employee ID', 'Account name', 'Bank', 'Account number', 'Amount (NPR)', 'Remarks'],
      items.filter((i) => Number(i.net) > 0).map((i) => [emp(i).code, emp(i).bank?.accountName ?? emp(i).name, emp(i).bank?.bankName, emp(i).bank?.accountNumberEnc ? decryptField(emp(i).bank.accountNumberEnc) : '', i.net, `Salary ${periodInfo(run.period).label}`]));
  }
  if (req.params.kind === 'tds') {
    return csv(res, name, ['Employee ID', 'Name', 'PAN', 'Assessable (month)', 'Annual taxable (projected)', 'Annual tax', 'TDS this month', 'SST waived (SSF)'],
      items.map((i) => [emp(i).code, emp(i).name, emp(i).pan, i.taxDetail.assessableMonth, i.taxDetail.annualTaxable, i.taxDetail.annualTax, i.tax, i.taxDetail.sstWaived ? 'Yes' : 'No']));
  }
  return csv(res, name, ['Employee ID', 'Name', 'SSF ID', 'Basic', 'Employee 11%', 'Employer 20%', 'Total 31%'],
    items.filter((i) => Number(i.ssfEmployee) > 0).map((i) => [emp(i).code, emp(i).name, emp(i).ssfId, line(i, 'BASIC'), i.ssfEmployee, i.ssfEmployer, r2(Number(i.ssfEmployee) + Number(i.ssfEmployer))]));
}));

// --------------------------------------------------------------------------- payslips (ESS)
payrollRouter.get('/payslips/me', requirePermission('payroll:view'), asyncHandler(async (req, res) => {
  if (!req.auth.principal.employeeId) return ok(res, []);
  const rows = await req.tx((t) => app.PayrollItem.findAll({
    where: { employeeId: req.auth.principal.employeeId }, attributes: ['id', 'gross', 'deductions', 'net', 'tax', 'lines'],
    include: [{ model: app.PayrollRun, as: 'run', where: { publishedAt: { [Op.ne]: null }, status: { [Op.in]: ['APPROVED', 'PAID'] } }, attributes: ['period', 'status', 'publishedAt'] }],
    order: [[{ model: app.PayrollRun, as: 'run' }, 'period', 'DESC']], transaction: t,
  }));
  return ok(res, rows.map((r) => ({ ...r.toJSON(), label: periodInfo(r.run.period).label })));
}));

payrollRouter.get('/payslips/:itemId/pdf', requirePermission('payroll:view'), validate({ params: z.object({ itemId: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const item = await req.tx(async (t) => {
    const i = await app.PayrollItem.findByPk(req.params.itemId, { include: [{ model: app.PayrollRun, as: 'run' }, { model: app.Employee, as: 'employee' }], transaction: t });
    if (!i) throw NotFound('Payslip');
    const own = i.employeeId === req.auth.principal.employeeId;
    if (own && !i.run.publishedAt) throw NotFound('Payslip');
    if (!own && !recordInScope(req.scopes, req.auth.principal, i.employee)) throw NotFound('Payslip');
    return i;
  });
  const p = periodInfo(item.run.period);
  const e = item.snapshot.employee;
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Payslip ${p.label}` } });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="payslip-${item.run.period}-${e.code}.pdf"`, 'Cache-Control': 'private, no-store' });
  doc.pipe(res);
  const npr = (n) => Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  doc.fontSize(16).fillColor('#0f1729').text(req.auth.ctx.tenant.name).fontSize(11).fillColor('#64748b').text(`Payslip · ${p.label} (${p.start} to ${p.end})`);
  doc.moveDown().fontSize(10).fillColor('#334155').text(`Employee: ${e.name} (${e.code})   PAN: ${e.pan ?? '—'}   Bank: ${e.bank?.bankName ?? '—'} ****${e.bank?.last4 ?? ''}`);
  doc.text(`Payable days: ${r2(item.attendance.periodDays - item.attendance.unpaidDays)} of ${item.attendance.periodDays}`);
  let y = doc.y + 15;
  const col = (title, rows, x) => {
    let yy = y; doc.fontSize(10).fillColor('#64748b').text(title, x, yy); yy += 16;
    rows.forEach((l) => { doc.fillColor('#334155').text(l.name, x, yy, { width: 160 }).text(npr(l.amount), x + 160, yy, { width: 80, align: 'right' }); yy += 15; });
    return yy;
  };
  const y1 = col('EARNINGS', item.lines.filter((l) => l.kind === 'EARNING'), 50);
  const y2 = col('DEDUCTIONS', item.lines.filter((l) => l.kind === 'DEDUCTION'), 305);
  y = Math.max(y1, y2) + 10;
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#e5e9f0').stroke();
  doc.fontSize(10).fillColor('#0f1729').text(`Gross: NPR ${npr(item.gross)}`, 50, y + 8).text(`Deductions: NPR ${npr(item.deductions)}`, 305, y + 8);
  doc.rect(50, y + 30, 495, 28).fill('#eff5ff');
  doc.fontSize(12).fillColor('#1d43ad').text(`Net pay: NPR ${npr(item.net)}`, 60, y + 38);
  doc.fontSize(8).fillColor('#94a3b8').text(`Employer SSF contribution: NPR ${npr(item.ssfEmployer)}. Annual tax projection: NPR ${npr(item.taxDetail.annualTax)} (FY ${item.run.fiscalYear}). Computer-generated payslip.`, 50, 760, { width: 495, align: 'center' });
  doc.end();
}));

