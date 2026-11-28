import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, DoorOpen, LogOut, Plus, Trash2, UserPlus, ListChecks } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Checkbox, Badge, cn } from '@hrms/shared-ui';
import { api, useAuth, useAction, useList, PageHeader, StatusBadge, dt, todayKtm } from '../lib.jsx';
import { PersonPicker, Tabs, Progress, BackLink, ErrorNote, Rating, label } from './kit.jsx';

const OWNER = { HR: 'HR', MANAGER: 'Manager', EMPLOYEE: 'Employee', IT: 'IT', FINANCE: 'Finance' };
const OWNER_TONE = { HR: 'brand', MANAGER: 'info', EMPLOYEE: 'success', IT: 'neutral', FINANCE: 'warning' };
const EXIT_TYPES = [['RESIGNATION', 'Resignation'], ['TERMINATION', 'Termination'], ['RETIREMENT', 'Retirement'], ['CONTRACT_END', 'End of contract'], ['OTHER', 'Other']];
const kindLabel = (k) => (k === 'ONBOARDING' ? 'Joining' : 'Exit');

// =========================================================================== list
export function Journeys() {
  const a = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('ONBOARDING');
  const list = useList('/onboarding/journeys', { kind: 'ONBOARDING', status: 'OPEN' });
  const { data: mine = [] } = useQuery({ queryKey: ['onboarding-my-tasks'], queryFn: () => api.get('/onboarding/my-tasks') });
  const [start, setStart] = useState(null);
  const manage = a.can('onboarding:manage');
  const go = (k) => { setTab(k); if (k !== 'tasks') list.set(k === 'done' ? { kind: undefined, status: 'COMPLETED' } : { kind: k, status: 'OPEN' }); };
  return (
    <>
      <PageHeader title="Onboarding and exits" description="Checklists for people joining and leaving, with a task for each person involved."
        actions={manage && <>
          {a.can('onboarding:configure') && <Button variant="secondary" onClick={() => nav('/onboarding/checklists')}>Checklists</Button>}
          <Button variant="secondary" onClick={() => setStart('OFFBOARDING')}><LogOut className="size-4" />Start an exit</Button>
          <Button onClick={() => setStart('ONBOARDING')}><UserPlus className="size-4" />Start onboarding</Button>
        </>} />
      <Tabs value={tab} onChange={go} tabs={[['ONBOARDING', 'Joining'], ['OFFBOARDING', 'Leaving'], ['tasks', 'Tasks for me', mine.length], ['done', 'Completed']]} />
      {tab === 'tasks' ? <MyTasks tasks={mine} /> : (
        <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/onboarding/${r.id}`)}
          empty={<EmptyState icon={<DoorOpen className="size-5" />} title={tab === 'done' ? 'Nothing completed yet' : `No ${tab === 'ONBOARDING' ? 'joiners' : 'leavers'} right now`} description={manage && tab !== 'done' ? (tab === 'ONBOARDING' ? 'Start a joining checklist when someone accepts an offer.' : 'Start an exit checklist when someone resigns.') : undefined} />}
          mobile={(r) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium text-ink-900">{r.employee.name}</p><p className="text-xs text-ink-400">{r.key} · {r.kind === 'ONBOARDING' ? `joins ${dt(r.startDate)}` : `last day ${dt(r.lastWorkingDay)}`}</p><div className="mt-1.5 w-40"><Progress value={r.percent} /></div></div>
              {r.overdue > 0 ? <Badge tone="danger">{r.overdue} overdue</Badge> : <StatusBadge value={r.status} />}
            </div>
          )}
          columns={[
            { key: 'employee', header: 'Employee', render: (r) => <><p className="font-medium text-ink-900">{r.employee.name}</p><p className="text-xs text-ink-400">{r.key} · {r.employee.code}</p></> },
            { key: 'date', header: tab === 'OFFBOARDING' ? 'Last working day' : tab === 'done' ? 'Type' : 'Joining date', render: (r) => (tab === 'done' ? kindLabel(r.kind) : dt(r.kind === 'ONBOARDING' ? r.startDate : r.lastWorkingDay)) },
            { key: 'progress', header: 'Progress', render: (r) => <div className="w-44"><Progress value={r.percent} /><p className="mt-0.5 text-xs text-ink-400">{r.tasksDone} of {r.tasksTotal} tasks</p></div> },
            { key: 'status', header: 'Status', render: (r) => (r.overdue > 0 ? <Badge tone="danger" dot>{r.overdue} overdue</Badge> : <StatusBadge value={r.status} />) },
          ]} />
      )}
      {start && <StartDialog kind={start} onClose={() => setStart(null)} onDone={(j) => { setStart(null); nav(`/onboarding/${j.id}`); }} />}
    </>
  );
}

function MyTasks({ tasks }) {
  const today = todayKtm();
  if (!tasks.length) return <Card><EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing for you right now" description="Tasks you own on joining and exit checklists appear here." /></Card>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {tasks.map((t) => (
          <li key={t.id}>
            <Link to={`/onboarding/${t.journeyId}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-subtle">
              <div className="min-w-0"><p className="text-sm font-medium text-ink-900">{t.title}</p><p className="text-xs text-ink-500">{kindLabel(t.kind)} · {t.employee.name}</p></div>
              <span className={cn('text-xs', t.dueDate && t.dueDate < today ? 'font-medium text-danger-600' : 'text-ink-500')}>{t.dueDate ? `Due ${dt(t.dueDate)}` : 'No due date'}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StartDialog({ kind, onClose, onDone }) {
  const { data: templates = [] } = useQuery({ queryKey: ['checklists', kind], queryFn: () => api.get(`/onboarding/templates?kind=${kind}`) });
  const [v, setV] = useState({ employeeId: '', templateId: '', startDate: '', exitType: 'RESIGNATION', noticeDate: todayKtm(), lastWorkingDay: '', exitReason: '', terminateEmployee: true });
  const save = useAction((b) => api.post('/onboarding/journeys', b), { success: 'Checklist started', invalidate: [['/onboarding/journeys']], onDone });
  const fe = save.error?.fieldErrors ?? {};
  const active = templates.filter((x) => x.active);
  const submit = () => save.mutate({
    kind, employeeId: v.employeeId, templateId: v.templateId || undefined,
    ...(kind === 'ONBOARDING' ? { ...(v.startDate && { startDate: v.startDate }) } : { exitType: v.exitType, noticeDate: v.noticeDate || undefined, lastWorkingDay: v.lastWorkingDay, exitReason: v.exitReason || undefined, terminateEmployee: v.terminateEmployee }),
  });
  return (
    <Dialog open onClose={onClose} title={kind === 'ONBOARDING' ? 'Start onboarding' : 'Start an exit'} size="lg"
      description={kind === 'ONBOARDING' ? 'Due dates count from the joining date. Add the employee first under Employees if they are not there yet.' : 'Due dates count back from the last working day.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!v.employeeId} onClick={submit}>Start checklist</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Employee" required error={fe.employeeId} className="sm:col-span-2"><PersonPicker value={v.employeeId} onChange={(employeeId) => setV({ ...v, employeeId })} /></Field>
        <Field label="Checklist" className={kind === 'ONBOARDING' ? '' : 'sm:col-span-2'}><Select value={v.templateId} onChange={(e) => setV({ ...v, templateId: e.target.value })} placeholder="Default checklist" options={active.map((x) => ({ value: x.id, label: `${x.name} (${x.items.length} tasks)` }))} /></Field>
        {kind === 'ONBOARDING' ? (
          <Field label="Joining date" hint="Leave empty to use the date on their record"><Input type="date" value={v.startDate} onChange={(e) => setV({ ...v, startDate: e.target.value })} /></Field>
        ) : (
          <>
            <Field label="Type of exit" required error={fe.exitType}><Select value={v.exitType} onChange={(e) => setV({ ...v, exitType: e.target.value })} options={EXIT_TYPES.map(([value, l]) => ({ value, label: l }))} /></Field>
            <Field label="Notice given on" error={fe.noticeDate}><Input type="date" value={v.noticeDate} onChange={(e) => setV({ ...v, noticeDate: e.target.value })} /></Field>
            <Field label="Last working day" required error={fe.lastWorkingDay}><Input type="date" value={v.lastWorkingDay} onChange={(e) => setV({ ...v, lastWorkingDay: e.target.value })} /></Field>
            <Field label="Reason" className="sm:col-span-2"><Textarea rows={2} value={v.exitReason} onChange={(e) => setV({ ...v, exitReason: e.target.value })} placeholder="As told by the employee" /></Field>
            <div className="sm:col-span-2"><Checkbox label="Mark the employee as left and close their login when the checklist is completed" checked={v.terminateEmployee} onChange={(e) => setV({ ...v, terminateEmployee: e.target.checked })} /></div>
          </>
        )}
      </div>
      <div className="mt-3"><ErrorNote error={save.error && !Object.keys(fe).length ? save.error : null} /></div>
    </Dialog>
  );
}

// =========================================================================== detail
export function JourneyDetail() {
  const { id } = useParams();
  const key = ['journey', id];
  const { data: j, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/onboarding/journeys/${id}`) });
  const [dlg, setDlg] = useState(null);
  const inv = [key, ['/onboarding/journeys'], ['onboarding-my-tasks']];
  const tick = useAction(({ taskId, done }) => api.post(`/onboarding/journeys/${id}/tasks/${taskId}`, { done }), { invalidate: inv });
  const remove = useAction((taskId) => api.del(`/onboarding/journeys/${id}/tasks/${taskId}`), { success: 'Task removed', invalidate: inv });
  const complete = useAction((b) => api.post(`/onboarding/journeys/${id}/complete`, b), { success: (r) => (r.employeeExited ? 'Exit completed. The employee is marked as left.' : 'Checklist completed'), invalidate: inv, onDone: () => setDlg(null) });
  const cancel = useAction((b) => api.post(`/onboarding/journeys/${id}/cancel`, b), { success: 'Checklist cancelled', invalidate: inv, onDone: () => setDlg(null) });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Checklist not found" description={error.message} />;
  const ab = j.abilities;
  const today = todayKtm();
  const groups = ['EMPLOYEE', 'MANAGER', 'HR', 'IT', 'FINANCE'].map((o) => [o, j.tasks.filter((x) => x.owner === o)]).filter(([, l]) => l.length);
  return (
    <>
      <BackLink to={ab.manage || j.status !== 'OPEN' ? '/onboarding' : '/'}>{ab.manage ? 'Onboarding and exits' : 'Back'}</BackLink>
      <PageHeader title={`${kindLabel(j.kind)} checklist: ${j.employee.name}`} description={`${j.key}${j.template ? ` · ${j.template}` : ''}`}
        actions={<>
          {ab.manage && <Button variant="ghost" onClick={() => setDlg('cancel')}>Cancel checklist</Button>}
          {ab.manage && <Button variant="secondary" onClick={() => setDlg('task')}><Plus className="size-4" />Add task</Button>}
          {ab.exitInterview && <Button variant="secondary" onClick={() => setDlg('exit')}>{j.exitInterview ? 'Edit exit interview' : 'Exit interview'}</Button>}
          {ab.complete && <Button disabled={j.tasksDone < j.tasksTotal} onClick={() => setDlg('complete')}><CheckCircle2 className="size-4" />Complete</Button>}
        </>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4">
          <Card><CardBody>
            <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium text-ink-900">{j.tasksDone} of {j.tasksTotal} tasks done</span><StatusBadge value={j.status} /></div>
            <Progress value={j.percent} tone={j.percent === 100 ? 'success' : 'brand'} />
          </CardBody></Card>
          {groups.map(([owner, tasks]) => (
            <Card key={owner}>
              <CardHeader title={owner === 'EMPLOYEE' ? `${j.employee.name.split(' ')[0]}'s tasks` : `${OWNER[owner]} tasks`} />
              <ul className="divide-y divide-line">
                {tasks.map((x) => {
                  const late = !x.doneAt && x.dueDate && x.dueDate < today;
                  return (
                    <li key={x.id} className="flex items-start gap-3 px-5 py-3">
                      <button type="button" disabled={!x.canTick || tick.isPending} onClick={() => tick.mutate({ taskId: x.id, done: !x.doneAt })} aria-label={x.doneAt ? `Mark "${x.title}" not done` : `Mark "${x.title}" done`}
                        className={cn('mt-0.5 shrink-0 rounded-full', x.canTick ? 'text-brand-600 hover:text-brand-700' : 'cursor-default text-ink-400')}>
                        {x.doneAt ? <CheckCircle2 className="size-5 text-success-600" /> : <Circle className="size-5" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className={cn('text-sm', x.doneAt ? 'text-ink-500 line-through' : 'font-medium text-ink-900')}>{x.title}</p>
                        {x.description && <p className="text-xs text-ink-500">{x.description}</p>}
                        <p className={cn('mt-0.5 text-xs', late ? 'font-medium text-danger-600' : 'text-ink-400')}>
                          {x.doneAt ? `Done ${dt(x.doneAt)}${x.doneBy ? ` by ${x.doneBy}` : ''}` : x.dueDate ? `${late ? 'Overdue · was due' : 'Due'} ${dt(x.dueDate)}` : 'No due date'}
                        </p>
                      </div>
                      {ab.manage && !x.doneAt && <button type="button" className="rounded p-1 text-ink-400 hover:bg-subtle hover:text-danger-600" onClick={() => remove.mutate(x.id)} aria-label={`Remove "${x.title}"`}><Trash2 className="size-4" /></button>}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title={j.kind === 'ONBOARDING' ? 'Joining' : 'Exit'} />
            <CardBody className="space-y-2 text-sm">
              <Row k="Employee" v={`${j.employee.name} (${j.employee.code})`} />
              {j.manager && <Row k="Manager" v={j.manager.name} />}
              {j.kind === 'ONBOARDING' ? <Row k="Joining date" v={dt(j.startDate)} /> : <>
                <Row k="Type" v={label(j.exitType)} />
                {j.noticeDate && <Row k="Notice given" v={dt(j.noticeDate)} />}
                <Row k="Last working day" v={dt(j.lastWorkingDay)} />
                {j.exitReason && <Row k="Reason" v={j.exitReason} />}
                {j.rehireEligible != null && <Row k="Would rehire" v={j.rehireEligible ? 'Yes' : 'No'} />}
              </>}
              {j.completedAt && <Row k="Completed" v={`${dt(j.completedAt)}${j.completedBy ? ` by ${j.completedBy}` : ''}`} />}
            </CardBody>
          </Card>
          {j.assetsHeld && (
            <Card>
              <CardHeader title="Company items to collect" description={j.assetsHeld.length ? 'Take each one back under Assets before completing the exit.' : undefined} />
              {j.assetsHeld.length ? <ul className="divide-y divide-line">{j.assetsHeld.map((x) => <li key={x.id}><Link to={`/assets/${x.id}`} className="flex justify-between gap-3 px-5 py-2.5 text-sm hover:bg-subtle"><span className="min-w-0 truncate">{x.name}</span><span className="shrink-0 text-ink-400">{x.key}</span></Link></li>)}</ul>
                : <CardBody className="text-sm text-success-700">Everything has been returned.</CardBody>}
            </Card>
          )}
          {j.exitInterview && (
            <Card>
              <CardHeader title="Exit interview" description={`Main reason: ${label(j.exitInterview.mainReason)}`} />
              <CardBody className="space-y-2 text-sm">
                {Object.entries(j.exitInterview.ratings).map(([k, n]) => <div key={k} className="flex justify-between"><span className="text-ink-500">{EXIT_RATINGS[k]}</span><span className="font-medium tabular-nums">{n} / 5</span></div>)}
                <Row k="Would recommend us" v={j.exitInterview.recommend ? 'Yes' : 'No'} />
                {j.exitInterview.liked && <p className="rounded-md bg-subtle p-2"><span className="text-ink-500">Liked: </span>{j.exitInterview.liked}</p>}
                {j.exitInterview.improve && <p className="rounded-md bg-subtle p-2"><span className="text-ink-500">Improve: </span>{j.exitInterview.improve}</p>}
              </CardBody>
            </Card>
          )}
        </div>
      </div>
      {dlg === 'task' && <AddTaskDialog id={id} onClose={() => setDlg(null)} />}
      {dlg === 'exit' && <ExitInterviewDialog j={j} onClose={() => setDlg(null)} />}
      {dlg === 'complete' && <CompleteDialog j={j} action={complete} onClose={() => setDlg(null)} />}
      {dlg === 'cancel' && <CancelDialog action={cancel} onClose={() => setDlg(null)} />}
    </>
  );
}
const Row = ({ k, v }) => <div className="flex justify-between gap-3"><span className="shrink-0 text-ink-500">{k}</span><span className="min-w-0 text-right font-medium text-ink-900">{v}</span></div>;
const EXIT_RATINGS = { role: 'The work itself', manager: 'Their manager', growth: 'Growth and learning', pay: 'Pay and benefits', culture: 'Team and culture' };
const EXIT_REASONS = [['BETTER_PAY', 'Better pay elsewhere'], ['CAREER_GROWTH', 'Career growth'], ['MANAGER', 'Manager'], ['WORKLOAD', 'Workload or hours'], ['CULTURE', 'Culture or team'], ['RELOCATION', 'Moving away'], ['STUDIES', 'Studies'], ['FAMILY', 'Family reasons'], ['HEALTH', 'Health'], ['ABROAD', 'Going abroad for work'], ['OTHER', 'Other']];

function AddTaskDialog({ id, onClose }) {
  const [v, setV] = useState({ title: '', description: '', owner: 'HR', dueDate: '' });
  const add = useAction((b) => api.post(`/onboarding/journeys/${id}/tasks`, b), { success: 'Task added', invalidate: [['journey', id]], onDone: onClose });
  const fe = add.error?.fieldErrors ?? {};
  return (
    <Dialog open onClose={onClose} title="Add a task"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={add.isPending} onClick={() => add.mutate({ title: v.title, owner: v.owner, description: v.description || undefined, dueDate: v.dueDate || null })}>Add</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Task" required error={fe.title} className="sm:col-span-2"><Input value={v.title} maxLength={160} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Who does it"><Select value={v.owner} onChange={(e) => setV({ ...v, owner: e.target.value })} options={Object.entries(OWNER).map(([value, l]) => ({ value, label: l }))} /></Field>
        <Field label="Due"><Input type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} /></Field>
        <Field label="Details" className="sm:col-span-2"><Textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function ExitInterviewDialog({ j, onClose }) {
  const x = j.exitInterview;
  const [v, setV] = useState({ mainReason: x?.mainReason ?? '', ratings: x?.ratings ?? {}, recommend: x?.recommend ?? null, liked: x?.liked ?? '', improve: x?.improve ?? '' });
  const save = useAction((b) => api.put(`/onboarding/journeys/${j.id}/exit-interview`, b), { success: 'Thank you. Your answers are saved.', invalidate: [['journey', j.id]], onDone: onClose });
  const ready = v.mainReason && Object.keys(EXIT_RATINGS).every((k) => v.ratings[k]) && v.recommend != null;
  return (
    <Dialog open onClose={onClose} title="Exit interview" description="Honest answers help us keep good people. Only HR sees them." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!ready} onClick={() => save.mutate({ ...v, liked: v.liked || undefined, improve: v.improve || undefined })}>Save answers</Button></>}>
      <div className="space-y-4">
        <Field label="Main reason for leaving" required><Select value={v.mainReason} placeholder="Choose" onChange={(e) => setV({ ...v, mainReason: e.target.value })} options={EXIT_REASONS.map(([value, l]) => ({ value, label: l }))} /></Field>
        <div className="space-y-3">
          <p className="text-sm font-medium text-ink-900">How would you rate…</p>
          {Object.entries(EXIT_RATINGS).map(([k, l]) => (
            <div key={k} className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm text-ink-700">{l}</span><Rating size="sm" name={l} labels={{ 1: 'Very poor', 2: 'Poor', 3: 'Fair', 4: 'Good', 5: 'Very good' }} value={v.ratings[k]} onChange={(n) => setV({ ...v, ratings: { ...v.ratings, [k]: n } })} /></div>
          ))}
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium text-ink-900">Would you recommend us as a place to work?</p>
          <div className="flex gap-2">{[[true, 'Yes'], [false, 'No']].map(([b, l]) => <Button key={l} size="sm" variant={v.recommend === b ? 'primary' : 'secondary'} onClick={() => setV({ ...v, recommend: b })}>{l}</Button>)}</div>
        </div>
        <Field label="What did you like most?"><Textarea rows={2} value={v.liked} onChange={(e) => setV({ ...v, liked: e.target.value })} /></Field>
        <Field label="What should we improve?"><Textarea rows={2} value={v.improve} onChange={(e) => setV({ ...v, improve: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

function CompleteDialog({ j, action, onClose }) {
  const [rehire, setRehire] = useState(true);
  return (
    <Dialog open onClose={onClose} title="Complete the checklist"
      description={j.kind === 'OFFBOARDING' && j.terminateEmployee ? `${j.employee.name} will be marked as left on ${dt(j.lastWorkingDay)} and their login will be closed.` : 'All tasks are done.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={action.isPending} onClick={() => action.mutate(j.kind === 'OFFBOARDING' ? { rehireEligible: rehire } : {})}>Complete</Button></>}>
      {j.kind === 'OFFBOARDING' && <Checkbox label="We would hire this person again" checked={rehire} onChange={(e) => setRehire(e.target.checked)} />}
      <div className="mt-3"><ErrorNote error={action.error} /></div>
    </Dialog>
  );
}

function CancelDialog({ action, onClose }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onClose} title="Cancel this checklist?" description="For example when a new joiner does not come, or a resignation is withdrawn."
      footer={<><Button variant="secondary" onClick={onClose}>Keep it</Button><Button variant="danger" loading={action.isPending} onClick={() => action.mutate({ reason })}>Cancel checklist</Button></>}>
      <Field label="Reason" required error={action.error?.fieldErrors?.reason}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

// =========================================================================== templates
export function Checklists() {
  const { data = [], isPending } = useQuery({ queryKey: ['checklists'], queryFn: () => api.get('/onboarding/templates') });
  const [edit, setEdit] = useState(null);
  return (
    <>
      <BackLink to="/onboarding">Onboarding and exits</BackLink>
      <PageHeader title="Checklists" description="The tasks copied into each new joining or exit checklist." actions={<>
        <Button variant="secondary" onClick={() => setEdit({ kind: 'OFFBOARDING', name: '', items: [], isDefault: false, active: true })}>New exit checklist</Button>
        <Button onClick={() => setEdit({ kind: 'ONBOARDING', name: '', items: [], isDefault: false, active: true })}><Plus className="size-4" />New joining checklist</Button>
      </>} />
      {isPending ? <Skeleton className="h-48" /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 [&>*]:min-w-0">
          {data.map((x) => (
            <Card key={x.id}>
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><p className="font-semibold text-ink-900">{x.name}</p><p className="text-sm text-ink-500">{x.kind === 'ONBOARDING' ? 'Joining' : 'Exit'} · {x.items.length} tasks</p></div>
                  <div className="flex shrink-0 gap-1">{x.isDefault && <Badge tone="brand">Default</Badge>}{!x.active && <Badge>Not in use</Badge>}</div>
                </div>
                {x.description && <p className="mt-2 text-sm text-ink-700">{x.description}</p>}
                <div className="mt-3 flex flex-wrap gap-1">{Object.keys(OWNER).map((o) => { const n = x.items.filter((i) => i.owner === o).length; return n ? <Badge key={o} tone={OWNER_TONE[o]}>{OWNER[o]} {n}</Badge> : null; })}</div>
                <Button size="sm" variant="secondary" className="mt-3" onClick={() => setEdit(x)}><ListChecks className="size-4" />Edit tasks</Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {edit && <TemplateDialog x={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TemplateDialog({ x, onClose }) {
  const [v, setV] = useState({ ...x, items: x.items.map((i) => ({ ...i, dueDays: i.dueDays ?? '' })) });
  const save = useAction((b) => (x.id ? api.put(`/onboarding/templates/${x.id}`, b) : api.post('/onboarding/templates', b)), { success: 'Checklist saved', invalidate: [['checklists']], onDone: onClose });
  const setItem = (i, patch) => setV({ ...v, items: v.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  useEffect(() => { if (!v.items.length) setV((p) => ({ ...p, items: [{ title: '', owner: 'HR', dueDays: 0 }] })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => save.mutate({ kind: v.kind, name: v.name, description: v.description || undefined, isDefault: v.isDefault, active: v.active, items: v.items.filter((i) => i.title.trim()).map((i) => ({ title: i.title, owner: i.owner, description: i.description || undefined, dueDays: i.dueDays === '' ? null : Number(i.dueDays) })) });
  return (
    <Dialog open onClose={onClose} title={x.id ? `Edit ${x.name}` : `New ${x.kind === 'ONBOARDING' ? 'joining' : 'exit'} checklist`} size="lg"
      description={x.kind === 'ONBOARDING' ? 'Days count from the joining date (−3 means three days before).' : 'Days count from the last working day (−3 means three days before).'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={submit}>Save checklist</Button></>}>
      <div className="space-y-4">
        <Field label="Name" required error={save.error?.fieldErrors?.name}><Input value={v.name} maxLength={120} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
        <div className="flex flex-wrap gap-4"><Checkbox label="Use by default" checked={v.isDefault} onChange={(e) => setV({ ...v, isDefault: e.target.checked })} /><Checkbox label="In use" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /></div>
        <div className="divide-y divide-line rounded-lg border border-line">
          {v.items.map((it, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] items-end gap-2 p-3 sm:grid-cols-[1fr_120px_90px_auto] [&>*]:min-w-0">
              <Field label={i === 0 ? 'Task' : undefined} className="col-span-2 sm:col-span-1"><Input aria-label="Task" value={it.title} maxLength={160} onChange={(e) => setItem(i, { title: e.target.value })} /></Field>
              <Field label={i === 0 ? 'Who' : undefined}><Select aria-label="Who" value={it.owner} onChange={(e) => setItem(i, { owner: e.target.value })} options={Object.entries(OWNER).map(([value, l]) => ({ value, label: l }))} /></Field>
              <Field label={i === 0 ? 'Day' : undefined}><Input aria-label="Day" type="number" value={it.dueDays} onChange={(e) => setItem(i, { dueDays: e.target.value })} /></Field>
              <button type="button" className="mb-2 rounded p-1 text-ink-400 hover:bg-subtle hover:text-danger-600" onClick={() => setV({ ...v, items: v.items.filter((_, j) => j !== i) })} aria-label="Remove task"><Trash2 className="size-4" /></button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={() => setV({ ...v, items: [...v.items, { title: '', owner: 'HR', dueDays: '' }] })}><Plus className="size-4" />Add task</Button>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}

/** Dashboard card for someone with an open joining or exit checklist. */
export function MyJourneyCard() {
  const { data } = useQuery({ queryKey: ['onboarding-mine'], queryFn: () => api.get('/onboarding/mine'), retry: false });
  if (!data || data.status !== 'OPEN') return null;
  return (
    <Card className="border-brand-100 bg-brand-50/50">
      <CardBody className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-semibold text-ink-900">{data.kind === 'ONBOARDING' ? 'Welcome! Your first-days checklist' : 'Your exit checklist'}</p><p className="text-sm text-ink-500">A few steps need you.</p></div>
        <Link to={`/onboarding/${data.id}`}><Button size="sm">Open checklist</Button></Link>
      </CardBody>
    </Card>
  );
}
