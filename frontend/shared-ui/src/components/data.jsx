import { cn } from '../cn.js';
import { Skeleton, EmptyState, Button } from './primitives.jsx';

/**
 * DataTable — server-driven (pagination/sort come from the API's meta).
 * columns: [{ key, header, render?(row), sortable?, align?, width? }]
 */
export function DataTable({
  columns, rows, loading, rowKey = 'id', sort, order, onSort, empty, onRowClick, meta, onPage, caption,
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="border-b border-line bg-subtle">
            <tr>
              {columns.map((c) => {
                const active = sort === c.key;
                return (
                  <th
                    key={c.key} scope="col" style={{ width: c.width }}
                    aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn('px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-ink-500', c.align === 'right' && 'text-right')}
                  >
                    {c.sortable && onSort ? (
                      <button type="button" className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink-900" onClick={() => onSort(c.key, active && order === 'asc' ? 'desc' : 'asc')}>
                        {c.header}
                        <span aria-hidden="true" className={cn('text-[10px]', !active && 'opacity-30')}>{active && order === 'asc' ? '▲' : '▼'}</span>
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {loading && [...Array(5)].map((_, i) => (
              <tr key={`s${i}`}>{columns.map((c) => <td key={c.key} className="px-4 py-3"><Skeleton className="h-4 w-3/4" /></td>)}</tr>
            ))}
            {!loading && rows.map((row) => (
              <tr
                key={row[rowKey]}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn('text-ink-700', onRowClick && 'cursor-pointer hover:bg-subtle')}
              >
                {columns.map((c) => (
                  <td key={c.key} className={cn('px-4 py-3', c.align === 'right' && 'text-right tabular-nums')}>
                    {c.render ? c.render(row) : row[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (empty ?? <EmptyState title="Nothing here yet" description="Records you add will appear here." />)}
      </div>
      {meta && meta.totalPages > 1 && (
        <nav className="flex items-center justify-between border-t border-line px-4 py-2.5 text-sm text-ink-500" aria-label="Pagination">
          <span>
            {(meta.page - 1) * meta.pageSize + 1}–{Math.min(meta.page * meta.pageSize, meta.total)} of {meta.total}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={meta.page <= 1} onClick={() => onPage?.(meta.page - 1)}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={meta.page >= meta.totalPages} onClick={() => onPage?.(meta.page + 1)}>Next</Button>
          </div>
        </nav>
      )}
    </div>
  );
}

/** Usage meter for plan limits (employees 18 / 20). */
export function UsageMeter({ label, used, limit }) {
  const pct = limit == null ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const tone = pct >= 100 ? 'bg-danger-600' : pct >= 80 ? 'bg-warning-600' : 'bg-brand-600';
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-ink-700">{label}</span>
        <span className="tabular-nums text-ink-500">{used}{limit == null ? '' : ` / ${limit}`}{limit == null && ' · Unlimited'}</span>
      </div>
      {limit != null && (
        <div className="mt-1.5 h-1.5 rounded-full bg-subtle" role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={limit} aria-label={label}>
          <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
