import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, asAdmin, api, teardown, db, adminLogin } from './helpers/context.js';
import { localDate, addDays } from '../src/services/hr/calendar.js';
import { zonedToUtc, parseAttlog, parseUsers } from '../src/services/biometric/adms.js';

const SN = 'CKJW220460123';
const day = addDays(localDate(), -1);
const line = (pin, hm, status = 0) => `${pin}\t${day} ${hm}:00\t${status}\t1\t0\t0`;
const device = (path, sn = SN) => api().get(`/iclock/${path}`).query({ SN: sn });
const push = (body, table = 'ATTLOG', sn = SN) => api().post('/iclock/cdata').query({ SN: sn, table, Stamp: '9999' }).set('Content-Type', 'text/plain').send(body);

describe('Biometric devices (ADMS push)', () => {
  let T; let owner; let dev; let ram; let sita;
  const record = (employeeId) => db.sys.AttendanceRecord.findOne({ where: { employeeId, workDate: day } });
  before(async () => {
    await resetDatabase();
    T = await makeTenant('bioco', 'PROFESSIONAL');
    owner = as('bioco', (await login('bioco', T.ownerEmail)).token);
    const mk = (b) => owner.post('/employees').send({ joinedOn: '2025-01-01', ...b }).then((r) => { assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.data; });
    ram = await mk({ firstName: 'Ram', lastName: 'Thapa', biometricId: '101' });
    sita = await mk({ firstName: 'Sita', lastName: 'Rai' });
  });
  after(teardown);

  describe('parsing', () => {
    it('converts device local time (Asia/Kathmandu) to UTC', () => {
      assert.equal(zonedToUtc('2026-11-20 10:00:00', 'Asia/Kathmandu').toISOString(), '2026-11-20T04:15:00.000Z');
      assert.equal(zonedToUtc('garbage', 'Asia/Kathmandu'), null);
    });
    it('reads ATTLOG lines and flags unreadable ones', () => {
      const { ok, bad } = parseAttlog(`101\t2026-11-20 09:58:12\t0\t1\t0\n\nbad line\n<script>\t2026-11-20 09:00:00`, 'Asia/Kathmandu');
      assert.equal(ok.length, 1); assert.equal(ok[0].pin, '101'); assert.equal(bad.length, 2);
    });
    it('keeps only PIN and name from user records, never templates', () => {
      assert.deepEqual(parseUsers('USER PIN=202\tName=Hari Bk\tPri=0\tPasswd=123\nFP PIN=202\tFID=1\tTMP=AAAA'), [{ pin: '202', name: 'Hari Bk' }]);
    });
  });

  it('refuses unregistered devices so they keep their data', async () => {
    const r = await device('cdata').query({ options: 'all' });
    assert.equal(r.status, 403);
    assert.equal((await push(line('101', '09:00'))).status, 403);
    assert.equal(await db.sys.DevicePunch.count(), 0);
  });

  it('Basic plan cannot register devices (biometric is a Professional feature)', async () => {
    const B = await makeTenant('basicbio', 'BASIC');
    const b = as('basicbio', (await login('basicbio', B.ownerEmail)).token);
    const r = await b.post('/devices').send({ name: 'Gate', serialNumber: 'BASIC0001' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'FEATURE_NOT_IN_PLAN');
  });

  it('registers a device; serial numbers are unique platform-wide', async () => {
    const r = await owner.post('/devices').send({ name: 'Head office gate', serialNumber: SN.toLowerCase(), location: 'Ground floor' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    dev = r.body.data;
    assert.equal(dev.serialNumber, SN);
    assert.equal(dev.health, 'NEVER_CONNECTED');
    const O = await makeTenant('otherbio', 'PROFESSIONAL');
    const o = as('otherbio', (await login('otherbio', O.ownerEmail)).token);
    const dup = await o.post('/devices').send({ name: 'Stolen', serialNumber: SN });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'SERIAL_TAKEN');
    assert.equal((await o.get('/devices')).body.data.length, 0, 'other company sees nothing');
    const setup = (await owner.get('/devices/setup')).body.data;
    assert.equal(setup.path, '/iclock/');
  });

  it('handshake returns push options and marks the device online', async () => {
    const r = await device('cdata').query({ options: 'all', pushver: '2.4.1' });
    assert.equal(r.status, 200);
    assert.match(r.text, new RegExp(`GET OPTION FROM: ${SN}`));
    assert.match(r.text, /Realtime=1/);
    assert.equal((await device('getrequest')).text, 'OK');
    const d = (await owner.get('/devices')).body.data[0];
    assert.equal(d.health, 'ONLINE');
  });

  it('punches become attendance: first in, last out, de-duplicated, double taps ignored', async () => {
    const body = [line('101', '09:58'), line('101', '09:59'), line('101', '18:05', 1), line('202', '10:20'), 'garbage'].join('\n');
    const r = await push(body);
    assert.equal(r.status, 200);
    assert.equal(r.text, 'OK: 5');
    const rec = await record(ram.id);
    assert.equal(rec.source, 'DEVICE');
    assert.equal(rec.clockIn.toISOString(), zonedToUtc(`${day} 09:58:00`, 'Asia/Kathmandu').toISOString());
    assert.equal(rec.clockOut.toISOString(), zonedToUtc(`${day} 18:05:00`, 'Asia/Kathmandu').toISOString());
    assert.ok(rec.workedMinutes > 400);
    const punches = await db.sys.DevicePunch.findAll({ where: { tenantId: T.id } });
    assert.deepEqual(punches.map((p) => p.result).sort(), ['APPLIED', 'APPLIED', 'IGNORED', 'UNMAPPED']);
    // device re-sends the same log
    assert.equal((await push(body)).status, 200);
    assert.equal(await db.sys.DevicePunch.count({ where: { tenantId: T.id } }), 4);
    const logs = (await owner.get(`/devices/${dev.id}/logs`)).body.data;
    assert.ok(logs.some((l) => l.event === 'attlog' && /already received/.test(l.message)));
    assert.ok(logs.some((l) => l.event === 'bad_lines'));
  });

  it('unmapped device users can be mapped, and their earlier punches are applied', async () => {
    await push('USER PIN=202\tName=Sita R\tPri=0\tPasswd=\tCard=', 'OPERLOG');
    const un = (await owner.get('/devices/unmapped')).body.data;
    const u = un.find((x) => x.deviceUserId === '202');
    assert.equal(u.punches, 1);
    assert.equal(u.nameOnDevice, 'Sita R');
    const res = await owner.post('/devices/mappings').send({ employeeId: sita.id, biometricId: '202' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { processed: 1, applied: 1 });
    assert.equal((await record(sita.id)).source, 'DEVICE');
    assert.equal((await owner.post('/devices/mappings').send({ employeeId: sita.id, biometricId: '101' })).status, 409, 'ID belongs to Ram');
  });

  it('never overwrites a manual entry', async () => {
    const d2 = addDays(day, -1);
    await owner.post('/attendance/manual').send({ employeeId: ram.id, workDate: d2, clockIn: zonedToUtc(`${d2} 10:00:00`, 'Asia/Kathmandu'), clockOut: zonedToUtc(`${d2} 17:00:00`, 'Asia/Kathmandu'), note: 'Field visit' });
    await push(`101\t${d2} 08:00:00\t0\t1`);
    const p = await db.sys.DevicePunch.findOne({ where: { tenantId: T.id, punchedAt: zonedToUtc(`${d2} 08:00:00`, 'Asia/Kathmandu') } });
    assert.equal(p.result, 'IGNORED');
    const rec = await db.sys.AttendanceRecord.findOne({ where: { employeeId: ram.id, workDate: d2 } });
    assert.equal(rec.source, 'MANUAL');
  });

  it('stores no biometric templates or photos', async () => {
    const before = await db.sys.DevicePunch.count();
    const r = await push('BIODATA Pin=101\tNo=0\tIndex=0\tValid=1\tTmp=SECRETTEMPLATE', 'BIODATA');
    assert.equal(r.status, 200);
    assert.equal(await db.sys.DevicePunch.count(), before);
    const d = await db.sys.AttendanceDevice.findOne({ where: { serialNumber: SN } });
    assert.ok(!JSON.stringify(d.deviceInfo).includes('SECRETTEMPLATE'));
  });

  it('IP allow-list, disabled devices and plan changes are enforced with a log entry', async () => {
    await owner.patch(`/devices/${dev.id}`).send({ allowedIps: ['10.9.9.9'] });
    assert.equal((await push(line('101', '12:00'))).status, 403);
    await owner.patch(`/devices/${dev.id}`).send({ allowedIps: [] , status: 'DISABLED' });
    assert.equal((await push(line('101', '12:00'))).status, 403);
    await owner.patch(`/devices/${dev.id}`).send({ status: 'ACTIVE' });
    const admin = await adminLogin();
    await asAdmin(admin).put(`/tenants/${T.id}/features/biometric`).send({ enabled: false });
    assert.equal((await push(line('101', '12:00'))).status, 403);
    await asAdmin(admin).put(`/tenants/${T.id}/features/biometric`).send({ enabled: null });
    assert.equal((await push(line('101', '12:00'))).status, 200);
    const logs = (await owner.get(`/devices/${dev.id}/logs`).query({ level: 'ERROR' })).body.data.map((l) => l.event);
    assert.ok(logs.includes('rejected_ip') && logs.includes('rejected_plan'));
  });

  it('read-only workspaces are refused so the device keeps punches until renewal', async () => {
    await db.sys.Subscription.update({ status: 'SUSPENDED' }, { where: { tenantId: T.id } });
    const { invalidateTenantContext } = await import('../src/services/subscription.service.js');
    await invalidateTenantContext(T.id);
    assert.equal((await push(line('101', '13:00'))).status, 403);
  });
  it('alerts once when a device goes silent, and notes when it is back', async () => {
    const { deviceOfflineAlerts } = await import('../src/services/biometric/monitor.js');
    const d = await db.sys.AttendanceDevice.findOne({ where: { serialNumber: SN } });
    await db.sys.Subscription.update({ status: 'ACTIVE' }, { where: { tenantId: d.tenantId } });
    const { invalidateTenantContext } = await import('../src/services/subscription.service.js');
    await invalidateTenantContext(d.tenantId);
    await d.update({ lastSeenAt: new Date(Date.now() - 3600_000), offlineAlertedAt: null });
    assert.equal((await deviceOfflineAlerts()).alerted, 1);
    assert.equal((await deviceOfflineAlerts()).alerted, 0, 'once per outage');
    assert.equal(await db.sys.Notification.count({ where: { tenantId: d.tenantId, type: 'device.offline' } }) >= 1, true);
    await api().get('/iclock/getrequest').query({ SN });
    await d.reload();
    assert.equal(d.offlineAlertedAt, null);
    assert.ok(await db.sys.DeviceLog.count({ where: { deviceId: d.id, event: 'online' } }));
  });
});
