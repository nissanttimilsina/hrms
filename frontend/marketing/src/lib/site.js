import { createApiClient } from '@hrms/shared-ui/api';

/** Site-wide configuration. Override with Vite env vars at build time. */
const ROOT = import.meta.env.VITE_ROOT_DOMAIN || 'yourhrms.com';
export const SITE = {
  name: import.meta.env.VITE_BRAND_NAME || 'Lishnu HRMS',
  company: 'Lishnu Tech Pvt. Ltd.',
  rootDomain: ROOT,
  url: import.meta.env.VITE_SITE_URL || `https://www.${ROOT}`,
  email: import.meta.env.VITE_CONTACT_EMAIL || `hello@${ROOT}`,
  phone: import.meta.env.VITE_CONTACT_PHONE || '',
  address: 'Kathmandu, Nepal',
};

export const workspaceUrl = (slug, path = '') => `https://${slug}.${SITE.rootDomain}${path}`;

export const api = createApiClient({ baseUrl: '/api/v1/public' });

/** Collect UTM parameters once per visit, so every form carries attribution. */
export function getUtm() {
  if (typeof window === 'undefined') return undefined;
  try {
    const saved = sessionStorage.getItem('utm');
    if (saved) return JSON.parse(saved);
    const p = new URLSearchParams(window.location.search);
    const utm = Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map((k) => [k, p.get(`utm_${k}`)]).filter(([, v]) => v));
    if (Object.keys(utm).length) sessionStorage.setItem('utm', JSON.stringify(utm));
    return Object.keys(utm).length ? utm : undefined;
  } catch { return undefined; }
}

export const formatPrice = (n) => (n == null ? '—' : new Intl.NumberFormat('en-IN').format(n));
