import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, asAdmin, api, teardown, db, adminLogin } from './helpers/context.js';
import { evaluateAccess, sweepSubscriptions, invalidateTenantContext } from '../src/services/subscription.service.js';

const DAY = 86_400_000;
const newEmployee = (n) => ({ firstName: `E${n}`, lastName: 'L', joinedOn: '2026-01-01' });

describe('Subscription engine', () => {
  let admin;
  before(async () => {
    await resetDatabase();
    admin = await adminLogin();
  });
  after(teardown);

  // ------------------------------------------------------------------ pure access evaluation
  describe('evaluateAccess', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const ctx = (sub, tenantStatus = 'ACTIVE') => ({ tenant: { status: tenantStatus }, subscription: { graceDays: 7, graceEndsAt: null, ...sub } });

    it('active in period => FULL', () => assert.equal(evaluateAccess(ctx({ status: 'ACTIVE', currentPeriodEnd: '2026-07-01' }), now).state, 'FULL'));
    it('trial in period => FULL', () => assert.equal(evaluateAccess(ctx({ status: 'TRIAL', currentPeriodEnd: '2026-06-20' }), now).state, 'FULL'));
    it('expired but within grace => GRACE (even if job has not run)', () =>
      assert.equal(evaluateAccess(ctx({ status: 'ACTIVE', currentPeriodEnd: '2026-06-10' }), now).state, 'GRACE'));
    it('past grace => READ_ONLY', () =>
      assert.equal(evaluateAccess(ctx({ status: 'ACTIVE', currentPeriodEnd: '2026-06-01' }), now).state, 'READ_ONLY'));
    it('explicit grace end honoured', () =>
      assert.equal(evaluateAccess(ctx({ status: 'GRACE_PERIOD', currentPeriodEnd: '2026-06-01', graceEndsAt: '2026-06-30' }), now).state, 'GRACE'));
    it('past due within period => GRACE warning', () =>
      assert.equal(evaluateAccess(ctx({ status: 'PAST_DUE', currentPeriodEnd: '2026-07-01' }), now).state, 'GRACE'));
    it('cancelled keeps access until period end', () => {
      assert.equal(evaluateAccess(ctx({ status: 'CANCELLED', currentPeriodEnd: '2026-07-01' }), now).state, 'FULL');
      assert.equal(evaluateAccess(ctx({ status: 'CANCELLED', currentPeriodEnd: '2026-06-01' }), now).state, 'READ_ONLY');
    });
    it('suspended / expired subscription => READ_ONLY', () => {
      assert.equal(evaluateAccess(ctx({ status: 'SUSPENDED', currentPeriodEnd: '2026-07-01' }), now).state, 'READ_ONLY');
      assert.equal(evaluateAccess(ctx({ status: 'EXPIRED', currentPeriodEnd: '2026-05-01' }), now).state, 'READ_ONLY');
    });
    it('suspended tenant => BLOCKED regardless of subscription', () =>
      assert.equal(evaluateAccess(ctx({ status: 'ACTIVE', currentPeriodEnd: '2026-07-01' }, 'SUSPENDED'), now).state, 'BLOCKED'));
  });

  // ------------------------------------------------------------------ provisioning
  describe('provisioning', () => {
    it('creates a trial subscription with plan trial days and correct amount', async () => {
      const t = await makeTenant('prov', 'BASIC');
      const sub = await db.sys.Subscription.findByPk(t.subscriptionId);
      assert.equal(sub.status, 'TRIAL');
      assert.equal(Number(sub.amount), 1499);
      const days = Math.round((sub.currentPeriodEnd - sub.startsAt) / DAY);
      assert.equal(days, 14);
      assert.ok(await db.sys.Branch.findOne({ where: { tenantId: t.id, isHeadOffice: true } }));
      const events = await db.sys.SubscriptionEvent.count({ where: { subscriptionId: sub.id } });
      assert.equal(events, 1);
    });

    it('rejects reserved and duplicate workspace names', async () => {
      const res1 = await asAdmin(admin).post('/tenants').send({ slug: 'admin', name: 'Xyz Co', planCode: 'BASIC', owner: { email: 'a@a.test', fullName: 'A A' } });
      assert.equal(res1.status, 400);
      const res2 = await asAdmin(admin).post('/tenants').send({ slug: 'prov', name: 'Xyz Co', planCode: 'BASIC', owner: { email: 'a@a.test', fullName: 'A A' } });
      assert.equal(res2.status, 409);
      assert.equal(res2.body.error.code, 'SLUG_TAKEN');
    });

    it('Super Admin can create a tenant that invites its owner', async () => {
      const res = await asAdmin(admin).post('/tenants').send({ slug: 'invited', name: 'Invited Co', planCode: 'STANDARD', owner: { email: 'boss@invited.test', fullName: 'Boss' } });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.ownerStatus, 'INVITED');
      assert.equal(res.body.data.hostname, 'invited.hrms.test');
    });
  });

  // ------------------------------------------------------------------ limits
  describe('employee & branch limits', () => {
    let T; let tok;
    before(async () => {
      T = await makeTenant('limits', 'BASIC');
      tok = (await login('limits', T.ownerEmail)).token;
      await asAdmin(admin).patch(`/tenants/${T.id}/subscription/limits`).send({ maxEmployees: 3 });
    });

    it('blocks the employee that would exceed the limit with an upgrade prompt', async () => {
      const t = as('limits', tok);
      for (let i = 0; i < 3; i += 1) assert.equal((await t.post('/employees').send(newEmployee(i))).status, 201);
      const res = await t.post('/employees').send(newEmployee(9));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'LIMIT_REACHED');
      assert.deepEqual(res.body.error.details, { metric: 'employees', limit: 3, current: 3, upgrade: true });
    });

    it('terminated employees free a seat; re-activating consumes one', async () => {
      const t = as('limits', tok);
      const list = (await t.get('/employees')).body.data;
      assert.equal((await t.patch(`/employees/${list[0].id}`).send({ status: 'TERMINATED' })).status, 200);
      assert.equal((await t.post('/employees').send(newEmployee(10))).status, 201);
      const reactivate = await t.patch(`/employees/${list[0].id}`).send({ status: 'ACTIVE' });
      assert.equal(reactivate.body.error.code, 'LIMIT_REACHED');
    });

    it('is race-safe: concurrent creates never exceed the limit', async () => {
      await asAdmin(admin).patch(`/tenants/${T.id}/subscription/limits`).send({ maxEmployees: 5 });
      const t = as('limits', tok);
      const results = await Promise.all([...Array(6)].map((_, i) => t.post('/employees').send(newEmployee(100 + i))));
      assert.equal(results.filter((r) => r.status === 201).length, 2); // 3 used -> 5 max
      assert.equal(results.filter((r) => r.body.error?.code === 'LIMIT_REACHED').length, 4);
    });

    it('branch limit from plan (Basic = 1 head office) and Super Admin override takes effect immediately', async () => {
      const t = as('limits', tok);
      const blocked = await t.post('/branches').send({ code: 'B2', name: 'Branch 2' });
      assert.equal(blocked.body.error.code, 'LIMIT_REACHED');
      await asAdmin(admin).patch(`/tenants/${T.id}/subscription/limits`).send({ maxBranches: 2 });
      assert.equal((await t.post('/branches').send({ code: 'B2', name: 'Branch 2' })).status, 201);
    });

    it('usage is reported to the tenant', async () => {
      const s = (await as('limits', tok).get('/subscription')).body.data;
      assert.equal(s.planCode, 'BASIC');
      assert.equal(s.limits.employees, 5);
      assert.equal(s.usage.employees, 5);
      assert.equal(s.usage.branches, 2);
    });
  });

  // ------------------------------------------------------------------ lifecycle
  describe('expiry, grace period and read-only mode', () => {
    let T; let tok;
    before(async () => {
      T = await makeTenant('lifecycle', 'STANDARD');
      tok = (await login('lifecycle', T.ownerEmail)).token;
      await as('lifecycle', tok).post('/employees').send(newEmployee(1));
    });

    it('expired subscription moves to GRACE_PERIOD; writes still allowed with warning header', async () => {
      await db.sys.Subscription.update({ currentPeriodEnd: new Date(Date.now() - DAY), startsAt: new Date(Date.now() - 20 * DAY) }, { where: { id: T.subscriptionId } });
      const changes = await sweepSubscriptions();
      assert.ok(changes.some((c) => c.tenantId === T.id && c.to === 'GRACE_PERIOD'));
      const res = await as('lifecycle', tok).post('/employees').send(newEmployee(2));
      assert.equal(res.status, 201);
      assert.equal(res.headers['x-subscription-state'], 'GRACE');
    });

    it('after grace => SUSPENDED: reads work, writes return 402, data is preserved', async () => {
      await db.sys.Subscription.update({ graceEndsAt: new Date(Date.now() - 1000) }, { where: { id: T.subscriptionId } });
      await sweepSubscriptions();
      const sub = await db.sys.Subscription.findByPk(T.subscriptionId);
      assert.equal(sub.status, 'SUSPENDED');

      const t = as('lifecycle', tok);
      const list = await t.get('/employees');
      assert.equal(list.status, 200);
      assert.equal(list.body.data.length, 2);
      assert.equal(list.headers['x-subscription-state'], 'READ_ONLY');
      const write = await t.post('/employees').send(newEmployee(3));
      assert.equal(write.status, 402);
      assert.equal(write.body.error.code, 'SUBSCRIPTION_INACTIVE');
      // auth still works so the customer can reach billing
      assert.equal((await t.get('/auth/me')).status, 200);
    });

    it('manual payment verification re-activates with a new period', async () => {
      const res = await asAdmin(admin).post(`/tenants/${T.id}/subscription/activate`);
      assert.equal(res.status, 200);
      const sub = await db.sys.Subscription.findByPk(T.subscriptionId);
      assert.equal(sub.status, 'ACTIVE');
      assert.equal(sub.paymentStatus, 'PAID');
      assert.ok(sub.currentPeriodEnd > new Date(Date.now() + 27 * DAY));
      assert.equal((await as('lifecycle', tok).post('/employees').send(newEmployee(4))).status, 201);
      const events = await db.sys.SubscriptionEvent.findAll({ where: { subscriptionId: sub.id }, order: [['createdAt', 'ASC']] });
      assert.deepEqual(events.filter((e) => e.type === 'status_changed').map((e) => e.toStatus), ['GRACE_PERIOD', 'SUSPENDED', 'ACTIVE']);
    });

    it('platform suspension blocks the tenant and revokes sessions', async () => {
      const res = await asAdmin(admin).post(`/tenants/${T.id}/suspend`).send({ reason: 'Terms violation' });
      assert.equal(res.status, 200);
      const blocked = await as('lifecycle', tok).get('/employees');
      assert.equal(blocked.status, 401); // session revoked
      const loginRes = await api().post('/api/v1/auth/login').set('Host', 'lifecycle.hrms.test').send({ email: T.ownerEmail, password: 'Str0ngPassw0rd!' });
      assert.equal(loginRes.status, 403);
      assert.equal(loginRes.body.error.code, 'TENANT_BLOCKED');
      await asAdmin(admin).post(`/tenants/${T.id}/activate`).send({ reason: 'Resolved' });
    });
  });

  // ------------------------------------------------------------------ plans & entitlements (Super Admin)
  describe('plan management', () => {
    it('plan change updates entitlements immediately', async () => {
      const T = await makeTenant('upgrade', 'BASIC');
      const tok = (await login('upgrade', T.ownerEmail)).token;
      const before = (await as('upgrade', tok).get('/subscription')).body.data;
      assert.ok(!before.features.includes('payroll'));
      const res = await asAdmin(admin).patch(`/tenants/${T.id}/subscription/plan`).send({ planCode: 'PREMIUM' });
      assert.equal(res.status, 200);
      const after = (await as('upgrade', tok).get('/subscription')).body.data;
      assert.ok(after.features.includes('payroll'));
      assert.equal(after.limits.employees, 150);
      const sub = await db.sys.Subscription.findByPk(T.subscriptionId);
      const basic = await db.sys.Plan.findOne({ where: { code: 'BASIC' } });
      assert.equal(sub.previousPlanId, basic.id); // history preserved
    });

    it('add-on module enables a feature for one tenant only', async () => {
      const T = await makeTenant('addon', 'BASIC');
      const tok = (await login('addon', T.ownerEmail)).token;
      const r = await asAdmin(admin).post(`/tenants/${T.id}/subscription/modules`).send({ featureKey: 'payroll' });
      assert.equal(r.status, 201);
      assert.ok((await as('addon', tok).get('/subscription')).body.data.features.includes('payroll'));
      const other = await makeTenant('noaddon', 'BASIC');
      const tok2 = (await login('noaddon', other.ownerEmail)).token;
      assert.ok(!(await as('noaddon', tok2).get('/subscription')).body.data.features.includes('payroll'));
    });

    it('prices are versioned; the pricing API reflects the new price and recomputes savings', async () => {
      const plans = (await asAdmin(admin).get('/plans')).body.data;
      const basic = plans.find((p) => p.code === 'BASIC');
      const res = await asAdmin(admin).put(`/plans/${basic.id}/prices`).send({ billingCycle: 'MONTHLY', amount: 1599 });
      assert.equal(res.status, 200);
      const rows = await db.sys.PlanPrice.findAll({ where: { planId: basic.id, billingCycle: 'MONTHLY' }, order: [['effectiveFrom', 'ASC']] });
      assert.equal(rows.length, 2);
      assert.ok(rows[0].effectiveTo); // old price closed, not overwritten
      assert.equal(Number(rows[0].amount), 1499);
      const pub = (await api().get('/api/v1/public/plans').set('Host', 'www.yourhrms.com')).body.data.find((p) => p.code === 'BASIC');
      assert.equal(pub.prices.monthly, 1599);
      assert.equal(pub.annualSavings.amount, 1599 * 12 - 14990);
    });

    it('public plans: 4 plans, enterprise is contact-sales without a price', async () => {
      const pub = (await api().get('/api/v1/public/plans').set('Host', 'www.yourhrms.com')).body.data;
      assert.deepEqual(pub.map((p) => p.code), ['BASIC', 'STANDARD', 'PREMIUM', 'ENTERPRISE']);
      const ent = pub.at(-1);
      assert.equal(ent.contactSales, true);
      assert.equal(ent.prices.monthly, null);
      assert.equal(ent.limits.employees, null);
    });

    it('entitlement edits propagate to tenants on that plan', async () => {
      const T = await makeTenant('entl', 'STANDARD');
      const tok = (await login('entl', T.ownerEmail)).token;
      const std = (await asAdmin(admin).get('/plans')).body.data.find((p) => p.code === 'STANDARD');
      const current = std.entitlements.map((e) => e.feature.key);
      await asAdmin(admin).put(`/plans/${std.id}/entitlements`).send({ features: [...current, 'assets'] });
      assert.ok((await as('entl', tok).get('/subscription')).body.data.features.includes('assets'));
      await asAdmin(admin).put(`/plans/${std.id}/entitlements`).send({ features: current });
      await invalidateTenantContext(T.id);
    });
  });

  // ------------------------------------------------------------------ platform RBAC
  describe('platform roles', () => {
    it('Marketing Admin cannot manage tenants or plans', async () => {
      const { hashPassword } = await import('../src/services/password.service.js');
      const u = await db.sys.PlatformUser.create({ email: 'mkt@lishnu.test', fullName: 'Mkt', passwordHash: await hashPassword('Marketing123!') });
      const role = await db.sys.PlatformRole.findOne({ where: { key: 'marketing_admin' } });
      await db.sys.PlatformUserRole.create({ userId: u.id, roleId: role.id });
      const login2 = await api().post('/api/v1/admin/auth/login').set('Host', 'admin.hrms.test').send({ email: 'mkt@lishnu.test', password: 'Marketing123!' });
      const m = asAdmin(login2.body.data.accessToken);
      assert.equal((await m.get('/tenants')).status, 403);
      assert.equal((await m.get('/plans')).status, 200); // plans:view
      assert.equal((await m.post('/plans').send({ code: 'X', name: 'X' })).status, 403);
    });

    it('privileged admin actions are audited', async () => {
      const logs = (await asAdmin(admin).get('/audit-logs').query({ action: 'subscription.override_limits' })).body.data;
      assert.ok(logs.length >= 1);
      assert.equal(logs[0].actorType, 'PLATFORM_USER');
    });
  });
});
