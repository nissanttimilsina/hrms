import { ForYou } from './ForYou.jsx';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronRight, ClipboardList, FileSignature, FileText, ListTodo, MessageSquareQuote, Plus, Receipt, Send, Users, Wallet } from 'lucide-react';
import { Card, CardBody, CardHeader, Skeleton, EmptyState, Badge, Button, cn } from '@hrms/shared-ui';
import { api, useAuth, PageHeader, dt, todayKtm, addDays } from '../lib.jsx';
import { ClockWidget } from './Time.jsx';
import { StatusPill, PriorityFlag, ProgressBar, DueLabel, Stars, ScoreRing } from './Work.jsx';
import { ExpensesCard } from './Expenses.jsx';
import { usePendingLetters } from './Letters.jsx';

const Tile = ({ label, value, hint, to, tone, icon: Icon }) => {
  const body = (
    <Card className={cn('h-full p-4 transition-colors', to && 'hover:border-brand-500')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-ink-500">{label}</p>
        {Icon && <Icon className={cn('size-4', tone === 'danger' ? 'text-danger-600' : tone === 'warning' ? 'text-warning-600' : tone === 'success' ? 'text-success-600' : 'text-ink-400')} />}
      </div>
      <p className={cn('mt-1.5 text-2xl font-semibold tabular-nums text-ink-900', tone === 'danger' && value > 0 && 'text-danger-600', tone === 'warning' && value > 0 && 'text-warning-700')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
    </Card>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
};
const SectionTitle = ({ children, action }) => (
  <div className="mb-3 flex items-end justify-between gap-3"><h2 className="text-base font-semibold text-ink-900">{children}</h2>{action}</div>
);

function TodayReport() {
  const nav = useNavigate();
  const { data, isPending } = useQuery({ queryKey: ['dash-report'], queryFn: () => api.get('/work-reports/mine') });
  if (isPending) return <Skeleton className="h-full min-h-32" />;
  const r = data?.report;
  const state = !r ? 'none' : r.status;
  const cfg = {
    none: { title: 'Today\'s report not started', text: 'Record what you worked on, what you finished and any problems.', cta: 'Write report', tone: 'border-line' },
    DRAFT: { title: 'Draft saved', text: `${r?.items.length ?? 0} item(s), ${r?.hours ?? 0} h so far. Submit it before you leave.`, cta: 'Continue', tone: 'border-line' },
    SUBMITTED: { title: 'Submitted', text: 'Waiting for your manager\'s review.', cta: 'View', tone: 'border-warning-600/25 bg-warning-50/50' },
    CHANGES_REQUESTED: { title: 'Changes requested', text: r?.feedback ?? '', cta: 'Update report', tone: 'border-danger-600/25 bg-danger-50/60' },
    APPROVED: { title: 'Approved', text: r?.feedback ?? 'Your manager approved today\'s report.', cta: 'View', tone: 'border-success-600/25 bg-success-50/60' },
  }[state];
  return (
    <Card className={cn('flex h-full flex-col p-4', cfg.tone)}>
      <div className="flex items-center justify-between gap-2"><p className="flex items-center gap-2 text-xs font-medium text-ink-500"><FileText className="size-4" />Daily report</p>{r?.rating && <Stars value={r.rating} size="size-3.5" />}</div>
      <p className="mt-2 font-semibold text-ink-900">{cfg.title}</p>
      <p className="mt-0.5 line-clamp-2 flex-1 text-sm text-ink-700">{cfg.text}</p>
      <Button size="sm" variant={state === 'none' || state === 'DRAFT' || state === 'CHANGES_REQUESTED' ? 'primary' : 'secondary'} className="mt-3 self-start" onClick={() => nav('/my-work/report')}>{state === 'none' && <Send className="size-4" />}{cfg.cta}</Button>
    </Card>
  );
}

function UpNext() {
  const nav = useNavigate();
  const { data: tasks, isPending } = useQuery({ queryKey: ['dash-tasks', 'mine'], queryFn: () => api.get('/tasks?view=mine&status=open&sort=dueOn&order=asc&pageSize=7') });
  return (
    <Card className="h-full">
      <CardHeader title="Up next" description="Your open tasks by due date" actions={<Link to="/my-work/tasks" className="text-sm font-medium text-brand-700 hover:underline">All my tasks</Link>} />
      {isPending ? <CardBody><Skeleton className="h-40" /></CardBody> : !tasks?.length ? (
        <EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing open" description="New tasks assigned to you will appear here." />
      ) : (
        <ul className="divide-y divide-line">
          {tasks.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => nav(`/tasks/${t.id}`)} className="flex w-full items-center gap-4 px-5 py-3 text-left hover:bg-subtle">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink-900"><span className="mr-1.5 text-xs font-normal text-ink-400">{t.key}</span>{t.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"><StatusPill value={t.status} /><PriorityFlag value={t.priority} />{t.project && <span className="flex items-center gap-1 text-xs text-ink-500"><span className="size-1.5 rounded-full" style={{ background: t.project.color }} />{t.project.name}</span>}</div>
                </div>
                <div className="hidden w-28 shrink-0 sm:block"><ProgressBar value={t.progress} /><p className="mt-1 text-right text-[11px] tabular-nums text-ink-500">{t.progress}%</p></div>
                <div className="w-28 shrink-0 text-right"><DueLabel task={t} /></div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MyPerformance({ employeeId }) {
  const from = addDays(todayKtm(), -29);
  const { data: d, isPending } = useQuery({ queryKey: ['emp-perf', employeeId, 30], queryFn: () => api.get(`/performance/employees/${employeeId}?from=${from}&to=${todayKtm()}`) });
  if (isPending) return <Skeleton className="h-full min-h-60" />;
  const rows = [
    ['On-time delivery', d.tasks?.onTimeRate != null ? `${d.tasks.onTimeRate}%` : '—'],
    ['Reports submitted', d.reports?.rate != null ? `${d.reports.rate}%` : '—'],
    ['Average rating', d.reports?.avgRating ? `${d.reports.avgRating} / 5` : '—'],
    ['Punctuality', d.attendance?.punctuality != null ? `${d.attendance.punctuality}%` : '—'],
  ];
  return (
    <Card className="flex h-full flex-col">
      <CardHeader title="My performance" description="Last 30 days" actions={<Link to="/my-work/performance" className="text-sm font-medium text-brand-700 hover:underline">Details</Link>} />
      <CardBody className="flex flex-1 items-center gap-5">
        <ScoreRing score={d.score} size={96} />
        <dl className="flex-1 space-y-2 text-sm">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-2"><dt className="text-ink-500">{k}</dt><dd className="font-medium tabular-nums">{v}</dd></div>)}</dl>
      </CardBody>
      {d.feedback?.[0]?.feedback && (
        <div className="border-t border-line px-5 py-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-ink-500"><MessageSquareQuote className="size-3.5" />Latest feedback · {dt(d.feedback[0].date)}</p>
          <p className="mt-1 line-clamp-2 text-sm text-ink-700">“{d.feedback[0].feedback}”</p>
        </div>
      )}
    </Card>
  );
}

function LeaveCard() {
  const { data, isPending } = useQuery({ queryKey: ['my-balances'], queryFn: () => api.get('/leave/balances/me'), retry: false });
  if (isPending) return <Skeleton className="h-full min-h-40" />;
  const list = (data?.balances ?? []).filter((b) => b.tracked && b.entitled > 0).slice(0, 4);
  return (
    <Card className="h-full">
      <CardHeader title="Leave balance" description={data ? `Fiscal year ${data.year}` : undefined} actions={<Link to="/me/leave" className="text-sm font-medium text-brand-700 hover:underline">Apply</Link>} />
      <CardBody className="space-y-3">
        {!list.length && <p className="text-sm text-ink-500">No leave balances yet.</p>}
        {list.map((b) => (
          <div key={b.leaveTypeId}>
            <div className="flex justify-between text-sm"><span className="text-ink-700">{b.name}</span><span className="tabular-nums font-medium">{b.available} <span className="font-normal text-ink-400">of {b.entitled}</span></span></div>
            <ProgressBar value={(b.available / b.entitled) * 100} className="mt-1" tone="bg-success-600" />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

/** Requests from employees that wait for this person: expense claims and letters. Hidden when there is nothing to show. */
function WaitingForYou() {
  const a = useAuth();
  const canExpenses = a.feature('expenses') && a.can('expenses:approve');
  const canLetters = a.can('letters:approve');
  const { data: ex } = useQuery({ queryKey: ['expense-summary'], queryFn: () => api.get('/expenses/summary'), enabled: canExpenses, retry: false });
  const { data: letters } = usePendingLetters(canLetters);
  const tiles = [
    canExpenses && ex?.queue > 0 && <Tile key="ex" label="Expense claims to approve" value={ex.queue} to="/expenses" icon={Receipt} tone="warning" />,
    canExpenses && ex?.toPay > 0 && <Tile key="pay" label="Approved claims to pay" value={ex.toPay} to="/expenses" icon={Wallet} tone="warning" />,
    canLetters && letters?.length > 0 && <Tile key="lt" label="Letters to issue" value={letters.length} to="/letters" icon={FileSignature} tone="warning" />,
  ].filter(Boolean);
  if (!tiles.length) return null;
  return (
    <section>
      <SectionTitle>Waiting for you</SectionTitle>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{tiles}</div>
    </section>
  );
}

function TeamSection({ canReview }) {
  const nav = useNavigate();
  const { data: sum } = useQuery({ queryKey: ['tasks-summary', 'team'], queryFn: () => api.get('/tasks/summary?view=team') });
  const { data: attention } = useQuery({ queryKey: ['dash-tasks', 'team'], queryFn: () => api.get('/tasks?view=team&status=open&sort=dueOn&order=asc&pageSize=40') });
  const { data: queue } = useQuery({ queryKey: ['dash-review'], queryFn: () => api.list('/work-reports?status=SUBMITTED&pageSize=5'), enabled: canReview });
  const { data: missing } = useQuery({ queryKey: ['missing-reports'], queryFn: () => api.get('/work-reports/missing'), enabled: canReview, retry: false });
  const td = todayKtm();
  const needs = (attention ?? []).filter((t) => t.status === 'BLOCKED' || (t.dueOn && t.dueOn <= td)).slice(0, 6);
  return (
    <section>
      <SectionTitle action={<Link to="/tasks" className="text-sm font-medium text-brand-700 hover:underline">Team tasks</Link>}>Your team</SectionTitle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {canReview && <Tile label="Reports to review" value={queue?.meta?.total ?? '…'} to="/work-reports" icon={ClipboardList} tone="warning" />}
        {canReview && <Tile label="No report today" value={missing?.employees.length ?? '…'} hint="At work, not reported" to="/work-reports" icon={FileText} />}
        <Tile label="Overdue tasks" value={sum?.overdue ?? '…'} to="/tasks?view=team" icon={AlertTriangle} tone="danger" />
        <Tile label="Blocked" value={sum?.byStatus.BLOCKED ?? '…'} to="/tasks?view=team" icon={AlertTriangle} tone="danger" />
        <Tile label="Done this week" value={sum?.doneThisWeek ?? '…'} hint={sum ? `${sum.open} still open` : undefined} to="/performance" icon={CheckCircle2} tone="success" />
      </div>
      <div className="mt-4 grid grid-cols-1 [&>*]:min-w-0 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Needs attention" description="Blocked, overdue or due today" />
          {!attention ? <CardBody><Skeleton className="h-32" /></CardBody> : !needs.length ? <EmptyState icon={<CheckCircle2 className="size-5" />} title="Nothing urgent" description="No blocked or overdue tasks in your team." /> : (
            <ul className="divide-y divide-line">
              {needs.map((t) => (
                <li key={t.id}><button type="button" onClick={() => nav(`/tasks/${t.id}`)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-subtle">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{t.title}</p><p className="text-xs text-ink-500">{t.assignee.name} · {t.key}</p></div>
                  <StatusPill value={t.status} /><div className="w-28 text-right"><DueLabel task={t} short /></div>
                </button></li>
              ))}
            </ul>
          )}
        </Card>
        {canReview && (
          <Card>
            <CardHeader title="Waiting for your review" actions={<Link to="/work-reports" className="text-sm font-medium text-brand-700 hover:underline">All</Link>} />
            {!queue ? <CardBody><Skeleton className="h-32" /></CardBody> : !queue.data.length ? <EmptyState icon={<CheckCircle2 className="size-5" />} title="All caught up" /> : (
              <ul className="divide-y divide-line">
                {queue.data.map((r) => (
                  <li key={r.id}><button type="button" onClick={() => nav(`/work-reports/${r.id}`)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-subtle">
                    <div className="min-w-0 flex-1"><p className="text-sm font-medium">{r.employee.name}</p><p className="truncate text-xs text-ink-500">{dt(r.date)} · {r.summary || r.items.map((i) => i.description).join(', ')}</p></div>
                    <span className="text-xs tabular-nums text-ink-500">{r.hours} h</span><ChevronRight className="size-4 text-ink-400" />
                  </button></li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </section>
  );
}

export function Dashboard() {
  const a = useAuth();
  const nav = useNavigate();
  const { data: d, isPending } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard') });
  const h = new Date().getHours();
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const tasksOn = a.feature('tasks');
  const me = a.employeeId;
  const isManager = tasksOn && (a.wide('tasks:view') || a.wide('work_reports:view'));
  const canReview = a.can('work_reports:approve');
  const wideStaff = a.wide('employees:view');
  const { data: mine } = useQuery({ queryKey: ['tasks-summary', 'mine'], queryFn: () => api.get('/tasks/summary?view=mine'), enabled: tasksOn && !!me });
  return (
    <>
      <PageHeader title={`${greeting}, ${a.me.user.fullName.split(' ')[0]}`} description={d ? `${dt(d.today)} · ${d.todayBS} BS` : ''}
        actions={<>
          {tasksOn && me && a.can('work_reports:create') && <Button variant="secondary" onClick={() => nav('/my-work/report')}><Send className="size-4" />Daily report</Button>}
          {a.feature('leave') && me && <Button variant="secondary" onClick={() => nav('/me/leave')}><CalendarDays className="size-4" />Apply for leave</Button>}
          {tasksOn && a.can('tasks:create') && <Button onClick={() => nav('/tasks?new=1')}><Plus className="size-4" />New task</Button>}
        </>} />

      <div className="space-y-8">
        <ForYou />
        {me && (
          <section className="space-y-4">
            <div className={cn('grid grid-cols-1 [&>*]:min-w-0 gap-4', tasksOn ? 'lg:grid-cols-[1.25fr_1fr_1.25fr]' : '')}>
              {a.feature('attendance') && <ClockWidget compact />}
              {tasksOn && a.can('work_reports:create') && <TodayReport />}
              {tasksOn && (
                <div className="grid grid-cols-2 gap-3">
                  <Tile label="Open tasks" value={mine?.open ?? '…'} to="/my-work/tasks" icon={ListTodo} />
                  <Tile label="Due today" value={mine?.dueToday ?? '…'} to="/my-work/tasks" icon={CalendarDays} tone="warning" />
                  <Tile label="Overdue" value={mine?.overdue ?? '…'} to="/my-work/tasks" icon={AlertTriangle} tone="danger" />
                  <Tile label="Done this week" value={mine?.doneThisWeek ?? '…'} to="/my-work/tasks" icon={CheckCircle2} tone="success" />
                </div>
              )}
            </div>
            {tasksOn && (
              <div className="grid grid-cols-1 [&>*]:min-w-0 gap-4 lg:grid-cols-[1.6fr_1fr]">
                <UpNext />
                <div className="flex flex-col gap-4">
                  <MyPerformance employeeId={me} />
                  {a.feature('leave') && a.can('leave:view') && <LeaveCard />}
                  {a.feature('expenses') && a.can('expenses:create') && <ExpensesCard />}
                </div>
              </div>
            )}
            {!tasksOn && a.feature('leave') && a.can('leave:view') && <div className="grid grid-cols-1 [&>*]:min-w-0 gap-4 lg:grid-cols-3"><LeaveCard /></div>}
          </section>
        )}

        <WaitingForYou />

        {isManager && <TeamSection canReview={canReview} />}

        {isPending ? <Skeleton className="h-64" /> : (
          <section>
            {((wideStaff && d.headcount) || d.attendanceToday) && <SectionTitle>Today at work</SectionTitle>}
            {((wideStaff && d.headcount) || d.attendanceToday) && (
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                {wideStaff && d.headcount && <Tile label="Employees" value={d.headcount.total} hint={`${d.headcount.joinedThisMonth} joined in 30 days`} to="/employees" icon={Users} />}
                {d.attendanceToday && <Tile label="Present today" value={`${d.attendanceToday.present} / ${d.attendanceToday.total}`} hint={`${d.attendanceToday.late} late`} to="/attendance" />}
                {d.attendanceToday && <Tile label="On leave · not in" value={`${d.attendanceToday.onLeave} · ${d.attendanceToday.notIn}`} to="/attendance" />}
                {d.pendingLeave != null && <Tile label="Leave to approve" value={d.pendingLeave} hint={d.pendingCorrections ? `${d.pendingCorrections} attendance corrections` : undefined} to="/leave/approvals" tone="warning" />}
              </div>
            )}
            <div className="grid grid-cols-1 [&>*]:min-w-0 gap-4 lg:grid-cols-3">
              {d.attendanceTrend && (
                <Card className="lg:col-span-2"><CardHeader title="Attendance, last 14 days" /><CardBody className="h-60">
                  {d.attendanceTrend.length ? (
                    <ResponsiveContainer><BarChart data={d.attendanceTrend}><CartesianGrid strokeDasharray="3 3" stroke="#e5e9f0" vertical={false} /><XAxis dataKey="date" tickFormatter={(x) => x.slice(5)} fontSize={11} tickLine={false} /><YAxis allowDecimals={false} fontSize={11} width={30} tickLine={false} axisLine={false} /><Tooltip /><Bar dataKey="present" name="Present" fill="#3a6ff2" radius={[3, 3, 0, 0]} maxBarSize={36} /><Bar dataKey="late" name="Late" fill="#c2560c" radius={[3, 3, 0, 0]} maxBarSize={36} /></BarChart></ResponsiveContainer>
                  ) : <EmptyState title="No attendance yet" description="Clock-ins will appear here." />}
                </CardBody></Card>
              )}
              {wideStaff && d.byDepartment?.length > 0 && (
                <Card><CardHeader title="People by department" /><CardBody className="space-y-2.5 text-sm">
                  {d.byDepartment.map((x) => <div key={x.name} className="flex items-center gap-3"><span className="w-28 truncate">{x.name}</span><div className="h-2 flex-1 rounded-full bg-subtle"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(x.count / Math.max(...d.byDepartment.map((y) => y.count))) * 100}%` }} /></div><span className="w-6 text-right tabular-nums">{x.count}</span></div>)}
                </CardBody></Card>
              )}
              <Card><CardHeader title="Announcements" actions={<Link to="/announcements" className="text-sm font-medium text-brand-700 hover:underline">All</Link>} /><CardBody className="space-y-3">
                {d.announcements.length ? d.announcements.map((x) => <div key={x.id}><p className="text-sm font-medium">{x.pinned && <Badge tone="brand">Pinned</Badge>} {x.title}</p><p className="line-clamp-2 text-sm text-ink-500">{x.body}</p></div>) : <p className="text-sm text-ink-500">No announcements.</p>}
              </CardBody></Card>
              {d.onLeaveToday && <Card><CardHeader title="On leave today" /><CardBody className="space-y-1.5 text-sm">{d.onLeaveToday.length ? d.onLeaveToday.map((x) => <p key={x.name}>{x.name} <span className="text-ink-400">· {x.type} until {dt(x.until)}</span></p>) : <p className="text-ink-500">Everyone is in.</p>}</CardBody></Card>}
              <Card><CardHeader title="Upcoming holidays" /><CardBody className="space-y-1.5 text-sm">{d.upcomingHolidays.length ? d.upcomingHolidays.map((x) => <p key={x.id}>{x.name} <span className="text-ink-400">· {dt(x.date)} ({x.bs})</span></p>) : <p className="text-ink-500">No holidays added yet.</p>}</CardBody></Card>
              {(d.birthdays?.length > 0 || d.anniversaries?.length > 0) && (
                <Card><CardHeader title="Celebrations, next 30 days" /><CardBody className="space-y-1.5 text-sm">
                  {d.birthdays.map((b) => <p key={`b${b.id}`}>🎂 {b.name} <span className="text-ink-400">· {b.date}</span></p>)}
                  {d.anniversaries.map((b) => <p key={`a${b.id}`}>🎉 {b.name} <span className="text-ink-400">· {b.years} year(s) on {b.date}</span></p>)}
                </CardBody></Card>
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
