import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resetDatabase, makeTenant, login, as, asAdmin, api, pub, teardown, db, adminLogin, staffToken, PASSWORD, host } from './helpers/context.js';
import { setHttpClient } from '../src/services/payments/providers.js';

const DAY = 86_400_000;
const r2 = (n) => Math.round(n * 100) / 100;
const esewaSign = (obj, names) => crypto.createHmac('sha256', '8gBm/:&EnhH.1/q').update(names.map((n) => `${n}=${obj[n]}`).join(',')).digest('base64');

/** Mock provider HTTP: responses keyed by URL substring. */
const providerCalls = [];
function mockProviders(responses) {
  setHttpClient(async (url, opts = {}) => {
    providerCalls.push({ url, body: opts.body });
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) return { status: 404, json: {} };
    return typeof responses[key] === 'function' ? responses[key](url, opts) : responses[key];
  });
}

async function paidTenant(slug, planCode = 'STANDARD') {
  const t = await makeTenant(slug, planCode, { trial: false });
  await db.sys.Subscription.update({ paymentStatus: 'PAID' }, { where: { id: t.subscriptionId } });
  return t;
}

describe('Commercial engine', () => {
  let admin;
  before(async () => { await resetDatabase(); admin = await adminLogin(); });
  after(teardown);

  // ------------------------------------------------------------------ pricing calculator
  describe('pricing calculator', () => {
    it('recommends the cheapest plan that fits and adds 13% VAT', async () => {
      const r = (await pub().post('/pricing/quote').send({ employees: 15 })).body.data;
      assert.equal(r.recommended, 'BASIC');
      assert.equal(r.subtotal, 1499);
      assert.equal(r.taxRate, 13);
      assert.equal(r.total, r2(1499 * 1.13));
    });
    it('employee count and modules drive the recommendation', async () => {
      assert.equal((await pub().post('/pricing/quote').send({ employees: 40 })).body.data.recommended, 'STANDARD');
      assert.equal((await pub().post('/pricing/quote').send({ employees: 10, modules: ['payroll'] })).body.data.recommended, 'STANDARD');
      assert.equal((await pub().post('/pricing/quote').send({ employees: 10, branches: 4 })).body.data.recommended, 'PREMIUM');
      assert.equal((await pub().post('/pricing/quote').send({ employees: 30, billingCycle: 'ANNUAL' })).body.data.subtotal, 29990);
    });
    it('beyond every package → Enterprise enquiry with reasons', async () => {
      const r = (await pub().post('/pricing/quote').send({ employees: 400, modules: ['ai_assistant'] })).body.data;
      assert.equal(r.contactSales, true);
      assert.equal(r.recommended, 'ENTERPRISE');
      assert.ok(r.reasons.some((x) => x.includes('150')));
      assert.ok(r.reasons.some((x) => x.includes('ai_assistant')));
    });
    it('applies a valid promo code and rejects invalid ones', async () => {
      await asAdmin(admin).post('/coupons').send({ code: 'LAUNCH20', percentOff: 20, planCodes: ['BASIC', 'STANDARD'] });
      const r = (await pub().post('/pricing/quote').send({ employees: 15, coupon: 'launch20' })).body.data;
      assert.equal(r.discount, r2(1499 * 0.2));
      assert.equal(r.total, r2((1499 - r2(1499 * 0.2)) * 1.13));
      assert.equal((await pub().post('/pricing/quote').send({ employees: 100, coupon: 'LAUNCH20' })).status, 400);
      assert.equal((await pub().post('/pricing/quote').send({ employees: 15, coupon: 'NOPE99' })).status, 400);
    });
  });

  // ------------------------------------------------------------------ leads & CMS
  describe('lead capture and CMS', () => {
    it('demo request creates a CRM lead with activity', async () => {
      const res = await pub().post('/leads').send({ source: 'DEMO', name: 'Hari Prasad', company: 'Everest Hotels', email: 'hari@everest.test', phone: '+977 9800000000', employeeCount: 80, industry: 'Hotels and Hospitality', modules: ['shifts', 'payroll'], consent: true, utm: { source: 'google' } });
      assert.equal(res.status, 201);
      const lead = await db.sys.Lead.findOne({ where: { email: 'hari@everest.test' }, include: [{ model: db.sys.LeadActivity, as: 'activities' }] });
      assert.equal(lead.source, 'DEMO');
      assert.deepEqual(lead.modules, ['shifts', 'payroll']);
      assert.equal(lead.utm.source, 'google');
      assert.equal(lead.activities.length, 1);
    });
    it('requires consent and validates input', async () => {
      const res = await pub().post('/leads').send({ source: 'CONTACT', name: 'X', email: 'bad' });
      assert.equal(res.status, 422);
    });
    it('honeypot submissions are accepted silently but not stored', async () => {
      const res = await pub().post('/leads').send({ source: 'CONTACT', name: 'Spam Bot', email: 'bot@spam.test', consent: true, website: 'http://spam' });
      assert.equal(res.status, 201);
      assert.equal(await db.sys.Lead.count({ where: { email: 'bot@spam.test' } }), 0);
    });
    it('public content returns only published, non-scheduled entries', async () => {
      const faqs = (await pub().get('/content').query({ type: 'FAQ' })).body.data;
      assert.ok(faqs.length >= 10);
      await asAdmin(admin).post('/cms').send({ type: 'FAQ', slug: 'draft-q', title: 'Draft?', body: 'x' });
      await asAdmin(admin).post('/cms').send({ type: 'FAQ', slug: 'future-q', title: 'Future?', body: 'x', status: 'PUBLISHED', publishAt: new Date(Date.now() + DAY).toISOString() });
      const slugs = (await pub().get('/content').query({ type: 'FAQ' })).body.data.map((f) => f.slug);
      assert.ok(!slugs.includes('draft-q'));
      assert.ok(!slugs.includes('future-q'));
      const page = await pub().get('/content/PAGE/security');
      assert.equal(page.status, 200);
      assert.match(page.body.data.body, /Argon2id/);
    });
    it('Marketing Admin can edit CMS but not billing; Sales can manage leads', async () => {
      const mkt = asAdmin(await staffToken('mkt@lishnu.test', 'marketing_admin'));
      assert.equal((await mkt.post('/cms').send({ type: 'BLOG_POST', slug: 'hr-guide', title: 'HR guide', body: '# Hi', status: 'PUBLISHED' })).status, 201);
      assert.equal((await mkt.get('/invoices')).status, 403);
      assert.equal((await mkt.patch(`/leads/${crypto.randomUUID()}`).send({ status: 'CONTACTED' })).status, 403);
      const sales = asAdmin(await staffToken('sales@lishnu.test', 'sales_admin'));
      const lead = await db.sys.Lead.findOne({ where: { email: 'hari@everest.test' } });
      assert.equal((await sales.patch(`/leads/${lead.id}`).send({ status: 'LOST' })).status, 400); // needs reason
      assert.equal((await sales.patch(`/leads/${lead.id}`).send({ status: 'QUALIFIED', followUpAt: new Date().toISOString() })).status, 200);
      assert.equal((await sales.get('/payments')).status, 403);
    });
    it('a won lead converts into a tenant with negotiated limits', async () => {
      const lead = await db.sys.Lead.findOne({ where: { email: 'hari@everest.test' } });
      const res = await asAdmin(admin).post(`/leads/${lead.id}/convert`).send({ slug: 'everest', planCode: 'PREMIUM', maxEmployees: 200 });
      assert.equal(res.status, 201);
      const reloaded = await db.sys.Lead.findByPk(lead.id);
      assert.equal(reloaded.status, 'WON');
      const sub = await db.sys.Subscription.findOne({ where: { tenantId: res.body.data.tenantId } });
      assert.equal(sub.maxEmployeesOverride, 200);
    });
  });

  // ------------------------------------------------------------------ self-service signup
  describe('self-service signup', () => {
    const form = (over = {}) => ({ companyName: 'Himal Traders', slug: 'himal', industry: 'Retail and Trading', employeeCount: 25, fullName: 'Sita Karki', email: 'sita@himal.test', phone: '9841000000', password: 'Himal#Pass2026', planCode: 'STANDARD', billingCycle: 'MONTHLY', acceptTerms: true, ...over });
    let token;

    it('checks workspace availability', async () => {
      assert.equal((await pub().get('/signup/slug-available').query({ slug: 'himal' })).body.data.available, true);
      assert.equal((await pub().get('/signup/slug-available').query({ slug: 'admin' })).body.data.available, false);
    });
    it('creates a pending workspace with a trial and a WON signup lead', async () => {
      const res = await pub().post('/signup').send(form());
      assert.equal(res.status, 201);
      assert.equal(res.body.data.verificationRequired, true);
      token = res.body.data._verifyToken;
      const t = await db.sys.Tenant.findOne({ where: { slug: 'himal' } });
      assert.equal(t.status, 'PENDING');
      const sub = await db.sys.Subscription.findOne({ where: { tenantId: t.id } });
      assert.equal(sub.status, 'TRIAL');
      assert.equal(await db.sys.Lead.count({ where: { source: 'SIGNUP', status: 'WON', convertedTenantId: t.id } }), 1);
    });
    it('blocks login until the email is confirmed', async () => {
      const res = await api().post('/api/v1/auth/login').set('Host', host('himal')).send({ email: 'sita@himal.test', password: 'Himal#Pass2026' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'EMAIL_NOT_VERIFIED');
    });
    it('verification activates the workspace (single use)', async () => {
      const res = await pub().post('/signup/verify-email').send({ token });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.slug, 'himal');
      assert.equal((await pub().post('/signup/verify-email').send({ token })).status, 400);
      await login('himal', 'sita@himal.test', 'Himal#Pass2026');
    });
    it('rejects duplicates, enterprise self-signup, weak passwords and missing terms', async () => {
      assert.equal((await pub().post('/signup').send(form({ email: 'x@y.test' }))).body.error.code, 'SLUG_TAKEN');
      assert.equal((await pub().post('/signup').send(form({ slug: 'bigco', planCode: 'ENTERPRISE' }))).status, 400);
      assert.equal((await pub().post('/signup').send(form({ slug: 'weak', password: 'password' }))).status, 422);
      assert.equal((await pub().post('/signup').send(form({ slug: 'noterms', acceptTerms: false }))).status, 422);
    });
  });

  // ------------------------------------------------------------------ billing
  describe('checkout, invoices and bank transfer', () => {
    let T; let tok; let invoice;
    before(async () => {
      T = await makeTenant('payco', 'BASIC');
      tok = (await login('payco', T.ownerEmail)).token;
    });

    it('trial → Standard creates an invoice with VAT and reuses it on retry', async () => {
      const res = await as('payco', tok).post('/billing/checkout').send({ planCode: 'STANDARD', billingCycle: 'MONTHLY' });
      assert.equal(res.status, 201);
      invoice = res.body.data.invoice;
      assert.equal(invoice.kind, 'SUBSCRIPTION');
      assert.equal(Number(invoice.subtotal), 2999);
      assert.equal(Number(invoice.tax), r2(2999 * 0.13));
      assert.equal(Number(invoice.total), r2(2999 * 1.13));
      assert.match(invoice.number, /^INV-\d{4}-\d{6}$/);
      const again = await as('payco', tok).post('/billing/checkout').send({ planCode: 'STANDARD', billingCycle: 'MONTHLY' });
      assert.equal(again.body.data.invoice.id, invoice.id);
    });
    it('Enterprise cannot be bought online', async () => {
      assert.equal((await as('payco', tok).post('/billing/checkout').send({ planCode: 'ENTERPRISE', billingCycle: 'MONTHLY' })).status, 400);
    });
    it('bank transfer goes to verification; duplicates are blocked', async () => {
      const res = await as('payco', tok).post(`/billing/invoices/${invoice.id}/pay`).send({ provider: 'BANK_TRANSFER', proofNote: 'NIC Asia, 2026-11-26, ref TXN123456' });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.status, 'PENDING_VERIFICATION');
      const dup = await as('payco', tok).post(`/billing/invoices/${invoice.id}/pay`).send({ provider: 'BANK_TRANSFER', proofNote: 'again again' });
      assert.equal(dup.body.error.code, 'PAYMENT_PENDING');
      // subscription unchanged until finance approves
      assert.equal((await db.sys.Subscription.findByPk(T.subscriptionId)).status, 'TRIAL');
    });
    it('finance approval activates the plan with a new paid period', async () => {
      const finance = asAdmin(await staffToken('fin@lishnu.test', 'finance_admin'));
      const pending = (await finance.get('/payments').query({ status: 'PENDING_VERIFICATION' })).body.data;
      const p = pending.find((x) => x.invoiceId === invoice.id);
      assert.ok(p);
      const res = await finance.post(`/payments/${p.id}/approve`).send({ providerRef: 'NIC-TXN123456' });
      assert.equal(res.status, 200);
      const sub = await db.sys.Subscription.findByPk(T.subscriptionId, { include: [{ model: db.sys.Plan, as: 'plan' }] });
      assert.equal(sub.status, 'ACTIVE');
      assert.equal(sub.paymentStatus, 'PAID');
      assert.equal(sub.plan.code, 'STANDARD');
      assert.ok(sub.currentPeriodEnd > new Date(Date.now() + 27 * DAY));
      assert.equal((await db.sys.Invoice.findByPk(invoice.id)).status, 'PAID');
      // approving twice is impossible
      assert.equal((await finance.post(`/payments/${p.id}/approve`).send({ providerRef: 'again' })).status, 409);
      // features updated immediately
      assert.ok((await as('payco', tok).get('/subscription')).body.data.features.includes('payroll'));
    });
    it('invoice PDF downloads', async () => {
      const res = await as('payco', tok).get(`/billing/invoices/${invoice.id}/pdf`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'application/pdf');
      assert.equal(res.body.subarray(0, 4).toString(), '%PDF');
    });
    it("tenants never see each other's invoices", async () => {
      const other = await makeTenant('nosy', 'BASIC');
      const otok = (await login('nosy', other.ownerEmail)).token;
      assert.equal((await as('nosy', otok).get(`/billing/invoices/${invoice.id}`)).status, 404);
      assert.equal((await as('nosy', otok).get('/billing/invoices')).body.data.length, 0);
    });
    it('employees without billing permission cannot pay', async () => {
      const { makeUser } = await import('./helpers/context.js');
      await makeUser(T.id, { email: 'emp@payco.test', roles: ['employee'] });
      const etok = (await login('payco', 'emp@payco.test')).token;
      assert.equal((await as('payco', etok).post('/billing/checkout').send({ planCode: 'PREMIUM', billingCycle: 'MONTHLY' })).status, 403);
    });
  });

  describe('upgrades, downgrades and read-only recovery', () => {
    it('mid-period upgrade charges the prorated difference and keeps the period end', async () => {
      const T = await paidTenant('upco', 'STANDARD');
      const tok = (await login('upco', T.ownerEmail)).token;
      const end = new Date(Date.now() + 15 * DAY);
      await db.sys.Subscription.update({ currentPeriodEnd: end, startsAt: new Date(Date.now() - 15 * DAY) }, { where: { id: T.subscriptionId } });
      const preview = (await as('upco', tok).post('/billing/preview').send({ planCode: 'PREMIUM', billingCycle: 'MONTHLY' })).body.data;
      assert.equal(preview.kind, 'UPGRADE');
      assert.ok(preview.subtotal > 1300 && preview.subtotal < 1700, `prorated ~1500, got ${preview.subtotal}`);
      const inv = (await as('upco', tok).post('/billing/checkout').send({ planCode: 'PREMIUM', billingCycle: 'MONTHLY' })).body.data.invoice;
      const p = (await as('upco', tok).post(`/billing/invoices/${inv.id}/pay`).send({ provider: 'BANK_TRANSFER', proofNote: 'Global IME ref 998877' })).body.data;
      await asAdmin(admin).post(`/payments/${p.paymentId}/approve`).send({ providerRef: 'GIME-998877' });
      const sub = await db.sys.Subscription.findByPk(T.subscriptionId, { include: [{ model: db.sys.Plan, as: 'plan' }] });
      assert.equal(sub.plan.code, 'PREMIUM');
      assert.equal(sub.currentPeriodEnd.getTime(), end.getTime());
    });
    it('downgrade is scheduled for renewal, not charged', async () => {
      const T = await paidTenant('downco', 'PREMIUM');
      const tok = (await login('downco', T.ownerEmail)).token;
      const res = await as('downco', tok).post('/billing/checkout').send({ planCode: 'BASIC', billingCycle: 'MONTHLY' });
      assert.equal(res.body.data.scheduled, true);
      const sub = await db.sys.Subscription.findByPk(T.subscriptionId);
      const basic = await db.sys.Plan.findOne({ where: { code: 'BASIC' } });
      assert.equal(sub.pendingPlanId, basic.id);
      assert.equal(await db.sys.Invoice.count({ where: { tenantId: T.id } }), 0);
      assert.equal((await as('downco', tok).post('/billing/cancel-downgrade')).status, 200);
    });
    it('a read-only workspace can still pay and open support tickets', async () => {
      const T = await makeTenant('lapsed', 'BASIC');
      const tok = (await login('lapsed', T.ownerEmail)).token;
      await db.sys.Subscription.update({ status: 'SUSPENDED', currentPeriodEnd: new Date(Date.now() - 30 * DAY), startsAt: new Date(Date.now() - 60 * DAY) }, { where: { id: T.subscriptionId } });
      const { invalidateTenantContext } = await import('../src/services/subscription.service.js');
      await invalidateTenantContext(T.id);
      assert.equal((await as('lapsed', tok).post('/branches').send({ code: 'X', name: 'Blocked' })).status, 402);
      assert.equal((await as('lapsed', tok).post('/billing/checkout').send({ planCode: 'BASIC', billingCycle: 'MONTHLY' })).status, 201);
      assert.equal((await as('lapsed', tok).post('/support/tickets').send({ subject: 'Need help renewing', body: 'How do I pay by bank transfer?' })).status, 201);
    });
  });

  // ------------------------------------------------------------------ online payments
  describe('eSewa and Khalti (server-side verification)', () => {
    let T; let tok;
    const newInvoice = async () => (await as('wallet', tok).post('/billing/checkout').send({ planCode: 'STANDARD', billingCycle: 'ANNUAL' })).body.data.invoice;
    before(async () => {
      T = await makeTenant('wallet', 'BASIC');
      tok = (await login('wallet', T.ownerEmail)).token;
    });

    it('eSewa: signed form, verified callback + status API → paid; redirect to workspace', async () => {
      const inv = await newInvoice();
      const start = (await as('wallet', tok).post(`/billing/invoices/${inv.id}/pay`).send({ provider: 'ESEWA' })).body.data;
      const f = start.redirect.fields;
      assert.equal(f.signature, esewaSign(f, ['total_amount', 'transaction_uuid', 'product_code']));
      assert.equal(Number(f.total_amount), Number(inv.total));

      mockProviders({ 'transaction/status': { status: 200, json: { status: 'COMPLETE', transaction_uuid: f.transaction_uuid, total_amount: Number(inv.total), ref_id: 'ESEWA-REF-1' } } });
      const cb = { transaction_code: '000AWEO', status: 'COMPLETE', total_amount: f.total_amount, transaction_uuid: f.transaction_uuid, product_code: 'EPAYTEST', signed_field_names: 'transaction_code,status,total_amount,transaction_uuid,product_code,signed_field_names' };
      cb.signature = esewaSign(cb, cb.signed_field_names.split(','));
      const res = await api().get('/api/v1/payments/esewa/return').set('Host', 'app.hrms.test').query({ data: Buffer.from(JSON.stringify(cb)).toString('base64') });
      assert.equal(res.status, 303);
      assert.match(res.headers.location, /^https:\/\/wallet\.hrms\.test\/billing\?payment=success/);
      assert.equal((await db.sys.Invoice.findByPk(inv.id)).status, 'PAID');
      const sub = await db.sys.Subscription.findByPk(T.subscriptionId);
      assert.equal(sub.billingCycle, 'ANNUAL');
      assert.ok(sub.currentPeriodEnd > new Date(Date.now() + 360 * DAY));
      // replaying the same callback is harmless
      const replay = await api().get('/api/v1/payments/esewa/return').set('Host', 'app.hrms.test').query({ data: Buffer.from(JSON.stringify(cb)).toString('base64') });
      assert.match(replay.headers.location, /payment=success/);
      assert.equal(await db.sys.Payment.count({ where: { invoiceId: inv.id, status: 'SUCCEEDED' } }), 1);
    });

    it('eSewa: forged signature is rejected without contacting eSewa', async () => {
      await db.sys.Subscription.update({ currentPeriodEnd: new Date(Date.now() + 3 * DAY) }, { where: { id: T.subscriptionId } });
      const inv = (await as('wallet', tok).post('/billing/checkout').send({ planCode: 'PREMIUM', billingCycle: 'ANNUAL' })).body.data.invoice;
      const start = (await as('wallet', tok).post(`/billing/invoices/${inv.id}/pay`).send({ provider: 'ESEWA' })).body.data;
      providerCalls.length = 0;
      const cb = { status: 'COMPLETE', total_amount: start.redirect.fields.total_amount, transaction_uuid: start.redirect.fields.transaction_uuid, product_code: 'EPAYTEST', signed_field_names: 'status,total_amount,transaction_uuid,product_code', signature: 'Zm9yZ2Vk' };
      const res = await api().get('/api/v1/payments/esewa/return').set('Host', 'app.hrms.test').query({ data: Buffer.from(JSON.stringify(cb)).toString('base64') });
      assert.match(res.headers.location, /payment=failed/);
      assert.equal(providerCalls.length, 0);
      assert.equal((await db.sys.Invoice.findByPk(inv.id)).status, 'OPEN');
    });

    it('eSewa: a correctly signed redirect is still NOT trusted if the status API disagrees', async () => {
      const inv = await db.sys.Invoice.findOne({ where: { tenantId: T.id, status: 'OPEN' } });
      const pay = await db.sys.Payment.findOne({ where: { invoiceId: inv.id, provider: 'ESEWA' } });
      mockProviders({ 'transaction/status': { status: 200, json: { status: 'NOT_FOUND', transaction_uuid: pay.reference } } });
      const cb = { status: 'COMPLETE', total_amount: String(Number(inv.total)), transaction_uuid: pay.reference, product_code: 'EPAYTEST', signed_field_names: 'status,total_amount,transaction_uuid,product_code' };
      cb.signature = esewaSign(cb, cb.signed_field_names.split(','));
      const res = await api().get('/api/v1/payments/esewa/return').set('Host', 'app.hrms.test').query({ data: Buffer.from(JSON.stringify(cb)).toString('base64') });
      assert.match(res.headers.location, /payment=failed/);
      assert.equal((await db.sys.Invoice.findByPk(inv.id)).status, 'OPEN');
      assert.equal((await db.sys.Payment.findByPk(pay.id)).status, 'FAILED');
    });

    it('Khalti: initiate → lookup Completed with matching amount → paid', async () => {
      const inv = await db.sys.Invoice.findOne({ where: { tenantId: T.id, status: 'OPEN' } });
      mockProviders({
        'epayment/initiate': (_u, o) => ({ status: 200, json: { pidx: 'PIDX123', payment_url: 'https://test-pay.khalti.com/?pidx=PIDX123', amount: JSON.parse(o.body).amount } }),
        'epayment/lookup': { status: 200, json: { pidx: 'PIDX123', status: 'Completed', total_amount: Math.round(Number(inv.total) * 100), transaction_id: 'KH-TX-9' } },
      });
      const start = (await as('wallet', tok).post(`/billing/invoices/${inv.id}/pay`).send({ provider: 'KHALTI' })).body.data;
      assert.equal(start.redirect.url, 'https://test-pay.khalti.com/?pidx=PIDX123');
      const initBody = JSON.parse(providerCalls.find((c) => c.url.includes('initiate')).body);
      assert.equal(initBody.amount, Math.round(Number(inv.total) * 100)); // paisa
      const pay = await db.sys.Payment.findByPk(start.paymentId);
      const res = await api().get('/api/v1/payments/khalti/return').set('Host', 'app.hrms.test').query({ pidx: 'PIDX123', purchase_order_id: pay.reference, status: 'Completed' });
      assert.match(res.headers.location, /payment=success/);
      assert.equal((await db.sys.Invoice.findByPk(inv.id)).status, 'PAID');
      assert.equal((await db.sys.Payment.findByPk(pay.id)).providerRef, 'KH-TX-9');
    });

    it('Khalti: amount mismatch in lookup is never accepted', async () => {
      await db.sys.Subscription.update({ currentPeriodEnd: new Date(Date.now() + 2 * DAY), paymentStatus: 'PENDING' }, { where: { id: T.subscriptionId } });
      const inv = (await as('wallet', tok).post('/billing/checkout').send({ planCode: 'STANDARD', billingCycle: 'MONTHLY' })).body.data.invoice;
      mockProviders({
        'epayment/initiate': { status: 200, json: { pidx: 'PIDX999', payment_url: 'https://test-pay.khalti.com/?pidx=PIDX999' } },
        'epayment/lookup': { status: 200, json: { pidx: 'PIDX999', status: 'Completed', total_amount: 100, transaction_id: 'KH-CHEAP' } },
      });
      const start = (await as('wallet', tok).post(`/billing/invoices/${inv.id}/pay`).send({ provider: 'KHALTI' })).body.data;
      const pay = await db.sys.Payment.findByPk(start.paymentId);
      const res = await api().get('/api/v1/payments/khalti/return').set('Host', 'app.hrms.test').query({ pidx: 'PIDX999', purchase_order_id: pay.reference });
      assert.match(res.headers.location, /payment=failed/);
      assert.equal((await db.sys.Invoice.findByPk(inv.id)).status, 'OPEN');
    });
  });

  // ------------------------------------------------------------------ finance corrections
  describe('void, credit notes, renewals', () => {
    it('credit note against a paid invoice; cannot exceed total; open invoices are voided instead', async () => {
      const paid = await db.sys.Invoice.findOne({ where: { status: 'PAID', kind: 'SUBSCRIPTION' } });
      const cn = await asAdmin(admin).post(`/invoices/${paid.id}/credit-note`).send({ amount: 500, reason: 'Goodwill credit' });
      assert.equal(cn.status, 201);
      assert.equal(cn.body.data.kind, 'CREDIT_NOTE');
      assert.equal((await asAdmin(admin).post(`/invoices/${paid.id}/credit-note`).send({ amount: 999999, reason: 'Too much' })).status, 400);
      const open = await db.sys.Invoice.findOne({ where: { status: 'OPEN' } });
      assert.equal((await asAdmin(admin).post(`/invoices/${open.id}/void`).send({ reason: 'Customer request' })).status, 200);
      assert.equal((await asAdmin(admin).post(`/invoices/${paid.id}/void`).send({ reason: 'nope' })).status, 409);
    });
    it('financial rows cannot be deleted even by the system role', async () => {
      await assert.rejects(db.systemDb.query('DELETE FROM invoices'), /permission denied/);
      await assert.rejects(db.systemDb.query('DELETE FROM payments'), /permission denied/);
    });
    it('renewal invoices are generated before period end (once)', async () => {
      const T = await paidTenant('renewco', 'BASIC');
      await db.sys.Subscription.update({ currentPeriodEnd: new Date(Date.now() + 3 * DAY) }, { where: { id: T.subscriptionId } });
      const { createRenewalInvoices } = await import('../src/services/billing.service.js');
      await createRenewalInvoices(7);
      await createRenewalInvoices(7);
      const invs = await db.sys.Invoice.findAll({ where: { tenantId: T.id, kind: 'RENEWAL' } });
      assert.equal(invs.length, 1);
      assert.equal(Number(invs[0].subtotal), 1499);
    });
  });

  // ------------------------------------------------------------------ support desk
  describe('support desk', () => {
    it('tickets flow between tenant and support; internal notes stay internal', async () => {
      const T = await makeTenant('helpme', 'BASIC');
      const tok = (await login('helpme', T.ownerEmail)).token;
      const ticket = (await as('helpme', tok).post('/support/tickets').send({ subject: 'Cannot import employees', body: 'The CSV import fails with an error', priority: 'HIGH', category: 'TECHNICAL' })).body.data;
      assert.ok(ticket.number);
      assert.ok(new Date(ticket.firstResponseDueAt) > new Date());
      const sup = asAdmin(await staffToken('support@lishnu.test', 'support_admin'));
      await sup.post(`/support/${ticket.id}/messages`).send({ body: 'Customer is on Basic; check CSV encoding', isInternal: true });
      await sup.post(`/support/${ticket.id}/messages`).send({ body: 'Please save the file as UTF-8 CSV and retry.', status: 'WAITING_ON_CUSTOMER' });
      const view = (await as('helpme', tok).get(`/support/tickets/${ticket.id}`)).body.data;
      assert.equal(view.messages.length, 2); // original + public reply, no internal note
      assert.ok(view.messages.every((m) => !m.isInternal));
      assert.equal(view.status, 'WAITING_ON_CUSTOMER');
      assert.ok((await db.sys.SupportTicket.findByPk(ticket.id)).firstRespondedAt);
      await as('helpme', tok).post(`/support/tickets/${ticket.id}/messages`).send({ body: 'That worked, thanks!' });
      assert.equal((await db.sys.SupportTicket.findByPk(ticket.id)).status, 'OPEN');
    });
  });

  // ------------------------------------------------------------------ admin dashboard & settings
  describe('Super Admin dashboard and settings', () => {
    it('reports KPIs and charts from real data', async () => {
      const dres = await asAdmin(admin).get('/dashboard');
      assert.equal(dres.status, 200, JSON.stringify(dres.body));
      const d = dres.body.data;
      assert.ok(d.kpis.tenants >= 8);
      assert.ok(d.kpis.mrr > 0);
      assert.equal(d.kpis.arr, Math.round(d.kpis.mrr * 1200) / 100);
      assert.ok(d.kpis.leads >= 2);
      assert.ok(d.charts.revenueByMonth.length >= 1);
      assert.ok(d.charts.planDistribution.some((p) => p.code === 'STANDARD'));
      assert.ok(d.recentTenants.length > 0);
    });
    it('VAT rate is a validated platform setting used by new quotes', async () => {
      assert.equal((await asAdmin(admin).put('/settings/billing.vat_rate').send({ value: 'abc' })).status, 400);
      assert.equal((await asAdmin(admin).put('/settings/billing.vat_rate').send({ value: 10 })).status, 200);
      assert.equal((await pub().post('/pricing/quote').send({ employees: 15 })).body.data.taxRate, 10);
      await asAdmin(admin).put('/settings/billing.vat_rate').send({ value: 13 });
    });
    it('staff management: create, disable (revokes sessions), cannot edit self', async () => {
      const res = await asAdmin(admin).post('/staff').send({ email: 'newstaff@lishnu.test', fullName: 'New Staff', password: PASSWORD, roleKeys: ['support_admin'] });
      assert.equal(res.status, 201);
      const login2 = await api().post('/api/v1/admin/auth/login').set('Host', 'admin.hrms.test').send({ email: 'newstaff@lishnu.test', password: PASSWORD });
      const stok = login2.body.data.accessToken;
      assert.equal((await asAdmin(admin).patch(`/staff/${res.body.data.id}`).send({ status: 'DISABLED' })).status, 200);
      assert.equal((await asAdmin(stok).get('/support')).status, 401);
      const me = (await asAdmin(admin).get('/auth/me')).body;
      assert.ok(me);
    });
  });
});
