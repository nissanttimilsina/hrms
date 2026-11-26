import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Card, CardBody, CardHeader, Stat, Skeleton, EmptyState, Badge } from '@hrms/shared-ui';
import { api, useAuth, PageHeader, dt } from '../lib.jsx';
import { ClockWidget } from './Time.jsx';

export function Dashboard() {
  const a = useAuth();
  const { data: d, isPending } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard') });
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <>
      <PageHeader title={`${greeting}, ${a.me.user.fullName.split(' ')[0]}`} description={d ? `${dt(d.today)} · ${d.todayBS} BS` : ''} />
      {a.employeeId && a.feature('attendance') && <div className="mb-6"><ClockWidget compact /></div>}
      {isPending ? <Skeleton className="h-64" /> : (
        <div className="space-y-6">
          {(d.headcount || d.attendanceToday) && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {d.headcount && d.headcount.total > 1 && <><Stat label="Employees" value={d.headcount.total} hint={`${d.headcount.joinedThisMonth} joined in 30 days`} /><Stat label="On probation / notice" value={`${d.headcount.probation} / ${d.headcount.onNotice}`} /></>}
              {d.attendanceToday && <><Stat label="Present today" value={`${d.attendanceToday.present} / ${d.attendanceToday.total}`} hint={`${d.attendanceToday.late} late`} /><Stat label="On leave · not in" value={`${d.attendanceToday.onLeave} · ${d.attendanceToday.notIn}`} /></>}
              {d.pendingLeave != null && <Link to="/leave/approvals"><Stat label="Pending leave approvals" value={d.pendingLeave} /></Link>}
              {d.pendingCorrections != null && <Link to="/attendance/corrections"><Stat label="Attendance corrections" value={d.pendingCorrections} /></Link>}
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-3">
            {d.attendanceTrend && (
              <Card className="lg:col-span-2"><CardHeader title="Attendance · last 14 days" /><CardBody className="h-60">
                {d.attendanceTrend.length ? (
                  <ResponsiveContainer><BarChart data={d.attendanceTrend}><CartesianGrid strokeDasharray="3 3" stroke="#e5e9f0" /><XAxis dataKey="date" tickFormatter={(x) => x.slice(5)} fontSize={11} /><YAxis allowDecimals={false} fontSize={11} width={30} /><Tooltip /><Bar dataKey="present" name="Present" fill="#3a6ff2" radius={[3, 3, 0, 0]} /><Bar dataKey="late" name="Late" fill="#c2560c" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer>
                ) : <EmptyState title="No attendance yet" description="Clock-ins will appear here." />}
              </CardBody></Card>
            )}
            {d.byDepartment?.length > 0 && (
              <Card><CardHeader title="Employees by department" /><CardBody className="space-y-2 text-sm">
                {d.byDepartment.map((x) => <div key={x.name} className="flex items-center gap-3"><span className="w-28 truncate">{x.name}</span><div className="h-2 flex-1 rounded-full bg-subtle"><div className="h-full rounded-full bg-brand-500" style={{ width: `${(x.count / Math.max(...d.byDepartment.map((y) => y.count))) * 100}%` }} /></div><span className="w-6 text-right tabular-nums">{x.count}</span></div>)}
              </CardBody></Card>
            )}
            <Card><CardHeader title="Announcements" actions={<Link to="/announcements" className="text-sm text-brand-700">All</Link>} /><CardBody className="space-y-3">
              {d.announcements.length ? d.announcements.map((x) => <div key={x.id}><p className="text-sm font-medium">{x.pinned && <Badge tone="brand">Pinned</Badge>} {x.title}</p><p className="line-clamp-2 text-sm text-ink-500">{x.body}</p></div>) : <p className="text-sm text-ink-500">No announcements.</p>}
            </CardBody></Card>
            {d.onLeaveToday && <Card><CardHeader title="On leave today" /><CardBody className="space-y-1.5 text-sm">{d.onLeaveToday.length ? d.onLeaveToday.map((x) => <p key={x.name}>{x.name} <span className="text-ink-400">· {x.type} until {dt(x.until)}</span></p>) : <p className="text-ink-500">Everyone is in.</p>}</CardBody></Card>}
            <Card><CardHeader title="Upcoming holidays" /><CardBody className="space-y-1.5 text-sm">{d.upcomingHolidays.length ? d.upcomingHolidays.map((h) => <p key={h.id}>{h.name} <span className="text-ink-400">· {dt(h.date)} ({h.bs})</span></p>) : <p className="text-ink-500">No holidays added yet.</p>}</CardBody></Card>
            {(d.birthdays?.length > 0 || d.anniversaries?.length > 0) && (
              <Card><CardHeader title="Celebrations (next 30 days)" /><CardBody className="space-y-1.5 text-sm">
                {d.birthdays.map((b) => <p key={`b${b.id}`}>🎂 {b.name} <span className="text-ink-400">· {b.date}</span></p>)}
                {d.anniversaries.map((b) => <p key={`a${b.id}`}>🎉 {b.name} <span className="text-ink-400">· {b.years} year(s) on {b.date}</span></p>)}
              </CardBody></Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
