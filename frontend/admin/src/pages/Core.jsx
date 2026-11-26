import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, PieChart, Pie, Cell, Legend } from 'recharts';
import { Button, Card, CardBody, CardHeader, DataTable, Field, Input, Select, Skeleton, Stat, UsageMeter, ConfirmDialog, Checkbox, EmptyState } from '@hrms/shared-ui';
import { api, useAuth, useList, useAction, FormDialog, PageHeader, StatusBadge, Filters, KV, npr, dt } from '../lib.jsx';
import { FeatureSwitches } from './Requests.jsx';

const BRAND = ['#2453d6', '#3a6ff2', '#7fa3f7', '#bfd5fe', '#0f8a4f', '#c2560c'];

// =========================================================================== login
export function Login() {
  const { login } = useAuth();
  const [v, setV] = useState({ email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await login(v.email, v.password); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-xl border border-line bg-white p-8 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-wider text-brand-600">Lishnu Tech</p>
        <h1 className="mt-1 text-xl font-semibold">Platform administration</h1>
        <div className="mt-6 space-y-4">
          <Field label="Email" required><Input type="email" autoComplete="username" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
          <Field label="Password" required error={err}><Input type="password" autoComplete="current-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} /></Field>
          <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
        </div>
      </form>
    </div>
  );
}

// =========================================================================== dashboard
export function Dashboard() {
  const [range, setRange] = useState('365');
  const { data: d, isPending } = useQuery({ queryKey: ['dashboard', range], queryFn: () => api.get(`/dashboard?from=${new Date(Date.now() - Number(range) * 86_400_000).toISOString()}`) });
  const k = d?.kpis ?? {};
  const tiles = [
    ['MRR', npr(k.mrr)], ['ARR', npr(k.arr)], ['Revenue (period)', npr(k.revenue)], ['Outstanding', npr(k.outstanding)],
    ['Companies', k.tenants], ['Active', k.activeTenants], ['On trial', k.trialTenants], ['Paying', k.payingTenants],
    ['Suspended', k.suspendedTenants], ['Expiring ≤14d', k.expiringSoon], ['Requests to review', k.pendingRequests], ['Payments to verify', k.pendingPayments], ['Employees on platform', k.employees],
    ['New subscriptions', k.newSubscriptions], ['Cancellations', k.cancellations], ['Leads', k.leads], ['Lead conversion', k.conversionRate != null ? `${k.conversionRate}%` : '—'],
  ];
  const chart = (title, data, key, type = 'area', fmt) => (
    <Card>
      <CardHeader title={title} />
      <CardBody className="h-56">
        {isPending ? <Skeleton className="h-full" /> : !data?.length ? <EmptyState title="No data in this period" /> : (
          <ResponsiveContainer width="100%" height="100%">
            {type === 'area' ? (
              <AreaChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e5e9f0" /><XAxis dataKey="month" fontSize={11} /><YAxis fontSize={11} tickFormatter={fmt} width={60} /><Tooltip formatter={fmt} /><Area dataKey={key} stroke="#2453d6" fill="#dbe8fe" /></AreaChart>
            ) : (
              <BarChart data={data}><CartesianGrid strokeDasharray="3 3" stroke="#e5e9f0" /><XAxis dataKey="month" fontSize={11} /><YAxis fontSize={11} allowDecimals={false} width={40} /><Tooltip /><Bar dataKey={key} fill="#3a6ff2" radius={[3, 3, 0, 0]} /></BarChart>
            )}
          </ResponsiveContainer>
        )}
      </CardBody>
    </Card>
  );
  return (
    <>
      <PageHeader title="Platform overview" description="Live metrics across all companies" actions={
        <Select value={range} onChange={(e) => setRange(e.target.value)} className="w-40" aria-label="Period" options={[{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last 12 months' }]} />
      } />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{tiles.map(([l, v]) => <Stat key={l} label={l} value={v ?? '—'} loading={isPending} />)}</div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {chart('Monthly revenue (NPR)', d?.charts.revenueByMonth, 'amount', 'area', (v) => Number(v).toLocaleString('en-IN'))}
        {chart('New companies', d?.charts.tenantGrowth, 'count', 'bar')}
        {chart('Churn events', d?.charts.churnByMonth, 'count', 'bar')}
        {chart('Employees added', d?.charts.employeeGrowth, 'count', 'bar')}
        <Card>
          <CardHeader title="Package distribution" />
          <CardBody className="h-56">
            {d?.charts.planDistribution?.length ? (
              <ResponsiveContainer><PieChart><Pie data={d.charts.planDistribution} dataKey="count" nameKey="name" innerRadius={45} outerRadius={70}>{d.charts.planDistribution.map((_, i) => <Cell key={i} fill={BRAND[i % BRAND.length]} />)}</Pie><Tooltip /><Legend verticalAlign="middle" align="right" layout="vertical" formatter={(v, e) => `${v} (${e.payload.count})`} /></PieChart></ResponsiveContainer>
            ) : <Skeleton className="h-full" />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Lead sources & most-used modules" />
          <CardBody className="grid grid-cols-2 gap-4 text-sm">
            <ul className="space-y-1.5">{(d?.charts.leadSources ?? []).map((s) => <li key={s.source} className="flex justify-between"><span>{s.source.toLowerCase()}</span><span className="tabular-nums text-ink-500">{s.won}/{s.total} won</span></li>)}</ul>
            <ul className="space-y-1.5">{(d?.charts.moduleUsage ?? []).map((m) => <li key={m.key} className="flex justify-between"><span>{m.name}</span><span className="tabular-nums text-ink-500">{m.tenants}</span></li>)}</ul>
          </CardBody>
        </Card>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card><CardHeader title="Recent registrations" /><CardBody className="space-y-2 text-sm">
          {(d?.recentTenants ?? []).map((t) => <Link key={t.id} to={`/tenants/${t.id}`} className="flex items-center justify-between rounded-md px-2 py-1.5 hover:bg-subtle"><span><span className="font-medium">{t.name}</span> <span className="text-ink-400">· {t.plan ?? '—'}</span></span><StatusBadge value={t.subscription_status ?? t.status} /></Link>)}
        </CardBody></Card>
        <Card><CardHeader title="Recent platform activity" /><CardBody className="space-y-2 text-sm">
          {(d?.recentActivity ?? []).map((a) => <div key={a.id} className="flex justify-between gap-3"><span className="font-mono text-xs">{a.action}</span><span className="text-ink-400">{dt(a.createdAt, true)}</span></div>)}
        </CardBody></Card>
      </div>
    </>
  );
}

// =========================================================================== tenants
const PLAN_OPTS = (plans) => (plans ?? []).map((p) => ({ value: p.code, label: p.name }));
const usePlansAdmin = () => useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get('/plans') });

export function Tenants() {
  const { can } = useAuth();
  const list = useList('/tenants');
  const nav = useNavigate();
  const [create, setCreate] = useState(false);
  const { data: plans } = usePlansAdmin();
  const add = useAction((b) => api.post('/tenants', b), { success: (r) => `Company created: ${r.hostname}`, invalidate: ['/tenants'], onDone: () => setCreate(false) });
  return (
    <>
      <PageHeader title="Companies" description="All tenant workspaces" actions={<><Button variant="secondary" onClick={() => api.download('/reports/companies?format=csv', 'companies.csv')}>Export CSV</Button>{can('tenants:manage') && <Button onClick={() => setCreate(true)}>New company</Button>}</>} />
      <Filters list={list} selects={[{ name: 'status', label: 'Any status', options: ['ACTIVE', 'PENDING', 'SUSPENDED', 'ARCHIVED'] }]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/tenants/${r.id}`)}
        columns={[
          { key: 'name', header: 'Company', render: (r) => <><p className="font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-400">{r.slug}</p></> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'plan', header: 'Plan', render: (r) => r.subscription?.plan ?? '—' },
          { key: 'sub', header: 'Subscription', render: (r) => <StatusBadge value={r.subscription?.status} /> },
          { key: 'end', header: 'Period ends', render: (r) => dt(r.subscription?.currentPeriodEnd) },
          { key: 'createdAt', header: 'Created', render: (r) => dt(r.createdAt) },
        ]} />
      <FormDialog open={create} onClose={() => setCreate(false)} title="Create company" description="Provisions the workspace, default roles and subscription. Leave password empty to email an invitation." loading={add.isPending} error={add.error}
        initial={{ billingCycle: 'MONTHLY', trial: true, planCode: 'PROFESSIONAL' }}
        fields={[
          { name: 'name', label: 'Company name', required: true }, { name: 'slug', label: 'Workspace (subdomain)', required: true },
          { name: 'legalName', label: 'Legal name' }, { name: 'industry', label: 'Industry' },
          { name: 'planCode', label: 'Plan', type: 'select', options: PLAN_OPTS(plans), required: true },
          { name: 'billingCycle', label: 'Billing cycle', type: 'select', options: [{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual' }] },
          { name: 'ownerName', label: 'Owner full name', required: true }, { name: 'ownerEmail', label: 'Owner email', type: 'email', required: true },
          { name: 'ownerPassword', label: 'Owner password (optional)', type: 'password' }, { name: 'trial', type: 'checkbox', checkLabel: 'Start with free trial' },
        ]}
        onSubmit={({ ownerName, ownerEmail, ownerPassword, ...b }) => add.mutate({ ...b, owner: { fullName: ownerName, email: ownerEmail, ...(ownerPassword && { password: ownerPassword }) } })} />
    </>
  );
}

export function TenantDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data: d, isPending } = useQuery({ queryKey: ['tenant', id], queryFn: () => api.get(`/tenants/${id}`) });
  const { data: plans } = usePlansAdmin();
  const { data: features } = useQuery({ queryKey: ['features'], queryFn: () => api.get('/features') });
  const [dlg, setDlg] = useState(null);
  const inv = ['tenant', id];
  const act = (fn, msg) => useAction(fn, { success: msg, invalidate: [inv, '/tenants'], onDone: () => setDlg(null) }); // eslint-disable-line react-hooks/rules-of-hooks
  const suspend = act((b) => api.post(`/tenants/${id}/suspend`, b), 'Company suspended');
  const activate = act((b) => api.post(`/tenants/${id}/activate`, b), 'Company activated');
  const plan = act((b) => api.patch(`/tenants/${id}/subscription/plan`, b), 'Plan changed');
  const limits = act((b) => api.patch(`/tenants/${id}/subscription/limits`, b), 'Limits updated');
  const addon = act((b) => api.post(`/tenants/${id}/subscription/modules`, b), 'Module enabled');
  const paid = act(() => api.post(`/tenants/${id}/subscription/activate`), 'New paid period started');
  if (isPending) return <Skeleton className="h-96" />;
  const { tenant: t, subscription: s, access, usage, limits: lim, history, features: feats, featureOverrides, requests } = d;
  return (
    <>
      <PageHeader title={t.name} description={`${t.domains.map((x) => x.hostname).join(', ')}`} actions={can('tenants:manage') && (
        <>
          {t.status === 'SUSPENDED' ? <Button onClick={() => setDlg('activate')}>Activate</Button> : <Button variant="danger" onClick={() => setDlg('suspend')}>Suspend</Button>}
        </>
      )} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Subscription" actions={can('subscriptions:manage') && (
            <><Button size="sm" variant="secondary" onClick={() => setDlg('plan')}>Change plan</Button><Button size="sm" variant="secondary" onClick={() => setDlg('limits')}>Override limits</Button><Button size="sm" variant="secondary" onClick={() => setDlg('addon')}>Add module</Button></>
          )} />
          <CardBody>
            <KV items={[['Company status', <StatusBadge value={t.status} />], ['Access', <StatusBadge value={access.state} />], ['Plan', s?.planName], ['Subscription', <StatusBadge value={s?.status} />], ['Billing cycle', s?.billingCycle], ['Period ends', dt(s?.currentPeriodEnd)], s?.trialEndsAt && ['Trial ends', dt(s.trialEndsAt)], s?.graceEndsAt && ['Grace ends', dt(s.graceEndsAt)], ['Industry', t.industry], ['Created', dt(t.createdAt)]]} />
            {can('billing:manage') && <Button size="sm" className="mt-4" variant="secondary" onClick={() => setDlg('paid')}>Record manual payment & start new period</Button>}
          </CardBody>
        </Card>
        <Card><CardHeader title="Usage" /><CardBody className="space-y-4">
          <UsageMeter label="Employees" used={usage.employees} limit={lim.employees} />
          <UsageMeter label="Branches" used={usage.branches} limit={lim.branches} />
          <UsageMeter label="Users" used={usage.users} limit={lim.users} />
          <UsageMeter label="Storage (MB)" used={usage.storageMb} limit={lim.storageMb} />
        </CardBody></Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <FeatureSwitches tenantId={id} effective={feats} overrides={featureOverrides} />
        <Card><CardHeader title="Requests & history" /><CardBody className="max-h-72 space-y-2 overflow-auto text-sm">
          {requests.length > 0 && <p className="font-medium">Requests</p>}
          {requests.map((r) => <div key={r.id} className="flex justify-between gap-2"><span>{r.plan?.name ?? r.features.join(', ')} <StatusBadge value={r.status} /></span><span className="shrink-0 text-ink-400">{dt(r.createdAt, true)}</span></div>)}
          {requests.length > 0 && <p className="pt-2 font-medium">Subscription events</p>}
          {history.map((h) => <div key={h.id} className="flex justify-between gap-2"><span>{h.type.replace(/_/g, ' ')}{h.toStatus && <> → <StatusBadge value={h.toStatus} /></>}</span><span className="shrink-0 text-ink-400">{dt(h.createdAt, true)}</span></div>)}
        </CardBody></Card>
      </div>
      <FormDialog open={dlg === 'suspend'} onClose={() => setDlg(null)} title="Suspend company" description="All users are signed out immediately. Data is preserved." fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} submitLabel="Suspend" loading={suspend.isPending} error={suspend.error} onSubmit={(b) => suspend.mutate(b)} />
      <FormDialog open={dlg === 'activate'} onClose={() => setDlg(null)} title="Activate company" fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} submitLabel="Activate" loading={activate.isPending} error={activate.error} onSubmit={(b) => activate.mutate(b)} />
      <FormDialog open={dlg === 'plan'} onClose={() => setDlg(null)} title="Change plan" description="Takes effect immediately. Use the billing flow if the customer should pay first." initial={{ planCode: s?.planCode, billingCycle: s?.billingCycle }} fields={[{ name: 'planCode', label: 'Plan', type: 'select', options: PLAN_OPTS(plans) }, { name: 'billingCycle', label: 'Billing cycle', type: 'select', options: [{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual' }] }]} loading={plan.isPending} error={plan.error} onSubmit={(b) => plan.mutate(b)} />
      <FormDialog open={dlg === 'limits'} onClose={() => setDlg(null)} title="Override limits" description="Leave empty to use the plan default." fields={[{ name: 'maxEmployees', label: 'Max employees', type: 'number', nullable: true, keepEmpty: true }, { name: 'maxBranches', label: 'Max branches', type: 'number', nullable: true, keepEmpty: true }]} loading={limits.isPending} error={limits.error} onSubmit={(b) => limits.mutate(b)} />
      <FormDialog open={dlg === 'addon'} onClose={() => setDlg(null)} title="Enable add-on module" fields={[{ name: 'featureKey', label: 'Module', type: 'select', options: (features ?? []).filter((f) => !feats.includes(f.key)).map((f) => ({ value: f.key, label: f.name })) }, { name: 'unitAmount', label: 'Price per period (NPR)', type: 'number' }]} loading={addon.isPending} error={addon.error} onSubmit={(b) => addon.mutate(b)} />
      <ConfirmDialog open={dlg === 'paid'} onCancel={() => setDlg(null)} onConfirm={() => paid.mutate()} loading={paid.isPending} title="Start a new paid period?" description="Use only after payment is verified offline. For invoices, approve the payment in Billing instead." confirmLabel="Confirm payment" />
    </>
  );
}

// =========================================================================== plans
export function Plans() {
  const { can } = useAuth();
  const { data: plans, isPending } = usePlansAdmin();
  const { data: features } = useQuery({ queryKey: ['features'], queryFn: () => api.get('/features') });
  const [dlg, setDlg] = useState(null);
  const done = { invalidate: [['admin-plans']], onDone: () => setDlg(null) };
  const create = useAction((b) => api.post('/plans', b), { success: 'Plan created', ...done });
  const update = useAction(({ id, ...b }) => api.patch(`/plans/${id}`, b), { success: 'Plan updated', ...done });
  const price = useAction(({ id, ...b }) => api.put(`/plans/${id}/prices`, b), { success: 'Price updated', ...done });
  const ent = useAction(({ id, features: f }) => api.put(`/plans/${id}/entitlements`, { features: f }), { success: 'Modules updated', ...done });
  const planFields = [
    { name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description' },
    { name: 'maxEmployees', label: 'Max employees (empty = unlimited)', type: 'number', nullable: true, keepEmpty: true }, { name: 'maxBranches', label: 'Max branches', type: 'number', nullable: true, keepEmpty: true },
    { name: 'maxUsers', label: 'Max users', type: 'number', nullable: true, keepEmpty: true }, { name: 'maxStorageMb', label: 'Storage (MB)', type: 'number', nullable: true, keepEmpty: true },
    { name: 'trialDays', label: 'Trial days', type: 'number' }, { name: 'graceDays', label: 'Grace days', type: 'number' }, { name: 'sortOrder', label: 'Sort order', type: 'number' },
    { name: 'status', label: 'Status', type: 'select', options: [{ value: 'ACTIVE', label: 'Active' }, { value: 'ARCHIVED', label: 'Archived' }] },
    { name: 'highlights', label: 'Highlights (comma-separated, shown on pricing page)', type: 'tags', span: 2 },
    { name: 'isPublic', type: 'checkbox', checkLabel: 'Show on pricing page' }, { name: 'contactSales', type: 'checkbox', checkLabel: 'Contact sales (no online checkout)' },
  ];
  const current = (p, cycle) => p.prices.find((x) => x.billingCycle === cycle && !x.effectiveTo)?.amount;
  return (
    <>
      <PageHeader title="Plans & pricing" description="Changes apply to the pricing page and all subscribers immediately. Prices are versioned." actions={can('plans:manage') && <Button onClick={() => setDlg({ type: 'create' })}>New plan</Button>} />
      {isPending ? <Skeleton className="h-64" /> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {plans.map((p) => (
            <Card key={p.id}>
              <CardHeader title={<>{p.name} <span className="text-xs text-ink-400">{p.code}</span></>} description={`${p.maxEmployees ?? '∞'} employees · ${p.maxBranches ?? '∞'} branches · trial ${p.trialDays}d · grace ${p.graceDays}d`} actions={<StatusBadge value={p.status} />} />
              <CardBody className="space-y-3 text-sm">
                <KV items={[['Monthly', npr(current(p, 'MONTHLY'))], ['Annual', npr(current(p, 'ANNUAL'))]]} />
                <p className="text-ink-500">{p.entitlements.map((e) => e.feature.name).join(' · ') || 'Core modules only'}</p>
                {can('plans:manage') && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setDlg({ type: 'edit', plan: p })}>Edit</Button>
                    <Button size="sm" variant="secondary" onClick={() => setDlg({ type: 'price', plan: p })}>Change price</Button>
                    <Button size="sm" variant="secondary" onClick={() => setDlg({ type: 'modules', plan: p, sel: p.entitlements.map((e) => e.feature.key) })}>Modules</Button>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      <FormDialog open={dlg?.type === 'create'} onClose={() => setDlg(null)} title="New plan" initial={{ isPublic: true, trialDays: 14, graceDays: 7, status: 'ACTIVE' }} fields={[{ name: 'code', label: 'Code (e.g. STARTER)', required: true }, ...planFields]} loading={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} />
      <FormDialog open={dlg?.type === 'edit'} onClose={() => setDlg(null)} title={`Edit ${dlg?.plan?.name}`} initial={dlg?.plan ?? {}} fields={planFields} loading={update.isPending} error={update.error} onSubmit={(b) => update.mutate({ id: dlg.plan.id, ...b })} />
      <FormDialog open={dlg?.type === 'price'} onClose={() => setDlg(null)} title={`Change ${dlg?.plan?.name} price`} description="The current price is closed and the new one takes effect from the chosen time. Existing invoices are unaffected." initial={{ billingCycle: 'MONTHLY' }}
        fields={[{ name: 'billingCycle', label: 'Cycle', type: 'select', options: [{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual' }] }, { name: 'amount', label: 'Amount (NPR, excl. VAT)', type: 'number', required: true }, { name: 'effectiveFrom', label: 'Effective from (empty = now)', type: 'datetime' }]}
        loading={price.isPending} error={price.error} onSubmit={(b) => price.mutate({ id: dlg.plan.id, ...b })} />
      {dlg?.type === 'modules' && (
        <ModulesDialog plan={dlg.plan} features={features ?? []} selected={dlg.sel} onClose={() => setDlg(null)} loading={ent.isPending} onSave={(f) => ent.mutate({ id: dlg.plan.id, features: f })} />
      )}
    </>
  );
}

function ModulesDialog({ plan, features, selected, onClose, onSave, loading }) {
  const [sel, setSel] = useState(selected);
  return (
    <FormDialogShell title={`${plan.name}: included modules`} onClose={onClose} onSave={() => onSave(sel)} loading={loading}>
      <div className="grid gap-2 sm:grid-cols-2">
        {features.filter((f) => !f.isCore).map((f) => <Checkbox key={f.key} label={f.name} checked={sel.includes(f.key)} onChange={() => setSel((s) => (s.includes(f.key) ? s.filter((x) => x !== f.key) : [...s, f.key]))} />)}
      </div>
      <p className="mt-3 text-xs text-ink-500">Core modules (organization, employees, self-service, documents, basic reports) are always included.</p>
    </FormDialogShell>
  );
}

export function FormDialogShell({ title, onClose, onSave, loading, children, saveLabel = 'Save' }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[90dvh] w-full max-w-2xl overflow-auto rounded-lg bg-white shadow-pop">
        <div className="border-b border-line px-5 py-4 font-semibold">{title}</div>
        <div className="px-5 py-4">{children}</div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={onSave} loading={loading}>{saveLabel}</Button></div>
      </div>
    </div>
  );
}
