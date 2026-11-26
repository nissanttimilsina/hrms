import { Op, QueryTypes } from 'sequelize';
import { appDb } from '../database/index.js';

/**
 * Tenant RBAC.
 * A user's effective grants = union of all role_permissions across their roles.
 * One permission may be granted several times with different scopes; access is
 * the OR of those scopes (e.g. OWN via "employee" + DEPARTMENT via "department_manager").
 */

export const SCOPES = ['OWN', 'DIRECT_REPORTS', 'DEPARTMENT', 'BRANCH', 'SELECTED_BRANCHES', 'COMPANY'];

/** Expand a role template (catalog.DEFAULT_ROLES[].grants) into role_permission rows. */
export function expandTemplate(grants, permissions) {
  const out = new Map();
  for (const [resource, actions, scope] of grants) {
    for (const p of permissions) {
      const [res, act] = p.key.split(':');
      if (resource !== '*' && resource !== res) continue;
      if (actions !== '*' && !actions.includes(act)) continue;
      const effective = p.supportsScope ? scope : 'COMPANY';
      const prev = out.get(p.id);
      // keep the broadest scope if a template lists the same permission twice
      if (!prev || SCOPES.indexOf(effective) > SCOPES.indexOf(prev.scope)) {
        out.set(p.id, { permissionId: p.id, scope: effective });
      }
    }
  }
  return [...out.values()];
}

/** Load grants for a user. Must run inside withTenant() (RLS scopes the join). */
export async function loadGrants(userId, transaction) {
  const rows = await appDb.query(
    `SELECT p.key, p.module, rp.scope, rp.branch_ids AS "branchIds"
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p       ON p.id = rp.permission_id
      WHERE ur.user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT, transaction },
  );
  const grants = new Map();
  for (const r of rows) {
    if (!grants.has(r.key)) grants.set(r.key, { module: r.module, scopes: [] });
    grants.get(r.key).scopes.push({ scope: r.scope, branchIds: r.branchIds ?? [] });
  }
  return grants;
}

/**
 * Build a Sequelize WHERE fragment restricting rows to the principal's data scope.
 * Returns {} for company-wide access. `fields` maps scope concepts to columns of
 * the target model (defaults fit the employees table).
 */
export function scopeWhere(scopes, principal, fields = {}) {
  const f = { self: 'id', manager: 'managerId', department: 'departmentId', branch: 'branchId', ...fields };
  if (scopes.some((s) => s.scope === 'COMPANY')) return {};
  const { employeeId, departmentId, branchId } = principal;
  const ors = [];
  for (const { scope, branchIds } of scopes) {
    if (scope === 'OWN' && employeeId) ors.push({ [f.self]: employeeId });
    if (scope === 'DIRECT_REPORTS' && employeeId) ors.push({ [f.manager]: employeeId }, { [f.self]: employeeId });
    if (scope === 'DEPARTMENT' && departmentId) ors.push({ [f.department]: departmentId });
    if (scope === 'BRANCH' && branchId) ors.push({ [f.branch]: branchId });
    if (scope === 'SELECTED_BRANCHES' && branchIds.length) ors.push({ [f.branch]: { [Op.in]: branchIds } });
  }
  // No applicable scope (e.g. OWN but user not linked to an employee) => match nothing.
  return ors.length ? { [Op.or]: ors } : { [f.self]: null, [Op.and]: [{ [f.self]: { [Op.ne]: null } }] };
}

/** In-memory equivalent of scopeWhere for a single record (used on create/update). */
export function recordInScope(scopes, principal, record, fields = {}) {
  const f = { self: 'id', manager: 'managerId', department: 'departmentId', branch: 'branchId', ...fields };
  const { employeeId, departmentId, branchId } = principal;
  return scopes.some(({ scope, branchIds }) => {
    switch (scope) {
      case 'COMPANY': return true;
      case 'OWN': return !!employeeId && record[f.self] === employeeId;
      case 'DIRECT_REPORTS': return !!employeeId && (record[f.manager] === employeeId || record[f.self] === employeeId);
      case 'DEPARTMENT': return !!departmentId && record[f.department] === departmentId;
      case 'BRANCH': return !!branchId && record[f.branch] === branchId;
      case 'SELECTED_BRANCHES': return branchIds.includes(record[f.branch]);
      default: return false;
    }
  });
}
