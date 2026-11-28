import { useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, LifeBuoy, Lock, MessageSquarePlus, Paperclip, Plus, Settings2 } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge, cn } from '@hrms/shared-ui';
import { api, useAuth, useAction, useList, PageHeader, StatusBadge, dt, todayKtm, addDays } from '../lib.jsx';
import { Tabs, Tiles, BackLink, ErrorNote, Rating, label, useDownload } from './kit.jsx';

const PRIORITIES = [['LOW', 'Low'], ['NORMAL', 'Normal'], ['HIGH', 'High'], ['URGENT', 'Urgent']];
const STATUS_LABEL = { OPEN: 'New', IN_PROGRESS: 'In progress', WAITING: 'Waiting for you', RESOLVED: 'Resolved', CLOSED: 'Closed' };
const useConfig = () => useQuery({ queryKey: ['helpdesk-config'], queryFn: () => api.get('/helpdesk/config'), staleTime: 300_000 });
const PriorityBadge = ({ p }) => (p === 'URGENT' ? <Badge tone="danger">Urgent</Badge> : p === 'HIGH' ? <Badge tone="warning">High</Badge> : null);

const ticketRow = (r, agent) => (
  <div className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 truncate font-medium text-ink-900">{r.confidential && <Lock className="size-3.5 shrink-0 text-ink-400" />}{r.subject}</p>
      <p className="text-xs text-ink-400">{r.key} · {r.categoryName}{agent && r.employee ? ` · ${r.employee.name}` : ''} · {dt(r.updatedAt)}</p>
    </div>
    <div className="flex shrink-0 flex-col items-end gap-1"><StatusBadge value={r.status} />{r.overdue && agent && <Badge tone="danger">Overdue</Badge>}</div>
  </div>
);

// =========================================================================== employee
export function MyTickets() {
  const nav = useNavigate();
  const loc = useLocation();
  const list = useList('/helpdesk/tickets', { view: 'mine' });
  const [open, setOpen] = useState(new URLSearchParams(loc.search).get('new') === '1');
  return (
    <>
      <PageHeader title="Ask HR" description="Questions about pay, leave, documents or policies, and anything you want to raise privately."
        actions={<Button onClick={() => setOpen(true)}><MessageSquarePlus className="size-4" />New request</Button>} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/me/helpdesk/${r.id}`)}
        empty={<EmptyState icon={<LifeBuoy className="size-5" />} title="No requests yet" description="Ask HR anything here instead of chasing emails. You can follow the answer and reply." action={<Button onClick={() => setOpen(true)}>New request</Button>} />}
        mobile={(r) => ticketRow(r, false)}
        columns={[
          { key: 'subject', header: 'Request', render: (r) => <><p className="flex items-center gap-1.5 font-medium text-ink-900">{r.confidential && <Lock className="size-3.5 text-ink-400" />}{r.subject}</p><p className="text-xs text-ink-400">{r.key} · {r.categoryName}</p></> },
          { key: 'updatedAt', header: 'Last update', render: (r) => dt(r.updatedAt, true) },
          { key: 'status', header: 'Status', render: (r) => <span className="inline-flex items-center gap-2"><StatusBadge value={r.status} /><PriorityBadge p={r.priority} /></span> },
        ]} />
      {open && <NewTicketDialog onClose={() => setOpen(false)} onDone={(t) => { setOpen(false); nav(`/me/helpdesk/${t.id}`); }} />}
    </>
  );
}

function NewTicketDialog({ onClose, onDone }) {
  const { data: cfg } = useConfig();
  const fileRef = useRef(null);
  const [v, setV] = useState({ category: '', subject: '', body: '', priority: 'NORMAL', confidential: false });
  const [file, setFile] = useState(null);
  const cat = cfg?.categories.find((c) => c.code === v.category);
  const save = useAction(() => {
    const fd = new FormData();
    Object.entries(v).forEach(([k, x]) => fd.append(k, String(x)));
    if (file) fd.append('attachment', file);
    return api.post('/helpdesk/tickets', fd);
  }, { success: (t) => `Sent as ${t.key}. HR will reply here.`, invalidate: [['/helpdesk/tickets'], ['helpdesk-summary']], onDone });
  const fe = save.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title="Ask HR" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Send</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Topic" required error={fe.category} hint={cat ? `HR aims to answer within ${cat.targetHours < 48 ? `${cat.targetHours} hours` : `${Math.round(cat.targetHours / 24)} days`}` : undefined}>
          <Select value={v.category} placeholder="Choose" onChange={(e) => setV({ ...v, category: e.target.value })} options={(cfg?.categories ?? []).filter((c) => c.active).map((c) => ({ value: c.code, label: c.name }))} />
        </Field>
        <Field label="How urgent?"><Select value={v.priority} onChange={(e) => setV({ ...v, priority: e.target.value })} options={PRIORITIES.map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Subject" required error={fe.subject} className="sm:col-span-2"><Input value={v.subject} maxLength={160} onChange={(e) => setV({ ...v, subject: e.target.value })} placeholder="e.g. Overtime missing from my payslip" /></Field>
        <Field label="Details" required error={fe.body} className="sm:col-span-2"><Textarea rows={5} value={v.body} maxLength={5000} onChange={(e) => setV({ ...v, body: e.target.value })} /></Field>
        <div className="sm:col-span-2 space-y-3">
          {cat?.confidential ? <p className="flex items-center gap-2 rounded-md bg-subtle p-3 text-sm text-ink-700"><Lock className="size-4 shrink-0" />This topic is always private: only HR leads see it.</p>
            : <Checkbox label="Keep it private (only HR leads can see it)" checked={v.confidential} onChange={(e) => setV({ ...v, confidential: e.target.checked })} />}
          <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" aria-label="Attachment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}><Paperclip className="size-4" />{file ? file.name : 'Attach a file'}</Button>
          {fe.attachment && <p className="text-xs text-danger-600">{fe.attachment}</p>}
        </div>
      </div>
    </Dialog>
  );
}

// =========================================================================== detail (employee and HR)
export function TicketDetail() {
  const { id } = useParams();
  const loc = useLocation();
  const mineView = loc.pathname.startsWith('/me/');
  const key = ['ticket', id];
  const { data: tk, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/helpdesk/tickets/${id}`) });
  const { data: cfg } = useConfig();
  const a = useAuth();
  const { data: agents = [] } = useQuery({ queryKey: ['helpdesk-agents'], queryFn: () => api.get('/helpdesk/agents'), enabled: !mineView && a.can('helpdesk:manage') });
  const fileRef = useRef(null);
  const [msg, setMsg] = useState({ body: '', internal: false });
  const [file, setFile] = useState(null);
  const [closeDlg, setCloseDlg] = useState(false);
  const download = useDownload();
  const inv = [key, ['/helpdesk/tickets'], ['helpdesk-summary']];
  const send = useAction(() => {
    const fd = new FormData(); fd.append('body', msg.body); fd.append('internal', String(msg.internal)); if (file) fd.append('attachment', file);
    return api.post(`/helpdesk/tickets/${id}/messages`, fd);
  }, { success: msg.internal ? 'Note added' : 'Sent', invalidate: inv, onDone: () => { setMsg({ body: '', internal: false }); setFile(null); } });
  const patch = useAction((b) => api.patch(`/helpdesk/tickets/${id}`, b), { success: 'Updated', invalidate: inv });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Request not found" description={error.message} />;
  const ab = tk.abilities;
  return (
    <>
      <BackLink to={mineView ? '/me/helpdesk' : '/helpdesk'}>{mineView ? 'Ask HR' : 'HR helpdesk'}</BackLink>
      <PageHeader title={tk.subject} description={`${tk.key} · ${tk.categoryName}${tk.employee && !mineView ? ` · ${tk.employee.name}` : ''}`}
        actions={<>
          {ab.reopen && !ab.close && <Button variant="secondary" onClick={() => patch.mutate({ status: 'IN_PROGRESS' })}>Reopen</Button>}
          {ab.close && <Button onClick={() => setCloseDlg(true)}>Close and rate</Button>}
          {ab.resolve && <Button onClick={() => patch.mutate({ status: 'RESOLVED' })}>Mark resolved</Button>}
        </>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.7fr_1fr] [&>*]:min-w-0">
        <div className="space-y-3">
          {tk.messages.map((m) => (
            <div key={m.id} className={cn('rounded-lg border p-4', m.internal ? 'border-warning-600/30 bg-warning-50' : m.fromRequester ? 'border-line bg-surface' : 'border-brand-100 bg-brand-50/60')}>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-ink-900">{m.by}{m.internal && <span className="ml-2 font-medium text-warning-700">Internal note</span>}{!m.fromRequester && !m.internal && <span className="ml-2 font-medium text-brand-700">HR</span>}</span>
                <span className="text-ink-500">{dt(m.at, true)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-ink-900">{m.body}</p>
              {m.attachment && <button type="button" className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline" onClick={() => download(`/helpdesk/tickets/${id}/attachments/${m.attachment.id}`, m.attachment.name)}><Paperclip className="size-4" />{m.attachment.name}</button>}
            </div>
          ))}
          {ab.reply ? (
            <Card><CardBody className="space-y-3">
              <Textarea rows={4} value={msg.body} maxLength={5000} aria-label="Your reply" placeholder={msg.internal ? 'Note for HR only. The employee does not see it.' : 'Write a reply'} onChange={(e) => setMsg({ ...msg, body: e.target.value })} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" aria-label="Attachment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}><Paperclip className="size-4" />{file ? file.name : 'Attach'}</Button>
                  {ab.note && <Checkbox label="Internal note" checked={msg.internal} onChange={(e) => setMsg({ ...msg, internal: e.target.checked })} />}
                </div>
                <Button loading={send.isPending} disabled={!msg.body.trim()} onClick={() => send.mutate()}>{msg.internal ? 'Add note' : 'Send'}</Button>
              </div>
              <ErrorNote error={send.error} />
            </CardBody></Card>
          ) : tk.status === 'CLOSED' && <p className="text-center text-sm text-ink-500">This request is closed.{mineView ? ' Raise a new one if you need more help.' : ''}</p>}
        </div>
        <Card className="self-start">
          <CardHeader title="Details" />
          <CardBody className="space-y-3 text-sm">
            <div className="flex justify-between gap-2"><span className="text-ink-500">Status</span><StatusBadge value={tk.status} /></div>
            {mineView && tk.status === 'WAITING' && <p className="rounded-md bg-warning-50 p-2 text-warning-700">HR is waiting for your reply.</p>}
            {ab.manage ? (
              <>
                <Field label="Status"><Select value={tk.status} onChange={(e) => patch.mutate({ status: e.target.value })} options={['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED'].map((s) => ({ value: s, label: s === 'WAITING' ? 'Waiting for the employee' : STATUS_LABEL[s] }))} /></Field>
                <Field label="Assigned to"><Select value={tk.assigneeId ?? ''} placeholder="Nobody yet" onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })} options={agents.map((x) => ({ value: x.id, label: x.name }))} /></Field>
                <Field label="Priority"><Select value={tk.priority} onChange={(e) => patch.mutate({ priority: e.target.value })} options={PRIORITIES.map(([value, l]) => ({ value, label: l }))} /></Field>
                <Field label="Topic"><Select value={tk.category} onChange={(e) => patch.mutate({ category: e.target.value })} options={(cfg?.categories ?? []).map((c) => ({ value: c.code, label: c.name }))} /></Field>
              </>
            ) : (
              <>
                <div className="flex justify-between gap-2"><span className="text-ink-500">Handled by</span><span>{tk.assignee ?? 'HR team'}</span></div>
                <div className="flex justify-between gap-2"><span className="text-ink-500">Priority</span><span>{label(tk.priority)}</span></div>
              </>
            )}
            <div className="flex justify-between gap-2"><span className="text-ink-500">Raised</span><span>{dt(tk.createdAt, true)}</span></div>
            {tk.dueAt && !['RESOLVED', 'CLOSED'].includes(tk.status) && <div className="flex justify-between gap-2"><span className="text-ink-500">Target</span><span className={tk.overdue ? 'font-medium text-danger-600' : ''}>{dt(tk.dueAt, true)}</span></div>}
            {tk.confidential && <p className="flex items-center gap-2 text-ink-500"><Lock className="size-4" />Private: HR leads only</p>}
            {tk.satisfaction && <div className="flex justify-between gap-2"><span className="text-ink-500">Rating</span><span>{tk.satisfaction} / 5</span></div>}
            {!mineView && tk.employee && <div className="border-t border-line pt-3"><p className="text-ink-500">Employee</p><p className="font-medium">{tk.employee.name} ({tk.employee.code})</p></div>}
            <ErrorNote error={patch.error} />
          </CardBody>
        </Card>
      </div>
      {closeDlg && <CloseDialog id={id} onClose={() => setCloseDlg(false)} />}
    </>
  );
}

function CloseDialog({ id, onClose }) {
  const [v, setV] = useState({ satisfaction: null, note: '' });
  const close = useAction((b) => api.post(`/helpdesk/tickets/${id}/close`, b), { success: 'Thank you for the feedback', invalidate: [['ticket', id], ['/helpdesk/tickets']], onDone: onClose });
  return (
    <Dialog open onClose={onClose} title="Close this request" description="How well did HR help you?"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={close.isPending} onClick={() => close.mutate({ ...(v.satisfaction && { satisfaction: v.satisfaction }), ...(v.note && { note: v.note }) })}>Close request</Button></>}>
      <div className="space-y-4">
        <Rating name="Satisfaction" value={v.satisfaction} onChange={(satisfaction) => setV({ ...v, satisfaction })} labels={{ 1: 'Very poor', 2: 'Poor', 3: 'OK', 4: 'Good', 5: 'Excellent' }} />
        <Field label="Comment (optional)"><Textarea rows={2} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

// =========================================================================== HR queue
export function HelpdeskQueue() {
  const a = useAuth();
  const nav = useNavigate();
  const [view, setView] = useState('open');
  const list = useList('/helpdesk/tickets', { view: 'open' });
  const { data: s } = useQuery({ queryKey: ['helpdesk-summary'], queryFn: () => api.get('/helpdesk/summary') });
  const { data: cfg } = useConfig();
  const [exp, setExp] = useState(false);
  const go = (k) => { setView(k); list.set({ view: k, status: undefined }); };
  return (
    <>
      <PageHeader title="HR helpdesk" description="Employee questions and requests, with response targets."
        actions={<>
          {a.can('helpdesk:export') && <Button variant="secondary" onClick={() => setExp(true)}><Download className="size-4" />Export</Button>}
          {a.can('helpdesk:configure') && <Button variant="secondary" onClick={() => nav('/helpdesk/settings')}><Settings2 className="size-4" />Topics</Button>}
        </>} />
      <Tiles tiles={[
        { label: 'Open', value: s?.open, onClick: () => go('open') },
        { label: 'Nobody assigned', value: s?.unassigned, tone: s?.unassigned ? 'warning' : undefined, onClick: () => go('unassigned') },
        { label: 'Past the target', value: s?.overdue, tone: s?.overdue ? 'danger' : undefined },
        { label: 'Satisfaction (90 days)', value: s?.satisfaction != null ? `${s.satisfaction} / 5` : '—', hint: s?.ratedCount ? `${s.ratedCount} ratings` : 'No ratings yet' },
      ]} />
      <Tabs value={view} onChange={go} tabs={[['open', 'Open'], ['assigned', 'Mine', s?.assignedToMe], ['unassigned', 'Unassigned', s?.unassigned], ['all', 'All']]} />
      {view === 'all' && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Input placeholder="Search…" className="max-w-xs" aria-label="Search" onChange={(e) => list.set({ search: e.target.value || undefined })} />
          <div className="w-44"><Select aria-label="Status" placeholder="Any status" value={list.params.status ?? ''} onChange={(e) => list.set({ status: e.target.value || undefined })} options={Object.entries(STATUS_LABEL).map(([value, l]) => ({ value, label: l }))} /></div>
          <div className="w-48"><Select aria-label="Topic" placeholder="Any topic" value={list.params.category ?? ''} onChange={(e) => list.set({ category: e.target.value || undefined })} options={(cfg?.categories ?? []).map((c) => ({ value: c.code, label: c.name }))} /></div>
        </div>
      )}
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/helpdesk/${r.id}`)}
        empty={<EmptyState icon={<LifeBuoy className="size-5" />} title="Nothing here" description={view === 'open' ? 'New requests from employees appear here.' : undefined} />}
        mobile={(r) => ticketRow(r, true)}
        columns={[
          { key: 'subject', header: 'Request', render: (r) => <><p className="flex max-w-80 items-center gap-1.5 truncate font-medium text-ink-900">{r.confidential && <Lock className="size-3.5 shrink-0 text-ink-400" />}{r.subject}</p><p className="text-xs text-ink-400">{r.key} · {r.categoryName}</p></> },
          { key: 'employee', header: 'Employee', render: (r) => r.employee?.name },
          { key: 'assignee', header: 'Assigned', render: (r) => r.assignee ?? <span className="text-ink-400">—</span> },
          { key: 'due', header: 'Target', render: (r) => (r.dueAt && !['RESOLVED', 'CLOSED'].includes(r.status) ? <span className={r.overdue ? 'font-medium text-danger-600' : ''}>{dt(r.dueAt, true)}</span> : '—') },
          { key: 'status', header: 'Status', render: (r) => <span className="inline-flex items-center gap-2"><StatusBadge value={r.status} /><PriorityBadge p={r.priority} /></span> },
        ]} />
      {exp && <ExportDialog onClose={() => setExp(false)} />}
    </>
  );
}

function ExportDialog({ onClose }) {
  const download = useDownload();
  const [r, setR] = useState({ from: addDays(todayKtm(), -30), to: todayKtm() });
  return (
    <Dialog open onClose={onClose} title="Export requests" description="A CSV with response and resolution times."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={async () => { await download(`/helpdesk/export?from=${r.from}&to=${r.to}`, `hr-helpdesk-${r.from}-to-${r.to}.csv`); onClose(); }}>Download CSV</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Raised from"><Input type="date" value={r.from} onChange={(e) => setR({ ...r, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={r.to} onChange={(e) => setR({ ...r, to: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

export function HelpdeskSettings() {
  const { data, isPending } = useConfig();
  const [cats, setCats] = useState(null);
  const save = useAction((b) => api.put('/helpdesk/config', b), { success: 'Topics saved', invalidate: [['helpdesk-config']] });
  if (isPending) return <Skeleton className="h-96" />;
  const list = cats ?? data.categories;
  const setCat = (i, patch) => setCats(list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <>
      <BackLink to="/helpdesk">HR helpdesk</BackLink>
      <PageHeader title="Helpdesk topics" description="What employees can ask about, how fast HR aims to resolve it, and which topics are always private."
        actions={<Button loading={save.isPending} onClick={() => save.mutate({ categories: list.map((c) => ({ ...c, targetHours: Number(c.targetHours) })) })}>Save</Button>} />
      <ErrorNote error={save.error} />
      <Card className="mt-3">
        <div className="divide-y divide-line">
          {list.map((c, i) => (
            <div key={i} className="grid grid-cols-[96px_1fr] items-end gap-3 px-5 py-3 sm:grid-cols-[110px_1fr_130px_auto_auto] [&>*]:min-w-0">
              <Field label="Code"><Input value={c.code} maxLength={20} onChange={(e) => setCat(i, { code: e.target.value.toUpperCase() })} /></Field>
              <Field label="Topic"><Input value={c.name} maxLength={40} onChange={(e) => setCat(i, { name: e.target.value })} /></Field>
              <Field label="Target (hours)"><Input type="number" min="1" value={c.targetHours} onChange={(e) => setCat(i, { targetHours: e.target.value })} /></Field>
              <div className="pb-2"><Checkbox label="Private" checked={c.confidential} onChange={(e) => setCat(i, { confidential: e.target.checked })} /></div>
              <div className="pb-2"><Checkbox label="In use" checked={c.active} onChange={(e) => setCat(i, { active: e.target.checked })} /></div>
            </div>
          ))}
        </div>
        <CardBody><Button size="sm" variant="secondary" onClick={() => setCats([...list, { code: '', name: '', targetHours: 48, confidential: false, active: true }])}><Plus className="size-4" />Add topic</Button></CardBody>
      </Card>
    </>
  );
}

