import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell, ToastProvider, Skeleton, Button } from '@hrms/shared-ui';
import { LayoutDashboard, Building2, Package, Receipt, Handshake, FileText, LifeBuoy, Settings as Cog, Users, ScrollText, Inbox } from 'lucide-react';
import { AuthProvider, useAuth } from './lib.jsx';
import { Login, Dashboard, Tenants, TenantDetail, Plans } from './pages/Core.jsx';
import { Requests } from './pages/Requests.jsx';
import { Billing, Leads, LeadDetail, Cms, Support, TicketDetail, Settings, Staff, Audit } from './pages/Ops.jsx';
import './styles.css';

const NAV = [
  { key: '/', label: 'Dashboard', icon: <LayoutDashboard className="size-4" />, perm: 'tenants:view' },
  { key: '/tenants', label: 'Companies', icon: <Building2 className="size-4" />, perm: 'tenants:view' },
  { key: '/requests', label: 'Requests', icon: <Inbox className="size-4" />, perm: 'subscriptions:view' },
  { key: '/plans', label: 'Plans & pricing', icon: <Package className="size-4" />, perm: 'plans:view' },
  { key: '/billing', label: 'Billing', icon: <Receipt className="size-4" />, perm: 'billing:view' },
  { key: '/crm', label: 'Sales CRM', icon: <Handshake className="size-4" />, perm: 'crm:view' },
  { key: '/cms', label: 'Website content', icon: <FileText className="size-4" />, perm: 'cms:manage' },
  { key: '/support', label: 'Support', icon: <LifeBuoy className="size-4" />, perm: 'support:view' },
  { key: '/settings', label: 'Settings', icon: <Cog className="size-4" />, perm: 'settings:manage' },
  { key: '/staff', label: 'Staff', icon: <Users className="size-4" />, perm: 'platform_users:manage' },
  { key: '/audit', label: 'Audit log', icon: <ScrollText className="size-4" />, perm: 'audit:view' },
];

function Guard({ perm, children }) {
  const { can } = useAuth();
  return can(perm) ? children : <p className="text-sm text-ink-500">You don’t have access to this section.</p>;
}

function Shell() {
  const { status, me, can, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  if (status === 'loading') return <div className="p-10"><Skeleton className="h-64" /></div>;
  if (status === 'out') return <Login />;
  const items = NAV.filter((n) => can(n.perm));
  const active = items.slice().reverse().find((n) => (n.key === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.key)))?.key;
  const home = items[0]?.key ?? '/';
  return (
    <AppShell
      brand={<span className="text-sm font-semibold">Lishnu HRMS · Admin</span>}
      nav={[{ items }]} activeKey={active} onNavigate={nav}
      topbar={<div className="flex flex-1 items-center justify-end gap-3 text-sm"><span className="text-ink-500">{me.user.fullName} · {me.roles.join(', ')}</span><Button size="sm" variant="ghost" onClick={logout}>Sign out</Button></div>}
    >
      <div className="mx-auto max-w-7xl">
        <Routes>
          <Route path="/" element={can('tenants:view') ? <Dashboard /> : <Navigate to={home} replace />} />
          <Route path="/tenants" element={<Guard perm="tenants:view"><Tenants /></Guard>} />
          <Route path="/tenants/:id" element={<Guard perm="tenants:view"><TenantDetail /></Guard>} />
          <Route path="/requests" element={<Guard perm="subscriptions:view"><Requests /></Guard>} />
          <Route path="/plans" element={<Guard perm="plans:view"><Plans /></Guard>} />
          <Route path="/billing" element={<Guard perm="billing:view"><Billing /></Guard>} />
          <Route path="/crm" element={<Guard perm="crm:view"><Leads /></Guard>} />
          <Route path="/crm/leads/:id" element={<Guard perm="crm:view"><LeadDetail /></Guard>} />
          <Route path="/cms" element={<Guard perm="cms:manage"><Cms /></Guard>} />
          <Route path="/support" element={<Guard perm="support:view"><Support /></Guard>} />
          <Route path="/support/:id" element={<Guard perm="support:view"><TicketDetail /></Guard>} />
          <Route path="/settings" element={<Guard perm="settings:manage"><Settings /></Guard>} />
          <Route path="/staff" element={<Guard perm="platform_users:manage"><Staff /></Guard>} />
          <Route path="/audit" element={<Guard perm="audit:view"><Audit /></Guard>} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </div>
    </AppShell>
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: (n, e) => n < 1 && !(e?.status >= 400 && e?.status < 500) } } });
createRoot(document.getElementById('root')).render(
  <StrictMode><QueryClientProvider client={qc}><ToastProvider><BrowserRouter><AuthProvider><Shell /></AuthProvider></BrowserRouter></ToastProvider></QueryClientProvider></StrictMode>,
);
