import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
  AppShell, Badge, Button, Card, CardBody, CardHeader, Checkbox, ConfirmDialog, DataTable, EmptyState, Field, Input,
  Select, Stat, SubscriptionBanner, Textarea, ToastProvider, UpgradePrompt, UsageMeter, useToast, formatNPR,
} from '../src/index.js';

// Illustrative rows for the gallery only — real screens load from the API.
const SAMPLE = [
  { id: '1', employeeCode: 'EMP-0001', name: 'Sita Sharma', department: 'Engineering', branch: 'Kathmandu HQ', status: 'ACTIVE', joinedOn: '2024-03-14' },
  { id: '2', employeeCode: 'EMP-0002', name: 'Ramesh Thapa', department: 'Finance', branch: 'Kathmandu HQ', status: 'PROBATION', joinedOn: '2026-09-01' },
  { id: '3', employeeCode: 'EMP-0003', name: 'Anjali Gurung', department: 'Operations', branch: 'Pokhara', status: 'ON_NOTICE', joinedOn: '2022-11-20' },
  { id: '4', employeeCode: 'EMP-0004', name: 'Bikash Rai', department: 'Engineering', branch: 'Pokhara', status: 'ACTIVE', joinedOn: '2025-01-06' },
];
const STATUS_TONE = { ACTIVE: 'success', PROBATION: 'info', ON_NOTICE: 'warning', TERMINATED: 'neutral' };

const Section = ({ title, children }) => (
  <section className="space-y-3">
    <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-500">{title}</h2>
    {children}
  </section>
);

function Gallery() {
  const toast = useToast();
  const [active, setActive] = useState('employees');
  const [confirm, setConfirm] = useState(false);
  const [upgrade, setUpgrade] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState(['name', 'asc']);
  const [state, setState] = useState('GRACE');

  const nav = [
    { items: [{ key: 'dashboard', label: 'Dashboard' }] },
    { label: 'People', items: [{ key: 'employees', label: 'Employees' }, { key: 'org', label: 'Organization' }] },
    { label: 'Time', items: [{ key: 'attendance', label: 'Attendance' }, { key: 'leave', label: 'Leave' }] },
    { label: 'Pay', items: [{ key: 'payroll', label: 'Payroll', locked: true }] },
    { label: 'Admin', items: [{ key: 'roles', label: 'Roles & access' }, { key: 'billing', label: 'Subscription' }] },
  ];

  return (
    <AppShell
      brand={<span className="text-sm font-semibold text-ink-900">Acme Pvt. Ltd.</span>}
      nav={nav}
      activeKey={active}
      onNavigate={setActive}
      banner={<SubscriptionBanner state={state} graceEndsAt="2026-12-05" canManageBilling onRenew={() => toast.info('Billing', 'Opens the renewal flow')} />}
      topbar={(
        <div className="flex flex-1 items-center justify-between">
          <Input placeholder="Search employees…" className="max-w-xs" aria-label="Search" />
          <div className="flex items-center gap-2">
            <Select aria-label="Subscription state" value={state} onChange={(e) => setState(e.target.value)} className="w-36"
              options={[{ value: 'FULL', label: 'State: Full' }, { value: 'GRACE', label: 'State: Grace' }, { value: 'READ_ONLY', label: 'State: Read-only' }]} />
            <span className="grid size-8 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">SO</span>
          </div>
        </div>
      )}
    >
      <div className="mx-auto max-w-6xl space-y-10">
        <header>
          <h1 className="text-2xl font-semibold">HRMS design system</h1>
          <p className="mt-1 text-sm text-ink-500">Shared tokens and components for the marketing site, Super Admin portal and company app.</p>
        </header>

        <Section title="KPI tiles">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Total employees" value="128" delta="+6" tone="success" hint="this month" />
            <Stat label="Present today" value="112" hint="87.5% attendance" />
            <Stat label="On leave" value="9" />
            <Stat label="Monthly payroll" value={formatNPR(4823500)} loading={loading} />
          </div>
        </Section>

        <Section title="Data table">
          <DataTable
            caption="Employees"
            loading={loading}
            sort={sort[0]} order={sort[1]} onSort={(k, o) => setSort([k, o])}
            columns={[
              { key: 'employeeCode', header: 'ID', width: 110 },
              { key: 'name', header: 'Name', sortable: true, render: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
              { key: 'department', header: 'Department', sortable: true },
              { key: 'branch', header: 'Branch' },
              { key: 'status', header: 'Status', render: (r) => <Badge dot tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Badge> },
              { key: 'joinedOn', header: 'Joined', sortable: true, align: 'right' },
            ]}
            rows={SAMPLE}
            meta={{ page: 1, pageSize: 4, total: 128, totalPages: 32 }}
          />
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1500); }}>Show loading state</Button>
          </div>
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Form">
            <Card>
              <CardHeader title="Add employee" description="Fields marked * are required." />
              <CardBody className="grid gap-4 sm:grid-cols-2">
                <Field label="First name" required><Input placeholder="Sita" /></Field>
                <Field label="Last name" required error="Last name is required"><Input /></Field>
                <Field label="Work email" hint="Used for login invitations"><Input type="email" placeholder="name@company.com" /></Field>
                <Field label="Branch" required>
                  <Select placeholder="Select branch" options={[{ value: 'hq', label: 'Kathmandu HQ' }, { value: 'pkr', label: 'Pokhara' }]} />
                </Field>
                <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} /></Field>
                <Checkbox label="Send login invitation" defaultChecked />
                <div className="flex justify-end gap-2 sm:col-span-2">
                  <Button variant="secondary">Cancel</Button>
                  <Button onClick={() => toast.success('Employee added', 'EMP-0005 · Sita Sharma')}>Save employee</Button>
                </div>
              </CardBody>
            </Card>
          </Section>

          <Section title="Plan usage & upgrade">
            <Card>
              <CardHeader title="Standard plan" description="Renews 05 Dec 2026" actions={<Badge tone="brand">Monthly</Badge>} />
              <CardBody className="space-y-4">
                <UsageMeter label="Employees" used={46} limit={50} />
                <UsageMeter label="Branches" used={2} limit={2} />
                <UsageMeter label="Storage (MB)" used={1840} limit={10240} />
                <div className="flex flex-wrap gap-2 pt-2">
                  <Button onClick={() => setUpgrade(true)}>Simulate LIMIT_REACHED</Button>
                  <Button variant="danger" onClick={() => setConfirm(true)}>Delete branch…</Button>
                  <Button variant="ghost" onClick={() => toast.error('Could not save', 'Request ID 7fc4…')}>Error toast</Button>
                </div>
              </CardBody>
            </Card>
          </Section>
        </div>

        <Section title="Buttons & badges">
          <Card><CardBody className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="ghost">Ghost</Button>
            <Button variant="danger">Danger</Button><Button loading>Saving</Button><Button disabled>Disabled</Button>
            <Button size="sm">Small</Button><Button size="lg">Large</Button>
            <span className="mx-2 h-6 w-px bg-line" />
            {['neutral', 'brand', 'success', 'warning', 'danger', 'info'].map((t) => <Badge key={t} tone={t}>{t}</Badge>)}
          </CardBody></Card>
        </Section>

        <Section title="Empty state">
          <Card><EmptyState icon="◎" title="No leave requests" description="When employees apply for leave, requests waiting for your approval show up here." action={<Button size="sm" variant="secondary">Configure leave types</Button>} /></Card>
        </Section>
      </div>

      <ConfirmDialog open={confirm} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); toast.success('Branch removed'); }}
        title="Delete Pokhara branch?" description="Employees must be moved first. This action is recorded in the audit log." confirmLabel="Delete branch" destructive />
      <UpgradePrompt open={upgrade} onClose={() => setUpgrade(false)} onUpgrade={() => setUpgrade(false)}
        title="Plan limit reached" message="Your plan allows 50 employees. Upgrade your subscription to add more." />
    </AppShell>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode><ToastProvider><Gallery /></ToastProvider></StrictMode>,
);
