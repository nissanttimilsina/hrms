import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createApiClient, qs } from '@hrms/shared-ui/api';
import { createKit } from '@hrms/shared-ui/kit';

export const api = createApiClient({ baseUrl: '/api/v1/admin', refreshPath: '/auth/refresh', channelName: 'hrms-admin-auth', onAuthLost: () => window.dispatchEvent(new Event('auth-lost')) });
export { qs };

// --------------------------------------------------------------------------- auth
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
  const value = useMemo(() => ({
    ...state,
    can: (perm) => !!state.me?.permissions.includes(perm),
    login: async (email, password) => { const r = await api.post('/auth/login', { email, password }, { auth: false }); api.setToken(r.accessToken); await loadMe(); },
    logout: async () => { await api.post('/auth/logout').catch(() => {}); api.setToken(null); setState({ status: 'out', me: null }); },
  }), [state, loadMe]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

const kit = createKit(api);
export const { useList, useAction } = kit;
export { FormDialog, PageHeader, StatusBadge, npr, dt, Filters, KV } from '@hrms/shared-ui/kit';
