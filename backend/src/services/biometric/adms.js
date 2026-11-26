/**
 * ZKTeco ADMS ("Cloud Server" / PUSH SDK) receiver for biometric attendance terminals.
 *
 * Protocol (HTTP, text/plain):
 *   GET  /iclock/cdata?SN=…&options=all        handshake → we reply with the device options
 *   POST /iclock/cdata?SN=…&table=ATTLOG       body: one punch per line  "PIN\tYYYY-MM-DD HH:MM:SS\tstatus\tverify\t…"
 *   POST /iclock/cdata?SN=…&table=OPERLOG      operation log, incl. "USER PIN=…\tName=…" (we keep PIN + name only)
 *   GET  /iclock/getrequest?SN=…               heartbeat / command poll → "OK"
 *   POST /iclock/devicecmd?SN=…                command results → "OK"
 *
 * Rules:
 * - A device is accepted only if its serial number is registered (and active) by a company whose plan includes
 *   biometric integration and whose workspace is writable. Otherwise we answer 403 so the device KEEPS its data and
 *   retries later (an "OK" would make it discard the punches).
 * - Optional IP allow-list per device.
 * - Re-sent punches are de-duplicated by (device, user ID, time).
 * - Fingerprint/face templates and photos are never stored: those uploads are acknowledged and dropped.
 */
import { Op } from 'sequelize';
import { sys, app, withTenant } from '../../database/index.js';
import { getTenantContext, evaluateAccess } from '../subscription.service.js';
import { getPolicy, scheduleFor, compute } from '../hr/attendance.js';
import { localDate, addDays } from '../hr/calendar.js';
import { logger } from '../../utils/logger.js';

export const ONLINE_WINDOW_MS = 10 * 60_000;
const MAX_DEVICE_USERS = 5000;
const DOUBLE_TAP_MS = 2 * 60_000;

/** Wall-clock "YYYY-MM-DD HH:MM:SS" in time zone tz → Date (UTC instant). */
export function zonedToUtc(s, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se = '0'] = m.map((x) => x);
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const offset = (at) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at)).filter((x) => x.type !== 'literal').map((x) => [x.type, +x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // second pass handles DST edges
  const out = new Date(t);
  return Number.isNaN(out.getTime()) ? null : out;
}

/** Parse ATTLOG lines. Malformed lines are returned in `bad`. */
export function parseAttlog(body, tz) {
  const ok = []; const bad = [];
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split('\t');
    const pin = (f[0] ?? '').trim();
    const at = zonedToUtc(f[1] ?? '', tz);
    if (!/^[A-Za-z0-9]{1,24}$/.test(pin) || !at) { bad.push(line.slice(0, 120)); continue; }
    ok.push({ pin, at, status: Number.isFinite(+f[2]) ? +f[2] : null, verify: Number.isFinite(+f[3]) ? +f[3] : null });
  }
  return { ok, bad };
}

/** Extract enrolled users ("USER PIN=1\tName=Ram") from OPERLOG/USERINFO bodies. Templates are ignored. */
export function parseUsers(body) {
  const users = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^USER\s+PIN=([A-Za-z0-9]{1,24})(.*)$/.exec(line.trim());
    if (!m) continue;
    const name = /(?:^|\t)Name=([^\t]*)/.exec(m[2])?.[1]?.trim().slice(0, 80) ?? '';
    users.push({ pin: m[1], name });
  }
  return users;
}

export async function deviceLog(device, level, event, message, details = {}) {
  try {
    await sys.DeviceLog.create({ tenantId: device.tenantId, deviceId: device.id, level, event, message: message.slice(0, 500), details });
    if (level === 'ERROR') await device.update({ lastError: message.slice(0, 500), lastErrorAt: new Date() });
  } catch (err) { logger.error({ err }, 'device log write failed'); }
}

/**
 * Identify and authorise the calling device. Returns { device, tz } or { status, reason } to refuse.
 */
export async function authorise(sn, ip) {
  if (!sn || !/^[A-Za-z0-9_-]{4,64}$/.test(sn)) return { status: 400, reason: 'missing or invalid SN' };
  const device = await sys.AttendanceDevice.findOne({ where: { serialNumber: { [Op.iLike]: sn }, deletedAt: null } });
  if (!device) { logger.warn({ sn, ip }, 'ADMS: unknown device serial number'); return { status: 403, reason: 'device not registered' }; }
  if (device.status !== 'ACTIVE') { await deviceLog(device, 'WARN', 'rejected', 'Device is disabled in HRMS; data kept on the device'); return { status: 403, reason: 'device disabled' }; }
  if (device.allowedIps?.length && !device.allowedIps.includes(ip)) {
    await deviceLog(device, 'ERROR', 'rejected_ip', `Connection from ${ip} is not in the allowed IP list`, { ip });
    return { status: 403, reason: 'address not allowed' };
  }
  const ctx = await getTenantContext(device.tenantId);
  if (!ctx || ctx.tenant.status !== 'ACTIVE') return { status: 403, reason: 'company inactive' };
  if (!ctx.features.includes('biometric')) {
    await deviceLog(device, 'ERROR', 'rejected_plan', 'Biometric integration is not included in the current plan; punches are kept on the device until it is enabled');
    return { status: 403, reason: 'feature not in plan' };
  }
  const access = evaluateAccess(ctx).state;
  if (access !== 'FULL' && access !== 'GRACE') {
    await deviceLog(device, 'WARN', 'rejected_readonly', 'Workspace is read-only (subscription); punches are kept on the device and will upload after renewal');
    return { status: 403, reason: 'workspace read-only' };
  }
  return { device, tz: ctx.tenant.timezone || 'Asia/Kathmandu' };
}

export async function touch(device, ip, query = {}) {
  const now = new Date();
  const patch = { lastSeenAt: now, lastIp: ip };
  if (query.pushver || query.language || query.DeviceType) patch.deviceInfo = { ...device.deviceInfo, pushver: query.pushver, language: query.language, deviceType: query.DeviceType };
  if (device.offlineAlertedAt) {
    patch.offlineAlertedAt = null;
    await deviceLog(device, 'INFO', 'online', 'Device is back online');
  }
  await device.update(patch);
}

/** Options sent on handshake. Realtime upload, ask for every stored punch the server hasn't acknowledged. */
export function handshakeOptions(sn) {
  return [
    `GET OPTION FROM: ${sn}`,
    'ATTLOGStamp=None', 'OPERLOGStamp=9999', 'ATTPHOTOStamp=None',
    'ErrorDelay=60', 'Delay=30', 'TransTimes=00:00;14:05', 'TransInterval=1',
    'TransFlag=TransData AttLog OpLog EnrollUser ChgUser', 'Realtime=1', 'Encrypt=None', '',
  ].join('\n');
}

/** Attribute a punch to a work date (night shifts: early-morning punches belong to the previous day). */
function workDateFor(at, sch, tz) {
  const date = localDate(at, tz);
  const [sh, sm] = sch.start.split(':').map(Number); const [eh, em] = sch.end.split(':').map(Number);
  const start = sh * 60 + sm; const end = eh * 60 + em;
  if (end > start) return date;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).split(':').map(Number);
  return local[0] * 60 + local[1] < end + 240 ? addDays(date, -1) : date;
}

/**
 * Merge one punch into the day's attendance record: earliest punch = in, latest = out (first-in / last-out).
 * Manual entries and approved corrections are never overwritten by a device.
 */
async function applyPunch(t, employee, at, device, tz) {
  const policy = await getPolicy(t);
  const workDate = workDateFor(at, await scheduleFor(t, employee, policy), tz);
  const sch = await scheduleFor(t, employee, policy, workDate); // that day's hours (per-weekday overrides)
  const rec = await app.AttendanceRecord.findOne({ where: { employeeId: employee.id, workDate }, transaction: t, lock: t.LOCK.UPDATE });
  const meta = { source: 'DEVICE', deviceId: device.id, device: device.name };
  if (!rec) {
    const r = app.AttendanceRecord.build({ tenantId: employee.tenantId, employeeId: employee.id, workDate, clockIn: at, inMeta: meta, source: 'DEVICE' });
    Object.assign(r, compute(r, sch, policy, tz));
    await r.save({ transaction: t });
    return { result: 'APPLIED', message: `Clock-in ${workDate}` };
  }
  if (['MANUAL', 'CORRECTION'].includes(rec.source)) return { result: 'IGNORED', message: 'Day was set manually or by an approved correction' };
  const times = [rec.clockIn, rec.clockOut, at].filter(Boolean).map((d) => new Date(d).getTime());
  const first = Math.min(...times); const last = Math.max(...times);
  if (last - first < DOUBLE_TAP_MS) return { result: 'IGNORED', message: 'Repeated punch within 2 minutes' };
  const newIn = new Date(first); const newOut = new Date(last);
  if (+newIn === +new Date(rec.clockIn) && rec.clockOut && +newOut === +new Date(rec.clockOut)) return { result: 'IGNORED', message: 'Inside an existing in/out span' };
  if (+newIn !== +new Date(rec.clockIn)) rec.inMeta = meta;
  if (!rec.clockOut || +newOut !== +new Date(rec.clockOut)) rec.outMeta = meta;
  rec.clockIn = newIn; rec.clockOut = newOut;
  Object.assign(rec, compute(rec, sch, policy, tz));
  await rec.save({ transaction: t });
  return { result: 'APPLIED', message: `In ${newIn.toISOString()} / out ${newOut.toISOString()}` };
}

/** Store punches (deduplicated) and apply mapped ones to attendance. Returns counts. */
export async function ingestAttlog(device, body, tz) {
  const { ok, bad } = parseAttlog(body, tz);
  const counts = { received: ok.length + bad.length, applied: 0, unmapped: 0, ignored: 0, duplicate: 0, bad: bad.length };
  if (bad.length) await deviceLog(device, 'WARN', 'bad_lines', `${bad.length} unreadable line(s) skipped`, { sample: bad.slice(0, 5) });
  const future = Date.now() + 10 * 60_000;
  await withTenant(device.tenantId, async (t) => {
    const pins = [...new Set(ok.map((p) => p.pin))];
    const emps = pins.length ? await app.Employee.findAll({ where: { biometricId: pins, deletedAt: null }, transaction: t }) : [];
    const byPin = new Map(emps.map((e) => [e.biometricId, e]));
    for (const p of ok) {
      const exists = await sys.DevicePunch.count({ where: { tenantId: device.tenantId, deviceId: device.id, deviceUserId: p.pin, punchedAt: p.at } });
      if (exists) { counts.duplicate += 1; continue; }
      const emp = byPin.get(p.pin);
      let out;
      if (p.at.getTime() > future) out = { result: 'IGNORED', message: 'Punch time is in the future: check the device clock' };
      else if (!emp) out = { result: 'UNMAPPED', message: `No employee has biometric ID ${p.pin}` };
      else if (emp.exitedOn && localDate(p.at, tz) > emp.exitedOn) out = { result: 'IGNORED', message: 'After the employee\'s exit date' };
      else {
        // Savepoint per punch: one bad record must not abort the rest of the upload.
        try { out = await t.sequelize.transaction({ transaction: t }, (sp) => applyPunch(sp, emp, p.at, device, tz)); } catch (err) { out = { result: 'ERROR', message: err.message.slice(0, 200) }; }
      }
      await sys.DevicePunch.create({ tenantId: device.tenantId, deviceId: device.id, deviceUserId: p.pin, punchedAt: p.at, statusCode: p.status, verifyMode: p.verify, employeeId: emp?.id ?? null, result: out.result, message: out.message });
      counts[{ APPLIED: 'applied', UNMAPPED: 'unmapped', IGNORED: 'ignored', ERROR: 'ignored' }[out.result]] += 1;
    }
  });
  const stored = counts.applied + counts.unmapped + counts.ignored;
  if (stored) {
    const last = ok.reduce((m, p) => (p.at > m ? p.at : m), new Date(0));
    await device.update({ punchCount: Number(device.punchCount) + stored, lastPunchAt: device.lastPunchAt && device.lastPunchAt > last ? device.lastPunchAt : last });
  }
  await deviceLog(device, counts.unmapped ? 'WARN' : 'INFO', 'attlog', `Received ${counts.received} punch(es): ${counts.applied} applied, ${counts.unmapped} unmapped, ${counts.ignored} ignored, ${counts.duplicate} already received`, counts);
  return counts;
}

export async function ingestUsers(device, body) {
  const users = parseUsers(body);
  if (!users.length) return 0;
  const map = { ...(device.deviceInfo?.users ?? {}) };
  for (const u of users) map[u.pin] = u.name;
  const keys = Object.keys(map);
  if (keys.length > MAX_DEVICE_USERS) for (const k of keys.slice(0, keys.length - MAX_DEVICE_USERS)) delete map[k];
  await device.update({ deviceInfo: { ...device.deviceInfo, users: map } });
  return users.length;
}

/** After an employee gets a biometric ID, apply their earlier unmapped punches (oldest first). */
export async function reprocessUnmapped(t, employee, tz) {
  const rows = await sys.DevicePunch.findAll({ where: { tenantId: employee.tenantId, deviceUserId: employee.biometricId, result: 'UNMAPPED' }, order: [['punchedAt', 'ASC']], limit: 5000 });
  let applied = 0;
  for (const r of rows) {
    const device = await sys.AttendanceDevice.findByPk(r.deviceId);
    const out = await applyPunch(t, employee, r.punchedAt, device, tz);
    await sys.DevicePunch.update({ employeeId: employee.id, result: out.result, message: `${out.message} (processed after linking)` }, { where: { id: r.id } });
    if (out.result === 'APPLIED') applied += 1;
  }
  return { processed: rows.length, applied };
}
