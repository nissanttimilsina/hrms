/**
 * Device housekeeping (worker):
 * - offline alerts: a device silent for 30 minutes notifies the people who manage devices (once per outage);
 * - retention: raw punches are kept DEVICE_PUNCH_RETENTION_DAYS (attendance records themselves are kept),
 *   device logs 90 days.
 */
import { Op } from 'sequelize';
import { sys, withTenant } from '../../database/index.js';
import { notifyUsers, usersWithPermission } from '../hr/notify.js';
import { deviceLog } from './adms.js';
import { logger } from '../../utils/logger.js';

export const OFFLINE_AFTER_MS = 30 * 60_000;
export const DEVICE_PUNCH_RETENTION_DAYS = 400;
export const DEVICE_LOG_RETENTION_DAYS = 90;

export async function deviceOfflineAlerts(now = new Date()) {
  const stale = await sys.AttendanceDevice.findAll({
    where: { status: 'ACTIVE', deletedAt: null, offlineAlertedAt: null, lastSeenAt: { [Op.lt]: new Date(now - OFFLINE_AFTER_MS) } },
  });
  for (const d of stale) {
    try {
      await deviceLog(d, 'ERROR', 'offline', `No contact since ${d.lastSeenAt.toISOString()}`);
      await d.update({ offlineAlertedAt: now });
      await withTenant(d.tenantId, async (t) => notifyUsers(t, await usersWithPermission(t, 'devices:manage'), {
        type: 'device.offline', title: `Attendance device "${d.name}" is offline`, link: '/devices', email: true,
        body: 'It has not connected for 30 minutes. Check its power and network. Punches recorded meanwhile stay on the device and upload when it reconnects.',
      }));
    } catch (err) { logger.error({ err, deviceId: d.id }, 'offline alert failed'); }
  }
  return { alerted: stale.length };
}

export async function deviceRetention(now = new Date()) {
  const punches = await sys.DevicePunch.destroy({ where: { createdAt: { [Op.lt]: new Date(now - DEVICE_PUNCH_RETENTION_DAYS * 86_400_000) } } });
  const logs = await sys.DeviceLog.destroy({ where: { createdAt: { [Op.lt]: new Date(now - DEVICE_LOG_RETENTION_DAYS * 86_400_000) } } });
  return { punches, logs };
}
