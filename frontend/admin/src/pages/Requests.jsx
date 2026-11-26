import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, DataTable, EmptyState, Field, Input, Select, Textarea, Badge, useToast } from '@hrms/shared-ui';
import { api, useAuth, useList, useAction, FormDialog, PageHeader, StatusBadge, npr, dt } from '../lib.jsx';

const TABS = [['PENDING', 'To review'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['CANCELLED', 'Cancelled']];
const what = (r) => (r.kind === 'FEATURES' ? `Modules: ${r.features.join(', ')}` : `${r.plan?.name ?? '—'}${r.billingCycle ? ` · ${r.billingCycle.toLowerCase()}` : ''}${r.features.length ? ` + ${r.features.join(', ')}` : ''}`);

export function Requests() {
  const { can } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const list = useList('/subscription-requests', { status });
  const [dlg, setDlg] = useState(null);
  const reject = useAction(({ id, reason }) => api.post(`/subscription-requests/${id}/reject`, { reason }), { success: 'Request rejected', invalidate: ['/subscription-requests', ['dashboard']], onDone: () => setDlg(null) });
  return (
    <>
      <PageHeader title="Subscription requests" description="Plan changes, Enterprise enquiries and extra modules requested by companies" />
      <div className="mb-4 flex gap-1 border-b border-line">{TABS.map(([k, l]) => <button key={k} type="button" onClick={() => setStatus(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${status === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{l}</button>)}</div>
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} empty={<EmptyState title={status === 'PENDING' ? 'Nothing to review' : 'No requests'} />} columns={[
        { key: 'createdAt', header: 'Requested', render: (r) => dt(r.createdAt, true) },
        { key: 'tenant', header: 'Company', render: (r) => <Link className="font-medium text-brand-700 hover:underline" to={`/tenants/${r.tenant.id}`}>{r.tenant.name}</Link> },
        { key: 'kind', header: 'Request', render: (r) => <><p>{what(r)}</p>{r.kind === 'ENTERPRISE' && <Badge tone="brand">Enterprise</Badge>}</> },
        { key: 'employeeCount', header: 'Employees', align: 'right', render: (r) => r.employeeCount ?? '—' },
        { key: 'message', header: 'Message', render: (r) => <span className="line-clamp-2 max-w-xs text-ink-600">{r.message ?? '—'}</span> },
        status === 'PENDING'
          ? { key: 'x', header: '', render: (r) => can('subscriptions:manage') && <div className="flex gap-1"><Button size="sm" onClick={() => setDlg({ t: 'approve', r })}>Review</Button><Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'reject', r })}>Reject</Button></div> }
          : { key: 'decisionNote', header: 'Decision', render: (r) => <><StatusBadge value={r.status} /> <span className="text-xs text-ink-500">{r.decisionNote ?? ''}</span></> },
      ]} />
      {dlg?.t === 'approve' && <ApproveDialog request={dlg.r} onClose={() => setDlg(null)} />}
      <FormDialog open={dlg?.t === 'reject'} onClose={() => setDlg(null)} title="Reject request" description="The company sees this reason." fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} submitLabel="Reject" loading={reject.isPending} error={reject.error} onSubmit={(b) => reject.mutate({ id: dlg.r.id, ...b })} />
    </>
  );
}

function ApproveDialog({ request: r, onClose }) {
  const toast = useToast();
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api.get('/plans') });
  const { data: catalog } = useQuery({ queryKey: ['features'], queryFn: () => api.get('/features') });
  const [f, setF] = useState({ planCode: r.plan?.code ?? '', billingCycle: r.billingCycle ?? 'MONTHLY', mode: 'INVOICE', customAmount: '', maxEmployees: '', maxBranches: '', note: '', features: Object.fromEntries(r.features.map((k) => [k, true])) });
  const plan = (plans ?? []).find((p) => p.code === f.planCode);
  const custom = plan?.isCustom;
  const approve = useAction((b) => api.post(`/subscription-requests/${r.id}/approve`, b), {
    invalidate: ['/subscription-requests', ['dashboard']],
    onDone: (out) => { toast.success('Request approved', out.invoice ? `Invoice ${out.invoice.number} sent to the company` : 'Changes are active'); onClose(); },
  });
  const submit = () => approve.mutate({
    ...(f.planCode && { planCode: f.planCode, billingCycle: f.billingCycle }), mode: f.mode,
    ...(f.customAmount !== '' && { customAmount: Number(f.customAmount) }),
    ...(f.maxEmployees !== '' && { maxEmployees: Number(f.maxEmployees) }), ...(f.maxBranches !== '' && { maxBranches: Number(f.maxBranches) }),
    features: f.features, ...(f.note && { note: f.note }),
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-label="Approve request">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-pop">
        <div className="border-b border-line p-5"><h2 className="font-semibold">Approve: {r.tenant.name}</h2><p className="text-sm text-ink-500">{what(r)}{r.message ? ` · "${r.message}"` : ''}</p></div>
        <div className="grid flex-1 gap-4 overflow-auto p-5 sm:grid-cols-2">
          {r.kind !== 'FEATURES' && <>
            <Field label="Plan"><Select value={f.planCode} onChange={set('planCode')} options={(plans ?? []).filter((p) => p.status === 'ACTIVE').map((p) => ({ value: p.code, label: p.name }))} /></Field>
            <Field label="Billing cycle"><Select value={f.billingCycle} onChange={set('billingCycle')} options={[{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual' }]} /></Field>
            <Field label={custom ? 'Negotiated price per period (NPR, before VAT)' : 'Custom price (optional, before VAT)'} required={custom} className="sm:col-span-2"><Input type="number" min="1" value={f.customAmount} onChange={set('customAmount')} placeholder={custom ? 'Required for Enterprise' : 'Leave empty for list price'} /></Field>
            <Field label="How to activate" className="sm:col-span-2"><Select value={f.mode} onChange={set('mode')} options={[{ value: 'INVOICE', label: 'Send an invoice; activate when it is paid' }, { value: 'ACTIVATE', label: 'Activate now (paid offline or complimentary)' }]} /></Field>
          </>}
          <Field label="Max employees (override)"><Input type="number" min="0" value={f.maxEmployees} onChange={set('maxEmployees')} placeholder="Plan default" /></Field>
          <Field label="Max branches (override)"><Input type="number" min="0" value={f.maxBranches} onChange={set('maxBranches')} placeholder="Plan default" /></Field>
          <div className="sm:col-span-2">
            <p className="mb-2 text-sm font-medium">Feature switches for this company</p>
            <div className="grid gap-1.5 sm:grid-cols-2">{(catalog ?? []).filter((x) => !x.isCore).map((x) => (
              <label key={x.key} className="flex items-center justify-between gap-2 rounded-md border border-line px-2 py-1 text-sm">
                <span>{x.name}</span>
                <select aria-label={`${x.name} switch`} className="rounded border border-line bg-white text-xs" value={f.features[x.key] === true ? 'on' : f.features[x.key] === false ? 'off' : ''} onChange={(e) => { const v = e.target.value; const n = { ...f.features }; if (v === '') delete n[x.key]; else n[x.key] = v === 'on'; setF({ ...f, features: n }); }}>
                  <option value="">Plan default</option><option value="on">Force on</option><option value="off">Force off</option>
                </select>
              </label>))}</div>
          </div>
          <Field label="Note to the company (optional)" className="sm:col-span-2"><Textarea rows={2} value={f.note} onChange={set('note')} /></Field>
        </div>
        {approve.error && <p className="px-5 text-sm text-danger-600">{approve.error.message}</p>}
        <div className="flex justify-end gap-2 border-t border-line p-4"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={approve.isPending} disabled={custom && f.mode && !f.customAmount} onClick={submit}>Approve</Button></div>
      </div>
    </div>
  );
}

/** Per-company feature switches shown on the company page. */
export function FeatureSwitches({ tenantId, effective, overrides }) {
  const { can } = useAuth();
  const { data: catalog } = useQuery({ queryKey: ['features'], queryFn: () => api.get('/features') });
  const sw = useAction(({ key, enabled }) => api.put(`/tenants/${tenantId}/features/${key}`, { enabled }), { success: 'Feature updated', invalidate: [['tenant', tenantId]] });
  const ov = Object.fromEntries(overrides.map((o) => [o.featureKey, o.enabled]));
  return (
    <Card><CardHeader title="Features" description="What this company can use. Switches override the plan for this company only." /><CardBody className="max-h-96 space-y-1 overflow-auto">
      {(catalog ?? []).map((x) => (
        <div key={x.key} className="flex items-center justify-between gap-2 text-sm">
          <span className={effective.includes(x.key) ? '' : 'text-ink-400'}>{effective.includes(x.key) ? '✓' : '·'} {x.name}{x.key in ov && <Badge tone={ov[x.key] ? 'success' : 'danger'}>{ov[x.key] ? 'forced on' : 'forced off'}</Badge>}</span>
          {can('subscriptions:manage') && !x.isCore && (
            <select aria-label={`${x.name} switch`} className="rounded border border-line bg-white text-xs" value={x.key in ov ? (ov[x.key] ? 'on' : 'off') : ''} disabled={sw.isPending}
              onChange={(e) => sw.mutate({ key: x.key, enabled: e.target.value === '' ? null : e.target.value === 'on' })}>
              <option value="">Plan default</option><option value="on">Force on</option><option value="off">Force off</option>
            </select>
          )}
        </div>
      ))}
    </CardBody></Card>
  );
}
