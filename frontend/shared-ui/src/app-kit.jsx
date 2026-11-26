import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Dialog, Field, Input, Select, Textarea, Checkbox, useToast, cn } from './index.js';
import { qs } from './api.js';

/**
 * App kit shared by the admin portal and the company app: paginated lists,
 * mutations with toasts, a generic form dialog and small display helpers.
 * Hooks are bound to an API client via createKit(api).
 */
export function createKit(api) {
/** Paginated, filterable list bound to an admin endpoint. */
function useList(path, initial = {}) {
  const [params, setParams] = useState({ page: 1, pageSize: 25, ...initial });
  const q = useQuery({ queryKey: [path, params], queryFn: () => api.list(`${path}${qs(params)}`), placeholderData: (prev) => prev });
  return {
    rows: q.data?.data ?? [], meta: q.data?.meta, loading: q.isPending, error: q.error, params,
    set: (patch) => setParams((p) => ({ ...p, page: 1, ...patch })), page: (page) => setParams((p) => ({ ...p, page })), refetch: q.refetch,
  };
}

/** Mutation with toast feedback and cache invalidation. */
function useAction(fn, { success, invalidate = [], onDone } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      if (success) toast.success(typeof success === 'function' ? success(data, vars) : success);
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: Array.isArray(k) ? k : [k] }));
      onDone?.(data, vars);
    },
    onError: (e) => { if (e.code !== 'VALIDATION_ERROR') toast.error('Action failed', e.message); },
  });
}

  return { useList, useAction };
}

// --------------------------------------------------------------------------- generic form dialog
/**
 * fields: [{ name, label, type: text|number|email|password|textarea|select|checkbox|date|datetime|json|tags, options, required, hint, span }]
 */
export function FormDialog({ open, onClose, title, description, fields, initial = {}, onSubmit, submitLabel = 'Save', loading, error }) {
  const [v, setV] = useState(initial);
  useEffect(() => { if (open) setV(initial); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const errs = error?.fieldErrors ?? {};
  const submit = (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      let x = v[f.name];
      if (f.type === 'number') x = x === '' || x == null ? (f.nullable ? null : undefined) : Number(x);
      if (f.type === 'json') { try { x = x ? JSON.parse(x) : {}; } catch { x = '__invalid__'; } }
      if (f.type === 'tags') x = typeof x === 'string' ? x.split(',').map((s) => s.trim()).filter(Boolean) : x ?? [];
      if ((f.type === 'datetime' || f.type === 'date') && x) x = new Date(x).toISOString();
      if (x === '' && !f.keepEmpty) x = undefined;
      if (x !== undefined) out[f.name] = x;
    }
    onSubmit(out);
  };
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="lg">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        {fields.map((f) => {
          const val = v[f.name] ?? '';
          const set = (x) => setV((p) => ({ ...p, [f.name]: x }));
          const ctl = f.type === 'textarea' ? <Textarea rows={f.rows ?? 4} value={val} onChange={(e) => set(e.target.value)} />
            : f.type === 'json' ? <Textarea rows={5} className="font-mono text-xs" value={typeof val === 'string' ? val : JSON.stringify(val, null, 2)} onChange={(e) => set(e.target.value)} />
              : f.type === 'select' ? <Select value={val} onChange={(e) => set(e.target.value)} options={f.options} placeholder={f.placeholder} />
                : f.type === 'checkbox' ? <Checkbox label={f.checkLabel ?? f.label} checked={!!val} onChange={(e) => set(e.target.checked)} />
                  : <Input type={f.type === 'datetime' ? 'datetime-local' : f.type ?? 'text'} value={f.type === 'tags' && Array.isArray(val) ? val.join(', ') : val} onChange={(e) => set(e.target.value)} />;
          return <Field key={f.name} label={f.type === 'checkbox' ? undefined : f.label} required={f.required} hint={f.hint} error={errs[f.name]} className={cn(f.span !== 1 && (f.type === 'textarea' || f.type === 'json' || f.span === 2) && 'sm:col-span-2')}>{ctl}</Field>;
        })}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{submitLabel}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- small UI
export const PageHeader = ({ title, description, actions }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div><h1 className="text-xl font-semibold">{title}</h1>{description && <p className="mt-1 text-sm text-ink-500">{description}</p>}</div>
    {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
  </div>
);

const TONES = {
  ACTIVE: 'success', PAID: 'success', SUCCEEDED: 'success', WON: 'success', PUBLISHED: 'success', RESOLVED: 'success',
  TRIAL: 'info', OPEN: 'info', NEW: 'info', IN_PROGRESS: 'info', INITIATED: 'info', DRAFT: 'neutral',
  PENDING: 'warning', PENDING_VERIFICATION: 'warning', GRACE_PERIOD: 'warning', PAST_DUE: 'warning', WAITING_ON_CUSTOMER: 'warning', QUALIFIED: 'brand', DEMO_SCHEDULED: 'brand', PROPOSAL: 'brand', CONTACTED: 'brand', HIGH: 'warning',
  SUSPENDED: 'danger', FAILED: 'danger', VOID: 'neutral', LOST: 'danger', CANCELLED: 'neutral', EXPIRED: 'danger', URGENT: 'danger', ARCHIVED: 'neutral', DISABLED: 'danger', REFUNDED: 'neutral', CLOSED: 'neutral',
};
export const StatusBadge = ({ value }) => (value ? <Badge tone={TONES[value] ?? 'neutral'} dot>{String(value).replace(/_/g, ' ').toLowerCase()}</Badge> : null);

export const npr = (n) => (n == null ? '—' : `NPR ${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const dt = (v, withTime) => (v ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime && { hour: '2-digit', minute: '2-digit' }), timeZone: 'Asia/Kathmandu' }).format(new Date(v)) : '—');

export function Filters({ list, search = true, selects = [] }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {search && <Input placeholder="Search…" className="max-w-xs" defaultValue={list.params.search ?? ''} onChange={(e) => list.set({ search: e.target.value || undefined })} aria-label="Search" />}
      {selects.map((s) => <Select key={s.name} className="w-44" value={list.params[s.name] ?? ''} placeholder={s.label} options={s.options.map((o) => (typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' ').toLowerCase() } : o))} onChange={(e) => list.set({ [s.name]: e.target.value || undefined })} aria-label={s.label} />)}
    </div>
  );
}

export const KV = ({ items }) => (
  <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
    {items.filter(Boolean).map(([k, v]) => <div key={k}><dt className="text-ink-500">{k}</dt><dd className="mt-0.5 font-medium text-ink-900">{v ?? '—'}</dd></div>)}
  </dl>
);
