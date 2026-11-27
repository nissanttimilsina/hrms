/**
 * Reset a Super Admin (platform staff) password from the server, e.g. when it is forgotten.
 *   docker compose exec api node src/scripts/reset-platform-password.js admin@example.com
 * Prints a new random password (or uses NEW_PASSWORD if set), unlocks the account and signs out all sessions.
 */
import crypto from 'node:crypto';
import { sys, systemDb } from '../database/index.js';
import { hashPassword, passwordPolicy } from '../services/password.service.js';

const email = (process.argv[2] ?? '').trim().toLowerCase();
if (!email) { console.error('Usage: node src/scripts/reset-platform-password.js <email>'); process.exit(2); }
const password = process.env.NEW_PASSWORD || `${crypto.randomBytes(12).toString('base64url')}Aa1`;
const check = passwordPolicy.safeParse(password);
if (!check.success) { console.error(check.error.issues[0].message); process.exit(2); }

try {
  const user = await sys.PlatformUser.findOne({ where: { email } });
  if (!user) {
    const all = await sys.PlatformUser.findAll({ attributes: ['email'] });
    console.error(`No platform user ${email}. Existing: ${all.map((u) => u.email).join(', ') || 'none'}`);
    process.exit(1);
  }
  await user.update({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null, status: 'ACTIVE' });
  await sys.AuthSession.update({ revokedAt: new Date(), revokeReason: 'password_reset_cli' }, { where: { userId: user.id, revokedAt: null } });
  await sys.AuditLog.create({ actorType: 'SYSTEM', action: 'platform_user.password_reset_cli', entityType: 'platform_user', entityId: user.id, after: { email } }).catch(() => {});
  console.log(`Password reset for ${email}\nNew password: ${password}\nSign in at the admin portal and change it under your profile.`);
} finally {
  await systemDb.close();
  process.exit(0);
}
