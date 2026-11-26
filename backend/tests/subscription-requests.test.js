import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, asAdmin, teardown, db, adminLogin, makeUser } from './helpers/context.js';

describe('Subscription requests & per-company features', () => {
  let admin; let T; let owner;
  const pending = () => db.sys.SubscriptionRequest.findOne({ where: { tenantId: T.id, status: 'PENDING' } });
  const features = async (tenantId) => (await asAdmin(admin).get(`/tenants/${tenantId}`)).body.data.features;
  before(async () => {
    await resetDatabase();
    admin = await adminLogin();
    T = await makeTenant('reqco', 'BASIC');
    owner = as('reqco', (await login('reqco', T.ownerEmail)).token);
  });
  after(teardown);

  it('a company requests a plan; one open request at a time', async () => {
    const r = await owner.post('/billing/requests').send({ planCode: 'professional', billingCycle: 'ANNUAL', employeeCount: 35, message: 'Need payroll from Magh' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.kind, 'PLAN_CHANGE');
    assert.equal((await owner.post('/billing/requests').send({ planCode: 'BUSINESS' })).status, 409);
    const mine = (await owner.get('/billing/requests')).body.data;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].plan.code, 'PROFESSIONAL');
    assert.equal((await owner.post('/billing/requests').send({})).status, 422);
  });

  it('employees cannot request; other companies cannot see or cancel it', async () => {
    await makeUser(T.id, { email: 'emp@reqco.test', roles: ['employee'] });
    const emp = as('reqco', (await login('reqco', 'emp@reqco.test')).token);
    assert.equal((await emp.post('/billing/requests').send({ planCode: 'BUSINESS' })).status, 403);
    const O = await makeTenant('nosy', 'BASIC');
    const other = as('nosy', (await login('nosy', O.ownerEmail)).token);
    assert.equal((await other.get('/billing/requests')).body.data.length, 0);
    assert.equal((await other.post(`/billing/requests/${(await pending()).id}/cancel`)).status, 404);
  });

  it('Super Admin sees pending requests on the list and dashboard', async () => {
    const list = await asAdmin(admin).get('/subscription-requests').query({ status: 'PENDING' });
    assert.equal(list.status, 200);
    assert.equal(list.body.data[0].tenant.slug, 'reqco');
    assert.equal((await asAdmin(admin).get('/dashboard')).body.data.kpis?.pendingRequests ?? (await asAdmin(admin).get('/dashboard')).body.data.pendingRequests, 1);
  });

  it('approve with invoice: features switch on only when the invoice is paid', async () => {
    const r = await pending();
    const res = await asAdmin(admin).post(`/subscription-requests/${r.id}/approve`).send({ note: 'Welcome aboard' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const inv = res.body.data.invoice;
    assert.ok(inv && inv.status === 'OPEN');
    assert.equal((await r.reload()).status, 'APPROVED');
    assert.ok(!(await features(T.id)).includes('payroll'), 'not active before payment');
    assert.equal((await owner.get('/payroll/runs')).status, 403);
    const note = await db.sys.Notification.findOne({ where: { tenantId: T.id, type: 'subscription.request' } });
    assert.match(note.body, /Invoice .* Welcome aboard/);
    // second decision is refused
    assert.equal((await asAdmin(admin).post(`/subscription-requests/${r.id}/reject`).send({ reason: 'changed my mind' })).status, 409);
    const paid = await asAdmin(admin).post(`/invoices/${inv.id}/record-payment`).send({ providerRef: 'NIC-7781' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.ok((await features(T.id)).includes('payroll'));
    const sub = await db.sys.Subscription.findByPk(T.subscriptionId, { include: ['plan'] });
    assert.deepEqual([sub.plan.code, sub.billingCycle, sub.status], ['PROFESSIONAL', 'ANNUAL', 'ACTIVE']);
    assert.equal((await owner.get('/payroll/runs')).status, 200);
  });

  it('reject with a reason; the company is told why', async () => {
    const r = (await owner.post('/billing/requests').send({ planCode: 'BUSINESS' })).body.data;
    assert.equal((await asAdmin(admin).post(`/subscription-requests/${r.id}/reject`).send({ reason: 'no' })).status, 422);
    assert.equal((await asAdmin(admin).post(`/subscription-requests/${r.id}/reject`).send({ reason: 'Please contact sales for 150+ seats' })).status, 200);
    const n = await db.sys.Notification.findOne({ where: { tenantId: T.id, title: 'Your subscription request was not approved' } });
    assert.equal(n.body, 'Please contact sales for 150+ seats');
  });

  it('cancel by the company', async () => {
    const r = (await owner.post('/billing/requests').send({ planCode: 'BUSINESS' })).body.data;
    assert.equal((await owner.post(`/billing/requests/${r.id}/cancel`)).status, 200);
    assert.equal((await asAdmin(admin).post(`/subscription-requests/${r.id}/approve`).send({})).status, 409);
  });

  it('Enterprise: negotiated price, limits and features applied on approval', async () => {
    const r = (await owner.post('/billing/requests').send({ planCode: 'ENTERPRISE', employeeCount: 600, features: ['assets'] })).body.data;
    assert.equal(r.kind, 'ENTERPRISE');
    assert.equal((await asAdmin(admin).post(`/subscription-requests/${r.id}/approve`).send({ mode: 'ACTIVATE' })).status, 400, 'price required');
    const res = await asAdmin(admin).post(`/subscription-requests/${r.id}/approve`).send({ mode: 'ACTIVATE', customAmount: 45000, billingCycle: 'MONTHLY', maxEmployees: 600, features: { ai_assistant: false } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = (await asAdmin(admin).get(`/tenants/${T.id}`)).body.data;
    assert.equal(d.subscription.planCode, 'ENTERPRISE');
    assert.equal(d.subscription.status, 'ACTIVE');
    assert.equal(d.limits.employees, 600);
    assert.ok(d.features.includes('assets'));
    assert.ok(!d.features.includes('ai_assistant'));
    assert.equal(Number((await db.sys.Subscription.findByPk(T.subscriptionId)).amount), 45000);
  });

  it('Enterprise via invoice: paying the custom invoice activates at the negotiated price', async () => {
    const E = await makeTenant('bigco', 'BASIC');
    const big = as('bigco', (await login('bigco', E.ownerEmail)).token);
    const r = (await big.post('/billing/requests').send({ planCode: 'ENTERPRISE' })).body.data;
    const inv = (await asAdmin(admin).post(`/subscription-requests/${r.id}/approve`).send({ customAmount: 300000, billingCycle: 'ANNUAL' })).body.data.invoice;
    assert.equal(Number(inv.subtotal), 300000);
    assert.equal(Number(inv.total), 339000);
    await asAdmin(admin).post(`/invoices/${inv.id}/record-payment`).send({ providerRef: 'WIRE-1' });
    const sub = await db.sys.Subscription.findByPk(E.subscriptionId, { include: ['plan'] });
    assert.deepEqual([sub.plan.code, sub.status, Number(sub.amount)], ['ENTERPRISE', 'ACTIVE', 300000]);
  });

  it('Super Admin switches single features off and on, enforced by the API', async () => {
    const P = await makeTenant('featco', 'PROFESSIONAL');
    const p = as('featco', (await login('featco', P.ownerEmail)).token);
    assert.equal((await p.get('/payroll/runs')).status, 200);
    assert.equal((await asAdmin(admin).put(`/tenants/${P.id}/features/payroll`).send({ enabled: false, reason: 'Unpaid add-on' })).status, 200);
    const off = await p.get('/payroll/runs');
    assert.equal(off.status, 403);
    assert.equal(off.body.error.code, 'FEATURE_NOT_IN_PLAN');
    assert.equal((await asAdmin(admin).put(`/tenants/${P.id}/features/assets`).send({ enabled: true })).status, 200);
    assert.ok((await features(P.id)).includes('assets'));
    assert.equal((await asAdmin(admin).put(`/tenants/${P.id}/features/payroll`).send({ enabled: null })).status, 200);
    assert.equal((await p.get('/payroll/runs')).status, 200, 'clearing the switch follows the plan again');
    assert.equal((await asAdmin(admin).put(`/tenants/${P.id}/features/no_such_feature`).send({ enabled: true })).status, 404);
    const core = (await db.sys.FeatureCatalog.findOne({ where: { isCore: true } })).key;
    assert.equal((await asAdmin(admin).put(`/tenants/${P.id}/features/${core}`).send({ enabled: false })).status, 400);
    assert.ok(await db.sys.AuditLog.count({ where: { tenantId: P.id, action: 'subscription.feature_override' } }) >= 3);
  });

  it('module-only request switches the modules on when approved', async () => {
    const M = await makeTenant('modco', 'PROFESSIONAL');
    const m = as('modco', (await login('modco', M.ownerEmail)).token);
    const r = (await m.post('/billing/requests').send({ features: ['assets', 'training'] })).body.data;
    assert.equal(r.kind, 'FEATURES');
    assert.equal((await m.post('/billing/requests').send({ features: ['nope'] })).status, 409, 'one at a time');
    await asAdmin(admin).post(`/subscription-requests/${r.id}/approve`).send({ mode: 'ACTIVATE' });
    const f = await features(M.id);
    assert.ok(f.includes('assets') && f.includes('training'));
  });
});
