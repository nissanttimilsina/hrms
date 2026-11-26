import { sys } from '../database/index.js';
import { cache } from './redis.js';

/** Platform-level settings (Super Admin managed). Defaults apply until changed. */
export const PLATFORM_DEFAULTS = {
  'billing.vat_rate': 13, // Nepal VAT %, editable by Super Admin
  'billing.due_days': 7,
  'billing.seller': {
    name: 'Lishnu Tech Pvt. Ltd.', pan: '', address: 'Kathmandu, Nepal', email: 'billing@yourhrms.com', phone: '',
  },
  'billing.bank_accounts': [], // [{ bank, accountName, accountNumber, branch }]
  'billing.proration': true,
  'support.sla_hours': { URGENT: 2, HIGH: 8, NORMAL: 24, LOW: 48 },
  'platform.maintenance': { enabled: false, message: '' },
  'signup.enabled': true,
  'signup.default_plan': 'STANDARD',
};

export async function getSetting(key) {
  const k = `pset:${key}`;
  const hit = await cache.get(k);
  if (hit !== null) return hit.v;
  const row = await sys.PlatformSetting.findByPk(key);
  const v = row ? row.value : PLATFORM_DEFAULTS[key] ?? null;
  await cache.set(k, { v }, 300);
  return v;
}

export async function getAllSettings() {
  const rows = await sys.PlatformSetting.findAll();
  return { ...PLATFORM_DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export async function setSetting(key, value, transaction) {
  if (!(key in PLATFORM_DEFAULTS)) throw new Error(`Unknown setting ${key}`);
  await sys.PlatformSetting.upsert({ key, value }, { transaction });
  await cache.del(`pset:${key}`);
}
