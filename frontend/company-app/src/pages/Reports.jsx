import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { Button, Card, CardBody, CardHeader, DataTable, Skeleton, Select, Input, Field, EmptyState, useToast } from '@hrms/shared-ui';
import { api, useAuth, PageHeader, npr, todayKtm, addDays } from '../lib.jsx';
import { useOrg } from './People.jsx';

const COLORS = ['#2453d6', '#e0812b', '#1a9e75', '#8b5cf6'];
const prevFy = (fy) => { const y = Number(fy.slice(0, 4)) - 1; return `${y}/${String(y + 1).slice(2)}`; };

export function Reports() {
  const a = useAuth();
  const toast = useToast();
  const org = useOrg();
  const { data: catalog } = useQuery({ queryKey: ['report-catalog'], queryFn: () => api.get('/reports') });
  const available = (catalog?.reports ?? []).filter((r) => !r.requires || a.wide(r.requires));
  const [key, setKey] = useState('headcount');
  const [f, setF] = useState({ from: addDays(todayKtm(), -29), to: todayKtm() });
  const def = available.find((r) => r.key === key);
  const params = new URLSearchParams(Object.entries({
    ...(def?.filters.includes('range') ? { from: f.from, to: f.to } : def?.filters.includes('fiscalYear') ? { fiscalYear: f.fiscalYear } : {}),
    ...(def?.filters.includes('branch') && { branchId: f.branchId }), ...(def?.filters.includes('department') && { departmentId: f.departmentId }),
  }).filter(([, v]) => v)).toString();
  const { data: r, isPending, error } = useQuery({ queryKey: ['report', key, params], queryFn: () => api.get(`/reports/${key}?${params}`), enabled: !!def });
  const fmt = (v) => (r?.money && typeof v === 'number' ? npr(v) : v);
  const fy = r?.period?.fiscalYear;
  const fyOptions = fy ? [fy, prevFy(fy), prevFy(prevFy(fy))] : [];
  const exportAs = async (format) => {
    try { await api.download(`/reports/${key}?${params}&format=${format}`, `${key}.${format}`); }
    catch (e) { toast.error('Export failed', e.message); }
  };
  return (
    <>
      <PageHeader title="Reports" description="Figures cover only the people you're allowed to see."
        actions={a.can('reports:export') && r && (catalog?.canExport ? <><Button variant="secondary" onClick={() => exportAs('pdf')}>PDF</Button><Button variant="secondary" onClick={() => exportAs('xlsx')}>Excel</Button><Button variant="secondary" onClick={() => exportAs('csv')}>CSV</Button></> : <span className="text-sm text-ink-500">PDF, Excel and CSV export are included from the Professional plan.</span>)} />
      <div className="mb-4 flex flex-wrap gap-1 border-b border-line">
        {available.map((x) => <button key={x.key} type="button" onClick={() => setKey(x.key)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${key === x.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{x.name}</button>)}
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {def?.filters.includes('range') ? (
          <>
            <Field label="From"><Input type="date" value={f.from} max={f.to} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
            <Field label="To"><Input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          </>
        ) : def?.filters.includes('fiscalYear') && fyOptions.length > 0 && (
          <Field label="Fiscal year"><Select value={f.fiscalYear ?? fy} onChange={(e) => setF({ ...f, fiscalYear: e.target.value })} options={fyOptions.map((x) => ({ value: x, label: `FY ${x}` }))} /></Field>
        )}
        {def?.filters.includes('branch') && <Field label="Branch"><Select value={f.branchId ?? ''} placeholder="All branches" options={org.branches} onChange={(e) => setF({ ...f, branchId: e.target.value || undefined })} /></Field>}
        {def?.filters.includes('department') && <Field label="Department"><Select value={f.departmentId ?? ''} placeholder="All departments" options={org.departments} onChange={(e) => setF({ ...f, departmentId: e.target.value || undefined })} /></Field>}
      </div>
      {error ? <EmptyState title="Couldn't load this report" description={error.message} /> : isPending || !r ? <Skeleton className="h-96" /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {r.summary.map(([k, v]) => <Card key={k}><CardBody><p className="text-xs text-ink-500">{k}</p><p className="mt-1 text-xl font-semibold">{fmt(v)}</p></CardBody></Card>)}
          </div>
          {r.note && <p className="mt-3 text-sm text-ink-500">{r.note}</p>}
          {r.chart.data.length > 0 && (
            <Card className="mt-4"><CardHeader title={r.title} /><CardBody>
              <div className="h-72">
                <ResponsiveContainer>
                  {r.chart.type === 'line' ? (
                    <LineChart data={r.chart.data}><CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" /><XAxis dataKey={r.chart.x} fontSize={11} /><YAxis fontSize={11} allowDecimals={false} /><Tooltip /><Legend />
                      {r.chart.series.map(([k, l], i) => <Line key={k} dataKey={k} name={l} stroke={COLORS[i]} strokeWidth={2} dot={false} />)}</LineChart>
                  ) : (
                    <BarChart data={r.chart.data}><CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" /><XAxis dataKey={r.chart.x} fontSize={11} /><YAxis fontSize={11} allowDecimals={!!r.money} /><Tooltip formatter={(v) => fmt(v)} /><Legend />
                      {r.chart.series.map(([k, l], i) => <Bar key={k} dataKey={k} name={l} fill={COLORS[i]} radius={[3, 3, 0, 0]} />)}</BarChart>
                  )}
                </ResponsiveContainer>
              </div>
            </CardBody></Card>
          )}
          <div className="mt-4">
            <DataTable rows={r.table.rows.map((row, i) => ({ id: i, ...row }))} empty={<EmptyState title="No data for these filters" />}
              columns={r.table.columns.map(([k, l]) => ({ key: k, header: l, align: typeof r.table.rows[0]?.[k] === 'number' ? 'right' : undefined, render: (row) => fmt(row[k]) }))} />
          </div>
        </>
      )}
    </>
  );
}
