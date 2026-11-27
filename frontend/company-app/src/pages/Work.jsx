import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import {
  AlertTriangle, ArrowLeft, Calendar, CheckCircle2, CircleDot, Clock3, Flag, FolderKanban, LayoutGrid, List, MessageSquare, Plus, Send, Star, Trash2, X,
} from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Skeleton, EmptyState, Field, Input, Select, Textarea, Badge, Checkbox, Dialog, ConfirmDialog, useToast, cn } from '@hrms/shared-ui';
import { api, useAuth, useList, useAction, FormDialog, PageHeader, dt, hours, timeOf, todayKtm, addDays } from '../lib.jsx';

// =========================================================================== shared bits
export const STATUS = {
  TODO: { label: 'To do', cls: 'bg-subtle text-ink-700', dot: 'bg-ink-400' },
  IN_PROGRESS: { label: 'In progress', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
  BLOCKED: { label: 'Blocked', cls: 'bg-danger-50 text-danger-700', dot: 'bg-danger-600' },
  IN_REVIEW: { label: 'In review', cls: 'bg-warning-50 text-warning-700', dot: 'bg-warning-600' },
  DONE: { label: 'Done', cls: 'bg-success-50 text-success-700', dot: 'bg-success-600' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-subtle text-ink-500', dot: 'bg-ink-400' },
};
export const PRIORITY = {
  URGENT: { label: 'Urgent', cls: 'text-danger-600' },
  HIGH: { label: 'High', cls: 'text-warning-600' },
  MEDIUM: { label: 'Medium', cls: 'text-brand-600' },
  LOW: { label: 'Low', cls: 'text-ink-400' },
};
const REPORT_STATUS = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Awaiting review', tone: 'warning' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'danger' },
  APPROVED: { label: 'Approved', tone: 'success' },
};
const BOARD = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE'];

export const StatusPill = ({ value }) => {
  const s = STATUS[value] ?? STATUS.TODO;
  return <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium', s.cls)}><span className={cn('size-1.5 rounded-full', s.dot)} />{s.label}</span>;
};
export const PriorityFlag = ({ value, withLabel = true }) => {
  const p = PRIORITY[value] ?? PRIORITY.MEDIUM;
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium', p.cls)} title={`${p.label} priority`}><Flag className="size-3.5" />{withLabel && p.label}</span>;
};
export const ProgressBar = ({ value, className, tone }) => (
  <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-subtle', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
    <div className={cn('h-full rounded-full transition-all', tone ?? (value >= 100 ? 'bg-success-600' : 'bg-brand-500'))} style={{ width: `${Math.min(100, value ?? 0)}%` }} />
  </div>
);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86_400_000);
export function DueLabel({ task, short }) {
  if (!task.dueOn) return <span className="text-xs text-ink-400">No due date</span>;
  const open = !['DONE', 'CANCELLED'].includes(task.status);
  const d = daysBetween(todayKtm(), task.dueOn);
  if (open && d < 0) return <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-danger-600"><AlertTriangle className="size-3.5" />{short ? `${-d}d late` : `Overdue by ${-d} day${d === -1 ? '' : 's'}`}</span>;
  if (open && d === 0) return <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-warning-700"><Clock3 className="size-3.5" />Due today</span>;
  if (open && d === 1) return <span className="whitespace-nowrap text-xs text-ink-700">Due tomorrow</span>;
  return <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-ink-500"><Calendar className="size-3.5" />{dt(task.dueOn)}</span>;
}
export const Stars = ({ value, size = 'size-4' }) => (
  <span className="inline-flex" aria-label={value ? `${value} out of 5` : 'Not rated'}>
    {[1, 2, 3, 4, 5].map((i) => <Star key={i} className={cn(size, i <= (value ?? 0) ? 'fill-warning-600 text-warning-600' : 'text-line-strong')} />)}
  </span>
);
const Avatar = ({ name, className }) => {
  const init = (name ?? '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  return <span className={cn('grid size-7 shrink-0 place-items-center rounded-full bg-brand-100 text-[11px] font-semibold text-brand-700', className)} title={name}>{init}</span>;
};

function useAssignees(enabled) {
  return useQuery({ queryKey: ['assignees'], queryFn: () => api.get('/tasks/assignees'), enabled, staleTime: 60_000 });
}
function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: () => api.get('/projects'), staleTime: 60_000 });
}

/** Create / edit task dialog. */
export function TaskDialog({ open, onClose, task, defaultAssignee, onSaved }) {
  const a = useAuth();
  const canAssign = a.can('tasks:create');
  const { data: people = [] } = useAssignees(open && canAssign);
  const { data: projects = [] } = useProjects();
  const save = useAction((b) => (task ? api.patch(`/tasks/${task.id}`, b) : api.post('/tasks', b)), {
    success: (r) => (task ? 'Task updated' : `${r.key} created and assigned to ${r.assignee.name ?? 'you'}`),
    invalidate: ['/tasks', ['tasks-summary'], ['task'], ['projects'], ['dash-tasks']],
    onDone: (r) => { onClose(); onSaved?.(r); },
  });
  const initial = task
    ? { ...task, assigneeId: task.assignee.id, projectId: task.project?.id ?? '', estimateHours: task.estimateHours ?? '' }
    : { priority: 'MEDIUM', assigneeId: defaultAssignee ?? a.employeeId ?? '' };
  return (
    <FormDialog open={open} onClose={onClose} title={task ? `Edit ${task.key}` : 'New task'} description={task ? undefined : 'The person you assign it to is notified by email and in the app.'}
      initial={initial} submitLabel={task ? 'Save changes' : 'Create task'} loading={save.isPending} error={save.error}
      fields={[
        { name: 'title', label: 'Title', required: true, span: 2, placeholder: 'e.g. Prepare the Mangsir sales report' },
        { name: 'description', label: 'Details', type: 'textarea', rows: 4, placeholder: 'What needs to be done, links, acceptance criteria' },
        { name: 'assigneeId', label: 'Assign to', type: 'select', required: true, options: people.map((p) => ({ value: p.id, label: p.id === a.employeeId ? `${p.name} (me)` : p.name })), placeholder: 'Choose a person', emptyHint: 'You can only assign tasks to yourself.' },
        { name: 'projectId', label: 'Project', type: 'select', options: projects.filter((p) => p.status === 'ACTIVE' || p.id === task?.project?.id).map((p) => ({ value: p.id, label: p.name })), placeholder: 'No project' },
        { name: 'priority', label: 'Priority', type: 'select', options: Object.entries(PRIORITY).map(([value, p]) => ({ value, label: p.label })) },
        { name: 'estimateHours', label: 'Estimated hours', type: 'number', nullable: true },
        { name: 'startOn', label: 'Start', type: 'date' },
        { name: 'dueOn', label: 'Due', type: 'date' },
        { name: 'requiresReview', type: 'checkbox', checkLabel: 'Needs my review before it counts as done', span: 2 },
      ]}
      onSubmit={(b) => {
        const body = { ...b, projectId: b.projectId || null, dueOn: b.dueOn ? b.dueOn.slice(0, 10) : null, startOn: b.startOn ? b.startOn.slice(0, 10) : null, requiresReview: !!b.requiresReview };
        const keys = ['title', 'description', 'assigneeId', 'projectId', 'priority', 'estimateHours', 'startOn', 'dueOn', 'requiresReview'];
        const orig = task ? { ...task, assigneeId: task.assignee.id, projectId: task.project?.id ?? null } : {};
        const same = (k) => (k === 'estimateHours' ? Number(body[k] ?? -1) === Number(orig[k] ?? -1) : (body[k] ?? null) === (orig[k] ?? null));
        save.mutate(Object.fromEntries(keys.filter((k) => body[k] !== undefined && (!task || !same(k))).map((k) => [k, body[k]])));
      }} />
  );
}

// =========================================================================== tasks: list + board
const VIEWS = [['mine', 'My tasks'], ['team', 'Team'], ['created', 'Assigned by me'], ['all', 'All']];

export function Tasks({ mineOnly }) {
  const a = useAuth();
  const [sp, setSp] = useSearchParams();
  const wideView = a.wide('tasks:view');
  const views = VIEWS.filter(([k]) => (k === 'mine' ? !!a.employeeId : wideView || k === 'created'));
  const view = mineOnly ? 'mine' : sp.get('view') ?? (wideView ? (a.employeeId ? 'team' : 'all') : 'mine');
  const [mode, setMode] = useState(() => { try { return localStorage.getItem('tasks.mode') ?? 'list'; } catch { return 'list'; } });
  const [creating, setCreating] = useState(sp.get('new') === '1');
  const list = useList('/tasks', { view, status: 'open', sort: 'dueOn', order: 'asc', pageSize: 50, ...(sp.get('projectId') && { projectId: sp.get('projectId') }) });
  useEffect(() => { list.set({ view }); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: sum } = useQuery({ queryKey: ['tasks-summary', view], queryFn: () => api.get(`/tasks/summary?view=${view === 'created' ? 'all' : view}`) });
  const { data: projects = [] } = useProjects();
  const switchMode = (m) => { setMode(m); try { localStorage.setItem('tasks.mode', m); } catch { /* private mode */ } if (m === 'board') list.set({ status: undefined, pageSize: 200 }); else list.set({ status: 'open', pageSize: 50 }); };
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const move = async (task, status) => {
    if (task.status === status) return;
    try {
      if (status === 'BLOCKED') { toast.info('Say what is blocking it'); nav(`/tasks/${task.id}`); return; }
      await api.patch(`/tasks/${task.id}`, { status });
      qc.invalidateQueries({ queryKey: ['/tasks'] }); qc.invalidateQueries({ queryKey: ['tasks-summary'] });
    } catch (e) { toast.error('Could not move the task', e.message); }
  };
  const chips = sum ? [
    ['Overdue', sum.overdue, { due: 'overdue', status: 'open' }, 'text-danger-600'],
    ['Due today', sum.dueToday, { due: 'today', status: 'open' }, 'text-warning-700'],
    ['In progress', sum.byStatus.IN_PROGRESS, { status: 'IN_PROGRESS', due: undefined }],
    ['Blocked', sum.byStatus.BLOCKED, { status: 'BLOCKED', due: undefined }, 'text-danger-600'],
    ['In review', sum.byStatus.IN_REVIEW, { status: 'IN_REVIEW', due: undefined }],
    ['Done this week', sum.doneThisWeek, { status: 'DONE', due: undefined }, 'text-success-700'],
  ] : [];
  return (
    <>
      <PageHeader title={mineOnly ? 'My tasks' : 'Tasks'} description={mineOnly ? 'Everything assigned to you. Update progress here or in your daily report.' : 'Assign work, follow progress and see what is late.'}
        actions={<>
          <div className="flex rounded-lg border border-line bg-white p-0.5" role="group" aria-label="View">
            {[['list', List, 'List'], ['board', LayoutGrid, 'Board']].map(([m, Ico, l]) => (
              <button key={m} type="button" onClick={() => switchMode(m)} aria-pressed={mode === m} className={cn('flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium', mode === m ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-subtle')}><Ico className="size-4" />{l}</button>
            ))}
          </div>
          {a.can('tasks:create') && <Button onClick={() => setCreating(true)}><Plus className="size-4" />New task</Button>}
        </>} />
      {!mineOnly && views.length > 1 && (
        <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
          {views.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setSp((p) => { p.set('view', k); return p; })} className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', view === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-900')}>{l}</button>)}
        </div>
      )}
      {sum && (
        <div className="mb-4 grid grid-cols-3 gap-2 lg:grid-cols-6">
          {chips.map(([l, n, f, cls]) => (
            <button key={l} type="button" onClick={() => { if (mode === 'board') switchMode('list'); list.set(f); }} className="rounded-lg border border-line bg-white px-3 py-2.5 text-left transition-colors hover:border-brand-500">
              <p className={cn('text-xl font-semibold tabular-nums text-ink-900', n > 0 && cls)}>{n}</p><p className="text-xs text-ink-500">{l}</p>
            </button>
          ))}
        </div>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        <Input placeholder="Search title or T-12…" className="max-w-xs" defaultValue={list.params.search ?? ''} onChange={(e) => list.set({ search: e.target.value || undefined })} aria-label="Search tasks" />
        {mode === 'list' && <div className="w-40"><Select aria-label="Status" value={list.params.status ?? ''} onChange={(e) => list.set({ status: e.target.value || undefined })} placeholder="Any status" options={[{ value: 'open', label: 'Open' }, ...Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))]} /></div>}
        <div className="w-36"><Select aria-label="Priority" value={list.params.priority ?? ''} onChange={(e) => list.set({ priority: e.target.value || undefined })} placeholder="Any priority" options={Object.entries(PRIORITY).map(([value, p]) => ({ value, label: p.label }))} /></div>
        <div className="w-40"><Select aria-label="Due" value={list.params.due ?? ''} onChange={(e) => list.set({ due: e.target.value || undefined })} placeholder="Any due date" options={[{ value: 'overdue', label: 'Overdue' }, { value: 'today', label: 'Due today' }, { value: 'week', label: 'Next 7 days' }, { value: 'none', label: 'No due date' }]} /></div>
        {projects.length > 0 && <div className="w-44"><Select aria-label="Project" value={list.params.projectId ?? ''} onChange={(e) => list.set({ projectId: e.target.value || undefined })} placeholder="All projects" options={projects.map((p) => ({ value: p.id, label: p.name }))} /></div>}
      </div>
      {mode === 'list' ? (
        <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} sort={list.params.sort} order={list.params.order} onSort={(sort, order) => list.set({ sort, order })}
          onRowClick={(r) => nav(`/tasks/${r.id}`)}
          empty={<EmptyState icon={<CheckCircle2 className="size-5" />} title={list.params.status === 'open' ? 'Nothing open here' : 'No tasks match'} description={a.can('tasks:create') ? 'Create a task and assign it to someone.' : 'Tasks assigned to you will appear here.'} action={a.can('tasks:create') && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />New task</Button>} />}
          columns={[
            { key: 'number', header: 'Task', sortable: true, render: (r) => (
              <div className="min-w-56">
                <p className="font-medium text-ink-900"><span className="mr-1.5 text-xs font-normal text-ink-400">{r.key}</span>{r.title}</p>
                {r.project && <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-500"><span className="size-2 rounded-full" style={{ background: r.project.color }} />{r.project.name}</p>}
              </div>) },
            view !== 'mine' && { key: 'assignee', header: 'Assignee', render: (r) => <span className="flex items-center gap-2 whitespace-nowrap"><Avatar name={r.assignee.name} />{r.assignee.name}</span> },
            { key: 'priority', header: 'Priority', sortable: true, render: (r) => <PriorityFlag value={r.priority} /> },
            { key: 'status', header: 'Status', render: (r) => <StatusPill value={r.status} /> },
            { key: 'progress', header: 'Progress', sortable: true, width: 140, render: (r) => <div className="flex items-center gap-2"><ProgressBar value={r.progress} className="w-20" /><span className="text-xs tabular-nums text-ink-500">{r.progress}%</span></div> },
            { key: 'dueOn', header: 'Due', sortable: true, render: (r) => <DueLabel task={r} /> },
          ].filter(Boolean)} />
      ) : (
        <Board tasks={list.rows} loading={list.loading} onOpen={(t) => nav(`/tasks/${t.id}`)} onMove={move} showAssignee={view !== 'mine'} />
      )}
      <TaskDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function Board({ tasks, loading, onOpen, onMove, showAssignee }) {
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  if (loading) return <div className="grid gap-3 md:grid-cols-5">{BOARD.map((s) => <Skeleton key={s} className="h-80" />)}</div>;
  return (
    <div className="grid gap-3 overflow-x-auto pb-2 md:grid-cols-5">
      {BOARD.map((s) => {
        const items = tasks.filter((t) => t.status === s);
        return (
          <section key={s} aria-label={STATUS[s].label}
            onDragOver={(e) => { e.preventDefault(); setOver(s); }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); if (drag) onMove(drag, s); setDrag(null); }}
            className={cn('flex min-h-64 min-w-52 flex-col rounded-xl border bg-canvas p-2 transition-colors', over === s ? 'border-brand-500 bg-brand-50/50' : 'border-line')}>
            <header className="flex items-center justify-between px-1.5 pb-2 pt-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-ink-900"><span className={cn('size-2 rounded-full', STATUS[s].dot)} />{STATUS[s].label}</span>
              <span className="rounded-full bg-white px-2 text-xs font-medium tabular-nums text-ink-500">{items.length}</span>
            </header>
            <div className="flex flex-1 flex-col gap-2">
              {items.map((t) => (
                <button key={t.id} type="button" draggable onDragStart={() => setDrag(t)} onDragEnd={() => setDrag(null)} onClick={() => onOpen(t)}
                  className={cn('rounded-lg border bg-white p-3 text-left shadow-card transition hover:border-brand-500', t.overdue ? 'border-danger-600/30' : 'border-line', drag?.id === t.id && 'opacity-50')}>
                  <div className="flex items-center justify-between gap-2"><span className="text-[11px] font-medium text-ink-400">{t.key}</span><PriorityFlag value={t.priority} withLabel={false} /></div>
                  <p className="mt-1 line-clamp-2 text-sm font-medium text-ink-900">{t.title}</p>
                  {t.project && <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-500"><span className="size-1.5 rounded-full" style={{ background: t.project.color }} />{t.project.name}</p>}
                  {t.progress > 0 && t.status !== 'DONE' && <ProgressBar value={t.progress} className="mt-2.5" />}
                  <div className="mt-2.5 flex items-center justify-between gap-2"><DueLabel task={t} short />{showAssignee && <Avatar name={t.assignee.name} className="size-6" />}</div>
                </button>
              ))}
              {!items.length && <p className="px-2 py-6 text-center text-xs text-ink-400">Drop tasks here</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// =========================================================================== task detail
const ACT_ICON = { CREATED: Plus, COMMENT: MessageSquare, STATUS: CircleDot, PROGRESS: CircleDot, ASSIGNED: CircleDot, EDITED: CircleDot, REPORT: Send };
function activityText(a) {
  if (a.kind === 'CREATED') return `created the task${a.to?.assignee ? ` and assigned it to ${a.to.assignee}` : ''}`;
  if (a.kind === 'STATUS') return <>moved it from <b>{STATUS[a.from?.status]?.label}</b> to <b>{STATUS[a.to?.status]?.label}</b>{a.to?.progress != null && a.from?.progress !== a.to.progress ? ` (${a.to.progress}%)` : ''}</>;
  if (a.kind === 'PROGRESS') return <>updated progress from {a.from?.progress}% to <b>{a.to?.progress}%</b></>;
  if (a.kind === 'ASSIGNED') return <>reassigned it to <b>{a.to?.assignee}</b></>;
  if (a.kind === 'EDITED') return a.body?.toLowerCase();
  if (a.kind === 'REPORT') return 'logged work in a daily report';
  return 'commented';
}

export function TaskDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: t, isPending, error } = useQuery({ queryKey: ['task', id], queryFn: () => api.get(`/tasks/${id}`) });
  const [editing, setEditing] = useState(false);
  const [del, setDel] = useState(false);
  const [comment, setComment] = useState('');
  const [prompt, setPrompt] = useState(null); // { status, title, label, required }
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['task', id] }); qc.invalidateQueries({ queryKey: ['/tasks'] }); qc.invalidateQueries({ queryKey: ['tasks-summary'] }); qc.invalidateQueries({ queryKey: ['dash-tasks'] }); };
  const patch = useAction((b) => api.patch(`/tasks/${id}`, b), { onDone: () => { refresh(); setPrompt(null); setNote(''); setProgress(null); } });
  const addComment = useAction((body) => api.post(`/tasks/${id}/comments`, { body }), { onDone: () => { refresh(); setComment(''); } });
  const remove = useAction(() => api.del(`/tasks/${id}`), { success: 'Task deleted', invalidate: ['/tasks', ['tasks-summary']], onDone: () => nav('/tasks') });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Task not found" description="It may have been deleted, or it is not assigned to you." action={<Button variant="secondary" onClick={() => nav(-1)}>Go back</Button>} />;
  const ab = t.abilities;
  const open = !['DONE', 'CANCELLED'].includes(t.status);
  const go = (status, extra = {}) => patch.mutate({ status, ...extra }, { onSuccess: () => toast.success(`Moved to ${STATUS[status].label.toLowerCase()}`) });
  const actions = [];
  if (ab.canUpdate && open) {
    if (t.status === 'TODO') actions.push(['Start work', () => go('IN_PROGRESS'), 'primary']);
    if (t.status === 'BLOCKED') actions.push(['Unblock', () => go('IN_PROGRESS'), 'primary']);
    if (t.status !== 'BLOCKED') actions.push(['Blocked', () => setPrompt({ status: 'BLOCKED', title: 'What is blocking this task?', label: 'Reason', required: true }), 'secondary']);
    if (t.status === 'IN_REVIEW' && ab.canManage) {
      actions.push(['Approve and close', () => go('DONE'), 'primary']);
      actions.push(['Request changes', () => setPrompt({ status: 'IN_PROGRESS', title: 'What should be changed?', label: 'Changes needed', required: true }), 'secondary']);
    } else if (t.status !== 'IN_REVIEW') {
      actions.push([t.requiresReview && !ab.canManage ? 'Submit for review' : 'Mark as done', () => setPrompt({ status: 'DONE', title: t.requiresReview && !ab.canManage ? 'Submit for review' : 'Mark as done', label: 'Note (optional)' }), t.status === 'TODO' ? 'secondary' : 'primary']);
    }
  }
  if (!open && ab.canManage) actions.push(['Reopen', () => go('IN_PROGRESS', { progress: Math.min(t.progress, 90) }), 'secondary']);
  const p = progress ?? t.progress;
  return (
    <>
      <button type="button" onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900"><ArrowLeft className="size-4" />Back</button>
      <div className="grid grid-cols-1 [&>*]:min-w-0 gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <Card>
            <CardBody className="space-y-4 py-5">
              <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium text-ink-400">{t.key}</span><StatusPill value={t.status} /><PriorityFlag value={t.priority} />{t.overdue && <Badge tone="danger">Overdue</Badge>}{t.requiresReview && <Badge tone="brand">Needs review</Badge>}</div>
              <h1 className="text-xl font-semibold text-ink-900">{t.title}</h1>
              {t.description ? <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700">{t.description}</p> : <p className="text-sm text-ink-400">No details added.</p>}
              {t.status === 'BLOCKED' && t.blockedReason && <p className="flex items-start gap-2 rounded-lg bg-danger-50 p-3 text-sm text-danger-700"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{t.blockedReason}</p>}
              {actions.length > 0 && <div className="flex flex-wrap gap-2 border-t border-line pt-4">{actions.map(([l, fn, v]) => <Button key={l} variant={v} size="sm" loading={patch.isPending} onClick={fn}>{l}</Button>)}</div>}
            </CardBody>
          </Card>

          {ab.canUpdate && open && (
            <Card>
              <CardHeader title="Progress" description="Move the slider to how far the work is, then save. It is also updated from your daily report." />
              <CardBody>
                <div className="flex items-center gap-4">
                  <input type="range" min={0} max={100} step={5} value={p} onChange={(e) => setProgress(Number(e.target.value))} className="flex-1 accent-[var(--color-brand-600)]" aria-label="Progress" />
                  <span className="w-12 text-right text-lg font-semibold tabular-nums">{p}%</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {[25, 50, 75, 100].map((v) => <button key={v} type="button" onClick={() => setProgress(v)} className={cn('rounded-md border px-2.5 py-1 text-xs font-medium', p === v ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line text-ink-700 hover:bg-subtle')}>{v}%</button>)}
                  <Input className="min-w-48 flex-1" placeholder="What did you do? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
                  <Button size="sm" disabled={progress == null || progress === t.progress} loading={patch.isPending} onClick={() => patch.mutate({ progress: p, ...(note && { note }) }, { onSuccess: () => toast.success('Progress saved') })}>Save progress</Button>
                </div>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Activity" description={`${t.activity.length} update${t.activity.length === 1 ? '' : 's'}`} />
            <CardBody>
              <ol className="relative space-y-4 border-l border-line pl-6">
                {t.activity.map((x) => {
                  const Ico = ACT_ICON[x.kind] ?? CircleDot;
                  return (
                    <li key={x.id} className="relative">
                      <span className={cn('absolute -left-[33px] grid size-6 place-items-center rounded-full border-2 border-white', x.kind === 'COMMENT' ? 'bg-brand-100 text-brand-700' : x.kind === 'REPORT' ? 'bg-success-50 text-success-700' : 'bg-subtle text-ink-500')}><Ico className="size-3" /></span>
                      <p className="text-sm text-ink-700"><span className="font-medium text-ink-900">{x.author?.name ?? 'System'}</span> {activityText(x)} <span className="text-xs text-ink-400">· {dt(x.at, true)}</span></p>
                      {x.body && x.kind !== 'EDITED' && <p className={cn('mt-1.5 whitespace-pre-wrap text-sm', x.kind === 'COMMENT' ? 'rounded-lg bg-canvas px-3 py-2 text-ink-900' : 'text-ink-500')}>{x.body}</p>}
                    </li>
                  );
                })}
              </ol>
              <form className="mt-5 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (comment.trim()) addComment.mutate(comment.trim()); }}>
                <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment, ask a question or share an update" aria-label="Comment" />
                <Button type="submit" className="self-end" loading={addComment.isPending} disabled={!comment.trim()}>Comment</Button>
              </form>
            </CardBody>
          </Card>
        </div>

        <aside className="space-y-5">
          <Card>
            <CardBody className="space-y-4 text-sm">
              <div><p className="text-xs text-ink-500">Assigned to</p><p className="mt-1 flex items-center gap-2 font-medium"><Avatar name={t.assignee.name} />{t.assignee.name}</p></div>
              <div><p className="text-xs text-ink-500">Assigned by</p><p className="mt-1 font-medium">{t.createdBy.name ?? '—'}</p></div>
              {t.project && <div><p className="text-xs text-ink-500">Project</p><p className="mt-1 flex items-center gap-2 font-medium"><span className="size-2.5 rounded-full" style={{ background: t.project.color }} />{t.project.name}</p></div>}
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-xs text-ink-500">Start</p><p className="mt-1 font-medium">{dt(t.startOn)}</p></div>
                <div><p className="text-xs text-ink-500">Due</p><p className="mt-1 font-medium">{dt(t.dueOn)}</p>{open && t.dueOn && daysBetween(todayKtm(), t.dueOn) <= 1 && <DueLabel task={t} />}</div>
              </div>
              <div>
                <div className="flex justify-between text-xs text-ink-500"><span>Progress</span><span className="tabular-nums">{t.progress}%</span></div>
                <ProgressBar value={t.progress} className="mt-1.5 h-2" />
              </div>
              <div>
                <div className="flex justify-between text-xs text-ink-500"><span>Hours logged</span><span className="tabular-nums">{t.loggedHours}{t.estimateHours ? ` of ${t.estimateHours}` : ''} h</span></div>
                {t.estimateHours > 0 && <ProgressBar value={(t.loggedHours / t.estimateHours) * 100} className="mt-1.5 h-2" tone={t.loggedHours > t.estimateHours ? 'bg-warning-600' : 'bg-ink-400'} />}
              </div>
              {t.completedAt && <div><p className="text-xs text-ink-500">Completed</p><p className="mt-1 font-medium">{dt(t.completedAt, true)}</p></div>}
              <p className="text-xs text-ink-400">Created {dt(t.createdAt, true)}</p>
            </CardBody>
          </Card>
          {(ab.canManage || ab.canDelete) && (
            <div className="flex gap-2">
              {ab.canManage && <Button variant="secondary" className="flex-1" onClick={() => setEditing(true)}>Edit task</Button>}
              {ab.canDelete && <Button variant="ghost" className="text-danger-600 hover:bg-danger-50" onClick={() => setDel(true)} aria-label="Delete task"><Trash2 className="size-4" /></Button>}
            </div>
          )}
        </aside>
      </div>
      <TaskDialog open={editing} onClose={() => setEditing(false)} task={t} onSaved={refresh} />
      <ConfirmDialog open={del} onCancel={() => setDel(false)} onConfirm={() => remove.mutate()} loading={remove.isPending} destructive confirmLabel="Delete task" title={`Delete ${t.key}?`} description="The task and its activity are removed from lists and reports. Hours already reported stay in the daily reports." />
      <Dialog open={!!prompt} onClose={() => setPrompt(null)} title={prompt?.title} size="sm"
        footer={<><Button variant="secondary" onClick={() => setPrompt(null)}>Cancel</Button><Button loading={patch.isPending} disabled={prompt?.required && !note.trim()} onClick={() => patch.mutate({ status: prompt.status, ...(prompt.status === 'BLOCKED' ? { blockedReason: note.trim() } : {}), ...(note.trim() && { note: note.trim() }) }, { onSuccess: (r) => toast.success(`Moved to ${STATUS[r.status].label.toLowerCase()}`) })}>Save</Button></>}>
        <Field label={prompt?.label} required={prompt?.required}><Textarea rows={3} autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Dialog>
    </>
  );
}

// =========================================================================== daily report (employee)
const blankItem = (task) => ({ key: Math.random().toString(36).slice(2), taskId: task?.id ?? '', description: '', hours: '', progress: task ? task.progress : '', completed: false });

export function DailyReport() {
  const [sp, setSp] = useSearchParams();
  const date = sp.get('date') ?? todayKtm();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isPending, error } = useQuery({ queryKey: ['my-report', date], queryFn: () => api.get(`/work-reports/mine?date=${date}`) });
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!data) return;
    const r = data.report;
    setForm({
      summary: r?.summary ?? '', challenges: r?.challenges ?? '', planNext: r?.planNext ?? '',
      items: r?.items?.length ? r.items.map((i) => ({ key: i.id, taskId: i.task?.id ?? '', description: i.description, hours: i.hours || '', progress: i.progress ?? '', completed: i.completed }))
        : data.tasks.filter((t) => t.status === 'IN_PROGRESS').slice(0, 5).map((t) => blankItem(t)),
    });
  }, [data]);
  const save = useAction((submit) => api.put(`/work-reports/mine/${date}`, {
    summary: form.summary || null, challenges: form.challenges || null, planNext: form.planNext || null, submit,
    items: form.items.filter((i) => i.description.trim() || i.taskId).map((i) => {
      const task = data.tasks.find((t) => t.id === i.taskId);
      return { taskId: i.taskId || null, description: i.description.trim() || (task ? `Worked on ${task.title}` : 'Work'), hours: Number(i.hours) || 0, progress: i.progress === '' ? null : Number(i.progress), completed: !!i.completed };
    }),
  }), {
    success: (r, submit) => (submit ? 'Report submitted to your manager' : 'Draft saved'),
    onDone: () => { qc.invalidateQueries({ queryKey: ['my-report'] }); qc.invalidateQueries({ queryKey: ['dash-report'] }); qc.invalidateQueries({ queryKey: ['/tasks'] }); qc.invalidateQueries({ queryKey: ['dash-tasks'] }); },
  });
  if (error) return <EmptyState title="Daily reports are not available" description={error.message} />;
  if (isPending || !form) return <Skeleton className="h-96" />;
  const r = data.report;
  const editable = data.editable;
  const used = new Set(form.items.map((i) => i.taskId).filter(Boolean));
  const total = form.items.reduce((s, i) => s + (Number(i.hours) || 0), 0);
  const setItem = (key, patchItem) => setForm((f) => ({ ...f, items: f.items.map((i) => (i.key === key ? { ...i, ...patchItem } : i)) }));
  const att = data.attendance;
  const minDate = addDays(todayKtm(), -14);
  return (
    <>
      <PageHeader title="Daily work report" description="What you worked on, what you finished and what got in the way. Your manager reviews it and gives feedback."
        actions={<div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={date <= minDate} onClick={() => setSp({ date: addDays(date, -1) })} aria-label="Previous day">‹</Button>
          <Input type="date" value={date} min={minDate} max={todayKtm()} onChange={(e) => e.target.value && setSp({ date: e.target.value })} className="w-40" aria-label="Report date" />
          <Button variant="secondary" size="sm" disabled={date >= todayKtm()} onClick={() => setSp({ date: addDays(date, 1) })} aria-label="Next day">›</Button>
        </div>} />

      <div className="grid grid-cols-1 [&>*]:min-w-0 gap-5 lg:grid-cols-[1fr_19rem]">
        <div className="space-y-5">
          {r && r.status !== 'DRAFT' && (
            <div className={cn('rounded-xl border p-4', r.status === 'APPROVED' ? 'border-success-600/20 bg-success-50' : r.status === 'CHANGES_REQUESTED' ? 'border-danger-600/20 bg-danger-50' : 'border-warning-600/20 bg-warning-50')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-ink-900">{r.status === 'APPROVED' ? 'Reviewed and approved' : r.status === 'CHANGES_REQUESTED' ? 'Your manager asked for changes' : 'Submitted, waiting for review'}</p>
                {r.rating && <Stars value={r.rating} />}
              </div>
              {r.feedback && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700"><span className="font-medium">{r.reviewer?.name ?? 'Manager'}:</span> {r.feedback}</p>}
              {r.status === 'SUBMITTED' && <p className="mt-1 text-sm text-ink-700">Submitted {dt(r.submittedAt, true)}. You can change it only if your manager asks for changes.</p>}
            </div>
          )}

          <Card>
            <CardHeader title="Work done" description="Add each task you worked on. Progress and completion are copied to the task when you submit." actions={<span className="text-sm font-semibold tabular-nums text-ink-900">{Math.round(total * 100) / 100} h</span>} />
            <CardBody className="space-y-3">
              {form.items.length > 0 && <div className="hidden grid-cols-[1fr_6rem_7rem_2.25rem] gap-2 px-3 text-xs font-medium text-ink-500 sm:grid"><span>Task</span><span>Hours</span><span>Progress after today</span><span /></div>}
              {form.items.map((i) => {
                const task = data.tasks.find((t) => t.id === i.taskId);
                return (
                  <div key={i.key} className="rounded-xl border border-line p-3">
                    <div className="grid gap-2 sm:grid-cols-[1fr_6rem_7rem_auto]">
                      <Select aria-label="Task" disabled={!editable} value={i.taskId} onChange={(e) => { const tk = data.tasks.find((x) => x.id === e.target.value); setItem(i.key, { taskId: e.target.value, progress: tk ? tk.progress : '' }); }}
                        placeholder="Other work (no task)" options={data.tasks.filter((t) => t.id === i.taskId || !used.has(t.id)).map((t) => ({ value: t.id, label: `${t.key} · ${t.title}` }))} />
                      <Input aria-label="Hours" type="number" min={0} max={24} step={0.25} placeholder="Hours" disabled={!editable} value={i.hours} onChange={(e) => setItem(i.key, { hours: e.target.value })} />
                      {task ? <div className="flex items-center gap-1"><Input aria-label="Progress %" type="number" min={0} max={100} step={5} disabled={!editable || i.completed} value={i.completed ? 100 : i.progress} onChange={(e) => setItem(i.key, { progress: e.target.value })} /><span className="text-sm text-ink-500">%</span></div> : <span />}
                      {editable && <Button variant="ghost" size="sm" onClick={() => setForm((f) => ({ ...f, items: f.items.filter((x) => x.key !== i.key) }))} aria-label="Remove line"><X className="size-4" /></Button>}
                    </div>
                    <Textarea rows={2} className="mt-2" disabled={!editable} placeholder={task ? 'What exactly did you do on this task today?' : 'Describe the work (meeting, support, training…)'} value={i.description} onChange={(e) => setItem(i.key, { description: e.target.value })} aria-label="Description" />
                    {task && <div className="mt-2"><Checkbox disabled={!editable} label={task.requiresReview ? 'Finished: send for review' : 'Finished this task'} checked={i.completed} onChange={(e) => setItem(i.key, { completed: e.target.checked })} /></div>}
                  </div>
                );
              })}
              {editable && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button variant="secondary" size="sm" onClick={() => setForm((f) => ({ ...f, items: [...f.items, blankItem()] }))}><Plus className="size-4" />Add work</Button>
                  {data.tasks.filter((t) => !used.has(t.id) && !['DONE', 'CANCELLED'].includes(t.status)).slice(0, 6).map((t) => (
                    <button key={t.id} type="button" onClick={() => setForm((f) => ({ ...f, items: [...f.items, blankItem(t)] }))} className="inline-flex max-w-64 items-center gap-1.5 truncate rounded-full border border-dashed border-line-strong px-3 py-1 text-xs text-ink-700 hover:border-brand-500 hover:text-brand-700"><Plus className="size-3" />{t.key} {t.title}</button>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardBody className="grid grid-cols-1 [&>*]:min-w-0 gap-4 py-5">
              <Field label="Summary of the day" hint="The main things you completed."><Textarea rows={3} disabled={!editable} value={form.summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} /></Field>
              <Field label="Challenges or blockers" hint="Anything that slowed you down or needs your manager's help."><Textarea rows={3} disabled={!editable} value={form.challenges} onChange={(e) => setForm((f) => ({ ...f, challenges: e.target.value }))} /></Field>
              <Field label="Plan for the next working day"><Textarea rows={2} disabled={!editable} value={form.planNext} onChange={(e) => setForm((f) => ({ ...f, planNext: e.target.value }))} /></Field>
            </CardBody>
            {editable && (
              <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-canvas px-5 py-3">
                <Button variant="secondary" loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Save draft</Button>
                <Button loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}><Send className="size-4" />{r?.status === 'CHANGES_REQUESTED' ? 'Resubmit report' : 'Submit report'}</Button>
              </div>
            )}
          </Card>
        </div>

        <aside className="space-y-5">
          <Card>
            <CardHeader title={date === todayKtm() ? 'Today' : dt(date)} />
            <CardBody className="text-sm">
              {att ? (
                <dl className="grid grid-cols-2 gap-3">
                  <div><dt className="text-xs text-ink-500">In</dt><dd className="font-medium">{timeOf(att.clockIn)}</dd></div>
                  <div><dt className="text-xs text-ink-500">Out</dt><dd className="font-medium">{timeOf(att.clockOut)}</dd></div>
                  <div><dt className="text-xs text-ink-500">Worked</dt><dd className="font-medium">{hours(att.workedMinutes)}</dd></div>
                  <div><dt className="text-xs text-ink-500">Status</dt><dd className="font-medium">{att.status.replace('_', ' ').toLowerCase()}{att.lateMinutes > 0 && <span className="text-warning-700"> · {att.lateMinutes} min late</span>}</dd></div>
                </dl>
              ) : <p className="text-ink-500">No attendance recorded for this day.</p>}
              {att?.workedMinutes > 0 && total > att.workedMinutes / 60 + 0.5 && <p className="mt-3 rounded-md bg-warning-50 p-2 text-xs text-warning-700">You reported more hours than your attendance shows.</p>}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Recent reports" />
            <ul className="divide-y divide-line">
              {data.recent.length === 0 && <li className="px-5 py-4 text-sm text-ink-500">Your submitted reports will appear here.</li>}
              {data.recent.map((x) => (
                <li key={x.id}><button type="button" onClick={() => setSp({ date: x.date })} className="w-full px-5 py-3 text-left hover:bg-subtle">
                  <div className="flex items-center justify-between gap-2"><span className="text-sm font-medium">{dt(x.date)}</span>{x.rating ? <Stars value={x.rating} size="size-3.5" /> : <Badge tone={REPORT_STATUS[x.status].tone}>{REPORT_STATUS[x.status].label}</Badge>}</div>
                  {x.feedback && <p className="mt-1 line-clamp-2 text-xs text-ink-500">“{x.feedback}”</p>}
                </button></li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}

// =========================================================================== review queue (managers)
const RTABS = [['SUBMITTED', 'Awaiting review'], ['CHANGES_REQUESTED', 'Changes requested'], ['APPROVED', 'Approved'], ['ALL', 'All']];
export function WorkReports() {
  const nav = useNavigate();
  const [range, setRange] = useState({ from: addDays(todayKtm(), -30), to: todayKtm() });
  const list = useList('/work-reports', { status: 'SUBMITTED', ...range, pageSize: 50 });
  const { data: missing } = useQuery({ queryKey: ['missing-reports'], queryFn: () => api.get('/work-reports/missing'), retry: false });
  return (
    <>
      <PageHeader title="Work reports" description="Review your team's daily reports, rate them and leave feedback." />
      <div className="grid grid-cols-1 [&>*]:min-w-0 gap-5 lg:grid-cols-[1fr_17rem]">
        <div>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div className="flex gap-1 overflow-x-auto border-b border-line" role="tablist">
              {RTABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={list.params.status === k} onClick={() => list.set({ status: k })} className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', list.params.status === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-900')}>{l}</button>)}
            </div>
            <div className="flex items-center gap-2">
              <Input type="date" className="w-38" value={range.from} max={range.to} onChange={(e) => { const v = { ...range, from: e.target.value }; setRange(v); list.set(v); }} aria-label="From" />
              <span className="text-ink-400">to</span>
              <Input type="date" className="w-38" value={range.to} max={todayKtm()} onChange={(e) => { const v = { ...range, to: e.target.value }; setRange(v); list.set(v); }} aria-label="To" />
            </div>
          </div>
          {list.loading ? <Skeleton className="h-64" /> : !list.rows.length ? (
            <Card><EmptyState icon={<CheckCircle2 className="size-5" />} title={list.params.status === 'SUBMITTED' ? 'All caught up' : 'No reports'} description={list.params.status === 'SUBMITTED' ? 'There are no reports waiting for your review.' : 'Nothing in this period.'} /></Card>
          ) : (
            <div className="space-y-2">
              {list.rows.map((r) => (
                <button key={r.id} type="button" onClick={() => nav(`/work-reports/${r.id}`)} className="flex w-full gap-4 rounded-xl border border-line bg-white p-4 text-left shadow-card transition hover:border-brand-500">
                  <Avatar name={r.employee.name} className="size-9 text-xs" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-semibold text-ink-900">{r.employee.name}</span><span className="text-sm text-ink-500">{dt(r.date)}</span><Badge tone={REPORT_STATUS[r.status].tone}>{REPORT_STATUS[r.status].label}</Badge></div>
                    <p className="mt-1 line-clamp-2 text-sm text-ink-700">{r.summary || r.items.map((i) => i.description).join(' · ') || 'No summary'}</p>
                    {r.challenges && <p className="mt-1 flex items-start gap-1.5 text-xs text-warning-700"><AlertTriangle className="mt-px size-3.5 shrink-0" /><span className="line-clamp-1">{r.challenges}</span></p>}
                  </div>
                  <div className="shrink-0 text-right"><p className="text-sm font-semibold tabular-nums">{r.hours} h</p><p className="text-xs text-ink-500">{r.items.length} item{r.items.length === 1 ? '' : 's'}</p>{r.rating && <Stars value={r.rating} size="size-3.5" />}</div>
                </button>
              ))}
              {list.meta?.totalPages > 1 && <div className="flex justify-end gap-2 pt-2"><Button size="sm" variant="secondary" disabled={list.params.page <= 1} onClick={() => list.page(list.params.page - 1)}>Previous</Button><Button size="sm" variant="secondary" disabled={list.params.page >= list.meta.totalPages} onClick={() => list.page(list.params.page + 1)}>Next</Button></div>}
            </div>
          )}
        </div>
        <aside>
          <Card>
            <CardHeader title="Not submitted today" description="At work today, no report yet." />
            <ul className="divide-y divide-line">
              {!missing && <li className="px-5 py-4"><Skeleton className="h-6" /></li>}
              {missing?.employees.length === 0 && <li className="px-5 py-4 text-sm text-ink-500">Everyone at work today has reported.</li>}
              {missing?.employees.map((e) => <li key={e.id} className="flex items-center gap-2.5 px-5 py-2.5 text-sm"><Avatar name={e.name} className="size-6" />{e.name}</li>)}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}

export function WorkReportDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: r, isPending, error } = useQuery({ queryKey: ['work-report', id], queryFn: () => api.get(`/work-reports/${id}`) });
  const [rating, setRating] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (r) { setRating(r.rating ?? 0); setFeedback(r.feedback ?? ''); } }, [r]);
  const review = useAction((decision) => api.post(`/work-reports/${id}/review`, { decision, ...(rating && { rating }), ...(feedback.trim() && { feedback: feedback.trim() }) }), {
    success: (x, d) => (d === 'APPROVE' ? 'Report approved' : 'Changes requested'),
    onDone: () => { qc.invalidateQueries({ queryKey: ['work-report', id] }); qc.invalidateQueries({ queryKey: ['/work-reports'] }); },
  });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Report not found" action={<Button variant="secondary" onClick={() => nav(-1)}>Go back</Button>} />;
  const att = r.attendance;
  const decide = (d) => {
    if (d === 'APPROVE' && !rating) { setErr('Choose a rating from 1 to 5'); return; }
    if (d === 'REQUEST_CHANGES' && !feedback.trim()) { setErr('Say what needs to change'); return; }
    setErr(''); review.mutate(d);
  };
  return (
    <>
      <button type="button" onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900"><ArrowLeft className="size-4" />Back</button>
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <Avatar name={r.employee.name} className="size-11 text-sm" />
        <div><h1 className="text-xl font-semibold">{r.employee.name}</h1><p className="text-sm text-ink-500">Daily report for {dt(r.date)}{r.submittedAt && ` · submitted ${dt(r.submittedAt, true)}`}</p></div>
        <Badge tone={REPORT_STATUS[r.status].tone} className="ml-auto">{REPORT_STATUS[r.status].label}</Badge>
      </div>
      <div className="grid grid-cols-1 [&>*]:min-w-0 gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Work done" actions={<span className="text-sm font-semibold tabular-nums">{r.hours} h</span>} />
            <ul className="divide-y divide-line">
              {r.items.map((i) => (
                <li key={i.id} className="flex gap-4 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    {i.task ? <Link to={`/tasks/${i.task.id}`} className="text-sm font-medium text-brand-700 hover:underline">{i.task.key} · {i.task.title}</Link> : <p className="text-sm font-medium text-ink-900">Other work</p>}
                    <p className="mt-0.5 whitespace-pre-wrap text-sm text-ink-700">{i.description}</p>
                  </div>
                  <div className="shrink-0 text-right text-sm">
                    <p className="font-semibold tabular-nums">{i.hours} h</p>
                    {i.completed ? <Badge tone="success">Finished</Badge> : i.progress != null && <p className="text-xs text-ink-500">{i.progress}% done</p>}
                  </div>
                </li>
              ))}
              {!r.items.length && <li className="px-5 py-4 text-sm text-ink-500">No itemised work.</li>}
            </ul>
          </Card>
          <Card>
            <CardBody className="space-y-4 py-5 text-sm">
              <div><p className="text-xs font-medium text-ink-500">Summary</p><p className="mt-1 whitespace-pre-wrap text-ink-900">{r.summary || '—'}</p></div>
              <div><p className="text-xs font-medium text-ink-500">Challenges</p>{r.challenges ? <p className="mt-1 whitespace-pre-wrap rounded-lg bg-warning-50 p-3 text-ink-900">{r.challenges}</p> : <p className="mt-1 text-ink-400">None reported</p>}</div>
              <div><p className="text-xs font-medium text-ink-500">Plan for next day</p><p className="mt-1 whitespace-pre-wrap text-ink-900">{r.planNext || '—'}</p></div>
            </CardBody>
          </Card>
        </div>
        <aside className="space-y-5">
          {r.canReview ? (
            <Card>
              <CardHeader title={r.status === 'APPROVED' ? 'Update your review' : 'Your review'} />
              <CardBody className="space-y-4">
                <div>
                  <p className="mb-1.5 text-sm font-medium">Rating</p>
                  <div className="flex gap-1" role="radiogroup" aria-label="Rating">
                    {[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => setRating(n)} className="rounded p-0.5 hover:bg-subtle"><Star className={cn('size-7', n <= rating ? 'fill-warning-600 text-warning-600' : 'text-line-strong')} /></button>)}
                  </div>
                  <p className="mt-1 text-xs text-ink-500">{['', 'Needs a lot of improvement', 'Below expectations', 'Meets expectations', 'Good work', 'Excellent'][rating]}</p>
                </div>
                <Field label="Feedback"><Textarea rows={4} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What went well, what to improve, answers to their challenges" /></Field>
                {err && <p role="alert" className="text-sm text-danger-600">{err}</p>}
                <div className="flex flex-col gap-2">
                  <Button loading={review.isPending && review.variables === 'APPROVE'} onClick={() => decide('APPROVE')}><CheckCircle2 className="size-4" />Approve</Button>
                  {r.status === 'SUBMITTED' && <Button variant="secondary" loading={review.isPending && review.variables === 'REQUEST_CHANGES'} onClick={() => decide('REQUEST_CHANGES')}>Ask for changes</Button>}
                </div>
              </CardBody>
            </Card>
          ) : (r.rating || r.feedback) && (
            <Card><CardHeader title="Review" /><CardBody className="space-y-2 text-sm">{r.rating && <Stars value={r.rating} />}{r.feedback && <p className="whitespace-pre-wrap">{r.feedback}</p>}<p className="text-xs text-ink-500">{r.reviewer?.name} · {dt(r.reviewedAt, true)}</p></CardBody></Card>
          )}
          <Card>
            <CardHeader title="That day" />
            <CardBody className="space-y-3 text-sm">
              {att ? <p>In {timeOf(att.clockIn)} · Out {timeOf(att.clockOut)} · {hours(att.workedMinutes)}{att.lateMinutes > 0 && <span className="text-warning-700"> · {att.lateMinutes} min late</span>}</p> : <p className="text-ink-500">No attendance record.</p>}
              <p className="text-ink-700">{r.context.openTasks} open task{r.context.openTasks === 1 ? '' : 's'}{r.context.overdue > 0 && <span className="text-danger-600"> · {r.context.overdue} overdue</span>}</p>
              <Link to={`/performance/${r.employee.id}`} className="inline-flex text-sm font-medium text-brand-700 hover:underline">View performance</Link>
            </CardBody>
          </Card>
        </aside>
      </div>
    </>
  );
}

// =========================================================================== performance
const RANGES = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']];
export const ScorePill = ({ score }) => {
  if (score == null) return <span className="text-xs text-ink-400">No data</span>;
  const tone = score >= 80 ? 'bg-success-50 text-success-700' : score >= 60 ? 'bg-brand-50 text-brand-700' : score >= 40 ? 'bg-warning-50 text-warning-700' : 'bg-danger-50 text-danger-700';
  return <span className={cn('inline-flex min-w-10 justify-center rounded-md px-2 py-0.5 text-sm font-semibold tabular-nums', tone)}>{score}</span>;
};
const pctText = (v) => (v == null ? '—' : `${v}%`);

export function Performance() {
  const nav = useNavigate();
  const [days, setDays] = useState(30);
  const [dept, setDept] = useState('');
  const from = addDays(todayKtm(), -(days - 1));
  const { data: depts = [] } = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments?pageSize=100') });
  const { data, isPending } = useQuery({ queryKey: ['performance', days, dept], queryFn: () => api.get(`/performance?from=${from}&to=${todayKtm()}${dept ? `&departmentId=${dept}` : ''}`) });
  const [sort, setSort] = useState({ key: 'score', order: 'desc' });
  const rows = useMemo(() => {
    const get = { score: (r) => r.score ?? -1, name: (r) => r.employee.name, completed: (r) => r.tasks.completed, overdue: (r) => r.tasks.overdue, onTime: (r) => r.tasks.onTimeRate ?? -1, reports: (r) => r.reports.rate ?? -1, rating: (r) => r.reports.avgRating ?? -1 }[sort.key];
    return [...(data?.rows ?? [])].sort((a, b) => (get(a) > get(b) ? 1 : get(a) < get(b) ? -1 : 0) * (sort.order === 'asc' ? 1 : -1));
  }, [data, sort]);
  const t = data?.totals;
  return (
    <>
      <PageHeader title="Performance" description="Delivery, daily reporting, manager ratings and punctuality for the people you manage."
        actions={<>
          <div className="w-44"><Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="All departments" options={(Array.isArray(depts) ? depts : []).map((d) => ({ value: d.id, label: d.name }))} /></div>
          <div className="flex rounded-lg border border-line bg-white p-0.5">{RANGES.map(([d, l]) => <button key={d} type="button" onClick={() => setDays(d)} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', days === d ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-subtle')}>{l}</button>)}</div>
        </>} />
      {t && (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
          {[['Average score', t.avgScore ?? '—'], ['Tasks completed', t.completed], ['Overdue now', t.overdue], ['Reports submitted', t.reportsSubmitted], ['Awaiting your review', t.awaitingReview]].map(([l, v]) => (
            <Card key={l} className="p-4"><p className="text-xs text-ink-500">{l}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{v}</p></Card>
          ))}
        </div>
      )}
      <DataTable loading={isPending} rows={rows.map((r) => ({ ...r, id: r.employee.id }))} sort={sort.key} order={sort.order} onSort={(key, order) => setSort({ key, order })}
        onRowClick={(r) => nav(`/performance/${r.employee.id}`)}
        empty={<EmptyState title="No one to show" description="Performance appears once people have tasks, reports or attendance in this period." />}
        columns={[
          { key: 'name', header: 'Employee', sortable: true, render: (r) => <span className="flex items-center gap-2.5"><Avatar name={r.employee.name} /><span><span className="block font-medium text-ink-900">{r.employee.name}</span><span className="text-xs text-ink-500">{[r.employee.designation, r.employee.department].filter(Boolean).join(' · ') || r.employee.employeeCode}</span></span></span> },
          { key: 'score', header: 'Score', sortable: true, render: (r) => <ScorePill score={r.score} /> },
          { key: 'completed', header: 'Done', sortable: true, align: 'right', render: (r) => <span className="tabular-nums">{r.tasks.completed}</span> },
          { key: 'onTime', header: 'On time', sortable: true, align: 'right', render: (r) => <span className="tabular-nums">{pctText(r.tasks.onTimeRate)}</span> },
          { key: 'overdue', header: 'Overdue', sortable: true, align: 'right', render: (r) => <span className={cn('tabular-nums', r.tasks.overdue > 0 && 'font-medium text-danger-600')}>{r.tasks.overdue}</span> },
          { key: 'reports', header: 'Reports', sortable: true, align: 'right', render: (r) => <span className="tabular-nums">{r.reports.submitted}{r.reports.expected ? <span className="text-ink-400">/{r.reports.expected}</span> : ''}</span> },
          { key: 'rating', header: 'Rating', sortable: true, render: (r) => (r.reports.avgRating ? <span className="flex items-center gap-1.5"><Stars value={Math.round(r.reports.avgRating)} size="size-3.5" /><span className="text-xs tabular-nums text-ink-500">{r.reports.avgRating}</span></span> : <span className="text-xs text-ink-400">—</span>) },
          { key: 'late', header: 'Late', align: 'right', render: (r) => <span className="tabular-nums">{r.attendance.late}</span> },
        ]} />
      <p className="mt-3 text-xs text-ink-500">Score (0–100) combines tasks finished by their due date (35%), daily reports submitted on days at work (25%), manager ratings (25%) and punctuality (15%). Only indicators with data are counted, and at least two are needed for a score.</p>
    </>
  );
}

export function EmployeePerformance({ self }) {
  const params = useParams();
  const a = useAuth();
  const id = self ? a.employeeId : params.id;
  const nav = useNavigate();
  const [days, setDays] = useState(30);
  const from = addDays(todayKtm(), -(days - 1));
  const { data: d, isPending, error } = useQuery({ queryKey: ['emp-perf', id, days], queryFn: () => api.get(`/performance/employees/${id}?from=${from}&to=${todayKtm()}`), enabled: !!id });
  if (!id) return <EmptyState title="Not linked to an employee record" description="Ask HR to link your login to your employee profile." />;
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Not available" description={error.message} />;
  const ind = [
    ['Tasks finished on time', pctText(d.tasks?.onTimeRate), `${d.tasks?.onTime ?? 0} of ${d.tasks?.completed ?? 0} completed with a due date`],
    ['Daily reports', pctText(d.reports?.rate), `${d.reports?.submitted ?? 0} submitted for ${d.reports?.expected ?? 0} working days (today counts once its report is in)`],
    ['Average rating', d.reports?.avgRating ? `${d.reports.avgRating} / 5` : '—', `${d.reports?.rated ?? 0} report${d.reports?.rated === 1 ? '' : 's'} rated`],
    ['Punctuality', pctText(d.attendance?.punctuality), `${d.attendance?.late ?? 0} late of ${d.attendance?.present ?? 0} days`],
  ];
  return (
    <>
      {!self && <button type="button" onClick={() => nav(-1)} className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900"><ArrowLeft className="size-4" />Back</button>}
      <PageHeader title={self ? 'My performance' : d.employee?.name ?? 'Performance'} description={self ? 'How your work is going, based on your tasks, daily reports, feedback and attendance.' : [d.employee?.designation, d.employee?.department].filter(Boolean).join(' · ')}
        actions={<div className="flex rounded-lg border border-line bg-white p-0.5">{RANGES.map(([n, l]) => <button key={n} type="button" onClick={() => setDays(n)} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', days === n ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-subtle')}>{l}</button>)}</div>} />
      <div className="grid grid-cols-1 [&>*]:min-w-0 gap-5 lg:grid-cols-[18rem_1fr]">
        <Card className="flex flex-col items-center justify-center p-6 text-center">
          <ScoreRing score={d.score} />
          <p className="mt-3 text-sm font-medium text-ink-900">Performance score</p>
          <p className="mt-1 text-xs text-ink-500">{d.score == null ? 'Not enough data yet. A score needs at least two of: tasks with due dates, daily reports, ratings and attendance.' : d.score >= 80 ? 'Excellent' : d.score >= 60 ? 'Good' : d.score >= 40 ? 'Needs attention' : 'Needs support'}</p>
        </Card>
        <div className="grid gap-3 sm:grid-cols-2">
          {ind.map(([l, v, h]) => <Card key={l} className="p-4"><p className="text-xs text-ink-500">{l}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{v}</p><p className="mt-1 text-xs text-ink-500">{h}</p></Card>)}
        </div>
      </div>
      <div className="mt-5 grid grid-cols-1 [&>*]:min-w-0 gap-5 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader title="Last 8 weeks" description="Tasks completed per week and average rating" />
          <CardBody className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={d.trend.map((w) => ({ ...w, label: w.week.slice(5) }))}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} />
                <YAxis yAxisId="l" allowDecimals={false} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={28} />
                <YAxis yAxisId="r" orientation="right" domain={[0, 5]} ticks={[0, 1, 2, 3, 4, 5]} tick={{ fontSize: 12 }} tickLine={false} axisLine={false} width={24} />
                <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="l" dataKey="completed" name="Tasks completed" fill="#2453d6" radius={[4, 4, 0, 0]} />
                <Line yAxisId="r" dataKey="rating" name="Avg rating" stroke="#d97706" strokeWidth={2} connectNulls dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Recent feedback" />
          <ul className="divide-y divide-line">
            {d.feedback.length === 0 && <li className="px-5 py-4 text-sm text-ink-500">No reviewed reports yet.</li>}
            {d.feedback.map((f) => (
              <li key={f.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2"><Link to={`/work-reports/${f.id}`} className="text-sm font-medium hover:text-brand-700">{dt(f.date)}</Link>{f.rating ? <Stars value={f.rating} size="size-3.5" /> : <Badge tone={REPORT_STATUS[f.status]?.tone}>{REPORT_STATUS[f.status]?.label}</Badge>}</div>
                {f.feedback && <p className="mt-1 text-sm text-ink-700">“{f.feedback}”</p>}
                <p className="mt-0.5 text-xs text-ink-400">{f.reviewer}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[['Open tasks', d.tasks?.open ?? 0], ['Overdue', d.tasks?.overdue ?? 0], ['Blocked', d.tasks?.blocked ?? 0], ['Hours reported', d.reports?.hours ?? 0]].map(([l, v]) => <Card key={l} className="p-4"><p className="text-xs text-ink-500">{l}</p><p className="mt-1 text-xl font-semibold tabular-nums">{v}</p></Card>)}
      </div>
    </>
  );
}

export function ScoreRing({ score, size = 120 }) {
  const r = 52; const c = 2 * Math.PI * r;
  const v = score ?? 0;
  const color = score == null ? '#cbd5e1' : v >= 80 ? '#16a34a' : v >= 60 ? '#2453d6' : v >= 40 ? '#d97706' : '#dc2626';
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={score == null ? 'No score' : `Score ${score} of 100`}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="#eef1f6" strokeWidth="10" />
      <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} transform="rotate(-90 60 60)" style={{ transition: 'stroke-dashoffset .6s ease' }} />
      <text x="60" y="66" textAnchor="middle" className="fill-ink-900" style={{ fontSize: 28, fontWeight: 600 }}>{score ?? '—'}</text>
    </svg>
  );
}

// =========================================================================== projects
export function Projects() {
  const a = useAuth();
  const nav = useNavigate();
  const { data = [], isPending } = useProjects();
  const [dlg, setDlg] = useState(null);
  const { data: people = [] } = useQuery({ queryKey: ['employees-mini'], queryFn: () => api.get('/employees?pageSize=100&sort=firstName&order=asc'), enabled: !!dlg });
  const save = useAction((b) => (dlg?.id ? api.patch(`/projects/${dlg.id}`, b) : api.post('/projects', b)), { success: 'Project saved', invalidate: [['projects']], onDone: () => setDlg(null) });
  const STATUS_P = { ACTIVE: ['Active', 'success'], ON_HOLD: ['On hold', 'warning'], COMPLETED: ['Completed', 'brand'], ARCHIVED: ['Archived', 'neutral'] };
  return (
    <>
      <PageHeader title="Projects" description="Group related tasks and follow how far each project is." actions={a.can('projects:create') && <Button onClick={() => setDlg({})}><FolderKanban className="size-4" />New project</Button>} />
      {isPending ? <Skeleton className="h-48" /> : !data.length ? (
        <Card><EmptyState icon={<FolderKanban className="size-5" />} title="No projects yet" description="Projects are optional. Use them to group tasks for a client, a launch or a department goal." action={a.can('projects:create') && <Button size="sm" onClick={() => setDlg({})}>New project</Button>} /></Card>
      ) : (
        <div className="grid grid-cols-1 [&>*]:min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id} className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                <span className="mt-1 size-3 shrink-0 rounded-full" style={{ background: p.color }} />
                <div className="min-w-0 flex-1"><p className="font-semibold text-ink-900">{p.name}</p><p className="text-xs text-ink-500">{[p.code, p.lead?.name && `Lead: ${p.lead.name}`].filter(Boolean).join(' · ')}</p></div>
                <Badge tone={STATUS_P[p.status][1]}>{STATUS_P[p.status][0]}</Badge>
              </div>
              {p.description && <p className="mt-3 line-clamp-2 text-sm text-ink-700">{p.description}</p>}
              <div className="mt-4"><div className="flex justify-between text-xs text-ink-500"><span>{p.tasks.done} of {p.tasks.total - (p.tasks.total - p.tasks.done - p.tasks.open)} tasks done</span><span className="tabular-nums">{p.tasks.percent}%</span></div><ProgressBar value={p.tasks.percent} className="mt-1.5 h-2" /></div>
              {p.endsOn && <p className="mt-2 text-xs text-ink-500">Target {dt(p.endsOn)}</p>}
              <div className="mt-auto flex gap-2 pt-4">
                <Button size="sm" variant="secondary" className="flex-1" onClick={() => nav(`/tasks?view=all&projectId=${p.id}`)}>View tasks ({p.tasks.open} open)</Button>
                {a.can('projects:edit') && <Button size="sm" variant="ghost" onClick={() => setDlg(p)}>Edit</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      <FormDialog open={!!dlg} onClose={() => setDlg(null)} title={dlg?.id ? 'Edit project' : 'New project'} initial={dlg?.id ? { ...dlg, leadEmployeeId: dlg.leadEmployeeId ?? '' } : { color: '#2453d6', status: 'ACTIVE' }}
        loading={save.isPending} error={save.error}
        fields={[
          { name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Short code', placeholder: 'e.g. WEB' },
          { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
          { name: 'leadEmployeeId', label: 'Project lead', type: 'select', options: (people ?? []).map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` })), placeholder: 'No lead' },
          { name: 'status', label: 'Status', type: 'select', options: Object.entries(STATUS_P).map(([value, [label]]) => ({ value, label })) },
          { name: 'startsOn', label: 'Start', type: 'date' }, { name: 'endsOn', label: 'Target end', type: 'date' },
          { name: 'color', label: 'Colour', type: 'select', options: [['#2453d6', 'Blue'], ['#16a34a', 'Green'], ['#d97706', 'Amber'], ['#dc2626', 'Red'], ['#7c3aed', 'Purple'], ['#0891b2', 'Teal'], ['#475569', 'Slate']].map(([value, label]) => ({ value, label })) },
        ]}
        onSubmit={(b) => save.mutate({ ...b, code: b.code ? b.code.toUpperCase() : null, leadEmployeeId: b.leadEmployeeId || null, startsOn: b.startsOn ? b.startsOn.slice(0, 10) : null, endsOn: b.endsOn ? b.endsOn.slice(0, 10) : null })} />
    </>
  );
}
