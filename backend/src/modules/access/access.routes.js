import { Router } from 'express';
import { z } from 'zod';
import { Op } from 'sequelize';
import { app } from '../../database/index.js';
import { requirePermission, allFeatureKeys } from '../../middleware/authorize.js';
import { validate } from '../../middleware/common.js';
import { assertWithinLimit } from '../../services/subscription.service.js';
import { SCOPES } from '../../services/rbac.service.js';
import { audit, tenantActor } from '../../services/audit.service.js';
import { enqueueEmail } from '../../jobs/queues.js';
import { randomToken, sha256 } from '../../utils/crypto.js';
import { asyncHandler, ok, created, listQuery, paginate, pageMeta, searchWhere } from '../../utils/http.js';
import { NotFound, Forbidden, Conflict, BadRequest } from '../../utils/errors.js';

/**
 * Roles, permissions and users inside a company workspace.
 * Anti-escalation rule: a user can only grant (via role edits or role
 * assignment) permissions they hold themselves, at a scope they hold.
 */
export const accessRouter = Router();
const idParam = { params: z.object({ id: z.string().uuid() }) };
const OWNER = 'company_owner';

const grantSchema = z.object({
  permission: z.string().regex(/^[a-z_]+:[a-z_]+$/),
  scope: z.enum(SCOPES).default('COMPANY'),
  branchIds: z.array(z.string().uuid()).max(50).default([]),
}).strict();

function assertCanGrant(req, grants) {
  for (const g of grants) {
    const mine = req.auth.grants.get(g.permission);
    const scopes = mine?.scopes.map((s) => s.scope) ?? [];
    if (!mine || (!scopes.includes('COMPANY') && !scopes.includes(g.scope))) {
      throw Forbidden(`You cannot grant ${g.permission} (${g.scope}) because you do not hold it`, 'ESCALATION_DENIED', { permission: g.permission });
    }
  }
}

async function resolveGrants(grants, t) {
  const perms = await app.Permission.findAll({ where: { key: grants.map((g) => g.permission) }, transaction: t });
  const byKey = new Map(perms.map((p) => [p.key, p]));
  return grants.map((g) => {
    const p = byKey.get(g.permission);
    if (!p) throw BadRequest(`Unknown permission ${g.permission}`);
    if (g.scope === 'SELECTED_BRANCHES' && !g.branchIds.length) throw BadRequest(`${g.permission}: select at least one branch`);
    return { permissionId: p.id, scope: p.supportsScope ? g.scope : 'COMPANY', branchIds: g.scope === 'SELECTED_BRANCHES' ? g.branchIds : [] };
  });
}

// --------------------------------------------------------------------------- permission catalogue
accessRouter.get('/permissions', requirePermission('roles:view'), asyncHandler(async (req, res) => {
  const features = await allFeatureKeys();
  const perms = await req.tx((t) => app.Permission.findAll({ order: [['key', 'ASC']], transaction: t }));
  return ok(res, perms.map((p) => ({
    key: p.key, module: p.module, action: p.action, supportsScope: p.supportsScope,
    availableInPlan: !features.has(p.module) || req.auth.ctx.features.includes(p.module),
  })));
}));

// --------------------------------------------------------------------------- roles
accessRouter.get('/roles', requirePermission('roles:view'), asyncHandler(async (req, res) => {
  const roles = await req.tx((t) => app.Role.findAll({
    include: [{ model: app.RolePermission, as: 'grants', include: [{ model: app.Permission, as: 'permission', attributes: ['key'] }] }],
    order: [['isSystem', 'DESC'], ['name', 'ASC']], transaction: t,
  }));
  return ok(res, roles.map((r) => ({
    id: r.id, key: r.key, name: r.name, description: r.description, isSystem: r.isSystem,
    grants: r.grants.map((g) => ({ permission: g.permission.key, scope: g.scope, branchIds: g.branchIds })),
  })));
}));

accessRouter.post('/roles', requirePermission('roles:create'), validate({
  body: z.object({
    name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional(),
    grants: z.array(grantSchema).max(500).default([]),
  }).strict(),
}), asyncHandler(async (req, res) => {
  assertCanGrant(req, req.body.grants);
  const role = await req.tx(async (t) => {
    const key = `custom_${req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}`;
    const r = await app.Role.create({ tenantId: req.auth.tenantId, key, name: req.body.name, description: req.body.description, isSystem: false }, { transaction: t });
    const rows = await resolveGrants(req.body.grants, t);
    await app.RolePermission.bulkCreate(rows.map((g) => ({ ...g, tenantId: req.auth.tenantId, roleId: r.id })), { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'role.create', entityType: 'role', entityId: r.id, after: req.body, req });
    return r;
  });
  return created(res, role);
}));

accessRouter.put('/roles/:id/permissions', requirePermission('roles:edit'), validate({
  ...idParam, body: z.object({ grants: z.array(grantSchema).max(500) }).strict(),
}), asyncHandler(async (req, res) => {
  assertCanGrant(req, req.body.grants);
  await req.tx(async (t) => {
    const role = await app.Role.findByPk(req.params.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!role) throw NotFound('Role');
    if (role.key === OWNER) throw Forbidden('The Company Owner role always has full access', 'OWNER_ROLE_LOCKED');
    const before = await app.RolePermission.findAll({ where: { roleId: role.id }, raw: true, transaction: t });
    const rows = await resolveGrants(req.body.grants, t);
    await app.RolePermission.destroy({ where: { roleId: role.id }, transaction: t });
    await app.RolePermission.bulkCreate(rows.map((g) => ({ ...g, tenantId: req.auth.tenantId, roleId: role.id })), { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'role.permissions_update', entityType: 'role', entityId: role.id, before, after: req.body.grants, req });
  });
  return ok(res, { updated: true });
}));

accessRouter.delete('/roles/:id', requirePermission('roles:delete'), validate(idParam), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const role = await app.Role.findByPk(req.params.id, { transaction: t });
    if (!role) throw NotFound('Role');
    if (role.isSystem) throw Conflict('Default roles cannot be deleted', 'SYSTEM_ROLE');
    const holders = await app.UserRole.count({ where: { roleId: role.id }, transaction: t });
    if (holders) throw Conflict(`Role is assigned to ${holders} user(s)`, 'ROLE_IN_USE');
    await role.destroy({ transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'role.delete', entityType: 'role', entityId: role.id, req });
  });
  return ok(res, { deleted: true });
}));

// --------------------------------------------------------------------------- users
accessRouter.get('/users', requirePermission('users:view'), validate({ query: listQuery(['createdAt', 'fullName', 'email']) }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows, count } = await req.tx((t) => app.User.findAndCountAll({
      where: searchWhere(q.search, ['fullName', 'email']),
      attributes: ['id', 'email', 'fullName', 'status', 'employeeId', 'lastLoginAt', 'createdAt'],
      include: [{ model: app.Role, as: 'roles', attributes: ['id', 'key', 'name'], through: { attributes: [] } }],
      distinct: true, ...paginate(q), transaction: t,
    }));
    return ok(res, rows, pageMeta(q, count));
  }));

accessRouter.post('/users/invitations', requirePermission('users:create'), validate({
  body: z.object({
    email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(120),
    roleId: z.string().uuid(), employeeId: z.string().uuid().optional(),
  }).strict(),
}), asyncHandler(async (req, res) => {
  const token = randomToken();
  const result = await req.tx(async (t) => {
    await assertWithinLimit(req.auth.ctx, 'users', t);
    const role = await app.Role.findByPk(req.body.roleId, { include: [{ model: app.RolePermission, as: 'grants', include: [{ model: app.Permission, as: 'permission' }] }], transaction: t });
    if (!role) throw NotFound('Role');
    assertCanGrant(req, role.grants.map((g) => ({ permission: g.permission.key, scope: g.scope })));
    if (await app.User.findOne({ where: { email: req.body.email }, transaction: t })) throw Conflict('A user with this email already exists', 'USER_EXISTS');
    const user = await app.User.create({ tenantId: req.auth.tenantId, email: req.body.email, fullName: req.body.fullName, employeeId: req.body.employeeId ?? null, status: 'INVITED' }, { transaction: t });
    await app.TenantInvitation.create({
      tenantId: req.auth.tenantId, email: req.body.email, roleId: role.id, tokenHash: sha256(token),
      invitedById: req.auth.userId, expiresAt: new Date(Date.now() + 7 * 86_400_000),
    }, { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'user.invite', entityType: 'user', entityId: user.id, after: { email: user.email, role: role.key }, req });
    return user;
  });
  await enqueueEmail({ tenantId: req.auth.tenantId, to: req.body.email, template: 'user.invitation', data: { token, companyName: req.auth.ctx.tenant.name } });
  return created(res, { id: result.id, email: result.email, status: result.status });
}));

accessRouter.put('/users/:id/roles', requirePermission('users:manage'), validate({
  ...idParam, body: z.object({ roleIds: z.array(z.string().uuid()).min(1).max(20) }).strict(),
}), asyncHandler(async (req, res) => {
  await req.tx(async (t) => {
    const user = await app.User.findByPk(req.params.id, { transaction: t });
    if (!user) throw NotFound('User');
    const roles = await app.Role.findAll({
      where: { id: { [Op.in]: req.body.roleIds } },
      include: [{ model: app.RolePermission, as: 'grants', include: [{ model: app.Permission, as: 'permission' }] }],
      transaction: t,
    });
    if (roles.length !== new Set(req.body.roleIds).size) throw NotFound('Role');
    assertCanGrant(req, roles.flatMap((r) => r.grants.map((g) => ({ permission: g.permission.key, scope: g.scope }))));

    // Never leave the company without an owner.
    const ownerRole = await app.Role.findOne({ where: { key: OWNER }, transaction: t, lock: t.LOCK.UPDATE });
    const wasOwner = await app.UserRole.count({ where: { userId: user.id, roleId: ownerRole.id }, transaction: t });
    const staysOwner = roles.some((r) => r.key === OWNER);
    if (wasOwner && !staysOwner) {
      const owners = await app.UserRole.count({ where: { roleId: ownerRole.id }, transaction: t });
      if (owners <= 1) throw Conflict('Assign another Company Owner before removing this one', 'LAST_OWNER');
    }
    const before = await app.UserRole.findAll({ where: { userId: user.id }, raw: true, transaction: t });
    await app.UserRole.destroy({ where: { userId: user.id }, transaction: t });
    await app.UserRole.bulkCreate(roles.map((r) => ({ tenantId: req.auth.tenantId, userId: user.id, roleId: r.id })), { transaction: t });
    await audit({ transaction: t, tenantId: req.auth.tenantId, actor: tenantActor(req), action: 'user.roles_update', entityType: 'user', entityId: user.id, before: before.map((x) => x.roleId), after: req.body.roleIds, req });
  });
  return ok(res, { updated: true });
}));

accessRouter.get('/audit-logs', requirePermission('audit:view'), validate({ query: listQuery(['createdAt'], { action: z.string().max(60).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows, count } = await req.tx((t) => app.AuditLog.findAndCountAll({
      where: q.action ? { action: q.action } : {}, ...paginate(q), transaction: t,
    }));
    return ok(res, rows, pageMeta(q, count));
  }));
