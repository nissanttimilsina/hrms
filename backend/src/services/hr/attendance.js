import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { localDate, localMinutes, timeToMinutes, weekday, eachDate } from './calendar.js';
import { scopeWhere } from '../rbac.service.js';

export const DEFAULT_POLICY = {
  workStart: '10:00', workEnd: '17:00', breakMinutes: 60, graceMinutes: 10, halfDayMinutes: 240, overtimeAfterMinutes: 30,
  weeklyOffs: ['SAT'], allowWeb: true, requireLocation: false,
  geofence: { enabled: false, lat: null, lng: null, radiusM: 200 }, ipAllowlist: [],
};

export async function getPolicy(t) {
  const row = await app.TenantSetting.findOne({ where: { key: 'attendance.policy' }, transaction: t });
  return { ...DEFAULT_POLICY, ...(row?.value ?? {}) };
}

/** Effective schedule for an employee: their shift, else the default shift, else the company policy. */
export async function scheduleFor(t, employee, policy) {
  const shift = employee.shiftId
    ? await app.Shift.findByPk(employee.shiftId, { transaction: t })
    : await app.Shift.findOne({ where: { isDefault: true, deletedAt: null }, transaction: t });
  if (shift) return { start: shift.startTime.slice(0, 5), end: shift.endTime.slice(0, 5), breakMinutes: shift.breakMinutes, graceMinutes: shift.graceMinutes, weeklyOffs: shift.weeklyOffs, shiftName: shift.name };
  return { start: policy.workStart, end: policy.workEnd, breakMinutes: policy.breakMinutes, graceMinutes: policy.graceMinutes, weeklyOffs: policy.weeklyOffs, shiftName: null };
}

/** Pure calculation of late/early/worked/overtime/status for one record. Exported for unit tests. */
export function compute({ clockIn, clockOut }, sch, policy, tz) {
  const start = timeToMinutes(sch.start);
  let end = timeToMinutes(sch.end);
  if (end <= start) end += 1440; // night shift
  const out = { lateMinutes: 0, earlyMinutes: 0, workedMinutes: 0, overtimeMinutes: 0, status: 'PRESENT' };
  if (clockIn) {
    let inMin = localMinutes(new Date(clockIn), tz);
    if (end > 1440 && inMin < start - 240) inMin += 1440;
    const late = inMin - start;
    if (late > sch.graceMinutes) { out.lateMinutes = late; out.status = 'LATE'; }
  }
  if (clockIn && clockOut) {
    const gross = Math.round((new Date(clockOut) - new Date(clockIn)) / 60000);
    out.workedMinutes = Math.max(0, gross - (gross > 300 ? sch.breakMinutes : 0));
    let outMin = localMinutes(new Date(clockOut), tz);
    if (end > 1440 && outMin < start) outMin += 1440;
    out.earlyMinutes = Math.max(0, end - outMin);
    const scheduled = end - start - sch.breakMinutes;
    const extra = out.workedMinutes - scheduled;
    out.overtimeMinutes = extra >= policy.overtimeAfterMinutes ? extra : 0;
    if (out.workedMinutes < policy.halfDayMinutes) out.status = 'HALF_DAY';
  }
  return out;
}

export const haversineM = (a, b) => {
  const R = 6_371_000; const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
};

/** Employee ids visible under the current permission scope (null = whole company). */
export async function scopedEmployeeIds(req, t, extraWhere = {}) {
  const sw = scopeWhere(req.scopes, req.auth.principal);
  if (!Object.keys(sw).length && !Object.getOwnPropertySymbols(sw).length && !Object.keys(extraWhere).length) return null;
  const rows = await app.Employee.findAll({ where: { [Op.and]: [sw, { deletedAt: null }, extraWhere] }, attributes: ['id'], transaction: t, raw: true });
  return rows.map((r) => r.id);
}

/**
 * Daily register: one row per active employee in scope with their effective status
 * (record, approved leave, holiday, weekly-off or absent).
 */
export async function dailyRegister(req, t, date) {
  const tz = req.auth.ctx.tenant.timezone;
  const policy = await getPolicy(t);
  const ids = await scopedEmployeeIds(req, t);
  const empWhere = { deletedAt: null, status: { [Op.ne]: 'TERMINATED' }, joinedOn: { [Op.lte]: date }, ...(ids && { id: ids }) };
  const [emps, records, leaves, holidays, shifts] = [
    await app.Employee.findAll({ where: empWhere, attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'branchId', 'departmentId', 'shiftId'], order: [['firstName', 'ASC']], transaction: t }),
    await app.AttendanceRecord.findAll({ where: { workDate: date }, transaction: t }),
    await app.LeaveRequest.findAll({ where: { status: 'APPROVED', startDate: { [Op.lte]: date }, endDate: { [Op.gte]: date } }, include: [{ model: app.LeaveType, as: 'leaveType', attributes: ['name'] }], transaction: t }),
    await app.Holiday.findAll({ where: { date, isOptional: false }, transaction: t }),
    await app.Shift.findAll({ where: { deletedAt: null }, transaction: t }),
  ];
  const recBy = new Map(records.map((r) => [r.employeeId, r]));
  const leaveBy = new Map(leaves.map((l) => [l.employeeId, l]));
  const defShift = shifts.find((s) => s.isDefault);
  const isPast = date < localDate(new Date(), tz);
  return emps.map((e) => {
    const r = recBy.get(e.id);
    const shift = shifts.find((s) => s.id === e.shiftId) ?? defShift;
    const offs = shift?.weeklyOffs ?? policy.weeklyOffs;
    const holiday = holidays.find((h) => !h.branchIds.length || h.branchIds.includes(e.branchId));
    const leave = leaveBy.get(e.id);
    let status = r?.status;
    if (!r) status = leave ? 'ON_LEAVE' : holiday ? 'HOLIDAY' : offs.includes(weekday(date)) ? 'WEEKLY_OFF' : isPast ? 'ABSENT' : 'NOT_IN';
    return {
      employee: { id: e.id, code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, branchId: e.branchId, departmentId: e.departmentId },
      status, record: r ?? null, leave: leave ? { type: leave.leaveType.name, halfDay: leave.halfDay } : null, holiday: holiday?.name ?? null,
    };
  });
}

/** Per-employee totals over a date range (feeds payroll payable days). */
export async function rangeSummary(t, { employeeIds, from, to, tz, policy }) {
  const [emps, records, leaves, holidays, shifts] = [
    await app.Employee.findAll({ where: { id: employeeIds }, attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'branchId', 'shiftId', 'joinedOn', 'exitedOn'], transaction: t }),
    await app.AttendanceRecord.findAll({ where: { employeeId: employeeIds, workDate: { [Op.between]: [from, to] } }, transaction: t }),
    await app.LeaveRequest.findAll({ where: { employeeId: employeeIds, status: 'APPROVED', startDate: { [Op.lte]: to }, endDate: { [Op.gte]: from } }, include: [{ model: app.LeaveType, as: 'leaveType', attributes: ['isPaid'] }], transaction: t }),
    await app.Holiday.findAll({ where: { date: { [Op.between]: [from, to] }, isOptional: false }, transaction: t }),
    await app.Shift.findAll({ where: { deletedAt: null }, transaction: t }),
  ];
  const today = localDate(new Date(), tz);
  const defShift = shifts.find((s) => s.isDefault);
  return emps.map((e) => {
    const offs = (shifts.find((s) => s.id === e.shiftId) ?? defShift)?.weeklyOffs ?? policy.weeklyOffs;
    const s = { employeeId: e.id, code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, calendarDays: 0, workingDays: 0, present: 0, late: 0, halfDay: 0, absent: 0, paidLeave: 0, unpaidLeave: 0, holidays: 0, weeklyOffs: 0, lateMinutes: 0, overtimeMinutes: 0, workedMinutes: 0 };
    for (const d of eachDate(from, to)) {
      s.calendarDays += 1;
      if (d < e.joinedOn || (e.exitedOn && d > e.exitedOn)) { s.calendarDays -= 1; continue; }
      const r = records.find((x) => x.employeeId === e.id && x.workDate === d);
      const lv = leaves.find((x) => x.employeeId === e.id && x.startDate <= d && x.endDate >= d);
      const hol = holidays.find((h) => h.date === d && (!h.branchIds.length || h.branchIds.includes(e.branchId)));
      const off = offs.includes(weekday(d));
      if (hol) { s.holidays += 1; continue; }
      if (off && !r) { s.weeklyOffs += 1; continue; }
      s.workingDays += 1;
      if (lv) {
        const amt = lv.halfDay ? 0.5 : 1;
        if (lv.leaveType.isPaid) s.paidLeave += amt; else s.unpaidLeave += amt;
        if (lv.halfDay && r) s.present += 0.5;
        continue;
      }
      if (r) {
        s.lateMinutes += r.lateMinutes; s.overtimeMinutes += r.overtimeMinutes; s.workedMinutes += r.workedMinutes;
        if (r.status === 'HALF_DAY') { s.halfDay += 1; s.present += 0.5; s.absent += 0.5; } else { s.present += 1; if (r.status === 'LATE') s.late += 1; }
      } else if (d < today) s.absent += 1;
    }
    return s;
  });
}
