// Browser check for the marketing website, run by .github/workflows/ui-check.yml.
// Opens the main pages at desktop size and at 390 px, scrolls through them so scroll animations play,
// takes screenshots (mk-*.jpg) and records console errors, failed requests and horizontal overflow.
// Usage: node marketing-screens.mjs <playwright-core dir> <out dir>
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [pwDir, outDir] = process.argv.slice(2);
const { chromium } = await import(join(pwDir, 'node_modules/playwright-core/index.mjs'));
const BASE = process.env.SITE_URL ?? 'http://localhost:4176';
mkdirSync(outDir, { recursive: true });
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const PAGES = [['home', '/'], ['pricing', '/pricing/'], ['features', '/features/'], ['feature-recruitment', '/features/recruitment/']];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let failed = 0;
for (const [vp, size] of Object.entries(VIEWPORTS)) {
  const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  for (const [name, path] of PAGES) {
    const page = await ctx.newPage();
    const issues = [];
    page.on('console', (m) => { if (m.type() === 'error') issues.push(`console: ${m.text().slice(0, 200)}`); });
    page.on('pageerror', (e) => issues.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on('response', (r) => { if (r.status() >= 400) issues.push(`HTTP ${r.status()} ${r.url()}`); });
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(outDir, `mk-${vp}-${name}-top.jpg`), type: 'jpeg', quality: 70 });
    if (name === 'home' && vp === 'desktop') {
      // The mega menus, opened by hovering like a visitor would.
      for (const label of ['Product', 'Industries']) {
        await page.getByRole('button', { name: label }).hover();
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(outDir, `mk-${vp}-menu-${label.toLowerCase()}.jpg`), type: 'jpeg', quality: 75 });
        const box = await page.evaluate(() => { const el = document.querySelector('.menu-in'); return el ? el.getBoundingClientRect().bottom : 0; });
        if (box > size.height) issues.push(`${label} menu runs past the bottom of the screen (${Math.round(box)} > ${size.height})`);
        await page.mouse.move(5, size.height - 5);
        await page.waitForTimeout(300);
      }
    }
    if (name === 'home') {
      // Catch the pricing cards mid-animation, to show the count-up is happening.
      await page.locator('text=Plans for 5 people or 500').scrollIntoViewIfNeeded();
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(outDir, `mk-${vp}-${name}-pricing-mid.jpg`), type: 'jpeg', quality: 70 });
    }
    // Scroll to the bottom in steps so every reveal fires, then back to the top for the full-page shot.
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += Math.round(size.height * 0.6)) { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(160); }
    await page.waitForTimeout(1400);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, vw: window.innerWidth,
      hidden: document.querySelectorAll('.reveal-wait').length,
    }));
    if (m.sw > m.vw) issues.push(`horizontal overflow: ${m.sw} > ${m.vw}`);
    if (m.hidden) issues.push(`${m.hidden} elements still hidden by the scroll reveal after scrolling`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `mk-${vp}-${name}.jpg`), fullPage: true, type: 'jpeg', quality: 70 });
    console.log(`${issues.length ? 'ISSUES' : 'ok    '} ${vp.padEnd(7)} ${name}${issues.length ? `\n         ${issues.join('\n         ')}` : ''}`);
    if (issues.length) failed += 1;
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(`marketing: ${failed} page(s) with issues`);
if (failed) process.exitCode = 1;
