import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppShell, ToastProvider, Skeleton, Button, SubscriptionBanner, BrandProvider } from '@hrms/shared-ui';
import { LayoutDashboard, Users, Building2, Clock, CalendarDays, Wallet, Megaphone, ShieldCheck, CreditCard, LifeBuoy, Settings as Cog, Bell, UserRound, ScrollText } from 'lucide-react';
import { AuthProvider, useAuth, api, dt } from './lib.jsx';
import { Login, AcceptInvite, ForgotPassword, ResetPassword } from './pages/Auth.jsx';
import { Dashboard } from './pages/Home.jsx';
import { Employees, EmployeeProfile, Organization } from './pages/People.jsx';
import { MyAttendance, AttendanceRegister, MyLeave, LeaveApprovals, LeaveSetup } from './pages/Time.jsx';
import { PayrollRuns, PayrollRunDetail, PayrollSetup, MyPayslips } from './pages/Pay.jsx';
import { Access, Announcements, Billing, Support, SupportTicket, Settings, Audit, MyProfile } from './pages/Admin.jsx';
import './styles.css';

const I = (C) => <C className="size-4" />;
function buildNav(a) {
  const f = a.feature; const can = a.can; const wide = a.wide;
  const me = a.employeeId;
  return [
    { items: [{ key: '/', label: 'Dashboard', icon: I(LayoutDashboard) }] },
    me && { label: 'My space', items: [
      { key: '/me', label: 'My profile', icon: I(UserRound) },
      f('attendance') && { key: '/me/attendance', label: 'My attendance', icon: I(Clock) },
      f('leave') && { key: '/me/leave', label: 'My leave', icon: I(CalendarDays) },
      f('payroll') && { key: '/me/payslips', label: 'My payslips', icon: I(Wallet) },
    ] },
    { label: 'People', items: [
      wide('employees:view') && { key: '/employees', label: 'Employees', icon: I(Users) },
      can('branches:view') && wide('employees:view') && { key: '/organization', label: 'Organization', icon: I(Building2) },
    ] },
    { label: 'Time & pay', items: [
      wide('attendance:view') && { key: '/attendance', label: 'Attendance', icon: I(Clock), locked: !f('attendance') },
      can('leave:approve') && { key: '/leave/approvals', label: 'Leave approvals', icon: I(CalendarDays), locked: !f('leave') },
      can('leave:configure') && { key: '/leave/setup', label: 'Leave setup', icon: I(CalendarDays) },
      wide('payroll:view') && { key: '/payroll', label: 'Payroll', icon: I(Wallet), locked: !f('payroll') },
    ] },
    { label: 'Company', items: [
      can('announcements:view') && { key: '/announcements', label: 'Announcements', icon: I(Megaphone) },
      can('roles:view') && { key: '/access', label: 'Users & roles', icon: I(ShieldCheck) },
      can('subscription:view') && { key: '/billing', label: 'Subscription', icon: I(CreditCard) },
      can('support:view') && { key: '/support', label: 'Help & support', icon: I(LifeBuoy) },
      can('settings:view') && { key: '/settings', label: 'Settings', icon: I(Cog) },
      can('audit:view') && { key: '/audit', label: 'Audit log', icon: I(ScrollText) },
    ] },
  ].filter(Boolean).map((s) => ({ ...s, items: s.items.filter(Boolean) })).filter((s) => s.items.length);
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => api.get('/notifications'), refetchInterval: 60_000 });
  const read = async () => { await api.post('/notifications/read', {}); qc.invalidateQueries({ queryKey: ['notifications'] }); };
  return (
    <div className="relative">
      <button type="button" className="relative rounded-md p-2 text-ink-500 hover:bg-subtle" onClick={() => setOpen((o) => !o)} aria-label={`Notifications (${data?.unread ?? 0} unread)`}>
        <Bell className="size-5" />
        {data?.unread > 0 && <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-danger-600 text-[10px] font-semibold text-white">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-40 w-80 rounded-lg border border-line bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5"><p className="text-sm font-semibold">Notifications</p>{data?.unread > 0 && <button type="button" className="text-xs text-brand-700" onClick={read}>Mark all read</button>}</div>
          <ul className="max-h-96 overflow-auto">
            {(data?.items ?? []).length === 0 && <li className="p-4 text-sm text-ink-500">You're all caught up.</li>}
            {(data?.items ?? []).map((n) => (
              <li key={n.id}><button type="button" onClick={() => { setOpen(false); if (n.link) nav(n.link); }} className={`w-full px-4 py-2.5 text-left hover:bg-subtle ${n.readAt ? '' : 'bg-brand-50/60'}`}>
                <p className="text-sm font-medium text-ink-900">{n.title}</p>{n.body && <p className="line-clamp-2 text-xs text-ink-500">{n.body}</p>}<p className="mt-0.5 text-[11px] text-ink-400">{dt(n.createdAt, true)}</p>
              </button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Shell() {
  const a = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  if (a.status === 'loading') return <div className="p-10"><Skeleton className="h-64" /></div>;
  if (a.status === 'out') {
    return (
      <Routes>
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  const { me } = a;
  const navItems = buildNav(a);
  const keys = navItems.flatMap((s) => s.items.map((i) => i.key));
  const active = keys.filter((k) => (k === '/' ? loc.pathname === '/' : loc.pathname === k || loc.pathname.startsWith(`${k}/`))).sort((x, y) => y.length - x.length)[0];
  const sub = me.subscription;
  return (
    <BrandProvider primary={me.tenant.brandColor}>
      <AppShell
        brand={<span className="truncate text-sm font-semibold">{me.tenant.name}</span>}
        nav={navItems} activeKey={active} onNavigate={nav}
        banner={<SubscriptionBanner state={sub.access.state} reason={sub.access.reason} graceEndsAt={sub.access.graceEndsAt ?? sub.graceEndsAt} canManageBilling={a.can('subscription:manage')} onRenew={() => nav('/billing')} />}
        topbar={(
          <div className="flex flex-1 items-center justify-end gap-2">
            <Notifications />
            <span className="hidden text-sm text-ink-500 sm:inline">{me.user.fullName}</span>
            <Button size="sm" variant="ghost" onClick={a.logout}>Sign out</Button>
          </div>
        )}
      >
        <div className="mx-auto max-w-7xl">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/me" element={<MyProfile />} />
            <Route path="/me/attendance" element={<MyAttendance />} />
            <Route path="/me/leave" element={<MyLeave />} />
            <Route path="/me/payslips" element={<MyPayslips />} />
            <Route path="/employees" element={<Employees />} />
            <Route path="/employees/:id" element={<EmployeeProfile />} />
            <Route path="/organization" element={<Organization />} />
            <Route path="/attendance/*" element={<AttendanceRegister />} />
            <Route path="/leave/approvals" element={<LeaveApprovals />} />
            <Route path="/leave/setup" element={<LeaveSetup />} />
            <Route path="/payroll" element={<PayrollRuns />} />
            <Route path="/payroll/setup" element={<PayrollSetup />} />
            <Route path="/payroll/runs/:id" element={<PayrollRunDetail />} />
            <Route path="/announcements" element={<Announcements />} />
            <Route path="/access" element={<Access />} />
            <Route path="/billing/*" element={<Billing />} />
            <Route path="/support" element={<Support />} />
            <Route path="/support/:id" element={<SupportTicket />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </AppShell>
    </BrandProvider>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: (n, e) => n < 1 && !(e?.status >= 400 && e?.status < 500) } } });
createRoot(document.getElementById('root')).render(
  <StrictMode><QueryClientProvider client={qc}><ToastProvider><BrowserRouter><AuthProvider><Shell /></AuthProvider></BrowserRouter></ToastProvider></QueryClientProvider></StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
