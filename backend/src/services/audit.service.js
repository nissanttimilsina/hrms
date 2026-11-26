import { app, sys } from '../database/index.js';

/**
 * Append an audit record.
 *  - Tenant actions are written through the RLS-enforced connection inside the
 *    caller's tenant transaction (so they commit/rollback with the change).
 *  - Platform actions (tenantId may be null or the target tenant) go through
 *    the system connection.
 */
export async function audit({ transaction, tenantId = null, actor, action, entityType, entityId, before, after, req }) {
  const row = {
    tenantId,
    actorType: actor?.type ?? 'SYSTEM',
    actorId: actor?.id ?? null,
    action,
    entityType: entityType ?? null,
    entityId: entityId != null ? String(entityId) : null,
    before: before ?? null,
    after: after ?? null,
    ip: req?.ip ?? null,
    userAgent: req?.get?.('user-agent')?.slice(0, 500) ?? null,
    requestId: req?.id ?? null,
  };
  const model = transaction?.tenantId ? app.AuditLog : sys.AuditLog;
  return model.create(row, { transaction });
}

/** Actor helpers derived from the authenticated request. */
export const tenantActor = (req) => ({ type: 'TENANT_USER', id: req.auth.userId });
export const platformActor = (req) => ({ type: 'PLATFORM_USER', id: req.auth.userId });
