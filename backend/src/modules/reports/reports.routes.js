/**
 * HR analytics & reports. Every report returns { summary, chart, table: { columns, rows } } and can be exported
 * with ?format=csv or ?format=xlsx. Data is limited to the caller's data scope (company / branch / department)
 * and, as everywhere, to the tenant by RLS.
 */
import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { appDb } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { localDate, fiscalYear, fiscalYearRange, addDays, toBS, BS_MONTHS } from '../../services/hr/calendar.js';
import { scopedEmployeeIds } from '../../services/hr/attendance.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { asyncHandler, ok } from '../../utils/http.js';
import { BadRequest, Forbidden, FeatureNotInPlan } from '../../utils/errors.js';

export const reportsRouter = Router();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
  fiscalYear: z.string().regex(/^\d{4}\/\d{2}$/).optional(),
  branchId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});

const MAX_RANGE_DAYS = 400;
const round = (n, d = 2) => Math.round(Number(n || 0) * 10 ** d) / 10 ** d;

/** Shared employee filter: data scope + optional branch/department. Returns SQL fragment and replacements. */
async function employeeFilter(req, t, alias = 'e') {
  const ids = await scopedEmployeeIds(req, t);
  const parts = [`${alias}.deleted_at IS NULL`];
  const rep = {};
  if (ids) { if (!ids.length) parts.push('false'); else { parts.push(`${alias}.id IN (:scopeIds)`); rep.scopeIds = ids; } }
  if (req.query.branchId) { parts.push(`${alias}.branch_id = :branchId`); rep.branchId = req.query.branchId; }
  if (req.query.departmentId) { parts.push(`${alias}.department_id = :departmentId`); rep.departmentId = req.query.departmentId; }
  return { sql: parts.join(' AND '), rep };
}

function range(q, tz) {
  const to = q.to ?? localDate(new Date(), tz);
  const from = q.from ?? addDays(to, -29);
  if (from > to) throw BadRequest('"from" must be on or before "to"');
  if ((new Date(to) - new Date(from)) / 86_400_000 > MAX_RANGE_DAYS) throw BadRequest(`Choose a range of at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

const sel = (t, sql, replacements) => appDb.query(sql, { replacements, type: 'SELECT', transaction: t });

// ----------------------------------------------------------------------------- reports
const REPORTS = {
  /** Headcount today, joiners/leavers in the range, turnover rate, and breakdowns. */
  async headcount(req, t, q, tz) {
    const { from, to } = range(q, tz);
    const f = await employeeFilter(req, t);
    const rep = { ...f.rep, from, to };
    const active = `e.joined_on <= :at AND (e.exited_on IS NULL OR e.exited_on > :at) AND e.status <> 'TERMINATED'`;
    const [{ start }] = await sel(t, `SELECT count(*)::int AS start FROM employees e WHERE ${f.sql} AND e.joined_on <= :at AND (e.exited_on IS NULL OR e.exited_on >= :at)`, { ...rep, at: from });
    const [{ end }] = await sel(t, `SELECT count(*)::int AS end FROM employees e WHERE ${f.sql} AND e.joined_on <= :at AND (e.exited_on IS NULL OR e.exited_on > :at)`, { ...rep, at: to });
    const [{ joiners }] = await sel(t, `SELECT count(*)::int AS joiners FROM employees e WHERE ${f.sql} AND e.joined_on BETWEEN :from AND :to`, rep);
    const [{ leavers }] = await sel(t, `SELECT count(*)::int AS leavers FROM employees e WHERE ${f.sql} AND e.exited_on BETWEEN :from AND :to`, rep);
    const avg = (start + end) / 2;
    const rows = await sel(t, `
      SELECT coalesce(d.name, 'No department') AS department, coalesce(b.name, 'No branch') AS branch,
             count(*) FILTER (WHERE e.gender = 'FEMALE')::int AS female, count(*) FILTER (WHERE e.gender = 'MALE')::int AS male,
             count(*) FILTER (WHERE coalesce(e.gender, 'OTHER') NOT IN ('FEMALE', 'MALE'))::int AS other,
             count(*) FILTER (WHERE e.employment_type = 'PERMANENT')::int AS permanent,
             count(*) FILTER (WHERE coalesce(e.employment_type, '') <> 'PERMANENT')::int AS non_permanent,
             count(*)::int AS total
        FROM employees e LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
        LEFT JOIN branches b ON b.tenant_id = e.tenant_id AND b.id = e.branch_id
       WHERE ${f.sql} AND ${active}
       GROUP BY 1, 2 ORDER BY total DESC, 1`, { ...rep, at: to });
    // Monthly joiners vs leavers for the chart
    const chart = await sel(t, `
      SELECT to_char(m, 'YYYY-MM') AS month,
             (SELECT count(*) FROM employees e WHERE ${f.sql} AND date_trunc('month', e.joined_on) = m)::int AS joiners,
             (SELECT count(*) FROM employees e WHERE ${f.sql} AND date_trunc('month', e.exited_on) = m)::int AS leavers
        FROM generate_series(date_trunc('month', CAST(:from AS date)), date_trunc('month', CAST(:to AS date)), interval '1 month') m
       ORDER BY 1`, rep);
    return {
      title: 'Headcount & turnover', period: { from, to },
      summary: [['Headcount at start', start], ['Headcount at end', end], ['Joiners', joiners], ['Leavers', leavers], ['Turnover rate', avg ? `${round((leavers / avg) * 100, 1)}%` : '—']],
      chart: { type: 'bar', x: 'month', series: [['joiners', 'Joiners'], ['leavers', 'Leavers']], data: chart },
      table: {
        columns: [['department', 'Department'], ['branch', 'Branch'], ['total', 'Headcount'], ['female', 'Female'], ['male', 'Male'], ['other', 'Other / not set'], ['permanent', 'Permanent'], ['non_permanent', 'Other employment']],
        rows,
      },
    };
  },

  /** Daily attendance trend plus per-employee totals including overtime. */
  async attendance(req, t, q, tz) {
    const { from, to } = range(q, tz);
    const f = await employeeFilter(req, t);
    const rep = { ...f.rep, from, to };
    const daily = await sel(t, `
      SELECT to_char(a.work_date, 'YYYY-MM-DD') AS date,
             count(*) FILTER (WHERE a.clock_in IS NOT NULL)::int AS present,
             count(*) FILTER (WHERE a.late_minutes > 0)::int AS late,
             round(sum(a.overtime_minutes) / 60.0, 1)::float AS overtime_hours
        FROM attendance_records a JOIN employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       WHERE ${f.sql} AND a.work_date BETWEEN :from AND :to GROUP BY 1 ORDER BY 1`, rep);
    const rows = await sel(t, `
      SELECT e.employee_code AS code, e.first_name || ' ' || e.last_name AS name, coalesce(d.name, '') AS department,
             count(*) FILTER (WHERE a.clock_in IS NOT NULL)::int AS days_present,
             count(*) FILTER (WHERE a.late_minutes > 0)::int AS late_days,
             coalesce(sum(a.late_minutes), 0)::int AS late_minutes,
             round(coalesce(sum(a.worked_minutes), 0) / 60.0, 1)::float AS worked_hours,
             round(coalesce(sum(a.overtime_minutes), 0) / 60.0, 1)::float AS overtime_hours
        FROM employees e
        LEFT JOIN attendance_records a ON a.tenant_id = e.tenant_id AND a.employee_id = e.id AND a.work_date BETWEEN :from AND :to
        LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       WHERE ${f.sql} AND e.joined_on <= :to AND (e.exited_on IS NULL OR e.exited_on >= :from)
       GROUP BY e.id, d.name ORDER BY e.first_name, e.last_name`, rep);
    const sum = (k) => round(rows.reduce((s, r) => s + Number(r[k] || 0), 0), 1);
    return {
      title: 'Attendance & overtime', period: { from, to },
      summary: [['Employees', rows.length], ['Present days', sum('days_present')], ['Late arrivals', sum('late_days')], ['Hours worked', sum('worked_hours')], ['Overtime hours', sum('overtime_hours')]],
      chart: { type: 'line', x: 'date', series: [['present', 'Present'], ['late', 'Late']], data: daily },
      table: {
        columns: [['code', 'Code'], ['name', 'Employee'], ['department', 'Department'], ['days_present', 'Days present'], ['late_days', 'Late days'], ['late_minutes', 'Late minutes'], ['worked_hours', 'Hours worked'], ['overtime_hours', 'Overtime hours']],
        rows,
      },
    };
  },

  /** Approved leave days by type and department for a fiscal year (or date range). */
  async leave(req, t, q, tz) {
    const fy = q.fiscalYear ?? fiscalYear(localDate(new Date(), tz));
    const { start, end } = fiscalYearRange(fy);
    const f = await employeeFilter(req, t);
    const rep = { ...f.rep, start, end };
    const byType = await sel(t, `
      SELECT lt.name AS type, round(sum(r.days), 1)::float AS days, count(*)::int AS requests
        FROM leave_requests r JOIN employees e ON e.tenant_id = r.tenant_id AND e.id = r.employee_id
        JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id
       WHERE ${f.sql} AND r.status = 'APPROVED' AND r.start_date BETWEEN :start AND :end
       GROUP BY lt.name ORDER BY days DESC`, rep);
    const rows = await sel(t, `
      SELECT coalesce(d.name, 'No department') AS department, lt.name AS type,
             count(DISTINCT r.employee_id)::int AS employees, count(*)::int AS requests, round(sum(r.days), 1)::float AS days
        FROM leave_requests r JOIN employees e ON e.tenant_id = r.tenant_id AND e.id = r.employee_id
        JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id
        LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       WHERE ${f.sql} AND r.status = 'APPROVED' AND r.start_date BETWEEN :start AND :end
       GROUP BY 1, 2 ORDER BY 1, days DESC`, rep);
    const [{ pending }] = await sel(t, `SELECT count(*)::int AS pending FROM leave_requests r JOIN employees e ON e.tenant_id = r.tenant_id AND e.id = r.employee_id WHERE ${f.sql} AND r.status = 'PENDING'`, rep);
    return {
      title: `Leave utilisation FY ${fy}`, period: { from: start, to: end, fiscalYear: fy },
      summary: [['Approved leave days', round(byType.reduce((s, r) => s + r.days, 0), 1)], ['Approved requests', byType.reduce((s, r) => s + r.requests, 0)], ['Pending requests', pending]],
      chart: { type: 'bar', x: 'type', series: [['days', 'Days taken']], data: byType },
      table: { columns: [['department', 'Department'], ['type', 'Leave type'], ['employees', 'Employees'], ['requests', 'Requests'], ['days', 'Days']], rows },
    };
  },

  /** Payroll cost per BS month for a fiscal year, from approved/published/paid runs. */
  async payroll(req, t, q, tz) {
    const fy = q.fiscalYear ?? fiscalYear(localDate(new Date(), tz));
    const f = await employeeFilter(req, t);
    const rep = { ...f.rep, fy };
    const rows = await sel(t, `
      SELECT r.period, to_char(r.period_start, 'YYYY-MM-DD') AS period_start, r.status, count(i.id)::int AS employees,
             round(sum(i.gross), 2)::float AS gross, round(sum(i.tax), 2)::float AS tax,
             round(sum(i.ssf_employee), 2)::float AS ssf_employee, round(sum(i.ssf_employer), 2)::float AS ssf_employer,
             round(sum(i.net), 2)::float AS net, round(sum(i.gross + i.ssf_employer), 2)::float AS employer_cost
        FROM payroll_runs r JOIN payroll_items i ON i.tenant_id = r.tenant_id AND i.run_id = r.id
        JOIN employees e ON e.tenant_id = i.tenant_id AND e.id = i.employee_id
       WHERE ${f.sql} AND r.fiscal_year = :fy AND r.status IN ('APPROVED', 'PUBLISHED', 'PAID')
       GROUP BY r.id ORDER BY r.period_start`, rep);
    for (const r of rows) { const bs = toBS(r.period_start); r.month = `${BS_MONTHS[bs.month - 1]} ${bs.year}`; }
    const total = (k) => round(rows.reduce((s, r) => s + r[k], 0));
    return {
      title: `Payroll cost FY ${fy}`, period: { fiscalYear: fy }, money: true,
      note: 'Includes approved, published and paid payroll runs. Drafts are left out until approved.',
      summary: [['Gross pay', total('gross')], ['Income tax (TDS)', total('tax')], ['SSF (employee + employer)', round(total('ssf_employee') + total('ssf_employer'))], ['Net pay', total('net')], ['Employer cost', total('employer_cost')]],
      chart: { type: 'bar', x: 'month', series: [['net', 'Net pay'], ['tax', 'Tax'], ['ssf_employer', 'Employer SSF']], data: rows },
      table: {
        columns: [['month', 'Month'], ['status', 'Status'], ['employees', 'Employees'], ['gross', 'Gross'], ['tax', 'Tax'], ['ssf_employee', 'SSF employee'], ['ssf_employer', 'SSF employer'], ['net', 'Net'], ['employer_cost', 'Employer cost']],
        rows,
      },
    };
  },
};

/** Payroll figures only for people who may see other people's payroll (not OWN-scope self-service). */
const wideGrant = (req, key) => (req.auth.grants.get(key)?.scopes ?? []).some((s) => s.scope !== 'OWN');
const EXTRA_PERMISSION = { payroll: 'payroll:view' };

// ----------------------------------------------------------------------------- export
function toCsv(report) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const { columns, rows } = report.table;
  return '﻿' + [columns.map(([, l]) => esc(l)).join(','), ...rows.map((r) => columns.map(([k]) => esc(r[k])).join(','))].join('\r\n') + '\r\n';
}

async function toXlsx(report, companyName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lishnu HRMS'; wb.created = new Date();
  const ws = wb.addWorksheet(report.title.slice(0, 31).replace(/[\\/?*[\]:]/g, '-'));
  ws.addRow([`${companyName}: ${report.title}`]).font = { bold: true, size: 14 };
  const p = report.period;
  ws.addRow([p.fiscalYear ? `Fiscal year ${p.fiscalYear}` : `${p.from} to ${p.to}`]);
  ws.addRow([]);
  for (const [k, v] of report.summary) { const r = ws.addRow([k, v]); r.getCell(1).font = { bold: true }; if (report.money && typeof v === 'number') r.getCell(2).numFmt = '#,##0.00'; }
  ws.addRow([]);
  const header = ws.addRow(report.table.columns.map(([, l]) => l));
  header.font = { bold: true }; header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEFC' } }; });
  for (const row of report.table.rows) {
    const r = ws.addRow(report.table.columns.map(([k]) => row[k]));
    if (report.money) r.eachCell((c) => { if (typeof c.value === 'number') c.numFmt = '#,##0.00'; });
  }
  ws.columns.forEach((c, i) => { c.width = Math.min(40, Math.max(12, ...report.table.rows.map((r) => String(r[report.table.columns[i]?.[0]] ?? '').length + 2), String(report.table.columns[i]?.[1] ?? '').length + 2)); });
  return wb.xlsx.writeBuffer();
}

// ----------------------------------------------------------------------------- routes
reportsRouter.get('/', requirePermission('reports:view'), (req, res) => ok(res, { canExport: req.auth.ctx.features.includes('reports_advanced'), reports: [
  { key: 'headcount', name: 'Headcount & turnover', filters: ['range', 'branch', 'department'] },
  { key: 'attendance', name: 'Attendance & overtime', filters: ['range', 'branch', 'department'] },
  { key: 'leave', name: 'Leave utilisation', filters: ['fiscalYear', 'branch', 'department'] },
  { key: 'payroll', name: 'Payroll cost', filters: ['fiscalYear', 'branch', 'department'], requires: 'payroll:view' },
].filter((r) => r.key !== 'payroll' || req.auth.ctx.features.includes('payroll')) }));

reportsRouter.get('/:key', requirePermission('reports:view'), validate({ query }), asyncHandler(async (req, res) => {
  const fn = REPORTS[req.params.key];
  if (!fn) throw BadRequest('Unknown report');
  const extra = EXTRA_PERMISSION[req.params.key];
  const features = req.auth.ctx.features;
  if (req.params.key === 'payroll' && !features.includes('payroll')) throw FeatureNotInPlan('payroll');
  if (extra && !wideGrant(req, extra)) throw Forbidden('You need payroll access for this report');
  const q = req.query;
  if (q.format !== 'json') {
    if (!features.includes('reports_advanced')) throw FeatureNotInPlan('reports_advanced'); // export is an "Advanced Reports" capability
    if (!req.auth.grants.has('reports:export')) throw Forbidden('You do not have permission to export reports');
  }
  const { timezone: tz = 'Asia/Kathmandu', name: companyName } = req.auth.ctx.tenant;
  const report = await req.tx(async (t) => {
    const r = await fn(req, t, q, tz);
    if (q.format !== 'json') await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'report.export', entityType: 'report', after: { report: req.params.key, ...q }, req });
    return r;
  });
  const file = `${req.params.key}-${(report.period.fiscalYear ?? report.period.to ?? '').replace('/', '-')}`;
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.csv"`);
    return res.send(toCsv(report));
  }
  if (q.format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
    return res.send(Buffer.from(await toXlsx(report, companyName)));
  }
  return ok(res, report);
}));
