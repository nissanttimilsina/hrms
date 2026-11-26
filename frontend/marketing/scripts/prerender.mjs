/**
 * Prerender every static marketing route to HTML for fast first paint and SEO.
 * Dynamic data (live prices, CMS lists) hydrates in the browser.
 * Also writes sitemap.xml.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const template = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
// Empty SPA shell for routes that are not prerendered (nginx falls back to it).
fs.writeFileSync(path.join(dist, '_shell.html'), template.replace('<!--head-->', '').replace('<!--app-->', ''));
const { render, routes } = await import(pathToFileURL(path.join(root, 'dist-ssr', 'entry-server.js')).href);
const site = process.env.VITE_SITE_URL || 'https://www.yourhrms.com';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

for (const url of routes) {
  const { html, head } = render(url);
  const tags = [
    head.title && `<title>${esc(head.title)}</title>`,
    head.description && `<meta name="description" content="${esc(head.description)}" />`,
    head.title && `<meta property="og:title" content="${esc(head.title)}" />`,
    head.description && `<meta property="og:description" content="${esc(head.description)}" />`,
    `<link rel="canonical" href="${site}${url === '/' ? '' : url}" />`,
    head.noindex && '<meta name="robots" content="noindex" />',
  ].filter(Boolean).join('\n    ');
  const page = template
    .replace(/<title>.*?<\/title>/, '')
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('<!--head-->', tags)
    .replace('<!--app-->', html);
  const out = url === '/' ? path.join(dist, 'index.html') : path.join(dist, url, 'index.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
}
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes.filter((r) => !['/signup', '/login'].includes(r)).map((r) => `  <url><loc>${site}${r === '/' ? '' : r}</loc></url>`).join('\n')}\n</urlset>\n`;
fs.writeFileSync(path.join(dist, 'sitemap.xml'), sitemap);
fs.rmSync(path.join(root, 'dist-ssr'), { recursive: true, force: true });
console.log(`prerendered ${routes.length} routes + sitemap.xml`);
