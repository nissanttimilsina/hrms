import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createApiClient, qs } from '@hrms/shared-ui/api';
import { createKit } from '@hrms/shared-ui/kit';

export const api = createApiClient({ baseUrl: '/api/v1', refreshPath: '/auth/refresh', channelName: 'hrms-app-auth', onAuthLost: () => window.dispatchEvent(new Event('auth-lost')) });
export { qs };
export const { useList, useAction } = createKit(api);
export { FormDialog, PageHeader, StatusBadge, npr, dt, Filters, KV } from '@hrms/shared-ui/kit';

/** On app.<domain> the workspace must be typed; on <slug>.<domain> it is implied by the host. */
export const isGenericHost = () => /^app\./.test(window.location.hostname) || import.meta.env.VITE_GENERIC_HOST === 'true';

const AuthCtx = createContext(null);
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', me: null });
  const loadMe = useCallback(async () => setState({ status: 'in', me: await api.get('/auth/me') }), []);
  useEffect(() => {
    (async () => { try { if (await api.refresh()) await loadMe(); else setState({ status: 'out', me: null }); } catch { setState({ status: 'out', me: null }); } })();
    const lost = () => setState({ status: 'out', me: null });
    window.addEventListener('auth-lost', lost);
    return () => window.removeEventListener('auth-lost', lost);
  }, [loadMe]);
  const value = useMemo(() => {
    const perms = state.me?.permissions ?? {};
    return {
      ...state,
      reload: loadMe,
      can: (p) => p in perms,
      scopeOf: (p) => perms[p] ?? [],
      wide: (p) => (perms[p] ?? []).some((s) => s !== 'OWN'),
      feature: (f) => !!state.me?.subscription.features.includes(f),
      employeeId: state.me?.user.employeeId,
      login: async (body) => { const r = await api.post('/auth/login', body, { auth: false }); api.setToken(r.accessToken); await loadMe(); },
      logout: async () => { await api.post('/auth/logout').catch(() => {}); api.setToken(null); setState({ status: 'out', me: null }); },
    };
  }, [state, loadMe]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

export const fullName = (e) => (e ? `${e.firstName} ${e.lastName}` : '—');
export const hours = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '—');
export const timeOf = (v) => (v ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kathmandu' }).format(new Date(v)) : '—');
export const todayKtm = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date());
export const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
