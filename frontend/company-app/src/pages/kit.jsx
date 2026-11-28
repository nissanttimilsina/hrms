import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search, Star, X } from 'lucide-react';
import { Badge, Button, Card, Input, cn, useToast } from '@hrms/shared-ui';
import { api } from '../lib.jsx';

/** Shared pieces for the HR modules: colleague pickers, tabs, ratings, progress, summary tiles. */

const useColleagues = (search, enabled = true, withLogin = false) => useQuery({
  queryKey: ['directory', search, withLogin], enabled,
  queryFn: () => api.get(`/directory?${new URLSearchParams({ ...(search && { search }), ...(withLogin && { withLogin: 'true' }) })}`),
  placeholderData: (p) => p, staleTime: 60_000,
});

/** Search-as-you-type picker for one colleague. value = employee id; onChange(id, person). */
export function PersonPicker({ value, onChange, placeholder = 'Search by name or ID', exclude = [], withLogin = false, invalid, id }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const box = useRef(null);
  const { data = [] } = useColleagues(q, open, withLogin);
  const { data: current } = useQuery({ queryKey: ['directory-one', value], enabled: !!value && !picked, queryFn: () => api.get(`/directory?ids=${value}`) });
  const person = picked?.id === value ? picked : current?.[0];
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (value && person && !open) {
    return (
      <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-line-strong bg-white px-3 text-sm">
        <span className="min-w-0 truncate"><span className="font-medium text-ink-900">{person.name}</span> <span className="text-ink-400">{person.code}</span></span>
        <button type="button" className="rounded p-1 text-ink-400 hover:bg-subtle hover:text-ink-900" onClick={() => { onChange('', null); setPicked(null); setOpen(true); }} aria-label="Change person"><X className="size-4" /></button>
      </div>
    );
  }
  const list = data.filter((p) => !exclude.includes(p.id) && (!withLogin || p.userId));
  return (
    <div className="relative" ref={box}>
      <Search className="pointer-events-none absolute left-3 top-3 size-4 text-ink-400" />
      <Input id={id} invalid={invalid} className="pl-9" value={q} placeholder={placeholder} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} autoComplete="off" />
      {open && (
        <ul className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-white py-1 shadow-pop" role="listbox">
          {list.length === 0 && <li className="px-3 py-2 text-sm text-ink-500">{withLogin ? 'No one with a login matches' : 'No one matches'}</li>}
          {list.map((p) => (
            <li key={p.id}>
              <button type="button" role="option" aria-selected={p.id === value} className="w-full px-3 py-2 text-left hover:bg-subtle" onClick={() => { setPicked(p); onChange(p.id, p); setOpen(false); setQ(''); }}>
                <p className="text-sm font-medium text-ink-900">{p.name} <span className="font-normal text-ink-400">{p.code}</span></p>
                {(p.designation || p.department) && <p className="text-xs text-ink-500">{[p.designation, p.department].filter(Boolean).join(' · ')}</p>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Several colleagues: chips plus a picker. value = [{id, name, userId?}] */
export function PeoplePicker({ value, onChange, withLogin = false, exclude = [], max = 20 }) {
  const [key, setKey] = useState(0);
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pl-3 pr-1 text-sm text-brand-700">
              {p.name}
              <button type="button" className="rounded-full p-0.5 hover:bg-brand-100" onClick={() => onChange(value.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.name}`}><X className="size-3.5" /></button>
            </span>
          ))}
        </div>
      )}
      {value.length < max && <PersonPicker key={key} value="" withLogin={withLogin} exclude={[...exclude, ...value.map((v) => v.id)]} placeholder="Add a person" onChange={(id, p) => { if (p) onChange([...value, p]); setKey((k) => k + 1); }} />}
    </div>
  );
}

/** Underlined tabs. tabs = [[key, label, count?]] */
export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div className={cn('mb-4 flex gap-1 overflow-x-auto border-b border-line', className)} role="tablist">
      {tabs.filter(Boolean).map(([k, label, count]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          className={cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-900')}>
          {label}{count ? <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 1–5 rating as buttons, with the label of the chosen value. */
export const RATING_LABELS = { 1: 'Unsatisfactory', 2: 'Needs improvement', 3: 'Meets expectations', 4: 'Exceeds expectations', 5: 'Outstanding' };
export function Rating({ value, onChange, labels = RATING_LABELS, readOnly, size = 'md', name = 'Rating' }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex gap-1" role="radiogroup" aria-label={name}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} disabled={readOnly} onClick={() => onChange?.(n)} aria-label={`${n}: ${labels[n]}`}
            className={cn('grid place-items-center rounded-md border text-sm font-semibold tabular-nums transition-colors', size === 'sm' ? 'size-7' : 'size-9',
              value === n ? 'border-brand-600 bg-brand-600 text-white' : value && n < value ? 'border-brand-100 bg-brand-50 text-brand-700' : 'border-line-strong bg-white text-ink-500',
              !readOnly && 'hover:border-brand-600')}>{n}</button>
        ))}
      </div>
      {value ? <span className="text-xs text-ink-500">{labels[value]}</span> : null}
    </div>
  );
}

export const Stars = ({ value, max = 5 }) => (
  <span className="inline-flex items-center gap-0.5" aria-label={`${value} out of ${max}`}>
    {Array.from({ length: max }, (_, i) => <Star key={i} className={cn('size-3.5', i < Math.round(value) ? 'fill-warning-600 text-warning-600' : 'text-line-strong')} />)}
  </span>
);

export function Progress({ value, tone = 'brand', label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
        <div className={cn('h-full rounded-full', tone === 'success' ? 'bg-success-600' : tone === 'warning' ? 'bg-warning-600' : 'bg-brand-600')} style={{ width: `${v}%` }} />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-ink-500">{v}%</span>
    </div>
  );
}

/** Small number tiles in a row. tiles = [{label, value, hint, tone, onClick}] */
export function Tiles({ tiles, className }) {
  const list = tiles.filter(Boolean);
  return (
    <div className={cn('mb-5 grid grid-cols-2 gap-3 [&>*]:min-w-0', list.length >= 4 ? 'lg:grid-cols-4' : list.length === 3 ? 'sm:grid-cols-3' : '', className)}>
      {list.map((x) => {
        const body = (
          <>
            <p className="text-xs font-medium text-ink-500">{x.label}</p>
            <p className={cn('mt-1 text-2xl font-semibold tabular-nums', x.tone === 'danger' ? 'text-danger-600' : x.tone === 'warning' ? 'text-warning-700' : x.tone === 'success' ? 'text-success-700' : 'text-ink-900')}>{x.value ?? '—'}</p>
            {x.hint && <p className="mt-0.5 truncate text-xs text-ink-500">{x.hint}</p>}
          </>
        );
        return x.onClick
          ? <button key={x.label} type="button" onClick={x.onClick} className="rounded-lg border border-line bg-surface p-4 text-left shadow-card hover:border-brand-600">{body}</button>
          : <Card key={x.label} className="p-4">{body}</Card>;
      })}
    </div>
  );
}

/** Download a file from the API with an error toast. */
export function useDownload() {
  const toast = useToast();
  return async (path, filename) => {
    try { await api.download(path, filename); } catch (e) { toast.error('Download failed', e.message); }
  };
}

export const Pill = ({ children, tone = 'neutral' }) => <Badge tone={tone}>{children}</Badge>;
export const label = (s) => (s ? String(s).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '');

/** A thin back link above a detail page. */
export const BackLink = ({ to, children }) => (
  <Link to={to} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-900">← {children}</Link>
);

export function ErrorNote({ error }) {
  if (!error) return null;
  const fe = Object.values(error.fieldErrors ?? {});
  return <p role="alert" className="rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{fe[0] ?? error.message}</p>;
}

export { Button };
