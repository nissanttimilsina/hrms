/**
 * Work management helpers shared by the tasks, work-report and performance routes and the daily reminder job.
 *
 * Visibility follows the RBAC data scope of the *assignee*: a team leader with tasks:view DIRECT_REPORTS sees
 * tasks assigned to their reports; anyone always sees tasks they created themselves.
 */
import { Op, QueryTypes } from 'sequelize';
import { app, appDb, systemDb, withTenant } from '../database/index.js';
import { scopeWhere, recordInScope } from './rbac.service.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from './hr/notify.js';
import { localDate, addDays, weekday } from './hr/calendar.js';
import { getTenantContext, evaluateAccess } from './subscription.service.js';
import { logger } from '../utils/logger.js';

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED'];
export const OPEN = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const EMP_ATTRS = ['id', 'firstName', 'lastName', 'employeeCode', 'managerId', 'departmentId', 'branchId'];

/** Employee ids inside a permission's scopes; null = whole company. */
export async function employeeIdsInScope(t, scopes, principal) {
  if (!scopes?.length) return [];
  if (scopes.some((s) => s.scope === 'COMPANY')) return null;
  const rows = await app.Employee.findAll({ where: { [Op.and]: [{ deletedAt: null }, scopeWhere(scopes, principal)] }, attributes: ['id'], raw: true, transaction: t });
  return rows.map((r) => r.id);
}

/** Scopes wider than "own" (manager-type access). */
export const wideScopes = (scopes = []) => scopes.filter((s) => s.scope !== 'OWN');

export async function loadEmployee(t, id) {
  return app.Employee.findOne({ where: { id, deletedAt: null }, attributes: EMP_ATTRS, transaction: t });
}

/** What the current user may do with a task. */
export function taskAbilities(req, task, assignee) {
  const p = req.auth.principal;
  const g = (k) => req.auth.grants.get(k)?.scopes ?? [];
  const isAssignee = !!p.employeeId && task.assigneeId === p.employeeId;
  const isCreator = task.createdBy === req.auth.userId;
  const manages = isCreator || (!!assignee && recordInScope(wideScopes(g('tasks:edit')), p, assignee));
  const canView = isAssignee || isCreator || (!!assignee && recordInScope(g('tasks:view'), p, assignee));
  return {
    canView,
    isAssignee,
    canManage: manages,                                   // edit fields, reassign, approve review, reopen, cancel
    canUpdate: manages || (isAssignee && req.auth.grants.has('tasks:edit')), // status/progress/comments
    canDelete: (isCreator || (!!assignee && recordInScope(wideScopes(g('tasks:delete')), p, assignee))) && req.auth.grants.has('tasks:delete'),
  };
}

export const label = (task) => `T-${task.number}`;

/** Next per-company task number (serialised per tenant inside the transaction). */
export async function nextTaskNumber(t, tenantId) {
  await appDb.query('SELECT pg_advisory_xact_lock(hashtext(:k))', { replacements: { k: `tasks:${tenantId}` }, transaction: t });
  const [{ n }] = await appDb.query('SELECT coalesce(max(number), 0) + 1 AS n FROM tasks', { type: QueryTypes.SELECT, transaction: t });
  return Number(n);
}

export async function logActivity(t, req, task, kind, { body = null, from = null, to = null } = {}) {
  return app.TaskActivity.create({ tenantId: task.tenantId, taskId: task.id, authorId: req?.auth?.userId ?? null, kind, body, fromValue: from, toValue: to }, { transaction: t });
}

/** Re-total hours logged against tasks from submitted daily reports. */
export async function recomputeLoggedHours(t, taskIds) {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (!ids.length) return;
  await appDb.query(
    `UPDATE tasks SET logged_hours = coalesce((SELECT sum(i.hours) FROM work_report_items i JOIN work_reports r ON r.id = i.report_id
        WHERE i.task_id = tasks.id AND r.status <> 'DRAFT'), 0), updated_at = now() WHERE id IN (:ids)`,
    { replacements: { ids }, transaction: t },
  );
}

/** Who reviews an employee's daily reports: their manager, otherwise company-wide reviewers. */
export async function reviewerUserIds(t, employee) {
  const mgr = employee.managerId ? await userIdForEmployee(t, employee.managerId) : null;
  if (mgr) return [mgr];
  return usersWithPermission(t, 'work_reports:approve');
}

export async function notifyTaskPeople(t, req, task, { to = [], title, body, email = false }) {
  const ids = [];
  for (const who of to) {
    if (who === 'assignee') ids.push(await userIdForEmployee(t, task.assigneeId));
    if (who === 'creator') ids.push(task.createdBy);
  }
  const recipients = ids.filter((id) => id && id !== req?.auth?.userId);
  if (recipients.length) await notifyUsers(t, recipients, { type: 'task', title, body, link: `/tasks/${task.id}`, email });
}

// --------------------------------------------------------------------------- performance
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

/**
 * Performance indicators per employee for a date range.
 *  - task delivery: completed in the period, share completed on or before the due date, overdue now
 *  - daily reports: submitted vs days present, average manager rating
 *  - attendance: days present, late arrivals
 *  - score (0-100): weighted mix of the indicators that have data (on-time 35, reports 25, rating 25, punctuality 15);
 *    shown only when at least two indicators have data
 */
export async function performance(t, { ids, from, to, tz, today }) {
  if (ids && !ids.length) return [];
  const idFilter = (col) => (ids ? `AND ${col} IN (:ids)` : '');
  const rep = { ids: ids ?? [], from, to, today, tz, fromTs: `${from} 00:00`, toTs: `${addDays(to, 1)} 00:00` };
  const q = (sql) => appDb.query(sql, { replacements: rep, type: QueryTypes.SELECT, transaction: t });
  const [emps, tasks, reports, att] = await Promise.all([
    q(`SELECT e.id, e.first_name, e.last_name, e.employee_code, e.department_id, e.branch_id, d.name AS department, des.name AS designation
         FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations des ON des.id = e.designation_id
        WHERE e.deleted_at IS NULL AND e.status <> 'TERMINATED' ${idFilter('e.id')} ORDER BY e.first_name, e.last_name`),
    q(`SELECT assignee_id AS id,
              count(*) FILTER (WHERE status IN ('TODO','IN_PROGRESS','BLOCKED','IN_REVIEW'))::int AS open,
              count(*) FILTER (WHERE status IN ('TODO','IN_PROGRESS','BLOCKED','IN_REVIEW') AND due_on < :today)::int AS overdue,
              count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked,
              count(*) FILTER (WHERE created_at >= (:fromTs)::timestamp AT TIME ZONE :tz AND created_at < (:toTs)::timestamp AT TIME ZONE :tz)::int AS assigned,
              count(*) FILTER (WHERE status = 'DONE' AND completed_at >= (:fromTs)::timestamp AT TIME ZONE :tz AND completed_at < (:toTs)::timestamp AT TIME ZONE :tz)::int AS completed,
              count(*) FILTER (WHERE status = 'DONE' AND completed_at >= (:fromTs)::timestamp AT TIME ZONE :tz AND completed_at < (:toTs)::timestamp AT TIME ZONE :tz
                                 AND due_on IS NOT NULL)::int AS completed_with_due,
              count(*) FILTER (WHERE status = 'DONE' AND completed_at >= (:fromTs)::timestamp AT TIME ZONE :tz AND completed_at < (:toTs)::timestamp AT TIME ZONE :tz
                                 AND due_on IS NOT NULL AND (completed_at AT TIME ZONE :tz)::date <= due_on)::int AS on_time,
              coalesce(round(avg(progress) FILTER (WHERE status IN ('TODO','IN_PROGRESS','BLOCKED','IN_REVIEW'))), 0)::int AS avg_progress
         FROM tasks WHERE deleted_at IS NULL ${idFilter('assignee_id')} GROUP BY assignee_id`),
    q(`SELECT employee_id AS id, count(*) FILTER (WHERE status <> 'DRAFT')::int AS submitted,
              count(*) FILTER (WHERE status = 'SUBMITTED')::int AS awaiting_review,
              round(avg(rating) FILTER (WHERE rating IS NOT NULL), 2)::float AS avg_rating, count(rating)::int AS rated,
              coalesce(sum(hours) FILTER (WHERE status <> 'DRAFT'), 0)::float AS hours
         FROM work_reports WHERE report_date BETWEEN :from AND :to ${idFilter('employee_id')} GROUP BY employee_id`),
    q(`SELECT employee_id AS id, count(*) FILTER (WHERE status IN ('PRESENT','LATE','HALF_DAY'))::int AS present,
              count(*) FILTER (WHERE status = 'LATE')::int AS late, coalesce(sum(worked_minutes), 0)::int AS worked_minutes
         FROM attendance_records WHERE work_date BETWEEN :from AND :to ${idFilter('employee_id')} GROUP BY employee_id`),
  ]);
  const by = (rows) => new Map(rows.map((r) => [r.id, r]));
  const T = by(tasks); const R = by(reports); const A = by(att);
  return emps.map((e) => {
    const tk = T.get(e.id) ?? { open: 0, overdue: 0, blocked: 0, assigned: 0, completed: 0, completed_with_due: 0, on_time: 0, avg_progress: 0 };
    const rp = R.get(e.id) ?? { submitted: 0, awaiting_review: 0, avg_rating: null, rated: 0, hours: 0 };
    const at = A.get(e.id) ?? { present: 0, late: 0, worked_minutes: 0 };
    const onTimeRate = pct(tk.on_time, tk.completed_with_due);
    const reportRate = at.present > 0 ? Math.min(100, pct(rp.submitted, at.present)) : null;
    const punctuality = at.present > 0 ? 100 - pct(at.late, at.present) : null;
    const ratingPct = rp.avg_rating != null ? Math.round(((rp.avg_rating - 1) / 4) * 100) : null;
    const parts = [[onTimeRate, 35], [reportRate, 25], [ratingPct, 25], [punctuality, 15]].filter(([v]) => v != null);
    const weight = parts.reduce((s, [, w]) => s + w, 0);
    // A single indicator (e.g. one rating) is not a fair picture of someone's work: require at least two.
    const score = parts.length >= 2 ? Math.round(parts.reduce((s, [v, w]) => s + v * w, 0) / weight) : null;
    return {
      employee: { id: e.id, name: `${e.first_name} ${e.last_name}`, employeeCode: e.employee_code, department: e.department, designation: e.designation },
      tasks: { open: tk.open, overdue: tk.overdue, blocked: tk.blocked, assigned: tk.assigned, completed: tk.completed, onTime: tk.on_time, onTimeRate, avgProgress: tk.avg_progress },
      reports: { submitted: rp.submitted, awaitingReview: rp.awaiting_review, expected: at.present, rate: reportRate, avgRating: rp.avg_rating, rated: rp.rated, hours: rp.hours },
      attendance: { present: at.present, late: at.late, punctuality, workedHours: Math.round(at.worked_minutes / 6) / 10 },
      score,
    };
  });
}

/** Weekly trend for one employee: tasks completed and average rating per week (Sunday-based weeks). */
export async function weeklyTrend(t, employeeId, { weeks = 8, today, tz }) {
  let start = today; while (weekday(start) !== 'SUN') start = addDays(start, -1);
  start = addDays(start, -7 * (weeks - 1));
  const rows = await appDb.query(
    `WITH w AS (SELECT generate_series((:start)::date, (:today)::date, interval '7 day')::date AS wk)
     SELECT w.wk::text AS week,
       (SELECT count(*) FROM tasks k WHERE k.assignee_id = :emp AND k.deleted_at IS NULL AND k.status = 'DONE'
          AND (k.completed_at AT TIME ZONE :tz)::date BETWEEN w.wk AND w.wk + 6)::int AS completed,
       (SELECT round(avg(r.rating), 2)::float FROM work_reports r WHERE r.employee_id = :emp AND r.rating IS NOT NULL AND r.report_date BETWEEN w.wk AND w.wk + 6) AS rating,
       (SELECT coalesce(sum(r.hours), 0)::float FROM work_reports r WHERE r.employee_id = :emp AND r.status <> 'DRAFT' AND r.report_date BETWEEN w.wk AND w.wk + 6) AS hours
     FROM w ORDER BY w.wk`,
    { replacements: { start, today, emp: employeeId, tz }, type: QueryTypes.SELECT, transaction: t },
  );
  return rows;
}

// --------------------------------------------------------------------------- daily reminders (worker)
async function once(t, userId, n) {
  if (await app.Notification.count({ where: { userId, type: n.type, title: n.title }, transaction: t })) return 0;
  await notifyUsers(t, [userId], n);
  return 1;
}

/** Morning: tasks due today and newly overdue tasks, one notification per task per day. */
export async function tenantWorkReminders(tenantId, today) {
  return withTenant(tenantId, async (t) => {
    const tasks = await app.Task.findAll({ where: { deletedAt: null, status: OPEN, dueOn: { [Op.lte]: today } }, transaction: t });
    let sent = 0;
    for (const k of tasks) {
      const uid = await userIdForEmployee(t, k.assigneeId);
      if (!uid) continue;
      const overdue = k.dueOn < today;
      sent += await once(t, uid, {
        type: 'task', title: overdue ? `Overdue: ${label(k)} ${k.title}`.slice(0, 200) : `Due today: ${label(k)} ${k.title}`.slice(0, 200),
        body: overdue ? `This task was due on ${k.dueOn}. Update its progress or ask for a new date.` : 'Finish it today or update its progress.',
        link: `/tasks/${k.id}`, email: overdue,
      });
    }
    return sent;
  });
}

/** Evening: employees who are clocked in today and have not submitted their daily report. */
export async function tenantReportReminders(tenantId, today) {
  return withTenant(tenantId, async (t) => {
    const present = await app.AttendanceRecord.findAll({ where: { workDate: today, status: ['PRESENT', 'LATE', 'HALF_DAY'] }, attributes: ['employeeId'], transaction: t });
    const done = new Set((await app.WorkReport.findAll({ where: { reportDate: today, status: { [Op.ne]: 'DRAFT' } }, attributes: ['employeeId'], transaction: t })).map((r) => r.employeeId));
    let sent = 0;
    for (const { employeeId } of present) {
      if (done.has(employeeId)) continue;
      const uid = await userIdForEmployee(t, employeeId);
      if (uid) sent += await once(t, uid, { type: 'work_report', title: `Daily report for ${today}`, body: 'Record what you completed today and any problems you faced.', link: '/my-work/report' });
    }
    return sent;
  });
}

async function eachTenant(fn) {
  const tenants = await systemDb.query("SELECT id, timezone FROM tenants WHERE status = 'ACTIVE'", { type: 'SELECT' });
  let processed = 0;
  for (const { id, timezone } of tenants) {
    try {
      const ctx = await getTenantContext(id);
      if (!ctx?.features.includes('tasks') || evaluateAccess(ctx).state === 'BLOCKED') continue;
      await fn(id, localDate(new Date(), timezone || 'Asia/Kathmandu'));
      processed += 1;
    } catch (err) { logger.error({ err, tenantId: id }, 'work reminder failed'); }
  }
  return { processed };
}
export const workReminders = () => eachTenant(tenantWorkReminders);
export const reportReminders = () => eachTenant(tenantReportReminders);
