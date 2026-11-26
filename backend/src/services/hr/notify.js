import { app } from '../../database/index.js';
import { enqueueEmail } from '../../jobs/queues.js';

/**
 * In-app notification (+ optional email) to tenant users, inside the caller's
 * tenant transaction. Emails are queued only after commit.
 */
export async function notifyUsers(t, userIds, { type, title, body, link, email = false }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  await app.Notification.bulkCreate(ids.map((userId) => ({ tenantId: t.tenantId, userId, type, title, body: body ?? null, link: link ?? null, readAt: null })), { transaction: t });
  if (email) {
    const users = await app.User.findAll({ where: { id: ids, status: 'ACTIVE' }, attributes: ['email'], transaction: t });
    t.afterCommit(() => Promise.all(users.map((u) => enqueueEmail({ tenantId: t.tenantId, to: u.email, template: 'notification.generic', data: { title, body, url: link } }))));
  }
}

/** Users (ids) who hold a permission at COMPANY scope — e.g. HR approvers. */
export async function usersWithPermission(t, permissionKey) {
  const rows = await app.User.sequelize.query(
    `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id WHERE p.key = :k AND rp.scope = 'COMPANY' AND u.status = 'ACTIVE'`,
    { replacements: { k: permissionKey }, type: 'SELECT', transaction: t },
  );
  return rows.map((r) => r.id);
}

/** The user account linked to an employee (if any). */
export async function userIdForEmployee(t, employeeId) {
  if (!employeeId) return null;
  return (await app.User.findOne({ where: { employeeId }, attributes: ['id'], transaction: t }))?.id ?? null;
}
