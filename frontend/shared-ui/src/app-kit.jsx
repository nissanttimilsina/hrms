import { useEffect, useId, useState } from 'react';
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
 * Select with an inline "+ New" action: type a name, it is created and selected without leaving the form.
 * create: { label: 'department', onCreate: async (name) => ({ value, label }) }
 */
function CreatableSelect({ value, onChange, options, placeholder, create, id, invalid, ...aria }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    if (name.trim().length < 2) { setErr('Enter at least 2 characters'); return; }
    setBusy(true); setErr('');
    try {
      const o = await create.onCreate(name.trim());
      onChange(o.value); setAdding(false); setName('');
    } catch (e) { setErr(Object.values(e.fieldErrors ?? {})[0] || e.message || 'Could not add it'); } finally { setBusy(false); }
  };
  if (adding) {
    return (
      <div>
        <div className="flex gap-2">
          <Input id={id} autoFocus value={name} placeholder={`New ${create.label} name`} invalid={!!err} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); } }} />
          <Button type="button" size="md" className="shrink-0" loading={busy} onClick={save}>Add</Button>
          <Button type="button" size="md" variant="ghost" className="shrink-0" onClick={() => { setAdding(false); setErr(''); }}>Cancel</Button>
        </div>
        {err && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{err}</p>}
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <Select id={id} invalid={invalid} {...aria} value={value} onChange={(e) => onChange(e.target.value)} options={options} placeholder={placeholder} />
      <Button type="button" variant="secondary" size="md" className="shrink-0" onClick={() => setAdding(true)} aria-label={`Add a new ${create.label}`}>+ New</Button>
    </div>
  );
}

/**
 * fields: [{ name, label, type: text|number|email|password|textarea|select|checkbox|multiselect|date|datetime|json|tags,
 *            options, required, hint, span, section, create, emptyHint, placeholder }]
 *  - section: starts a titled group before this field
 *  - create (select only): adds an inline "+ New" action
 *  - emptyHint (select only): shown instead of the hint when there is nothing to choose yet
 */
export function FormDialog({ open, onClose, title, description, fields, initial = {}, onSubmit, submitLabel = 'Save', loading, error, onChange }) {
  const [v, setV] = useState(initial);
  const formId = useId();
  useEffect(() => { if (open) setV(initial); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onChange?.(v); }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
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
    <Dialog open={open} onClose={onClose} title={title} description={description} size="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form={formId} loading={loading}>{submitLabel}</Button>
      </>}>
      <form id={formId} onSubmit={submit} className="grid gap-x-4 gap-y-4 sm:grid-cols-2" noValidate>
        {error?.code === 'VALIDATION_ERROR' && !Object.keys(errs).length && <p role="alert" className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700 sm:col-span-2">{error.message}</p>}
        {fields.map((f, i) => {
          const val = v[f.name] ?? '';
          const set = (x) => setV((p) => ({ ...p, [f.name]: x }));
          const emptySelect = f.type === 'select' && !f.options?.length;
          const ctl = f.type === 'textarea' ? <Textarea rows={f.rows ?? 4} value={val} onChange={(e) => set(e.target.value)} />
            : f.type === 'json' ? <Textarea rows={5} className="font-mono text-xs" value={typeof val === 'string' ? val : JSON.stringify(val, null, 2)} onChange={(e) => set(e.target.value)} />
              : f.type === 'select' && f.create ? <CreatableSelect value={val} onChange={set} options={f.options} placeholder={f.placeholder ?? 'Select'} create={f.create} />
                : f.type === 'select' ? <Select value={val} onChange={(e) => set(e.target.value)} options={f.options} placeholder={f.placeholder} disabled={emptySelect && !!f.emptyHint} />
                  : f.type === 'checkbox' ? <Checkbox label={f.checkLabel ?? f.label} checked={!!val} onChange={(e) => set(e.target.checked)} />
                    : f.type === 'multiselect' ? (
                      <div className="grid max-h-56 gap-1 overflow-auto rounded-md border border-line p-2 sm:grid-cols-2" role="group" aria-label={f.label}>
                        {f.options.map((o) => <Checkbox key={o.value} label={o.label} checked={(val || []).includes(o.value)} onChange={(e) => set(e.target.checked ? [...(val || []), o.value] : (val || []).filter((x) => x !== o.value))} />)}
                      </div>)
                      : <Input type={f.type === 'datetime' ? 'datetime-local' : f.type ?? 'text'} value={f.type === 'tags' && Array.isArray(val) ? val.join(', ') : val} placeholder={f.placeholder} onChange={(e) => set(e.target.value)} />;
          const wide = f.span !== 1 && (f.type === 'textarea' || f.type === 'json' || f.type === 'multiselect' || f.span === 2);
          return [
            f.section && (
              <div key={`s-${f.name}`} className={cn('sm:col-span-2', i > 0 && 'mt-3 border-t border-line pt-5')}>
                <h3 className="text-sm font-semibold text-ink-900">{f.section}</h3>
                {f.sectionHint && <p className="mt-0.5 text-sm text-ink-500">{f.sectionHint}</p>}
              </div>
            ),
            <Field key={f.name} label={f.type === 'checkbox' ? undefined : f.label} required={f.required} hint={emptySelect && f.emptyHint && !f.create ? f.emptyHint : f.hint} error={errs[f.name]} className={cn(wide && 'sm:col-span-2')}>{ctl}</Field>,
          ];
        })}
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
      {selects.map((s) => <div key={s.name} className="w-44"><Select value={list.params[s.name] ?? ''} placeholder={s.label} options={s.options.map((o) => (typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' ').toLowerCase() } : o))} onChange={(e) => list.set({ [s.name]: e.target.value || undefined })} aria-label={s.label} /></div>)}
    </div>
  );
}

export const KV = ({ items }) => (
  <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
    {items.filter(Boolean).map(([k, v]) => <div key={k}><dt className="text-ink-500">{k}</dt><dd className="mt-0.5 font-medium text-ink-900">{v ?? '—'}</dd></div>)}
  </dl>
);
