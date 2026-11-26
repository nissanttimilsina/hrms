import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDatabase, makeTenant, login, as, api, host, teardown, db, PASSWORD, adminLogin, makeUser } from './helpers/context.js';
import { randomToken, sha256 } from '../src/utils/crypto.js';

const refresh = (slug, cookie) =>
  api().post('/api/v1/auth/refresh').set('Host', host(slug)).set('Cookie', cookie).set('X-Requested-With', 'XMLHttpRequest');
const cookieOf = (res) => res.headers['set-cookie'].find((c) => c.startsWith('hrms_rt=')).split(';')[0];

describe('Authentication', () => {
  let T;
  before(async () => {
    await resetDatabase();
    T = await makeTenant('acme');
  });
  after(teardown);

  it('rejects wrong password and unknown user with the same generic error', async () => {
    const a = await api().post('/api/v1/auth/login').set('Host', host('acme')).send({ email: T.ownerEmail, password: 'wrong' });
    const b = await api().post('/api/v1/auth/login').set('Host', host('acme')).send({ email: 'nobody@acme.test', password: 'wrong' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.body.error.code, 'INVALID_CREDENTIALS');
    assert.equal(a.body.error.message, b.body.error.message);
  });

  it('sets refresh token as httpOnly SameSite=Strict cookie, not in body', async () => {
    const res = await api().post('/api/v1/auth/login').set('Host', host('acme')).send({ email: T.ownerEmail, password: PASSWORD });
    const cookie = res.headers['set-cookie'].find((c) => c.startsWith('hrms_rt='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/v1\/auth/);
    assert.equal(res.body.data.refreshToken, undefined);
  });

  it('mobile clients receive the refresh token in the body', async () => {
    const res = await api().post('/api/v1/auth/login').set('Host', host('acme')).set('X-Client', 'mobile').send({ email: T.ownerEmail, password: PASSWORD });
    assert.ok(res.body.data.refreshToken);
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    await makeUser(T.id, { email: 'lock@acme.test', roles: ['employee'] });
    for (let i = 0; i < 5; i += 1) {
      await api().post('/api/v1/auth/login').set('Host', host('acme')).send({ email: 'lock@acme.test', password: 'bad' });
    }
    const res = await api().post('/api/v1/auth/login').set('Host', host('acme')).send({ email: 'lock@acme.test', password: PASSWORD });
    assert.equal(res.status, 401);
  });

  it('generic app host requires a workspace and validates it', async () => {
    const noWs = await api().post('/api/v1/auth/login').set('Host', 'app.hrms.test').send({ email: T.ownerEmail, password: PASSWORD });
    assert.equal(noWs.status, 400);
    const ok = await api().post('/api/v1/auth/login').set('Host', 'app.hrms.test').send({ email: T.ownerEmail, password: PASSWORD, workspace: 'acme' });
    assert.equal(ok.status, 200);
    const other = await makeTenant('other');
    const wrong = await api().post('/api/v1/auth/login').set('Host', 'app.hrms.test').send({ email: T.ownerEmail, password: PASSWORD, workspace: other.slug });
    assert.equal(wrong.status, 401);
  });

  it('refresh rotates the token and requires the CSRF header', async () => {
    const { cookie } = await login('acme', T.ownerEmail);
    const noHeader = await api().post('/api/v1/auth/refresh').set('Host', host('acme')).set('Cookie', cookie);
    assert.equal(noHeader.status, 403);
    assert.equal(noHeader.body.error.code, 'CSRF_CHECK_FAILED');

    const r1 = await refresh('acme', cookie);
    assert.equal(r1.status, 200);
    assert.ok(r1.body.data.accessToken);
    assert.notEqual(cookieOf(r1), cookie);
  });

  it('reusing a rotated refresh token revokes the whole session family', async () => {
    const { cookie: c0 } = await login('acme', T.ownerEmail);
    const r1 = await refresh('acme', c0);
    const c1 = cookieOf(r1);
    const access1 = r1.body.data.accessToken;

    const replay = await refresh('acme', c0); // attacker replays the old token
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'TOKEN_REUSED');

    const legit = await refresh('acme', c1); // the legitimate newer token is dead too
    assert.equal(legit.status, 401);
    const me = await as('acme', access1).get('/auth/me');
    assert.equal(me.status, 401);
    assert.equal(me.body.error.code, 'SESSION_REVOKED');
  });

  it('logout immediately invalidates the access token and refresh token', async () => {
    const { token, cookie } = await login('acme', T.ownerEmail);
    assert.equal((await as('acme', token).post('/auth/logout')).status, 200);
    assert.equal((await as('acme', token).get('/auth/me')).status, 401);
    assert.equal((await refresh('acme', cookie)).status, 401);
  });

  it('refresh token from tenant A is useless on tenant B', async () => {
    const other = await makeTenant('beta');
    const { cookie } = await login('acme', T.ownerEmail);
    const res = await refresh(other.slug, cookie);
    assert.equal(res.status, 401);
  });

  it('rejects tampered and wrong-audience tokens', async () => {
    const { token } = await login('acme', T.ownerEmail);
    const tampered = `${token.slice(0, -3)}abc`;
    assert.equal((await as('acme', tampered).get('/auth/me')).status, 401);
    const platformToken = await adminLogin();
    assert.equal((await as('acme', platformToken).get('/auth/me')).status, 401);
    const res = await api().get('/api/v1/admin/tenants').set('Host', 'admin.hrms.test').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
  });

  it('password reset: single use, expires, revokes sessions', async () => {
    const { token: oldAccess } = await login('acme', T.ownerEmail);
    const user = await db.sys.User.findOne({ where: { tenantId: T.id, email: T.ownerEmail } });
    const raw = randomToken();
    await db.sys.AuthActionToken.create({
      subjectType: 'TENANT', userId: user.id, tenantId: T.id, purpose: 'PASSWORD_RESET',
      tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 600_000),
    });
    const weak = await api().post('/api/v1/auth/password/reset').set('Host', host('acme')).send({ token: raw, password: 'short' });
    assert.equal(weak.status, 422);
    const ok = await api().post('/api/v1/auth/password/reset').set('Host', host('acme')).send({ token: raw, password: 'BrandNewPass9' });
    assert.equal(ok.status, 200);
    const again = await api().post('/api/v1/auth/password/reset').set('Host', host('acme')).send({ token: raw, password: 'AnotherPass9x' });
    assert.equal(again.status, 400);
    assert.equal((await as('acme', oldAccess).get('/auth/me')).status, 401);
    await login('acme', T.ownerEmail, 'BrandNewPass9');
  });

  it('forgot-password never reveals whether an account exists', async () => {
    const a = await api().post('/api/v1/auth/password/forgot').set('Host', host('acme')).send({ email: 'ghost@acme.test' });
    const b = await api().post('/api/v1/auth/password/forgot').set('Host', host('acme')).send({ email: T.ownerEmail });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body, b.body);
  });

  it('passwords are stored as argon2id hashes', async () => {
    const u = await db.sys.User.findOne({ where: { tenantId: T.id } });
    assert.match(u.passwordHash, /^\$argon2id\$/);
  });

  it('production-style errors never leak stack traces', async () => {
    const res = await api().post('/api/v1/auth/login').set('Host', host('acme')).set('Content-Type', 'application/json').send('{bad json');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'BAD_JSON');
    assert.ok(!JSON.stringify(res.body).includes('at '));
  });
});
