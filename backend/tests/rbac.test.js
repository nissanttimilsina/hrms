import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, teardown, db, makeUser } from './helpers/context.js';
import { requirePermission } from '../src/middleware/authorize.js';

describe('RBAC & data scopes', () => {
  let T; let owner; const emp = {}; let deptEng; let deptOps; let branchHQ;

  before(async () => {
    await resetDatabase();
    T = await makeTenant('rbac', 'BUSINESS');
    owner = (await login('rbac', T.ownerEmail)).token;
    const o = as('rbac', owner);
    branchHQ = (await o.get('/branches')).body.data[0];
    deptEng = (await o.post('/departments').send({ code: 'ENG', name: 'Engineering' })).body.data;
    deptOps = (await o.post('/departments').send({ code: 'OPS', name: 'Operations' })).body.data;
    const mk = async (key, extra) => {
      emp[key] = (await o.post('/employees').send({ firstName: key, lastName: 'X', joinedOn: '2026-01-01', branchId: branchHQ.id, ...extra })).body.data;
    };
    await mk('manager', { departmentId: deptEng.id });
    await mk('dev1', { departmentId: deptEng.id, managerId: emp.manager.id });
    await mk('dev2', { departmentId: deptEng.id });
    await mk('ops1', { departmentId: deptOps.id });

    await makeUser(T.id, { email: 'staff@rbac.test', roles: ['employee'], employeeId: emp.dev1.id });
    await makeUser(T.id, { email: 'dm@rbac.test', roles: ['department_manager'], employeeId: emp.dev2.id });
    await makeUser(T.id, { email: 'tl@rbac.test', roles: ['team_leader'], employeeId: emp.manager.id });
    await makeUser(T.id, { email: 'hro@rbac.test', roles: ['hr_officer'] });
    await makeUser(T.id, { email: 'aud@rbac.test', roles: ['auditor'] });
  });
  after(teardown);

  const ids = (res) => res.body.data.map((e) => e.firstName).sort();

  it('Employee role sees only their own record', async () => {
    const { token } = await login('rbac', 'staff@rbac.test');
    const res = await as('rbac', token).get('/employees');
    assert.deepEqual(ids(res), ['dev1']);
    assert.equal((await as('rbac', token).get(`/employees/${emp.ops1.id}`)).status, 404);
  });

  it('Employee role cannot create employees', async () => {
    const { token } = await login('rbac', 'staff@rbac.test');
    const res = await as('rbac', token).post('/employees').send({ firstName: 'n', lastName: 'n', joinedOn: '2026-01-01' });
    assert.equal(res.status, 403);
  });

  it('Department Manager sees exactly their department', async () => {
    const { token } = await login('rbac', 'dm@rbac.test');
    assert.deepEqual(ids(await as('rbac', token).get('/employees')), ['dev1', 'dev2', 'manager']);
  });

  it('Team Leader sees self + direct reports', async () => {
    const { token } = await login('rbac', 'tl@rbac.test');
    assert.deepEqual(ids(await as('rbac', token).get('/employees')), ['dev1', 'manager']);
  });

  it('HR Officer sees the whole company but cannot delete branches or manage roles', async () => {
    const { token } = await login('rbac', 'hro@rbac.test');
    const h = as('rbac', token);
    assert.equal((await h.get('/employees')).body.data.length, 4);
    assert.equal((await h.delete(`/branches/${branchHQ.id}`)).status, 403);
    assert.equal((await h.get('/roles')).status, 403);
  });

  it('Auditor can view but not change', async () => {
    const { token } = await login('rbac', 'aud@rbac.test');
    const h = as('rbac', token);
    assert.equal((await h.get('/employees')).status, 200);
    assert.equal((await h.get('/audit-logs')).status, 200);
    assert.equal((await h.patch(`/employees/${emp.dev2.id}`).send({ firstName: 'x' })).status, 403);
  });

  it('custom role with SELECTED_BRANCHES scope', async () => {
    const o = as('rbac', owner);
    const pkr = (await o.post('/branches').send({ code: 'PKR', name: 'Pokhara' })).body.data;
    await o.post('/employees').send({ firstName: 'pokhara1', lastName: 'X', joinedOn: '2026-01-01', branchId: pkr.id });
    const role = await o.post('/roles').send({
      name: 'Pokhara Viewer', grants: [{ permission: 'employees:view', scope: 'SELECTED_BRANCHES', branchIds: [pkr.id] }],
    });
    assert.equal(role.status, 201);
    const u = await makeUser(T.id, { email: 'pv@rbac.test', roles: [] });
    assert.equal((await o.put(`/users/${u.id}/roles`).send({ roleIds: [role.body.data.id] })).status, 200);
    const { token } = await login('rbac', 'pv@rbac.test');
    assert.deepEqual(ids(await as('rbac', token).get('/employees')), ['pokhara1']);
  });

  it('prevents privilege escalation through role creation and assignment', async () => {
    const o = as('rbac', owner);
    const delegate = await o.post('/roles').send({
      name: 'Role Delegate',
      grants: ['roles:view', 'roles:create', 'roles:edit', 'users:manage', 'employees:view'].map((permission) => ({ permission, scope: 'COMPANY' })),
    });
    const u = await makeUser(T.id, { email: 'del@rbac.test', roles: [] });
    await o.put(`/users/${u.id}/roles`).send({ roleIds: [delegate.body.data.id] });
    const { token } = await login('rbac', 'del@rbac.test');
    const d = as('rbac', token);

    const esc = await d.post('/roles').send({ name: 'Sneaky', grants: [{ permission: 'payroll:manage', scope: 'COMPANY' }] });
    assert.equal(esc.status, 403);
    assert.equal(esc.body.error.code, 'ESCALATION_DENIED');

    const roles = (await d.get('/roles')).body.data;
    const ownerRole = roles.find((r) => r.key === 'company_owner');
    const selfPromote = await d.put(`/users/${u.id}/roles`).send({ roleIds: [ownerRole.id] });
    assert.equal(selfPromote.status, 403);

    const allowed = await d.post('/roles').send({ name: 'Viewer', grants: [{ permission: 'employees:view', scope: 'COMPANY' }] });
    assert.equal(allowed.status, 201);
  });

  it('Company Owner role cannot be edited and the last owner cannot be removed', async () => {
    const o = as('rbac', owner);
    const roles = (await o.get('/roles')).body.data;
    const ownerRole = roles.find((r) => r.key === 'company_owner');
    const hr = roles.find((r) => r.key === 'hr_manager');
    assert.equal((await o.put(`/roles/${ownerRole.id}/permissions`).send({ grants: [] })).body.error.code, 'OWNER_ROLE_LOCKED');
    const me = (await o.get('/auth/me')).body.data.user;
    const res = await o.put(`/users/${me.id}/roles`).send({ roleIds: [hr.id] });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'LAST_OWNER');
  });

  it('default roles are not deletable; custom roles in use are protected', async () => {
    const o = as('rbac', owner);
    const roles = (await o.get('/roles')).body.data;
    assert.equal((await o.delete(`/roles/${roles.find((r) => r.key === 'employee').id}`)).status, 409);
    const custom = roles.find((r) => r.key === 'custom_pokhara_viewer');
    assert.equal((await o.delete(`/roles/${custom.id}`)).body.error.code, 'ROLE_IN_USE');
  });

  it('requirePermission denies modules the plan does not include, even with a grant', async () => {
    const grants = new Map([['payroll:view', { module: 'payroll', scopes: [{ scope: 'COMPANY', branchIds: [] }] }]]);
    const req = { auth: { grants, ctx: { features: ['employees', 'attendance'] } } };
    const err = await new Promise((resolve) => requirePermission('payroll:view')(req, {}, resolve));
    assert.equal(err.code, 'FEATURE_NOT_IN_PLAN');
    const okReq = { auth: { grants, ctx: { features: ['payroll'] } } };
    const none = await new Promise((resolve) => requirePermission('payroll:view')(okReq, {}, resolve));
    assert.equal(none, undefined);
    assert.equal(okReq.scopes[0].scope, 'COMPANY');
  });

  it('/auth/me exposes effective permissions with scopes for the UI', async () => {
    const { token } = await login('rbac', 'dm@rbac.test');
    const me = (await as('rbac', token).get('/auth/me')).body.data;
    assert.deepEqual(me.permissions['employees:view'], ['DEPARTMENT']);
    assert.equal(me.permissions['employees:create'], undefined);
  });

  it('every default role has been provisioned', async () => {
    const n = await db.sys.Role.count({ where: { tenantId: T.id, isSystem: true } });
    assert.equal(n, 12);
  });
});
