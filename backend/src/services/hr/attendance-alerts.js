/**
 * Daily attendance follow-up (worker, every morning, for the previous day):
 * - employees: missing check-out, no attendance on a working day (missing check-in / absence), late arrival;
 * - managers + HR: someone reached the monthly repeated-lateness threshold;
 * - HR: one summary line for the day.
 * Follows each company's attendance policy switches. Idempotent per day.
 */
import { Op } from 'sequelize';
import { systemDb, withTenant, app } from '../../database/index.js';
import { getTenantContext, evaluateAccess } from '../subscription.service.js';
import { getPolicy, loadCalendar } from './attendance.js';
import { notifyUsers, usersWithPermission, userIdForEmployee } from './notify.js';
import { localDate, addDays, toBS, bsMonthRange } from './calendar.js';
import { logger } from '../../utils/logger.js';

async function once(t, userIds, n) {
  const ids = [...new Set(userIds.filter(Boolean))];
  const fresh = [];
  for (const id of ids) if (!(await app.Notification.count({ where: { userId: id, type: n.type, title: n.title }, transaction: t }))) fresh.push(id);
  if (fresh.length) await notifyUsers(t, fresh, n);
  return fresh.length;
}

export async function tenantAttendanceAlerts(tenantId, date) {
  return withTenant(tenantId, async (t) => {
    const policy = await getPolicy(t);
    const [emps, records, leaves, cal] = [
      await app.Employee.findAll({ where: { deletedAt: null, status: { [Op.ne]: 'TERMINATED' }, joinedOn: { [Op.lte]: date }, [Op.or]: [{ exitedOn: null }, { exitedOn: { [Op.gte]: date } }] }, attributes: ['id', 'firstName', 'lastName', 'branchId', 'shiftId', 'managerId'], transaction: t }),
      await app.AttendanceRecord.findAll({ where: { workDate: date }, transaction: t }),
      await app.LeaveRequest.findAll({ where: { status: 'APPROVED', startDate: { [Op.lte]: date }, endDate: { [Op.gte]: date } }, attributes: ['employeeId', 'halfDay'], transaction: t }),
      await loadCalendar(t, { from: date, to: date, policy }),
    ];
    const rec = new Map(records.map((r) => [r.employeeId, r]));
    const onLeave = new Set(leaves.filter((l) => !l.halfDay).map((l) => l.employeeId));
    const bs = toBS(date);
    const month = bsMonthRange(bs.year, bs.month);
    const counts = { late: 0, absent: 0, missingOut: 0, repeated: 0 };
    for (const e of emps) {
      const r = rec.get(e.id);
      const day = cal.dayType(e, date);
      const me = await userIdForEmployee(t, e.id);
      const name = `${e.firstName} ${e.lastName}`;
      if (r?.clockIn && !r.clockOut) {
        counts.missingOut += 1;
        if (policy.notifyMissingPunch) await once(t, [me], { type: 'attendance.missing_punch', title: `No check-out recorded on ${date}`, body: 'If you forgot to check out, request a correction so your hours are counted.', link: '/me/attendance', email: true });
      }
      if (!r && day.type === 'WORKING' && !onLeave.has(e.id)) {
        counts.absent += 1;
        if (policy.notifyMissingPunch) await once(t, [me], { type: 'attendance.missing_punch', title: `No attendance recorded on ${date}`, body: 'If you worked, request a correction. If you were away, apply for leave.', link: '/me/attendance', email: true });
      }
      if (r?.lateMinutes > 0) {
        counts.late += 1;
        if (policy.notifyLate) await once(t, [me], { type: 'attendance.late', title: `Late arrival on ${date}: ${r.lateMinutes} min`, body: 'Late arrivals are counted under your company attendance policy.', link: '/me/attendance' });
        if (policy.repeatedLateThreshold > 0) {
          const n = await app.AttendanceRecord.count({ where: { employeeId: e.id, workDate: { [Op.between]: [month.start, date] }, lateMinutes: { [Op.gt]: 0 } }, transaction: t });
          if (n === policy.repeatedLateThreshold) {
            counts.repeated += 1;
            const hr = await usersWithPermission(t, 'attendance:approve');
            await once(t, [await userIdForEmployee(t, e.managerId), ...hr], { type: 'attendance.repeated_late', title: `${name} has been late ${n} times in ${bs.monthName}`, body: 'This reached the repeated-lateness threshold in your attendance policy.', link: '/attendance', email: true });
          }
        }
      }
    }
    if (counts.late + counts.absent + counts.missingOut) {
      await once(t, await usersWithPermission(t, 'attendance:configure'), {
        type: 'attendance.daily_summary', title: `Attendance ${date}: ${counts.late} late, ${counts.absent} without attendance, ${counts.missingOut} missing check-out`,
        body: 'Open the attendance register for details.', link: `/attendance?date=${date}`,
      });
    }
    return counts;
  });
}

export async function attendanceAlerts(now = new Date()) {
  const date = addDays(localDate(now), -1);
  const tenants = await systemDb.query("SELECT id FROM tenants WHERE status = 'ACTIVE'", { type: 'SELECT' });
  let processed = 0;
  for (const { id } of tenants) {
    try {
      const ctx = await getTenantContext(id);
      if (!ctx?.features.includes('attendance') || evaluateAccess(ctx).state === 'BLOCKED') continue;
      await tenantAttendanceAlerts(id, date);
      processed += 1;
    } catch (err) { logger.error({ err, tenantId: id }, 'attendance alerts failed'); }
  }
  return { date, processed };
}
