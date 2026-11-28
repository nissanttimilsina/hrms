import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, LineChart, Plus, Trash2, CheckCircle2 } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Badge, cn } from '@hrms/shared-ui';
import { api, useAuth, useAction, PageHeader, StatusBadge, npr, dt } from '../lib.jsx';
import { Tiles, BackLink, ErrorNote, useDownload } from './kit.jsx';

const useOrg = () => {
  const d = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments?pageSize=100&sort=name&order=asc') });
  const b = useQuery({ queryKey: ['branches'], queryFn: () => api.get('/branches?pageSize=100&sort=name&order=asc') });
  const g = useQuery({ queryKey: ['designations'], queryFn: () => api.get('/designations?pageSize=100') });
  const opt = (q) => (q.data ?? []).map((x) => ({ value: x.id, label: x.name }));
  return { depts: opt(d), branches: opt(b), designations: opt(g) };
};

/** Bar chart of headcount by month with joiners and leavers below. */
function HeadcountChart({ months }) {
  const max = Math.max(1, ...months.map((m) => m.headcount));
  return (
    <div>
      <div className="flex h-36 items-end gap-1.5" role="img" aria-label="Headcount by month">
        {months.map((m) => (
          <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[10px] tabular-nums text-ink-500">{m.headcount}</span>
            <div className="w-full rounded-t bg-brand-600/80" style={{ height: `${Math.max(2, (m.headcount / max) * 100)}%` }} title={`${m.month}: ${m.headcount} people, ${m.joined} joined, ${m.exited} left`} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5">{months.map((m) => <div key={m.month} className="min-w-0 flex-1 text-center"><p className="truncate text-[10px] text-ink-400">{new Date(`${m.month}-01`).toLocaleString('en-GB', { month: 'short' })}</p><p className="text-[10px] tabular-nums"><span className="text-success-700">+{m.joined}</span> <span className="text-danger-600">−{m.exited}</span></p></div>)}</div>
    </div>
  );
}

export function Workforce() {
  const a = useAuth();
  const nav = useNavigate();
  const { data: o } = useQuery({ queryKey: ['workforce-overview'], queryFn: () => api.get('/workforce/overview') });
  const { data: plans = [], isPending } = useQuery({ queryKey: ['workforce-plans'], queryFn: () => api.get('/workforce/plans') });
  const [dlg, setDlg] = useState(null);
  return (
    <>
      <PageHeader title="Workforce planning" description="How many people you have, how many you plan for, and what it costs."
        actions={a.can('workforce:edit') && <Button onClick={() => setDlg({})}><Plus className="size-4" />New plan</Button>} />
      <Tiles tiles={[
        { label: 'People now', value: o?.headcount },
        { label: 'Joined (12 months)', value: o?.joined12m },
        { label: 'Left (12 months)', value: o?.exited12m },
        { label: 'Turnover (12 months)', value: o?.turnover12m != null ? `${o.turnover12m}%` : '—', hint: 'Leavers ÷ average headcount' },
      ]} />
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr] [&>*]:min-w-0">
        <Card><CardHeader title="Headcount, last 12 months" /><CardBody>{o ? <HeadcountChart months={o.months} /> : <Skeleton className="h-36" />}</CardBody></Card>
        <Card><CardHeader title="By department" />
          <ul className="divide-y divide-line">{(o?.byDepartment ?? []).map((d) => <li key={d.name} className="flex justify-between gap-2 px-5 py-2 text-sm"><span className="truncate">{d.name}</span><span className="tabular-nums text-ink-500">{d.n}</span></li>)}</ul>
        </Card>
      </div>
      <DataTable loading={isPending} rows={plans} onRowClick={(p) => nav(`/workforce/${p.id}`)}
        empty={<EmptyState icon={<LineChart className="size-5" />} title="No headcount plans yet" description="Plan how many people each department needs this fiscal year and track it against reality." action={a.can('workforce:edit') ? <Button onClick={() => setDlg({})}>New plan</Button> : undefined} />}
        mobile={(p) => <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink-900">{p.name}</p><p className="text-xs text-ink-500">FY {p.fiscalYear} · {p.planned} planned</p></div><StatusBadge value={p.status} /></div>}
        columns={[
          { key: 'name', header: 'Plan', render: (p) => <span className="font-medium text-ink-900">{p.name}</span> },
          { key: 'fy', header: 'Fiscal year', render: (p) => p.fiscalYear },
          { key: 'planned', header: 'Planned people', align: 'right', render: (p) => p.planned },
          { key: 'updated', header: 'Updated', render: (p) => dt(p.updatedAt) },
          { key: 'status', header: 'Status', render: (p) => <StatusBadge value={p.status} /> },
          { key: 'x', header: '', render: (p) => (a.can('workforce:edit') ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setDlg({ copy: p }); }}><Copy className="size-4" />Copy</Button> : null) },
        ]} />
      {dlg && <PlanDialog copy={dlg.copy} fy={o?.fiscalYear} onClose={() => setDlg(null)} onDone={(p) => { setDlg(null); nav(`/workforce/${p.id}`); }} />}
    </>
  );
}

function PlanDialog({ copy, fy, onClose, onDone }) {
  const [v, setV] = useState({ name: copy ? `${copy.name} (copy)` : '', fiscalYear: copy?.fiscalYear ?? fy ?? '', notes: '' });
  const save = useAction((b) => api.post('/workforce/plans', b), { success: 'Plan created', invalidate: [['workforce-plans']], onDone });
  const fe = save.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title={copy ? `Copy ${copy.name}` : 'New headcount plan'} description={copy ? 'Starts from the same rows. The copy is a draft you can change.' : undefined}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ ...v, notes: v.notes || undefined, ...(copy && { copyFromId: copy.id }) })}>Create</Button></>}>
      <div className="space-y-4">
        <Field label="Name" required error={fe.name}><Input value={v.name} maxLength={120} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Headcount plan 2083/84" /></Field>
        <Field label="Fiscal year" required error={fe.fiscalYear} hint="Like 2083/84"><Input value={v.fiscalYear} maxLength={7} onChange={(e) => setV({ ...v, fiscalYear: e.target.value })} /></Field>
        <Field label="Notes"><Textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

export function PlanDetail() {
  const { id } = useParams();
  const key = ['workforce-plan', id];
  const { data: p, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/workforce/plans/${id}`) });
  const [editing, setEditing] = useState(false);
  const download = useDownload();
  const status = useAction((s) => api.post(`/workforce/plans/${id}/status`, { status: s }), { success: (r) => `Plan ${r.status.toLowerCase()}`, invalidate: [key, ['workforce-plans']] });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Plan not found" description={error.message} />;
  const ab = p.abilities; const t = p.totals;
  const name = (r) => [r.department ?? 'All departments', r.designation, r.branch].filter(Boolean).join(' · ');
  return (
    <>
      <BackLink to="/workforce">Workforce planning</BackLink>
      <PageHeader title={p.name} description={`Fiscal year ${p.fiscalYear}${p.approvedAt ? ` · approved ${dt(p.approvedAt)}` : ''}`}
        actions={<>
          <Button variant="secondary" onClick={() => download(`/workforce/plans/${id}/export`, `headcount-plan-${p.fiscalYear.replace('/', '-')}.csv`)}><Download className="size-4" />Export</Button>
          {ab.edit && <Button variant="secondary" onClick={() => setEditing(true)}>Edit rows</Button>}
          {ab.approve && p.status === 'DRAFT' && <Button onClick={() => status.mutate('APPROVED')}><CheckCircle2 className="size-4" />Approve</Button>}
          {ab.approve && p.status === 'APPROVED' && <Button variant="ghost" onClick={() => status.mutate('DRAFT')}>Back to draft</Button>}
          {ab.approve && p.status !== 'ARCHIVED' && <Button variant="ghost" onClick={() => status.mutate('ARCHIVED')}>Archive</Button>}
        </>} />
      <ErrorNote error={status.error} />
      <Tiles tiles={[
        { label: 'Planned', value: t.planned },
        { label: 'Employed', value: t.actual, hint: t.over ? `${t.over} above plan` : undefined },
        { label: 'Being recruited', value: t.recruiting },
        { label: 'Still to recruit', value: t.toRecruit, tone: t.toRecruit ? 'warning' : 'success' },
      ]} />
      {(t.budget != null || p.showsPay) && <p className="-mt-2 mb-4 text-sm text-ink-500">{t.budget != null && <>Budget {npr(t.budget)} a month</>}{p.showsPay && t.actualCost != null && <> · actual salaries {npr(t.actualCost)} a month</>}</p>}
      <DataTable rows={p.rows}
        empty={<EmptyState icon={<LineChart className="size-5" />} title="No rows yet" description="Add a row for each department (and designation, if you plan at that level)." action={ab.edit ? <Button onClick={() => setEditing(true)}>Add rows</Button> : undefined} />}
        mobile={(r) => <>
          <p className="font-medium text-ink-900">{name(r)}</p>
          <p className="text-xs tabular-nums text-ink-500">Planned {r.planned} · employed {r.actual} · recruiting {r.recruiting}{r.neededBy ? ` · by ${dt(r.neededBy)}` : ''}</p>
          {r.toRecruit > 0 ? <Badge tone="warning">{r.toRecruit} still to recruit</Badge> : r.over > 0 ? <Badge tone="danger">{r.over} above plan</Badge> : <Badge tone="success">On plan</Badge>}
        </>}
        columns={[
          { key: 'name', header: 'Group', render: (r) => <><p className="font-medium text-ink-900">{r.department ?? 'All departments'}</p><p className="text-xs text-ink-400">{[r.designation ?? 'All designations', r.branch].filter(Boolean).join(' · ')}</p></> },
          { key: 'planned', header: 'Planned', align: 'right', render: (r) => r.planned },
          { key: 'actual', header: 'Employed', align: 'right', render: (r) => r.actual },
          { key: 'recruiting', header: 'Recruiting', align: 'right', render: (r) => (r.openings.length ? <span title={r.openings.map((o) => `${o.title} (${o.open})`).join(', ')}>{r.recruiting}</span> : r.recruiting) },
          { key: 'gap', header: 'Gap', render: (r) => (r.toRecruit > 0 ? <Badge tone="warning">{r.toRecruit} to recruit</Badge> : r.over > 0 ? <Badge tone="danger">{r.over} over</Badge> : <Badge tone="success">On plan</Badge>) },
          { key: 'budget', header: 'Budget / month', align: 'right', render: (r) => (r.budget != null ? npr(r.budget) : '—') },
          ...(p.showsPay ? [{ key: 'cost', header: 'Actual / month', align: 'right', render: (r) => <span className={cn(r.budget != null && r.actualCost > r.budget && 'font-medium text-danger-600')}>{npr(r.actualCost)}</span> }] : []),
          { key: 'x', header: '', render: (r) => (ab.recruit && r.toRecruit > 0 ? <Link to="/recruitment" className="text-sm font-medium text-brand-700 hover:underline">Open a job</Link> : null) },
        ]} />
      {p.unplanned.length > 0 && (
        <Card className="mt-4"><CardHeader title="People outside the plan" description="Employees who do not fall in any row." />
          <ul className="divide-y divide-line">{p.unplanned.map((u, i) => <li key={i} className="flex justify-between gap-2 px-5 py-2 text-sm"><span>{u.department}{u.designation ? ` · ${u.designation}` : ''}</span><span className="tabular-nums text-ink-500">{u.actual}</span></li>)}</ul>
        </Card>
      )}
      {p.notes && <Card className="mt-4"><CardBody className="whitespace-pre-wrap text-sm text-ink-700">{p.notes}</CardBody></Card>}
      {editing && <LinesDialog p={p} onClose={() => setEditing(false)} />}
    </>
  );
}

function LinesDialog({ p, onClose }) {
  const org = useOrg();
  const [rows, setRows] = useState(() => (p.rows.length ? p.rows : [{}]).map((r) => ({ departmentId: r.departmentId ?? '', designationId: r.designationId ?? '', branchId: r.branchId ?? '', planned: r.planned ?? '', monthlyCost: r.monthlyCost ?? '', neededBy: r.neededBy ?? '', note: r.note ?? '' })));
  const save = useAction((b) => api.put(`/workforce/plans/${p.id}/lines`, b), { success: 'Plan saved', invalidate: [['workforce-plan', p.id], ['workforce-plans']], onDone: onClose });
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const submit = () => save.mutate({ lines: rows.filter((r) => r.planned !== '').map((r) => ({ departmentId: r.departmentId || null, designationId: r.designationId || null, branchId: r.branchId || null, planned: Number(r.planned), monthlyCost: r.monthlyCost === '' ? null : Number(r.monthlyCost), neededBy: r.neededBy || null, note: r.note || undefined })) });
  return (
    <Dialog open onClose={onClose} title="Plan rows" description="One row per group. Leave department, designation or branch empty to mean all of them. People count in the most specific row that matches." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={submit}>Save</Button></>}>
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-line p-3 sm:grid-cols-3 [&>*]:min-w-0">
            <Field label="Department"><Select value={r.departmentId} placeholder="All" onChange={(e) => set(i, { departmentId: e.target.value })} options={org.depts} /></Field>
            <Field label="Designation"><Select value={r.designationId} placeholder="All" onChange={(e) => set(i, { designationId: e.target.value })} options={org.designations} /></Field>
            <Field label="Branch"><Select value={r.branchId} placeholder="All" onChange={(e) => set(i, { branchId: e.target.value })} options={org.branches} /></Field>
            <Field label="People planned"><Input type="number" min="0" value={r.planned} onChange={(e) => set(i, { planned: e.target.value })} /></Field>
            <Field label="Cost per head (NPR/month)"><Input type="number" min="0" value={r.monthlyCost} onChange={(e) => set(i, { monthlyCost: e.target.value })} /></Field>
            <Field label="Needed by"><Input type="date" value={r.neededBy} onChange={(e) => set(i, { neededBy: e.target.value })} /></Field>
            <div className="col-span-2 flex items-end gap-2 sm:col-span-3"><Input aria-label="Note" value={r.note} placeholder="Note" onChange={(e) => set(i, { note: e.target.value })} /><Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove row"><Trash2 className="size-4" /></Button></div>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => setRows([...rows, { departmentId: '', designationId: '', branchId: '', planned: '', monthlyCost: '', neededBy: '', note: '' }])}><Plus className="size-4" />Add row</Button>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}
