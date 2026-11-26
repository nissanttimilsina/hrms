/**
 * Shared API client for all three apps.
 *  - Unwraps { success, data, meta } envelopes; throws ApiError(code, message, details).
 *  - Access token kept in memory only (never localStorage).
 *  - Refresh is SINGLE-FLIGHT and cross-tab coordinated: concurrent 401s share one
 *    refresh request, and other tabs are told about the new token via
 *    BroadcastChannel so they never replay an already-rotated refresh token.
 */
export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error ?? {};
    super(e.message || `Request failed (${status})`);
    this.status = status;
    this.code = e.code || 'HTTP_ERROR';
    this.details = e.details;
    this.requestId = e.requestId;
    this.body = body;
  }
  /** { fieldPath: message } for VALIDATION_ERROR responses */
  get fieldErrors() {
    return Array.isArray(this.details) ? Object.fromEntries(this.details.map((d) => [d.path, d.message])) : {};
  }
}

export function createApiClient({ baseUrl = '/api/v1', refreshPath, onAuthLost, channelName } = {}) {
  let accessToken = null;
  let refreshing = null;
  const listeners = new Set();
  const channel = typeof BroadcastChannel !== 'undefined' && channelName ? new BroadcastChannel(channelName) : null;

  const setToken = (t, { broadcast = true } = {}) => {
    accessToken = t;
    listeners.forEach((fn) => fn(t));
    if (broadcast) channel?.postMessage({ type: t ? 'token' : 'logout', token: t });
  };
  channel?.addEventListener('message', (e) => {
    if (e.data?.type === 'token') setToken(e.data.token, { broadcast: false });
    if (e.data?.type === 'logout') { setToken(null, { broadcast: false }); onAuthLost?.(); }
  });

  async function raw(path, { method = 'GET', body, headers = {}, signal, auth = true } = {}) {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      credentials: 'include',
      signal,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        ...(body && !isForm && { 'Content-Type': 'application/json' }),
        ...(auth && accessToken && { Authorization: `Bearer ${accessToken}` }),
        ...headers,
      },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    return res;
  }

  async function refresh() {
    if (!refreshPath) return false;
    if (!refreshing) {
      // Web Locks serialise refresh across tabs where supported.
      const run = async () => {
        const res = await raw(refreshPath, { method: 'POST', auth: false });
        if (!res.ok) return false;
        const json = await res.json();
        setToken(json.data.accessToken);
        return true;
      };
      const locked = typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(`refresh:${refreshPath}`, async () => {
          const before = accessToken;
          // Another tab may have refreshed while we waited for the lock.
          await new Promise((r) => setTimeout(r, 0));
          return accessToken && accessToken !== before ? true : run();
        })
        : run();
      refreshing = Promise.resolve(locked).finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function request(path, opts = {}) {
    let res = await raw(path, opts);
    if (res.status === 401 && opts.auth !== false && refreshPath) {
      const body = await res.clone().json().catch(() => ({}));
      if (['TOKEN_EXPIRED', 'UNAUTHORIZED', 'INVALID_TOKEN'].includes(body?.error?.code) && (await refresh())) {
        res = await raw(path, opts);
      }
    }
    if (opts.raw) return res;
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new ApiError(res.status, json);
      if (res.status === 401 && opts.auth !== false) { setToken(null); onAuthLost?.(err); }
      throw err;
    }
    return { data: json?.data, meta: json?.meta, headers: res.headers };
  }

  return {
    get: (p, o) => request(p, o).then((r) => r.data),
    list: (p, o) => request(p, o), // keeps meta for pagination
    post: (p, body, o) => request(p, { ...o, method: 'POST', body }).then((r) => r.data),
    put: (p, body, o) => request(p, { ...o, method: 'PUT', body }).then((r) => r.data),
    patch: (p, body, o) => request(p, { ...o, method: 'PATCH', body }).then((r) => r.data),
    del: (p, o) => request(p, { ...o, method: 'DELETE' }).then((r) => r.data),
    raw: request,
    download: async (p, filename) => {
      const res = await request(p, { raw: true });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    setToken,
    getToken: () => accessToken,
    refresh,
    onToken: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** Build a query string, dropping empty values. */
export const qs = (params = {}) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString();
  return s ? `?${s}` : '';
};
