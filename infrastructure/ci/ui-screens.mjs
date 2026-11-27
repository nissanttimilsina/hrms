// Browser check for the company app, run by .github/workflows/ui-check.yml.
// Signs in as each demo user, opens every page at desktop size and at 390 px, takes full-page
// screenshots, and records console errors, failed API calls and horizontal overflow.
// Usage: node ui-screens.mjs <playwright-core dir> <fixtures.json> <out dir>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [pwDir, fixturesFile, outDir] = process.argv.slice(2);
const { chromium } = await import(join(pwDir, 'node_modules/playwright-core/index.mjs'));
const fx = JSON.parse(readFileSync(fixturesFile, 'utf8'));
const BASE = process.env.APP_URL ?? 'http://localhost:4175';
mkdirSync(outDir, { recursive: true });

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
// [user or null for signed out, name, path, optional action after load]
const clickText = (text) => async (page) => { await page.getByRole('button', { name: text }).first().click(); await page.waitForTimeout(600); };
const PAGES = [
  ['sita', 'dashboard', '/'],
  ['sita', 'my-expenses', '/me/expenses'],
  ['sita', 'my-expenses-new', '/me/expenses', clickText('New claim')],
  ['sita', 'my-expense-detail', `/me/expenses/${fx.taxiId}`],
  ['sita', 'my-letters', '/me/letters'],
  ['sita', 'my-letters-request', '/me/letters', async (page) => { await clickText('Request a letter')(page); await page.getByRole('radio').first().click(); await page.waitForTimeout(300); }],
  ['sita', 'my-tax', '/me/tax'],
  ['sita', 'my-payslips', '/me/payslips'],
  ['sita', 'my-attendance', '/me/attendance'],
  ['ram', 'expenses-manager-queue', '/expenses'],
  ['ram', 'expense-manager-detail', `/expenses/${fx.hotelId}`],
  ['finance', 'expenses-finance-queue', '/expenses'],
  ['finance', 'expenses-finance-all', '/expenses', async (page) => { await page.getByRole('tab', { name: 'All claims' }).click(); await page.waitForTimeout(800); }],
  ['finance', 'expense-finance-pay', `/expenses/${fx.taxiId}`],
  ['finance', 'expense-finance-approve', `/expenses/${fx.hotelId}`, clickText('Approve')],
  ['finance', 'expense-settings', '/expenses/settings'],
  ['hr', 'letters-pending', '/letters'],
  ['hr', 'letters-issue-dialog', '/letters', clickText('Review and issue')],
  ['hr', 'letters-letterhead', '/letters', clickText('Letterhead')],
  ['hr', 'letters-all', '/letters', async (page) => { await page.getByLabel('Status').selectOption(''); await page.waitForTimeout(800); }],
  [null, 'verify-valid', `/verify/${fx.verifyCode}`],
  [null, 'verify-unknown', '/verify/AAAA-BBBB-CCCC'],
  ['sita', 'verify-signed-in', `/verify/${fx.verifyCode}`],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [];
for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  const contexts = {};
  const ctxFor = async (user) => {
    const k = user ?? 'anon';
    if (contexts[k]) return contexts[k];
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, timezoneId: 'Asia/Kathmandu', locale: 'en-GB' });
    if (user) {
      const p = await ctx.newPage();
      await p.goto(`${BASE}/`);
      await p.getByLabel('Email').fill(`${user}@demo.test`);
      await p.getByLabel('Password').fill(fx.password);
      await p.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForFunction(() => !document.querySelector('input[type=password]'), null, { timeout: 15000 });
      await p.waitForLoadState('networkidle');
      await p.close();
    }
    contexts[k] = ctx;
    return ctx;
  };
  for (const [user, name, path, action] of PAGES) {
    const ctx = await ctxFor(user);
    const page = await ctx.newPage();
    const issues = [];
    page.on('console', (m) => { if (m.type() === 'error') issues.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => issues.push(`pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) issues.push(`api ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      if (action) await action(page);
    } catch (e) { issues.push(`step failed: ${e.message.split('\n')[0]}`); }
    const m = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= vw + 1) return false;
        for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return false; }
        return true;
      }).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)} right=${Math.round(el.getBoundingClientRect().right)}`);
      return { scrollWidth: document.documentElement.scrollWidth, vw, wide, h1: document.querySelector('h1')?.textContent ?? null };
    });
    const expected = (x) => (!user && /401|Unauthorized/.test(x)) || (name === 'verify-unknown' && /404|Not Found/.test(x));
    issues.splice(0, issues.length, ...issues.filter((x) => !expected(x)));
    if (m.scrollWidth > m.vw) issues.push(`horizontal overflow: scrollWidth ${m.scrollWidth} > ${m.vw}`);
    const file = `${vpName}-${name}.jpg`;
    await page.screenshot({ path: join(outDir, file), fullPage: true, type: 'jpeg', quality: 70 });
    report.push({ viewport: vpName, user, name, path, file, h1: m.h1, overflowing: m.wide, issues });
    console.log(`${issues.length ? 'ISSUES' : 'ok    '} ${vpName.padEnd(7)} ${name}${issues.length ? `\n         ${issues.join('\n         ')}` : ''}${m.wide.length ? `\n         wide: ${m.wide.join(' | ')}` : ''}`);
    await page.close();
  }
  await Promise.all(Object.values(contexts).map((c) => c.close()));
}
await browser.close();
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
