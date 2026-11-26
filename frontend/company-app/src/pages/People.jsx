import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, DataTable, Skeleton, Badge, EmptyState, Field, Input, useToast, ConfirmDialog } from '@hrms/shared-ui';
import { api, useAuth, useList, useAction, FormDialog, PageHeader, StatusBadge, Filters, KV, npr, dt, fullName } from '../lib.jsx';

export const useOrg = () => {
  const b = useQuery({ queryKey: ['branches'], queryFn: () => api.get('/branches?pageSize=100&sort=name&order=asc') });
  const d = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments?pageSize=100&sort=name&order=asc') });
  const g = useQuery({ queryKey: ['designations'], queryFn: () => api.get('/designations') });
  const opt = (q) => (q.data ?? []).map((x) => ({ value: x.id, label: x.name }));
  return { branches: opt(b), departments: opt(d), designations: opt(g), nameOf: (list, id) => list.find((x) => x.value === id)?.label ?? '—' };
};
const TYPES = ['PERMANENT', 'PROBATION', 'CONTRACT', 'PART_TIME', 'INTERN', 'DAILY_WAGE'].map((x) => ({ value: x, label: x.replace('_', ' ').toLowerCase() }));
const STATUSES = ['ACTIVE', 'PROBATION', 'ON_NOTICE', 'SUSPENDED', 'TERMINATED'];

const employeeFields = (org, managers) => [
  { name: 'firstName', label: 'First name', required: true }, { name: 'lastName', label: 'Last name', required: true },
  { name: 'workEmail', label: 'Work email', type: 'email' }, { name: 'phone', label: 'Mobile' },
  { name: 'joinedOn', label: 'Joining date', type: 'date', required: true }, { name: 'employmentType', label: 'Employment type', type: 'select', options: TYPES },
  { name: 'branchId', label: 'Branch', type: 'select', options: org.branches, placeholder: '—' }, { name: 'departmentId', label: 'Department', type: 'select', options: org.departments, placeholder: '—' },
  { name: 'designationId', label: 'Designation', type: 'select', options: org.designations, placeholder: '—' }, { name: 'managerId', label: 'Reporting manager', type: 'select', options: managers, placeholder: '—' },
  { name: 'gender', label: 'Gender', type: 'select', placeholder: '—', options: ['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED'].map((x) => ({ value: x, label: x.toLowerCase() })) },
  { name: 'dateOfBirth', label: 'Date of birth', type: 'date' }, { name: 'pan', label: 'PAN (9 digits)' }, { name: 'ssfId', label: 'SSF ID' },
];
const clean = (b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v === '' ? null : v]).filter(([k, v]) => !(v === null && ['firstName', 'lastName', 'joinedOn'].includes(k))));
const dateOnly = (b) => ({ ...b, ...['joinedOn', 'dateOfBirth', 'contractEndOn', 'probationEndOn'].reduce((o, k) => (b[k] ? { ...o, [k]: String(b[k]).slice(0, 10) } : o), {}) });

// =========================================================================== employees
export function Employees() {
  const a = useAuth();
  const nav = useNavigate();
  const org = useOrg();
  const list = useList('/employees', { sort: 'employeeCode', order: 'asc', status: undefined });
  const { data: all } = useQuery({ queryKey: ['employees-mini'], queryFn: () => api.get('/employees?pageSize=100&sort=firstName&order=asc') });
  const managers = (all ?? []).map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }));
  const [dlg, setDlg] = useState(null);
  const create = useAction((b) => api.post('/employees', clean(dateOnly(b))), { success: (r) => `${r.firstName} added as ${r.employeeCode}`, invalidate: ['/employees', ['employees-mini']], onDone: () => setDlg(null) });
  return (
    <>
      <PageHeader title="Employees" description={list.meta ? `${list.meta.total} people` : ''} actions={<>
        {a.can('employees:export') && <Button variant="secondary" onClick={() => api.download('/employees/export', 'employees.csv')}>Export</Button>}
        {a.can('employees:import') && <Button variant="secondary" onClick={() => setDlg('import')}>Import</Button>}
        {a.can('employees:create') && <Button onClick={() => setDlg('create')}>Add employee</Button>}
      </>} />
      <Filters list={list} selects={[{ name: 'status', label: 'Any status', options: STATUSES }, { name: 'branchId', label: 'All branches', options: org.branches }, { name: 'departmentId', label: 'All departments', options: org.departments }]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/employees/${r.id}`)}
        sort={list.params.sort} order={list.params.order} onSort={(sort, order) => list.set({ sort, order })}
        empty={<EmptyState title="No employees yet" description="Add your first employee or import them from Excel." action={a.can('employees:create') && <Button onClick={() => setDlg('create')}>Add employee</Button>} />}
        columns={[
          { key: 'employeeCode', header: 'ID', sortable: true, width: 110 },
          { key: 'firstName', header: 'Name', sortable: true, render: (r) => <><p className="font-medium text-ink-900">{fullName(r)}</p><p className="text-xs text-ink-400">{r.workEmail}</p></> },
          { key: 'designation', header: 'Designation', render: (r) => r.designation?.name ?? '—' },
          { key: 'departmentId', header: 'Department', render: (r) => org.nameOf(org.departments, r.departmentId) },
          { key: 'branchId', header: 'Branch', render: (r) => org.nameOf(org.branches, r.branchId) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'joinedOn', header: 'Joined', sortable: true, render: (r) => dt(r.joinedOn) },
        ]} />
      <FormDialog open={dlg === 'create'} onClose={() => setDlg(null)} title="Add employee" description="An employee ID is generated automatically." initial={{ employmentType: 'PERMANENT', joinedOn: new Date().toISOString().slice(0, 10) }}
        fields={employeeFields(org, managers)} loading={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} />
      {dlg === 'import' && <ImportDialog onClose={() => setDlg(null)} onDone={() => { setDlg(null); list.refetch(); }} />}
    </>
  );
}

function ImportDialog({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = async (dryRun) => {
    setBusy(true); setResult(null);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api.post(`/employees/import?dryRun=${dryRun}`, fd);
      if (dryRun) setResult({ ok: true, text: `${r.valid} rows are valid and ready to import.` });
      else { toast.success(`${r.imported} employees imported`); onDone(); }
    } catch (e) { setResult({ ok: false, text: e.message, rows: e.details }); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-label="Import employees">
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-pop">
        <h2 className="font-semibold">Import employees</h2>
        <p className="mt-1 text-sm text-ink-500">Use the template, then save from Excel as <strong>CSV UTF-8</strong>. Nothing is saved unless every row is valid.</p>
        <Button size="sm" variant="ghost" className="mt-2 px-0" onClick={() => api.download('/employees/import/template', 'employee-import-template.csv')}>Download template</Button>
        <input type="file" accept=".csv,text/csv" className="mt-4 block w-full text-sm" onChange={(e) => { setFile(e.target.files[0]); setResult(null); }} aria-label="CSV file" />
        {result && (
          <div className={`mt-4 max-h-48 overflow-auto rounded-md p-3 text-sm ${result.ok ? 'bg-success-50 text-success-700' : 'bg-danger-50 text-danger-700'}`}>
            <p className="font-medium">{result.text}</p>
            {result.rows?.map((r, i) => <p key={i} className="text-xs">{r.path}: {r.message}</p>)}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="secondary" disabled={!file} loading={busy} onClick={() => run(true)}>Validate</Button>
          <Button disabled={!file || !result?.ok} loading={busy} onClick={() => run(false)}>Import</Button>
        </div>
      </div>
    </div>
  );
}

export function EmployeeProfile() {
  const { id } = useParams();
  const a = useAuth();
  const org = useOrg();
  const key = ['employee', id];
  const [tab, setTab] = useState('overview');
  const [dlg, setDlg] = useState(null);
  const { data: e, isPending } = useQuery({ queryKey: key, queryFn: () => api.get(`/employees/${id}`) });
  const { data: all } = useQuery({ queryKey: ['employees-mini'], queryFn: () => api.get('/employees?pageSize=100&sort=firstName&order=asc') });
  const managers = (all ?? []).filter((x) => x.id !== id).map((x) => ({ value: x.id, label: fullName(x) }));
  const done = { invalidate: [key, '/employees'], onDone: () => setDlg(null) };
  const update = useAction((b) => api.patch(`/employees/${id}`, b), { success: 'Profile updated', ...done });
  const invite = useAction((b) => api.post(`/employees/${id}/invite`, b), { success: (r) => `Invitation sent to ${r.email}`, ...done });
  const terminate = useAction((b) => api.post(`/employees/${id}/terminate`, b), { success: 'Exit recorded', ...done });
  if (isPending) return <Skeleton className="h-96" />;
  const tabs = [['overview', 'Overview'], ['history', 'History'], a.can('documents:view') && ['documents', 'Documents'], a.feature('payroll') && a.can('payroll:view') && a.wide('payroll:view') && ['salary', 'Salary'], a.feature('leave') && ['leave', 'Leave balance']].filter(Boolean);
  return (
    <>
      <PageHeader title={fullName(e)} description={`${e.employeeCode} · ${e.designation?.name ?? 'No designation'} · ${e.department?.name ?? 'No department'}`} actions={<>
        {a.can('employees:edit') && <Button variant="secondary" onClick={() => setDlg('edit')}>Edit</Button>}
        {a.can('users:create') && !e.user && e.status !== 'TERMINATED' && <Button variant="secondary" onClick={() => setDlg('invite')}>Give login access</Button>}
        {a.can('employees:manage') && e.status !== 'TERMINATED' && <Button variant="danger" onClick={() => setDlg('exit')}>Record exit</Button>}
      </>} />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{l}</button>)}
      </div>
      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card><CardHeader title="Employment" actions={<StatusBadge value={e.status} />} /><CardBody><KV items={[['Employee ID', e.employeeCode], ['Joined', dt(e.joinedOn)], ['Type', e.employmentType?.toLowerCase().replace('_', ' ')], ['Branch', e.branch?.name], ['Department', e.department?.name], ['Designation', e.designation?.name], ['Manager', e.manager ? fullName(e.manager) : '—'], ['Shift', e.shift?.name ?? 'Default'], e.exitedOn && ['Exited', dt(e.exitedOn)], ['Login', e.user ? <StatusBadge value={e.user.status} /> : 'No login']]} /></CardBody></Card>
          <Card><CardHeader title="Personal & statutory" /><CardBody>
            {e.pan !== undefined || e.bank ? <KV items={[['Work email', e.workEmail], ['Mobile', e.phone], ['Personal email', e.personalEmail], ['Date of birth', dt(e.dateOfBirth)], ['Gender', e.gender?.toLowerCase()], ['PAN', e.pan], ['SSF ID', e.ssfId], ['Bank', e.bank?.bankName ? `${e.bank.bankName} ****${e.bank.last4 ?? ''}` : '—'], ['Emergency contact', e.emergencyContacts?.[0] ? `${e.emergencyContacts[0].name} (${e.emergencyContacts[0].relation}) ${e.emergencyContacts[0].phone}` : '—']]} />
              : <p className="text-sm text-ink-500">You don't have access to personal details.</p>}
            {a.can('employees:edit') && <Button size="sm" variant="secondary" className="mt-4" onClick={() => setDlg('bank')}>Update bank account</Button>}
          </CardBody></Card>
        </div>
      )}
      {tab === 'history' && <History id={id} />}
      {tab === 'documents' && <Documents id={id} />}
      {tab === 'salary' && <Salary id={id} />}
      {tab === 'leave' && <LeaveBalance id={id} />}
      <FormDialog open={dlg === 'edit'} onClose={() => setDlg(null)} title="Edit employee" description="Changes to branch, department, designation or status are saved to the employee's history." initial={{ ...e, effectiveOn: new Date().toISOString().slice(0, 10) }}
        fields={[...employeeFields(org, managers), { name: 'status', label: 'Status', type: 'select', options: STATUSES.filter((s) => s !== 'TERMINATED').map((s) => ({ value: s, label: s.toLowerCase() })) }, { name: 'effectiveOn', label: 'Change effective from', type: 'date' }, { name: 'changeNote', label: 'Reason for change', type: 'textarea', rows: 2 }]}
        loading={update.isPending} error={update.error} onSubmit={(b) => update.mutate(clean(dateOnly(b)))} />
      <FormDialog open={dlg === 'bank'} onClose={() => setDlg(null)} title="Bank account" description="The account number is encrypted and only the last 4 digits are shown afterwards." initial={{ bankName: e.bank?.bankName ?? '', accountName: e.bank?.accountName ?? fullName(e), branch: e.bank?.branch ?? '' }}
        fields={[{ name: 'bankName', label: 'Bank', required: true }, { name: 'branch', label: 'Bank branch' }, { name: 'accountName', label: 'Account name', required: true }, { name: 'accountNumber', label: 'Account number', required: true }]}
        loading={update.isPending} error={update.error} onSubmit={(b) => update.mutate({ bank: b })} />
      <FormDialog open={dlg === 'invite'} onClose={() => setDlg(null)} title="Give login access" description="An invitation email lets the employee set a password and use self-service." initial={{ email: e.workEmail ?? '' }}
        fields={[{ name: 'email', label: 'Email', type: 'email', required: true }]} submitLabel="Send invitation" loading={invite.isPending} error={invite.error} onSubmit={(b) => invite.mutate(b)} />
      <FormDialog open={dlg === 'exit'} onClose={() => setDlg(null)} title={`Record exit for ${fullName(e)}`} description="Their login is disabled and the seat is freed. All history is kept." initial={{ exitedOn: new Date().toISOString().slice(0, 10), reason: 'RESIGNATION' }}
        fields={[{ name: 'exitedOn', label: 'Last working day', type: 'date', required: true }, { name: 'reason', label: 'Reason', type: 'select', options: ['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'CONTRACT_END', 'DEATH', 'OTHER'].map((x) => ({ value: x, label: x.replace('_', ' ').toLowerCase() })) }, { name: 'note', label: 'Notes', type: 'textarea' }]}
        submitLabel="Record exit" loading={terminate.isPending} error={terminate.error} onSubmit={(b) => terminate.mutate({ ...b, exitedOn: b.exitedOn.slice(0, 10) })} />
    </>
  );
}

function History({ id }) {
  const { data, isPending } = useQuery({ queryKey: ['history', id], queryFn: () => api.get(`/employees/${id}/history`) });
  if (isPending) return <Skeleton className="h-40" />;
  const fmt = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}: ${v ?? '—'}`).join(', ');
  return <Card><CardBody><ol className="space-y-4">{data.map((h) => (
    <li key={h.id} className="border-l-2 border-brand-200 pl-4 text-sm">
      <p className="font-medium">{h.type.replace(/_/g, ' ').toLowerCase()} <span className="font-normal text-ink-400">· effective {dt(h.effectiveOn)}</span></p>
      {Object.keys(h.toValue ?? {}).length > 0 && <p className="text-ink-500">{fmt(h.fromValue) && `${fmt(h.fromValue)} → `}{fmt(h.toValue)}</p>}
      {h.note && <p className="text-ink-700">{h.note}</p>}
    </li>))}</ol></CardBody></Card>;
}

function Documents({ id }) {
  const a = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isPending } = useQuery({ queryKey: ['docs', id], queryFn: () => api.get(`/employees/${id}/documents`) });
  const [meta, setMeta] = useState({ category: '', expiresOn: '' });
  const [busy, setBusy] = useState(false);
  const upload = async (file) => {
    setBusy(true);
    const fd = new FormData(); fd.append('file', file);
    if (meta.category) fd.append('category', meta.category);
    if (meta.expiresOn) fd.append('expiresOn', meta.expiresOn);
    try { await api.post(`/employees/${id}/documents`, fd); toast.success('Document uploaded'); qc.invalidateQueries({ queryKey: ['docs', id] }); } catch (e) { toast.error('Upload failed', e.message); } finally { setBusy(false); }
  };
  const del = useAction((fid) => api.del(`/employees/${id}/documents/${fid}`), { success: 'Removed', invalidate: [['docs', id]] });
  return (
    <Card>
      {a.can('documents:create') && (
        <CardBody className="flex flex-wrap items-end gap-3 border-b border-line">
          <Field label="Category"><Input value={meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })} placeholder="Contract, Citizenship…" /></Field>
          <Field label="Expires on"><Input type="date" value={meta.expiresOn} onChange={(e) => setMeta({ ...meta, expiresOn: e.target.value })} /></Field>
          <label className="inline-flex h-10 cursor-pointer items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">{busy ? 'Uploading…' : 'Upload PDF/image'}<input type="file" className="sr-only" accept="application/pdf,image/png,image/jpeg" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} /></label>
        </CardBody>
      )}
      <DataTable loading={isPending} rows={data ?? []} empty={<EmptyState title="No documents" />} columns={[
        { key: 'filename', header: 'File' }, { key: 'category', header: 'Category' },
        { key: 'expiresOn', header: 'Expires', render: (r) => (r.expiresOn ? <span className={r.expiresOn < new Date().toISOString().slice(0, 10) ? 'text-danger-600' : ''}>{dt(r.expiresOn)}</span> : '—') },
        { key: 'sizeBytes', header: 'Size', render: (r) => `${Math.ceil(r.sizeBytes / 1024)} KB` }, { key: 'createdAt', header: 'Uploaded', render: (r) => dt(r.createdAt) },
        { key: 'x', header: '', render: (r) => <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => api.download(`/employees/${id}/documents/${r.id}`, r.filename)}>Download</Button>{a.can('documents:delete') && <Button size="sm" variant="ghost" onClick={() => del.mutate(r.id)}>Remove</Button>}</div> },
      ]} />
    </Card>
  );
}

function Salary({ id }) {
  const a = useAuth();
  const { data, isPending } = useQuery({ queryKey: ['salary', id], queryFn: () => api.get(`/payroll/salaries/${id}`) });
  const { data: comps } = useQuery({ queryKey: ['components'], queryFn: () => api.get('/payroll/components') });
  const [open, setOpen] = useState(false);
  const save = useAction((b) => api.post('/payroll/salaries', b), { success: 'Salary saved', invalidate: [['salary', id]], onDone: () => setOpen(false) });
  const current = data?.[0];
  const active = (comps ?? []).filter((c) => c.isActive);
  return (
    <Card>
      <CardHeader title="Salary" description="Each revision is kept as history; approved payroll periods cannot be changed." actions={a.can('payroll:edit') && <Button size="sm" onClick={() => setOpen(true)}>{current ? 'Revise salary' : 'Set salary'}</Button>} />
      <CardBody>
        {isPending ? <Skeleton className="h-24" /> : !current ? <EmptyState title="No salary set" description="Employees without a salary are skipped in payroll." /> : (
          <div className="space-y-4">
            <KV items={[['Basic', npr(current.basic)], ...current.components.map((c) => [active.find((x) => x.code === c.code)?.name ?? c.code, npr(c.amount)]), ['SSF enrolled', current.ssfEnrolled ? 'Yes (11% + 20%)' : 'No'], ['PF', `${Number(current.pfPercent)}%`], ['CIT / month', npr(current.citMonthly)], ['Effective from', dt(current.effectiveFrom)]]} />
            <details><summary className="cursor-pointer text-sm text-brand-700">Revision history ({data.length})</summary>
              <ul className="mt-2 space-y-1 text-sm">{data.map((s) => <li key={s.id}>{dt(s.effectiveFrom)} · basic {npr(s.basic)} {s.reason && <span className="text-ink-400">· {s.reason}</span>}</li>)}</ul></details>
          </div>
        )}
      </CardBody>
      <FormDialog open={open} onClose={() => setOpen(false)} title={current ? 'Revise salary' : 'Set salary'}
        initial={{ effectiveFrom: new Date().toISOString().slice(0, 10), basic: current?.basic ?? '', ssfEnrolled: current?.ssfEnrolled ?? true, pfPercent: current?.pfPercent ?? 0, citMonthly: current?.citMonthly ?? 0, ...Object.fromEntries((current?.components ?? []).map((c) => [`c_${c.code}`, c.amount])) }}
        fields={[{ name: 'effectiveFrom', label: 'Effective from', type: 'date', required: true }, { name: 'basic', label: 'Basic salary / month (NPR)', type: 'number', required: true },
          ...active.map((c) => ({ name: `c_${c.code}`, label: `${c.name} (${c.kind === 'DEDUCTION' ? 'deduction' : 'monthly'})`, type: 'number' })),
          { name: 'pfPercent', label: 'Provident Fund %', type: 'number' }, { name: 'citMonthly', label: 'CIT per month (NPR)', type: 'number' },
          { name: 'ssfEnrolled', type: 'checkbox', checkLabel: 'Enrolled in Social Security Fund' }, { name: 'reason', label: 'Reason', type: 'textarea', rows: 2 }]}
        loading={save.isPending} error={save.error}
        onSubmit={(b) => {
          const components = Object.entries(b).filter(([k, v]) => k.startsWith('c_') && v > 0).map(([k, v]) => ({ code: k.slice(2), amount: v }));
          const rest = Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith('c_')));
          save.mutate({ ...rest, employeeId: id, effectiveFrom: String(b.effectiveFrom).slice(0, 10), components, ssfEnrolled: !!b.ssfEnrolled });
        }} />
    </Card>
  );
}

function LeaveBalance({ id }) {
  const { data, isPending } = useQuery({ queryKey: ['balance', id], queryFn: () => api.get(`/leave/balances/${id}`) });
  if (isPending) return <Skeleton className="h-40" />;
  return <DataTable rows={data.balances} rowKey="leaveTypeId" caption={`Leave balances ${data.year}`} columns={[
    { key: 'name', header: `Leave type (FY ${data.year})` }, { key: 'entitled', header: 'Entitled', align: 'right' }, { key: 'used', header: 'Used', align: 'right' },
    { key: 'pending', header: 'Pending', align: 'right' }, { key: 'available', header: 'Available', align: 'right', render: (r) => (r.tracked ? <strong>{r.available}</strong> : 'Unlimited') },
  ]} />;
}

// =========================================================================== organization
export function Organization() {
  const [tab, setTab] = useState('branches');
  const a = useAuth();
  const tabs = [['branches', 'Branches'], ['departments', 'Departments'], ['designations', 'Designations'], a.feature('shifts') && ['shifts', 'Shifts']].filter(Boolean);
  return (
    <>
      <PageHeader title="Organization" description="Branches, departments, designations and work shifts" />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">{tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{l}</button>)}</div>
      {tab === 'branches' && <SimpleCrud path="/branches" perm="branches" listQ="?pageSize=100&sort=name&order=asc" fields={[{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'address', label: 'Address', type: 'textarea', rows: 2 }]} columns={[{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name', render: (r) => <>{r.name} {r.isHeadOffice && <Badge tone="brand">Head office</Badge>}</> }, { key: 'address', header: 'Address' }]} />}
      {tab === 'departments' && <SimpleCrud path="/departments" perm="departments" listQ="?pageSize=100&sort=name&order=asc" fields={[{ name: 'code', label: 'Code', required: true }, { name: 'name', label: 'Name', required: true }]} columns={[{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }]} />}
      {tab === 'designations' && <SimpleCrud path="/designations" perm="departments" fields={[{ name: 'name', label: 'Name', required: true }, { name: 'level', label: 'Level (for ordering)', type: 'number' }]} columns={[{ key: 'name', header: 'Name' }, { key: 'level', header: 'Level' }]} />}
      {tab === 'shifts' && <SimpleCrud path="/shifts" perm="shifts" noDelete fields={[{ name: 'name', label: 'Name', required: true }, { name: 'startTime', label: 'Start (HH:MM)', required: true }, { name: 'endTime', label: 'End (HH:MM)', required: true }, { name: 'breakMinutes', label: 'Break (minutes)', type: 'number' }, { name: 'graceMinutes', label: 'Grace (minutes)', type: 'number' }, { name: 'weeklyOffs', label: 'Weekly offs (e.g. SAT)', type: 'tags' }, { name: 'isDefault', type: 'checkbox', checkLabel: 'Default shift for employees without one' }]}
        columns={[{ key: 'name', header: 'Shift', render: (r) => <>{r.name} {r.isDefault && <Badge tone="brand">Default</Badge>}</> }, { key: 't', header: 'Hours', render: (r) => `${r.startTime.slice(0, 5)}–${r.endTime.slice(0, 5)}` }, { key: 'breakMinutes', header: 'Break' }, { key: 'weeklyOffs', header: 'Weekly off', render: (r) => r.weeklyOffs.join(', ') }]} />}
    </>
  );
}

function SimpleCrud({ path, perm, fields, columns, listQ = '', noDelete }) {
  const a = useAuth();
  const { data, isPending } = useQuery({ queryKey: [path], queryFn: () => api.get(`${path}${listQ}`) });
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const save = useAction((b) => (edit?.id ? api.patch(`${path}/${edit.id}`, b) : api.post(path, b)), { success: 'Saved', invalidate: [[path]], onDone: () => setEdit(null) });
  const remove = useAction((id) => api.del(`${path}/${id}`), { success: 'Removed', invalidate: [[path]], onDone: () => setDel(null) });
  return (
    <>
      {a.can(`${perm}:create`) && <div className="mb-3 flex justify-end"><Button onClick={() => setEdit({})}>Add</Button></div>}
      <DataTable loading={isPending} rows={data ?? []} onRowClick={a.can(`${perm}:edit`) ? setEdit : undefined}
        columns={[...columns, ...(!noDelete && a.can(`${perm}:delete`) ? [{ key: 'x', header: '', render: (r) => !r.isHeadOffice && <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setDel(r); }}>Delete</Button> }] : [])]} />
      {edit && <FormDialog open onClose={() => setEdit(null)} title={edit.id ? 'Edit' : 'Add'} initial={{ ...edit, ...(edit.startTime && { startTime: edit.startTime.slice(0, 5), endTime: edit.endTime.slice(0, 5) }) }} fields={fields} loading={save.isPending} error={save.error} onSubmit={(b) => save.mutate(Object.fromEntries(Object.entries(b).filter(([k]) => fields.some((f) => f.name === k))))} />}
      <ConfirmDialog open={!!del} onCancel={() => setDel(null)} onConfirm={() => remove.mutate(del.id)} loading={remove.isPending} title={`Delete ${del?.name}?`} description="Records that still use it must be moved first." confirmLabel="Delete" destructive />
    </>
  );
}

