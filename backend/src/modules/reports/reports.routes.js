/**
 * HR analytics & reports. Every report returns { summary, chart, table: { columns, rows } } and can be exported
 * with ?format=csv or ?format=xlsx. Data is limited to the caller's data scope (company / branch / department)
 * and, as everywhere, to the tenant by RLS.
 */
import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { getPolicy, rangeSummary } from '../../services/hr/attendance.js';
import { balances } from '../leave/leave.routes.js';
import { getUsage } from '../../services/subscription.service.js';
import { appDb } from '../../database/index.js';
import { requirePermission } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { localDate, fiscalYear, fiscalYearRange, addDays, toBS, BS_MONTHS } from '../../services/hr/calendar.js';
import { scopedEmployeeIds } from '../../services/hr/attendance.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { performance } from '../../services/work.service.js';
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
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
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
  /** Late arrivals, early departures, absences and missing punches per employee. */
  async punctuality(req, t, q, tz) {
    const { from, to } = range(q, tz);
    const f = await employeeFilter(req, t);
    const emps = await sel(t, `SELECT e.id FROM employees e WHERE ${f.sql} AND e.joined_on <= :to AND (e.exited_on IS NULL OR e.exited_on >= :from)`, { ...f.rep, from, to });
    const policy = await getPolicy(t);
    const sum = emps.length ? await rangeSummary(t, { employeeIds: emps.map((e) => e.id), from, to, tz, policy }) : [];
    const rows = sum.map((s) => ({ code: s.code, name: s.name, working_days: s.workingDays, present: s.present, late_days: s.late, late_minutes: s.lateMinutes, early_days: s.early, absent: s.absent, missing_punch: s.missingPunch, rule_days: s.lateDeductionDays }))
      .sort((a, b) => b.late_days + b.absent - (a.late_days + a.absent));
    const tot = (k) => round(rows.reduce((n, r) => n + Number(r[k] || 0), 0), 1);
    return {
      title: 'Late arrivals & absences', period: { from, to },
      summary: [['Late arrivals', tot('late_days')], ['Late minutes', tot('late_minutes')], ['Early departures', tot('early_days')], ['Absent days', tot('absent')], ['Missing check-outs', tot('missing_punch')]],
      chart: { type: 'bar', x: 'name', series: [['late_days', 'Late days'], ['absent', 'Absent days']], data: rows.slice(0, 15) },
      table: { columns: [['code', 'Code'], ['name', 'Employee'], ['working_days', 'Working days'], ['present', 'Present'], ['late_days', 'Late days'], ['late_minutes', 'Late minutes'], ['early_days', 'Early departures'], ['absent', 'Absent'], ['missing_punch', 'Missing check-out'], ['rule_days', 'Unpaid days (late rule)']], rows },
    };
  },

  /** Current leave balances per employee and leave type. */
  async balances(req, t, q, tz) {
    const fy = q.fiscalYear ?? fiscalYear(localDate(new Date(), tz));
    const f = await employeeFilter(req, t);
    const emps = await sel(t, `SELECT e.id, e.employee_code AS code, e.first_name || ' ' || e.last_name AS name, e.gender FROM employees e WHERE ${f.sql} AND e.status <> 'TERMINATED' ORDER BY 3 LIMIT 2000`, f.rep);
    const rows = [];
    for (const e of emps) {
      for (const b of await balances(t, { id: e.id, gender: e.gender }, fy, tz)) {
        if (!b.tracked) continue;
        rows.push({ code: e.code, name: e.name, type: b.name, entitled: b.entitled, used: b.used, pending: b.pending, available: b.available });
      }
    }
    const byType = Object.values(rows.reduce((m, r) => { (m[r.type] ??= { type: r.type, used: 0, available: 0 }); m[r.type].used += r.used; m[r.type].available += r.available; return m; }, {}))
      .map((x) => ({ ...x, used: round(x.used, 1), available: round(x.available, 1) }));
    return {
      title: `Leave balances FY ${fy}`, period: { fiscalYear: fy },
      summary: [['Employees', emps.length], ['Days used', round(rows.reduce((n, r) => n + r.used, 0), 1)], ['Days available', round(rows.reduce((n, r) => n + r.available, 0), 1)]],
      chart: { type: 'bar', x: 'type', series: [['used', 'Used'], ['available', 'Available']], data: byType },
      table: { columns: [['code', 'Code'], ['name', 'Employee'], ['type', 'Leave type'], ['entitled', 'Entitled'], ['used', 'Used'], ['pending', 'Pending'], ['available', 'Available']], rows },
    };
  },

  /** Overtime pay and every deduction type, per employee, from approved payroll in a fiscal year. */
  async deductions(req, t, q, tz) {
    const fy = q.fiscalYear ?? fiscalYear(localDate(new Date(), tz));
    const f = await employeeFilter(req, t);
    const items = await sel(t, `
      SELECT e.employee_code AS code, e.first_name || ' ' || e.last_name AS name, i.lines, i.attendance, i.tax
        FROM payroll_items i JOIN payroll_runs r ON r.tenant_id = i.tenant_id AND r.id = i.run_id
        JOIN employees e ON e.tenant_id = i.tenant_id AND e.id = i.employee_id
       WHERE ${f.sql} AND r.fiscal_year = :fy AND r.status IN ('APPROVED', 'PAID')`, { ...f.rep, fy });
    const per = new Map();
    const lineSum = (lines, pred) => lines.filter(pred).reduce((n, l) => n + Number(l.amount), 0);
    for (const it of items) {
      const p = per.get(it.code) ?? { code: it.code, name: it.name, overtime_hours: 0, overtime_pay: 0, unpaid_days: 0, late_rule_days: 0, ssf_pf_cit: 0, tax: 0, advances_loans: 0, fines_other: 0 };
      p.overtime_hours += Number(it.attendance?.overtimeMinutes ?? 0) / 60;
      p.overtime_pay += lineSum(it.lines, (l) => l.code === 'OVERTIME');
      p.unpaid_days += Number(it.attendance?.unpaidDays ?? 0);
      p.late_rule_days += Number(it.attendance?.unpaidBreakdown?.lateRule ?? 0);
      p.ssf_pf_cit += lineSum(it.lines, (l) => ['SSF', 'PF', 'CIT'].includes(l.code));
      p.tax += Number(it.tax);
      p.advances_loans += lineSum(it.lines, (l) => l.loanId);
      p.fines_other += lineSum(it.lines, (l) => l.kind === 'DEDUCTION' && !['SSF', 'PF', 'CIT', 'TDS'].includes(l.code) && !l.loanId);
      per.set(it.code, p);
    }
    const out = [...per.values()].map((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])));
    const tot = (k) => round(out.reduce((n, r) => n + r[k], 0));
    return {
      title: `Overtime & deductions FY ${fy}`, period: { fiscalYear: fy }, money: true,
      note: 'From approved and paid payroll runs.',
      summary: [['Overtime pay', tot('overtime_pay')], ['Unpaid days', tot('unpaid_days')], ['Tax (TDS)', tot('tax')], ['Advances & loans recovered', tot('advances_loans')], ['Fines & other', tot('fines_other')]],
      chart: { type: 'bar', x: 'name', series: [['overtime_pay', 'Overtime pay'], ['advances_loans', 'Advances & loans']], data: out.slice(0, 15) },
      table: { columns: [['code', 'Code'], ['name', 'Employee'], ['overtime_hours', 'OT hours'], ['overtime_pay', 'OT pay'], ['unpaid_days', 'Unpaid days'], ['late_rule_days', 'Of which late rule'], ['ssf_pf_cit', 'SSF/PF/CIT'], ['tax', 'Tax'], ['advances_loans', 'Advances/loans'], ['fines_other', 'Fines & other']], rows: out },
    };
  },

  /** Biometric device activity in a date range. */
  async devices(req, t, q, tz) {
    const { from, to } = range(q, tz);
    const rep = { from: `${from}T00:00:00+05:45`, to: `${addDays(to, 1)}T00:00:00+05:45` };
    const rows = await sel(t, `
      SELECT d.name AS device, d.serial_number AS serial, coalesce(b.name, '') AS branch, d.status,
             to_char(d.last_seen_at AT TIME ZONE 'Asia/Kathmandu', 'YYYY-MM-DD HH24:MI') AS last_seen,
             count(p.id) FILTER (WHERE p.result = 'APPLIED')::int AS applied, count(p.id) FILTER (WHERE p.result = 'UNMAPPED')::int AS unmapped,
             count(p.id) FILTER (WHERE p.result IN ('IGNORED', 'ERROR'))::int AS ignored,
             (SELECT count(*) FROM device_logs l WHERE l.tenant_id = d.tenant_id AND l.device_id = d.id AND l.level = 'ERROR' AND l.created_at >= CAST(:from AS timestamptz) AND l.created_at < CAST(:to AS timestamptz))::int AS errors
        FROM attendance_devices d LEFT JOIN branches b ON b.tenant_id = d.tenant_id AND b.id = d.branch_id
        LEFT JOIN device_punches p ON p.tenant_id = d.tenant_id AND p.device_id = d.id AND p.punched_at >= CAST(:from AS timestamptz) AND p.punched_at < CAST(:to AS timestamptz)
       WHERE d.deleted_at IS NULL GROUP BY d.id, b.name ORDER BY d.name`, rep);
    const tot = (k) => rows.reduce((n, r) => n + r[k], 0);
    return {
      title: 'Attendance device activity', period: { from, to },
      summary: [['Devices', rows.length], ['Punches applied', tot('applied')], ['Unmapped punches', tot('unmapped')], ['Ignored', tot('ignored')], ['Errors', tot('errors')]],
      chart: { type: 'bar', x: 'device', series: [['applied', 'Applied'], ['unmapped', 'Unmapped']], data: rows },
      table: { columns: [['device', 'Device'], ['serial', 'Serial'], ['branch', 'Branch'], ['status', 'Status'], ['last_seen', 'Last contact'], ['applied', 'Applied'], ['unmapped', 'Unmapped'], ['ignored', 'Ignored'], ['errors', 'Errors']], rows },
    };
  },

  /** Per-employee performance: task delivery, daily-report compliance, manager ratings, punctuality. */
  async performance(req, t, q, tz) {
    const { from, to } = range(q, tz);
    const f = await employeeFilter(req, t);
    const ids = (await sel(t, `SELECT e.id FROM employees e WHERE ${f.sql}`, f.rep)).map((r) => r.id);
    const data = await performance(t, { ids, from, to, tz, today: localDate(new Date(), tz) });
    const rows = data.map((r) => ({
      employee: r.employee.name, code: r.employee.employeeCode, department: r.employee.department ?? '—',
      score: r.score ?? '—', completed: r.tasks.completed, on_time: r.tasks.onTimeRate != null ? `${r.tasks.onTimeRate}%` : '—', overdue: r.tasks.overdue, open: r.tasks.open,
      reports: r.reports.submitted, report_rate: r.reports.rate != null ? `${r.reports.rate}%` : '—', rating: r.reports.avgRating ?? '—', hours: round(r.reports.hours, 1),
      present: r.attendance.present, late: r.attendance.late,
    }));
    const scored = data.filter((r) => r.score != null);
    const sum = (fn) => data.reduce((s, r) => s + fn(r), 0);
    return {
      title: 'Employee performance', period: { from, to },
      summary: [['Employees', data.length], ['Average score', scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : '—'],
        ['Tasks completed', sum((r) => r.tasks.completed)], ['Overdue now', sum((r) => r.tasks.overdue)], ['Daily reports', sum((r) => r.reports.submitted)]],
      chart: { type: 'bar', x: 'employee', series: [['completed', 'Tasks completed'], ['overdue', 'Overdue']], data: rows.slice(0, 20) },
      table: { columns: [['employee', 'Employee'], ['code', 'ID'], ['department', 'Department'], ['score', 'Score'], ['completed', 'Completed'], ['on_time', 'On time'], ['overdue', 'Overdue'], ['open', 'Open'],
        ['reports', 'Reports'], ['report_rate', 'Report rate'], ['rating', 'Avg rating'], ['hours', 'Hours reported'], ['present', 'Days present'], ['late', 'Late']], rows },
    };
  },

  /** Task register: every task due or completed in the range, with delivery against the due date. */
  async tasks(req, t, q, tz) {
    const { from, to } = range(q, tz);
    const f = await employeeFilter(req, t);
    const rows = await sel(t, `
      SELECT 'T-' || k.number AS key, k.title, e.first_name || ' ' || e.last_name AS assignee, coalesce(p.name, '—') AS project,
             initcap(k.priority) AS priority, replace(initcap(k.status), '_', ' ') AS status, k.progress, k.due_on::text AS due,
             (k.completed_at AT TIME ZONE :tz)::date::text AS completed,
             CASE WHEN k.status = 'DONE' AND k.due_on IS NOT NULL THEN CASE WHEN (k.completed_at AT TIME ZONE :tz)::date <= k.due_on THEN 'Yes' ELSE 'Late' END
                  WHEN k.status IN ('TODO','IN_PROGRESS','BLOCKED','IN_REVIEW') AND k.due_on < :today THEN 'Overdue' ELSE '' END AS on_time,
             k.estimate_hours::float AS estimate, k.logged_hours::float AS logged
        FROM tasks k JOIN employees e ON e.tenant_id = k.tenant_id AND e.id = k.assignee_id
        LEFT JOIN projects p ON p.tenant_id = k.tenant_id AND p.id = k.project_id
       WHERE k.deleted_at IS NULL AND ${f.sql}
         AND (k.due_on BETWEEN :from AND :to OR (k.completed_at AT TIME ZONE :tz)::date BETWEEN :from AND :to
              OR (k.created_at AT TIME ZONE :tz)::date BETWEEN :from AND :to)
       ORDER BY k.due_on NULLS LAST, k.number`, { ...f.rep, from, to, tz, today: localDate(new Date(), tz) });
    const c = (st) => rows.filter((r) => r.status === st).length;
    const byStatus = ['To do', 'In progress', 'Blocked', 'In review', 'Done', 'Cancelled'].map((st) => ({ status: st, count: rows.filter((r) => r.status.toLowerCase() === st.toLowerCase()).length }));
    return {
      title: 'Task register', period: { from, to },
      summary: [['Tasks', rows.length], ['Done', c('Done')], ['Completed on time', rows.filter((r) => r.on_time === 'Yes').length], ['Completed late', rows.filter((r) => r.on_time === 'Late').length], ['Overdue now', rows.filter((r) => r.on_time === 'Overdue').length]],
      chart: { type: 'bar', x: 'status', series: [['count', 'Tasks']], data: byStatus },
      table: { columns: [['key', 'Task'], ['title', 'Title'], ['assignee', 'Assignee'], ['project', 'Project'], ['priority', 'Priority'], ['status', 'Status'], ['progress', 'Progress %'],
        ['due', 'Due'], ['completed', 'Completed'], ['on_time', 'On time'], ['estimate', 'Estimate h'], ['logged', 'Logged h']], rows },
    };
  },

  /** Plan, usage against limits and enabled features. */
  async subscription(req, t) {
    const ctx = req.auth.ctx;
    const usage = await getUsage(t);
    const lim = ctx.limits;
    const pct = (u, l) => (l ? `${Math.round((u / l) * 100)}%` : 'Unlimited');
    const rows = [
      { metric: 'Employees', used: usage.employees, limit: lim.employees ?? 'Unlimited', share: pct(usage.employees, lim.employees) },
      { metric: 'Branches', used: usage.branches, limit: lim.branches ?? 'Unlimited', share: pct(usage.branches, lim.branches) },
      { metric: 'Users', used: usage.users, limit: lim.users ?? 'Unlimited', share: pct(usage.users, lim.users) },
      { metric: 'Storage (MB)', used: usage.storageMb, limit: lim.storageMb ?? 'Unlimited', share: pct(usage.storageMb, lim.storageMb) },
    ];
    return {
      title: 'Subscription usage', period: { from: localDate(new Date()), to: localDate(new Date()) },
      summary: [['Plan', ctx.subscription?.planName ?? '—'], ['Status', ctx.subscription?.status?.toLowerCase() ?? '—'], ['Renews / ends', ctx.subscription?.currentPeriodEnd ? localDate(new Date(ctx.subscription.currentPeriodEnd)) : '—'], ['Features enabled', ctx.features.length]],
      chart: { type: 'bar', x: 'metric', series: [['used', 'Used']], data: rows.filter((r) => typeof r.limit === 'number').map((r) => ({ metric: r.metric, used: r.used })) },
      table: { columns: [['metric', 'Limit'], ['used', 'Used'], ['limit', 'Allowed'], ['share', 'Used %']], rows },
    };
  },
};

/** Payroll figures only for people who may see other people's payroll (not OWN-scope self-service). */
const wideGrant = (req, key) => (req.auth.grants.get(key)?.scopes ?? []).some((s) => s.scope !== 'OWN');
const EXTRA_PERMISSION = { performance: 'work_reports:view', tasks: 'tasks:view', payroll: 'payroll:view', deductions: 'payroll:view', devices: 'devices:view', subscription: 'subscription:view' };
const FEATURE_FOR = { performance: 'tasks', tasks: 'tasks', payroll: 'payroll', deductions: 'payroll', devices: 'biometric', punctuality: 'attendance', attendance: 'attendance', leave: 'leave', balances: 'leave' };

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

/** A4 landscape table, repeated header on each page. */
function toPdf(report, companyName, res, filename) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: report.title } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  doc.pipe(res);
  const p = report.period;
  doc.fontSize(15).fillColor('#0f1729').text(`${companyName}: ${report.title}`);
  doc.fontSize(9).fillColor('#64748b').text(`${p.fiscalYear ? `Fiscal year ${p.fiscalYear}` : `${p.from} to ${p.to}`} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  doc.moveDown(0.6).fontSize(9).fillColor('#334155').text(report.summary.map(([k, v]) => `${k}: ${report.money && typeof v === 'number' ? v.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : v}`).join('   ·   '));
  if (report.note) doc.fontSize(8).fillColor('#64748b').text(report.note);
  const cols = report.table.columns;
  const width = doc.page.width - 72;
  const w = width / cols.length;
  const fmt = (v) => (v == null ? '' : report.money && typeof v === 'number' ? v.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : String(v));
  let y = doc.y + 12;
  const header = () => {
    doc.rect(36, y - 3, width, 16).fill('#e8eefc');
    doc.fillColor('#0f1729').fontSize(7.5).font('Helvetica-Bold');
    cols.forEach(([, l], i) => doc.text(l, 38 + i * w, y, { width: w - 4, ellipsis: true, lineBreak: false }));
    doc.font('Helvetica'); y += 16;
  };
  header();
  for (const row of report.table.rows) {
    if (y > doc.page.height - 50) { doc.addPage(); y = 40; header(); }
    doc.fillColor('#334155').fontSize(7.5);
    cols.forEach(([k], i) => doc.text(fmt(row[k]), 38 + i * w, y, { width: w - 4, ellipsis: true, lineBreak: false, align: typeof row[k] === 'number' ? 'right' : 'left' }));
    y += 13;
  }
  if (!report.table.rows.length) doc.fillColor('#64748b').fontSize(9).text('No data for these filters.', 36, y);
  doc.end();
}

// ----------------------------------------------------------------------------- routes
reportsRouter.get('/', requirePermission('reports:view'), (req, res) => ok(res, { canExport: req.auth.ctx.features.includes('reports_advanced'), reports: [
  { key: 'headcount', name: 'Headcount & turnover', filters: ['range', 'branch', 'department'] },
  { key: 'attendance', name: 'Attendance & overtime', filters: ['range', 'branch', 'department'] },
  { key: 'leave', name: 'Leave utilisation', filters: ['fiscalYear', 'branch', 'department'] },
  { key: 'punctuality', name: 'Late & absences', filters: ['range', 'branch', 'department'] },
  { key: 'balances', name: 'Leave balances', filters: ['fiscalYear', 'branch', 'department'] },
  { key: 'performance', name: 'Employee performance', filters: ['range', 'branch', 'department'], requires: 'work_reports:view' },
  { key: 'tasks', name: 'Task register', filters: ['range', 'branch', 'department'], requires: 'tasks:view' },
  { key: 'payroll', name: 'Payroll cost', filters: ['fiscalYear', 'branch', 'department'], requires: 'payroll:view' },
  { key: 'deductions', name: 'Overtime & deductions', filters: ['fiscalYear', 'branch', 'department'], requires: 'payroll:view' },
  { key: 'devices', name: 'Device activity', filters: ['range'], requires: 'devices:view' },
  { key: 'subscription', name: 'Subscription usage', filters: [], requires: 'subscription:view' },
].filter((r) => !FEATURE_FOR[r.key] || req.auth.ctx.features.includes(FEATURE_FOR[r.key])) }));

reportsRouter.get('/:key', requirePermission('reports:view'), validate({ query }), asyncHandler(async (req, res) => {
  const fn = REPORTS[req.params.key];
  if (!fn) throw BadRequest('Unknown report');
  const extra = EXTRA_PERMISSION[req.params.key];
  const features = req.auth.ctx.features;
  if (FEATURE_FOR[req.params.key] && !features.includes(FEATURE_FOR[req.params.key])) throw FeatureNotInPlan(FEATURE_FOR[req.params.key]);
  if (extra && !wideGrant(req, extra)) throw Forbidden(`This report needs ${extra.split(':')[0]} access`);
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
  if (q.format === 'pdf') return toPdf(report, companyName, res, file);
  if (q.format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"`);
    return res.send(Buffer.from(await toXlsx(report, companyName)));
  }
  return ok(res, report);
}));
