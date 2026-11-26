import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { localDate, localMinutes, timeToMinutes, weekday, eachDate } from './calendar.js';
import { scopeWhere } from '../rbac.service.js';

export const DEFAULT_POLICY = {
  workStart: '10:00', workEnd: '17:00', breakMinutes: 60, graceMinutes: 10, halfDayMinutes: 240, overtimeAfterMinutes: 30,
  weeklyOffs: ['SAT'], allowWeb: true, requireLocation: false,
  // Off by default: a company that doesn't track attendance must not see days without a record docked from pay.
  deductAbsences: false,
  // Lateness: every N late days counts as `deductDays` unpaid days (off unless the company enables it).
  lateRule: { enabled: false, everyLateDays: 3, deductDays: 0.5 },
  earlyLeaveGraceMinutes: 10, earlyLeaveCountsAsLate: false,
  // Notifications: late arrival / missing punch reminders, and a manager alert at N late days in a month (0 = off).
  notifyLate: true, notifyMissingPunch: true, repeatedLateThreshold: 3,
  geofence: { enabled: false, lat: null, lng: null, radiusM: 200 }, ipAllowlist: [],
};

export async function getPolicy(t) {
  const row = await app.TenantSetting.findOne({ where: { key: 'attendance.policy' }, transaction: t });
  return { ...DEFAULT_POLICY, ...(row?.value ?? {}) };
}

/**
 * Working calendar for a set of dates: resolves each employee's schedule (employee shift > branch default shift >
 * company default shift > company policy), per-weekday hours, holidays and special working days (company-wide or
 * per branch). Used by attendance, the daily register, payroll and leave day counts so they always agree.
 */
export async function loadCalendar(t, { from, to, policy }) {
  const [shifts, branches, entries] = [
    await app.Shift.findAll({ where: { deletedAt: null }, transaction: t }),
    await app.Branch.findAll({ attributes: ['id', 'defaultShiftId'], transaction: t }),
    from ? await app.Holiday.findAll({ where: { date: { [Op.between]: [from, to ?? from] }, isOptional: false }, transaction: t }) : [],
  ];
  const defShift = shifts.find((s) => s.isDefault);
  const branchShift = new Map(branches.map((b) => [b.id, b.defaultShiftId]));
  const applies = (h, e) => !h.branchIds.length || h.branchIds.includes(e.branchId);
  const shiftFor = (e) => shifts.find((s) => s.id === e.shiftId) ?? shifts.find((s) => s.id === branchShift.get(e.branchId)) ?? defShift ?? null;
  const scheduleOn = (e, date) => {
    const sh = shiftFor(e);
    const base = sh
      ? { start: sh.startTime.slice(0, 5), end: sh.endTime.slice(0, 5), breakMinutes: sh.breakMinutes, graceMinutes: sh.graceMinutes, weeklyOffs: sh.weeklyOffs, shiftName: sh.name }
      : { start: policy.workStart, end: policy.workEnd, breakMinutes: policy.breakMinutes, graceMinutes: policy.graceMinutes, weeklyOffs: policy.weeklyOffs, shiftName: null };
    const day = date && sh?.dayHours?.[weekday(date)];
    return day ? { ...base, start: day.start ?? base.start, end: day.end ?? base.end, breakMinutes: day.breakMinutes ?? base.breakMinutes } : base;
  };
  /** 'HOLIDAY' | 'WEEKLY_OFF' | 'WORKING' (+ holiday name) */
  const dayType = (e, date) => {
    const mine = entries.filter((h) => h.date === date && applies(h, e));
    const hol = mine.find((h) => h.kind !== 'WORKING_DAY');
    if (hol) return { type: 'HOLIDAY', name: hol.name };
    if (mine.some((h) => h.kind === 'WORKING_DAY')) return { type: 'WORKING', special: true };
    return scheduleOn(e, date).weeklyOffs.includes(weekday(date)) ? { type: 'WEEKLY_OFF' } : { type: 'WORKING' };
  };
  return { shiftFor, scheduleOn, dayType };
}

/** Effective schedule for one employee on one date (date optional → the shift's normal hours). */
export async function scheduleFor(t, employee, policy, date = null) {
  const cal = await loadCalendar(t, { from: date, to: date, policy });
  return cal.scheduleOn(employee, date);
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
    const early = Math.max(0, end - outMin);
    out.earlyMinutes = early > (policy.earlyLeaveGraceMinutes ?? 0) ? early : 0;
    const scheduled = end - start - sch.breakMinutes;
    const extra = out.workedMinutes - scheduled;
    out.overtimeMinutes = extra >= policy.overtimeAfterMinutes ? extra : 0;
    // On short days (scheduled hours at or below the half-day threshold, e.g. a 4-hour Friday) half a shift counts as half a day.
    const halfDay = scheduled <= policy.halfDayMinutes ? scheduled / 2 : policy.halfDayMinutes;
    if (out.workedMinutes < halfDay) out.status = 'HALF_DAY';
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
  const [emps, records, leaves, cal] = [
    await app.Employee.findAll({ where: empWhere, attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'branchId', 'departmentId', 'shiftId'], order: [['firstName', 'ASC']], transaction: t }),
    await app.AttendanceRecord.findAll({ where: { workDate: date }, transaction: t }),
    await app.LeaveRequest.findAll({ where: { status: 'APPROVED', startDate: { [Op.lte]: date }, endDate: { [Op.gte]: date } }, include: [{ model: app.LeaveType, as: 'leaveType', attributes: ['name'] }], transaction: t }),
    await loadCalendar(t, { from: date, to: date, policy }),
  ];
  const recBy = new Map(records.map((r) => [r.employeeId, r]));
  const leaveBy = new Map(leaves.map((l) => [l.employeeId, l]));
  const isPast = date < localDate(new Date(), tz);
  return emps.map((e) => {
    const r = recBy.get(e.id);
    const day = cal.dayType(e, date);
    const holiday = day.type === 'HOLIDAY' ? { name: day.name } : null;
    const leave = leaveBy.get(e.id);
    let status = r?.status;
    if (!r) status = leave ? 'ON_LEAVE' : holiday ? 'HOLIDAY' : day.type === 'WEEKLY_OFF' ? 'WEEKLY_OFF' : isPast ? 'ABSENT' : 'NOT_IN';
    return {
      employee: { id: e.id, code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, branchId: e.branchId, departmentId: e.departmentId },
      status, record: r ?? null, leave: leave ? { type: leave.leaveType.name, halfDay: leave.halfDay } : null, holiday: holiday?.name ?? null,
    };
  });
}

/** Per-employee totals over a date range (feeds payroll payable days). */
export async function rangeSummary(t, { employeeIds, from, to, tz, policy }) {
  const [emps, records, leaves, cal] = [
    await app.Employee.findAll({ where: { id: employeeIds }, attributes: ['id', 'employeeCode', 'firstName', 'lastName', 'branchId', 'shiftId', 'joinedOn', 'exitedOn'], transaction: t }),
    await app.AttendanceRecord.findAll({ where: { employeeId: employeeIds, workDate: { [Op.between]: [from, to] } }, transaction: t }),
    await app.LeaveRequest.findAll({ where: { employeeId: employeeIds, status: 'APPROVED', startDate: { [Op.lte]: to }, endDate: { [Op.gte]: from } }, include: [{ model: app.LeaveType, as: 'leaveType', attributes: ['isPaid'] }], transaction: t }),
    await loadCalendar(t, { from, to, policy }),
  ];
  const today = localDate(new Date(), tz);
  const rule = policy.lateRule ?? {};
  return emps.map((e) => {
    const s = { employeeId: e.id, code: e.employeeCode, name: `${e.firstName} ${e.lastName}`, calendarDays: 0, workingDays: 0, present: 0, late: 0, early: 0, halfDay: 0, absent: 0, paidLeave: 0, unpaidLeave: 0, holidays: 0, weeklyOffs: 0, lateMinutes: 0, earlyMinutes: 0, overtimeMinutes: 0, workedMinutes: 0, missingPunch: 0 };
    for (const d of eachDate(from, to)) {
      s.calendarDays += 1;
      if (d < e.joinedOn || (e.exitedOn && d > e.exitedOn)) { s.calendarDays -= 1; continue; }
      const r = records.find((x) => x.employeeId === e.id && x.workDate === d);
      const lv = leaves.find((x) => x.employeeId === e.id && x.startDate <= d && x.endDate >= d);
      const day = cal.dayType(e, d);
      if (day.type === 'HOLIDAY') { s.holidays += 1; continue; }
      if (day.type === 'WEEKLY_OFF' && !r) { s.weeklyOffs += 1; continue; }
      s.workingDays += 1;
      if (lv) {
        const amt = lv.halfDay ? 0.5 : 1;
        if (lv.leaveType.isPaid) s.paidLeave += amt; else s.unpaidLeave += amt;
        if (lv.halfDay && r) s.present += 0.5;
        continue;
      }
      if (r) {
        s.lateMinutes += r.lateMinutes; s.overtimeMinutes += r.overtimeMinutes; s.workedMinutes += r.workedMinutes; s.earlyMinutes += r.earlyMinutes ?? 0;
        if (r.earlyMinutes > 0) s.early += 1;
        if (r.clockIn && !r.clockOut && d < today) s.missingPunch += 1;
        if (r.status === 'HALF_DAY') { s.halfDay += 1; s.present += 0.5; s.absent += 0.5; } else { s.present += 1; if (r.status === 'LATE' || r.lateMinutes > 0) s.late += 1; }
      } else if (d < today) s.absent += 1;
    }
    // Late rule: every N late days (optionally counting early departures) = X unpaid days.
    s.lateCountForRule = s.late + (policy.earlyLeaveCountsAsLate ? s.early : 0);
    s.lateDeductionDays = rule.enabled && rule.everyLateDays > 0 ? Math.floor(s.lateCountForRule / rule.everyLateDays) * Number(rule.deductDays ?? 0) : 0;
    return s;
  });
}
