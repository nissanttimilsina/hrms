import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, FileText, Plus, Send, Settings2, Trash2, XCircle, Workflow } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge, cn } from '@hrms/shared-ui';
import { api, useAuth, useAction, useList, PageHeader, StatusBadge, npr, dt } from '../lib.jsx';
import { PersonPicker, Tabs, BackLink, ErrorNote } from './kit.jsx';

const FIELD_TYPES = [['TEXT', 'Short text'], ['TEXTAREA', 'Long text'], ['NUMBER', 'Number'], ['AMOUNT', 'Amount (NPR)'], ['DATE', 'Date'], ['SELECT', 'List of options'], ['CHECKBOX', 'Tick box']];
const APPROVERS = [['MANAGER', 'Their manager'], ['MANAGERS_MANAGER', "Their manager's manager"], ['ROLE', 'Anyone with a role'], ['USER', 'A named person']];
const show = (f, v) => (v == null || v === '' ? '—' : f.type === 'CHECKBOX' ? (v ? 'Yes' : 'No') : f.type === 'AMOUNT' ? npr(v) : f.type === 'DATE' ? dt(v) : String(v));

// =========================================================================== requests
export function Requests() {
  const a = useAuth();
  const nav = useNavigate();
  const [view, setView] = useState('mine');
  const list = useList('/workflows/requests', { view: 'mine' });
  const { data: inbox = [] } = useQuery({ queryKey: ['requests-inbox'], queryFn: () => api.get('/workflows/requests?view=approvals') });
  const [pick, setPick] = useState(false);
  const go = (k) => { setView(k); list.set({ view: k }); };
  return (
    <>
      <PageHeader title="Requests" description="Ask for approval for things like working from home, purchases or travel, and follow each step."
        actions={<>
          {a.can('workflows:configure') && <Button variant="secondary" onClick={() => nav('/requests/forms')}><Settings2 className="size-4" />Request forms</Button>}
          {a.employeeId && <Button onClick={() => setPick(true)}><Plus className="size-4" />New request</Button>}
        </>} />
      <Tabs value={view} onChange={go} tabs={[['mine', 'My requests'], ['approvals', 'To approve', inbox.length], ['decided', 'Decided by me'], a.can('workflows:configure') && ['all', 'All']]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/requests/${r.id}`)}
        empty={<EmptyState icon={<Workflow className="size-5" />} title={view === 'approvals' ? 'Nothing waiting for you' : 'No requests yet'} action={view === 'mine' && a.employeeId ? <Button onClick={() => setPick(true)}>New request</Button> : undefined} />}
        mobile={(r) => <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-500">{r.key}{view !== 'mine' ? ` · ${r.employee.name}` : ''} · {dt(r.createdAt)}</p>{r.status === 'PENDING' && <p className="text-xs text-ink-500">With: {r.steps[r.currentStep]?.name}</p>}</div><StatusBadge value={r.status} /></div>}
        columns={[
          { key: 'name', header: 'Request', render: (r) => <><p className="font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-400">{r.key}</p></> },
          ...(view !== 'mine' ? [{ key: 'employee', header: 'From', render: (r) => r.employee.name }] : []),
          { key: 'created', header: 'Sent', render: (r) => dt(r.createdAt) },
          { key: 'step', header: 'Now with', render: (r) => (r.status === 'PENDING' ? r.steps[r.currentStep]?.name : '—') },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]} />
      {pick && <NewRequest onClose={() => setPick(false)} onDone={(r) => { setPick(false); nav(`/requests/${r.id}`); }} />}
    </>
  );
}

function NewRequest({ onClose, onDone }) {
  const { data: defs = [], isPending } = useQuery({ queryKey: ['workflow-defs'], queryFn: () => api.get('/workflows/definitions') });
  const [d, setD] = useState(null);
  const [data, setData] = useState({});
  const send = useAction((b) => api.post('/workflows/requests', b), { success: (r) => `${r.key} sent for approval`, invalidate: [['/workflows/requests']], onDone });
  const fe = send.error?.fieldErrors ?? {};
  const active = defs.filter((x) => x.active);
  if (!d) {
    return (
      <Dialog open onClose={onClose} title="What do you need?">
        {isPending ? <Skeleton className="h-32" /> : !active.length ? <EmptyState title="No request forms yet" description="Ask HR or an administrator to set them up." /> : (
          <div className="grid grid-cols-1 gap-2">{active.map((x) => (
            <button key={x.id} type="button" onClick={() => setD(x)} className="rounded-lg border border-line p-3 text-left hover:border-brand-600 hover:bg-brand-50">
              <p className="font-semibold text-ink-900">{x.name}</p>{x.description && <p className="text-sm text-ink-500">{x.description}</p>}
              <p className="mt-1 text-xs text-ink-400">Approved by: {x.steps.map((s) => s.label).join(' → ')}</p>
            </button>
          ))}</div>
        )}
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} title={d.name} description={`Approved by: ${d.steps.map((s) => s.label).join(' → ')}`} size="lg"
      footer={<><Button variant="ghost" onClick={() => setD(null)}>Back</Button><Button loading={send.isPending} onClick={() => send.mutate({ definitionId: d.id, data })}><Send className="size-4" />Send</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        {d.fields.map((f) => {
          const set = (val) => setData({ ...data, [f.key]: val });
          const wide = ['TEXTAREA', 'CHECKBOX'].includes(f.type) || f.label.length > 30;
          if (f.type === 'CHECKBOX') return <div key={f.key} className="sm:col-span-2"><Checkbox label={`${f.label}${f.required ? ' *' : ''}`} checked={!!data[f.key]} onChange={(e) => set(e.target.checked)} />{fe[f.key] && <p className="mt-1 text-xs text-danger-600">{fe[f.key]}</p>}</div>;
          return (
            <Field key={f.key} label={f.label} required={f.required} hint={f.hint} error={fe[f.key]} className={wide ? 'sm:col-span-2' : ''}>
              {f.type === 'TEXTAREA' ? <Textarea rows={3} value={data[f.key] ?? ''} onChange={(e) => set(e.target.value)} />
                : f.type === 'SELECT' ? <Select value={data[f.key] ?? ''} placeholder="Choose" onChange={(e) => set(e.target.value)} options={f.options.map((o) => ({ value: o, label: o }))} />
                  : <Input type={f.type === 'DATE' ? 'date' : ['NUMBER', 'AMOUNT'].includes(f.type) ? 'number' : 'text'} min={['NUMBER', 'AMOUNT'].includes(f.type) ? 0 : undefined} value={data[f.key] ?? ''} onChange={(e) => set(['NUMBER', 'AMOUNT'].includes(f.type) && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />}
            </Field>
          );
        })}
      </div>
      <div className="mt-3"><ErrorNote error={send.error && !Object.keys(fe).length ? send.error : null} /></div>
    </Dialog>
  );
}

export function RequestDetail() {
  const { id } = useParams();
  const key = ['request', id];
  const { data: r, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/workflows/requests/${id}`) });
  const [decide, setDecide] = useState(null);
  const cancel = useAction(() => api.post(`/workflows/requests/${id}/cancel`, {}), { success: 'Request cancelled', invalidate: [key, ['/workflows/requests']] });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Request not found" description={error.message} />;
  return (
    <>
      <BackLink to="/requests">Requests</BackLink>
      <PageHeader title={r.name} description={`${r.key} · ${r.employee.name} · sent ${dt(r.createdAt, true)}`}
        actions={<>
          {r.abilities.cancel && <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel request</Button>}
          {r.abilities.decide && <Button variant="secondary" onClick={() => setDecide(false)}><XCircle className="size-4" />Reject</Button>}
          {r.abilities.decide && <Button onClick={() => setDecide(true)}><CheckCircle2 className="size-4" />Approve</Button>}
        </>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
        <Card><CardHeader title="Details" />
          <dl className="divide-y divide-line">{r.fields.map((f) => <div key={f.key} className="grid grid-cols-1 gap-1 px-5 py-3 sm:grid-cols-[200px_1fr]"><dt className="text-sm text-ink-500">{f.label}</dt><dd className="whitespace-pre-wrap text-sm text-ink-900">{show(f, r.data[f.key])}</dd></div>)}</dl>
        </Card>
        <Card className="self-start"><CardHeader title="Approval" description={<StatusBadge value={r.status} />} />
          <CardBody>
            <ol className="space-y-4">{r.steps.map((s) => (
              <li key={s.index} className="flex gap-3">
                {s.status === 'APPROVED' ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-600" /> : s.status === 'REJECTED' ? <XCircle className="mt-0.5 size-5 shrink-0 text-danger-600" /> : <Circle className={cn('mt-0.5 size-5 shrink-0', s.status === 'PENDING' ? 'text-brand-600' : 'text-ink-400')} />}
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink-900">{s.name}</p>
                  <p className="text-xs text-ink-500">{s.decidedBy ? `${s.status === 'APPROVED' ? 'Approved' : 'Rejected'} by ${s.decidedBy}, ${dt(s.decidedAt, true)}` : s.status === 'PENDING' ? `Waiting for ${s.approvers.join(', ') || 'an approver'}` : s.status === 'SKIPPED' ? 'Not needed' : 'Next'}</p>
                  {s.note && <p className="mt-1 text-ink-700">{s.note}</p>}
                </div>
              </li>
            ))}</ol>
          </CardBody>
        </Card>
      </div>
      {decide != null && <DecideDialog id={id} approve={decide} onClose={() => setDecide(null)} />}
    </>
  );
}

function DecideDialog({ id, approve, onClose }) {
  const [note, setNote] = useState('');
  const save = useAction((b) => api.post(`/workflows/requests/${id}/decide`, b), { success: approve ? 'Approved' : 'Rejected', invalidate: [['request', id], ['/workflows/requests'], ['requests-inbox']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={approve ? 'Approve this request' : 'Reject this request'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={approve ? 'primary' : 'danger'} loading={save.isPending} onClick={() => save.mutate({ approve, note: note || undefined })}>{approve ? 'Approve' : 'Reject'}</Button></>}>
      <Field label={approve ? 'Note (optional)' : 'Reason'} required={!approve} error={save.error?.fieldErrors?.note}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Dialog>
  );
}

// =========================================================================== form designer
export function RequestForms() {
  const { data = [], isPending } = useQuery({ queryKey: ['workflow-defs'], queryFn: () => api.get('/workflows/definitions') });
  const { data: templates = [] } = useQuery({ queryKey: ['workflow-templates'], queryFn: () => api.get('/workflows/templates') });
  const [edit, setEdit] = useState(null);
  return (
    <>
      <BackLink to="/requests">Requests</BackLink>
      <PageHeader title="Request forms" description="Design what people can ask for and who approves it, step by step." actions={<Button onClick={() => setEdit({ name: '', fields: [], steps: [{ name: 'Manager approval', approver: 'MANAGER' }], active: true })}><Plus className="size-4" />New form</Button>} />
      {isPending ? <Skeleton className="h-40" /> : (
        <>
          {data.length > 0 && <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">{data.map((d) => (
            <Card key={d.id}><CardBody>
              <div className="flex items-start justify-between gap-2"><p className="font-semibold text-ink-900">{d.name}</p>{!d.active && <Badge>Not in use</Badge>}</div>
              {d.description && <p className="text-sm text-ink-500">{d.description}</p>}
              <p className="mt-2 text-xs text-ink-500">{d.fields.length} fields · {d.steps.map((s) => s.label).join(' → ')} · {d.requests} request{d.requests === 1 ? '' : 's'}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => setEdit(d)}>Edit</Button>
            </CardBody></Card>
          ))}</div>}
          <p className="mb-2 text-sm font-semibold text-ink-700">Start from a ready-made form</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">{templates.map((t) => (
            <button key={t.name} type="button" onClick={() => setEdit({ ...t, active: true })} className="rounded-lg border border-dashed border-line-strong p-4 text-left hover:border-brand-600 hover:bg-brand-50">
              <FileText className="size-5 text-brand-600" /><p className="mt-2 font-semibold text-ink-900">{t.name}</p><p className="text-xs text-ink-500">{t.description}</p>
            </button>
          ))}</div>
        </>
      )}
      {edit && <FormEditor d={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function FormEditor({ d, onClose }) {
  const { data: roles = [] } = useQuery({ queryKey: ['workflow-roles'], queryFn: () => api.get('/workflows/roles') });
  const [v, setV] = useState(() => ({ name: d.name, description: d.description ?? '', icon: d.icon ?? 'FileText', active: d.active !== false, fields: d.fields.map((f) => ({ ...f, options: f.options ?? [] })), steps: d.steps.map(({ name, approver, roleKey, userId }) => ({ name, approver, roleKey, userId, employeeId: '' })) }));
  const save = useAction((b) => (d.id ? api.put(`/workflows/definitions/${d.id}`, b) : api.post('/workflows/definitions', b)), { success: 'Form saved', invalidate: [['workflow-defs']], onDone: onClose });
  const setF = (i, patch) => setV({ ...v, fields: v.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const setS = (i, patch) => setV({ ...v, steps: v.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const keyOf = (label, i) => (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f$1').slice(0, 30) || `field_${i + 1}`);
  const submit = () => save.mutate({
    name: v.name, description: v.description || undefined, icon: v.icon, active: v.active,
    fields: v.fields.map((f, i) => ({ key: f.key || keyOf(f.label, i), label: f.label, type: f.type, required: !!f.required, ...(f.type === 'SELECT' && { options: f.options.filter(Boolean) }), ...(f.hint && { hint: f.hint }) })),
    steps: v.steps.map((s) => ({ name: s.name, approver: s.approver, ...(s.approver === 'ROLE' && { roleKey: s.roleKey }), ...(s.approver === 'USER' && { userId: s.userId }) })),
  });
  return (
    <Dialog open onClose={onClose} title={d.id ? `Edit ${d.name}` : 'New request form'} description="Changes apply to new requests. Requests already sent keep the form they were sent with." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={submit}>Save form</Button></>}>
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Name" required error={save.error?.fieldErrors?.name}><Input value={v.name} maxLength={80} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <div className="flex items-end pb-2"><Checkbox label="People can use it" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /></div>
          <Field label="Short description" className="sm:col-span-2"><Input value={v.description} maxLength={500} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold text-ink-900">Fields</p>
          <div className="space-y-2">{v.fields.map((f, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border border-line p-3 sm:grid-cols-[1fr_170px_auto_auto] [&>*]:min-w-0">
              <Input aria-label="Field label" value={f.label} placeholder="Label" onChange={(e) => setF(i, { label: e.target.value })} className="col-span-2 sm:col-span-1" />
              <Select aria-label="Field type" value={f.type} onChange={(e) => setF(i, { type: e.target.value })} options={FIELD_TYPES.map(([value, l]) => ({ value, label: l }))} />
              <div className="flex items-center"><Checkbox label="Required" checked={!!f.required} onChange={(e) => setF(i, { required: e.target.checked })} /></div>
              <button type="button" className="rounded p-1 text-ink-400 hover:text-danger-600" onClick={() => setV({ ...v, fields: v.fields.filter((_, j) => j !== i) })} aria-label="Remove field"><Trash2 className="size-4" /></button>
              {f.type === 'SELECT' && <Input aria-label="Options" className="col-span-2 sm:col-span-4" value={f.options.join(', ')} placeholder="Options, separated by commas" onChange={(e) => setF(i, { options: e.target.value.split(',').map((x) => x.trim()) })} />}
            </div>
          ))}</div>
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => setV({ ...v, fields: [...v.fields, { label: '', type: 'TEXT', required: true, options: [] }] })}><Plus className="size-4" />Add field</Button>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold text-ink-900">Approval steps, in order</p>
          <div className="space-y-2">{v.steps.map((s, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-line p-3 sm:grid-cols-[auto_1fr_1fr_auto] sm:items-center [&>*]:min-w-0">
              <span className="grid size-6 place-items-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">{i + 1}</span>
              <Input aria-label="Step name" value={s.name} placeholder="e.g. Manager approval" onChange={(e) => setS(i, { name: e.target.value })} />
              <Select aria-label="Approved by" value={s.approver} onChange={(e) => setS(i, { approver: e.target.value })} options={APPROVERS.map(([value, l]) => ({ value, label: l }))} />
              <button type="button" className="justify-self-end rounded p-1 text-ink-400 hover:text-danger-600" onClick={() => setV({ ...v, steps: v.steps.filter((_, j) => j !== i) })} aria-label="Remove step"><Trash2 className="size-4" /></button>
              {s.approver === 'ROLE' && <div className="sm:col-span-4"><Select aria-label="Role" value={s.roleKey ?? ''} placeholder="Choose a role" onChange={(e) => setS(i, { roleKey: e.target.value })} options={roles.map((r) => ({ value: r.key, label: r.name }))} /></div>}
              {s.approver === 'USER' && <div className="sm:col-span-4">{s.userId && !s.employeeId ? <p className="text-sm text-ink-700">A named person is set. <button type="button" className="text-brand-700 hover:underline" onClick={() => setS(i, { userId: undefined })}>Change</button></p> : <PersonPicker withLogin value={s.employeeId} onChange={(employeeId, p) => setS(i, { employeeId, userId: p?.userId })} placeholder="Search for the approver" />}</div>}
            </div>
          ))}</div>
          <Button size="sm" variant="secondary" className="mt-2" disabled={v.steps.length >= 6} onClick={() => setV({ ...v, steps: [...v.steps, { name: '', approver: 'ROLE' }] })}><Plus className="size-4" />Add step</Button>
          <p className="mt-2 text-xs text-ink-500">If a step has nobody to decide it (for example, the person has no manager), it goes to the people who manage request forms.</p>
        </div>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}
