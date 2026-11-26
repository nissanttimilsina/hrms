import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, DataTable, Skeleton, Textarea, Checkbox, Select, Field, Input, Badge } from '@hrms/shared-ui';
import { api, useAuth, useList, useAction, FormDialog, PageHeader, StatusBadge, Filters, KV, npr, dt } from '../lib.jsx';

// =========================================================================== billing
export function Billing() {
  const [tab, setTab] = useState('payments');
  return (
    <>
      <PageHeader title="Billing" description="Invoices, payment verification and promo codes" />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {[['payments', 'Payments'], ['invoices', 'Invoices'], ['coupons', 'Promo codes']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{l}</button>
        ))}
      </div>
      {tab === 'payments' ? <Payments /> : tab === 'invoices' ? <Invoices /> : <Coupons />}
    </>
  );
}

function Payments() {
  const { can } = useAuth();
  const list = useList('/payments', { status: 'PENDING_VERIFICATION' });
  const [dlg, setDlg] = useState(null);
  const approve = useAction(({ id, ...b }) => api.post(`/payments/${id}/approve`, b), { success: 'Payment approved; subscription updated', invalidate: ['/payments'], onDone: () => setDlg(null) });
  const reject = useAction(({ id, ...b }) => api.post(`/payments/${id}/reject`, b), { success: 'Payment rejected; customer notified', invalidate: ['/payments'], onDone: () => setDlg(null) });
  return (
    <>
      <Filters list={list} search={false} selects={[{ name: 'status', label: 'Any status', options: ['PENDING_VERIFICATION', 'INITIATED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] }, { name: 'provider', label: 'Any method', options: ['BANK_TRANSFER', 'ESEWA', 'KHALTI', 'MANUAL'] }]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page}
        empty={<p className="p-8 text-center text-sm text-ink-500">No payments match.</p>}
        columns={[
          { key: 'tenant', header: 'Company', render: (r) => r.tenant?.name },
          { key: 'invoice', header: 'Invoice', render: (r) => r.invoice?.number },
          { key: 'provider', header: 'Method', render: (r) => r.provider.replace('_', ' ').toLowerCase() },
          { key: 'amount', header: 'Amount', align: 'right', render: (r) => npr(r.amount) },
          { key: 'proof', header: 'Payer details', render: (r) => <span className="line-clamp-2 max-w-64 text-xs">{r.proofNote || r.providerRef || '—'}</span> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'createdAt', header: 'Date', render: (r) => dt(r.createdAt, true) },
          { key: 'a', header: '', render: (r) => r.status === 'PENDING_VERIFICATION' && can('billing:manage') && (
            <div className="flex gap-1"><Button size="sm" onClick={() => setDlg({ t: 'approve', p: r })}>Approve</Button><Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'reject', p: r })}>Reject</Button></div>
          ) },
        ]} />
      <FormDialog open={dlg?.t === 'approve'} onClose={() => setDlg(null)} title="Approve payment" description={`Confirm ${npr(dlg?.p.amount)} was received in the bank account. The invoice is marked paid and the plan activated.`} fields={[{ name: 'providerRef', label: 'Bank transaction reference', required: true }, { name: 'note', label: 'Internal note', type: 'textarea' }]} submitLabel="Approve payment" loading={approve.isPending} error={approve.error} onSubmit={(b) => approve.mutate({ id: dlg.p.id, ...b })} />
      <FormDialog open={dlg?.t === 'reject'} onClose={() => setDlg(null)} title="Reject payment" description="The customer is emailed with the reason." fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} submitLabel="Reject" loading={reject.isPending} error={reject.error} onSubmit={(b) => reject.mutate({ id: dlg.p.id, ...b })} />
    </>
  );
}

function Invoices() {
  const { can } = useAuth();
  const list = useList('/invoices');
  const [dlg, setDlg] = useState(null);
  const voidI = useAction(({ id, ...b }) => api.post(`/invoices/${id}/void`, b), { success: 'Invoice voided', invalidate: ['/invoices'], onDone: () => setDlg(null) });
  const credit = useAction(({ id, ...b }) => api.post(`/invoices/${id}/credit-note`, b), { success: 'Credit note issued', invalidate: ['/invoices'], onDone: () => setDlg(null) });
  const record = useAction(({ id, ...b }) => api.post(`/invoices/${id}/record-payment`, b), { success: 'Payment recorded', invalidate: ['/invoices'], onDone: () => setDlg(null) });
  return (
    <>
      <Filters list={list} selects={[{ name: 'status', label: 'Any status', options: ['OPEN', 'PAID', 'VOID', 'REFUNDED'] }]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page}
        columns={[
          { key: 'number', header: 'Number', render: (r) => <span className="font-mono text-xs">{r.number}</span> },
          { key: 'tenant', header: 'Company', render: (r) => r.tenant?.name },
          { key: 'kind', header: 'Type', render: (r) => r.kind.replace('_', ' ').toLowerCase() },
          { key: 'total', header: 'Total', align: 'right', render: (r) => npr(r.total) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'issuedAt', header: 'Issued', render: (r) => dt(r.issuedAt) },
          { key: 'a', header: '', render: (r) => (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => api.download(`/invoices/${r.id}/pdf`, `${r.number}.pdf`)}>PDF</Button>
              {can('billing:manage') && r.status === 'OPEN' && <><Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'record', i: r })}>Record payment</Button><Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'void', i: r })}>Void</Button></>}
              {can('billing:manage') && r.status === 'PAID' && r.kind !== 'CREDIT_NOTE' && <Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'credit', i: r })}>Credit note</Button>}
            </div>
          ) },
        ]} />
      <FormDialog open={dlg?.t === 'void'} onClose={() => setDlg(null)} title={`Void ${dlg?.i.number}`} fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} submitLabel="Void invoice" loading={voidI.isPending} error={voidI.error} onSubmit={(b) => voidI.mutate({ id: dlg.i.id, ...b })} />
      <FormDialog open={dlg?.t === 'credit'} onClose={() => setDlg(null)} title={`Credit note for ${dlg?.i.number}`} description={`Up to ${npr(dlg?.i.total)} including VAT.`} fields={[{ name: 'amount', label: 'Amount incl. VAT (NPR)', type: 'number', required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }]} submitLabel="Issue credit note" loading={credit.isPending} error={credit.error} onSubmit={(b) => credit.mutate({ id: dlg.i.id, ...b })} />
      <FormDialog open={dlg?.t === 'record'} onClose={() => setDlg(null)} title={`Record payment for ${dlg?.i.number}`} description="For cash or cheque received offline. Marks the invoice paid and applies the plan." fields={[{ name: 'providerRef', label: 'Receipt / cheque number', required: true }, { name: 'note', label: 'Note', type: 'textarea' }]} submitLabel="Record payment" loading={record.isPending} error={record.error} onSubmit={(b) => record.mutate({ id: dlg.i.id, ...b })} />
    </>
  );
}

function Coupons() {
  const { can } = useAuth();
  const { data, isPending, refetch } = useQuery({ queryKey: ['coupons'], queryFn: () => api.get('/coupons') });
  const [open, setOpen] = useState(false);
  const create = useAction((b) => api.post('/coupons', b), { success: 'Promo code created', invalidate: [['coupons']], onDone: () => setOpen(false) });
  const toggle = useAction(({ id, isActive }) => api.patch(`/coupons/${id}`, { isActive }), { onDone: () => refetch() });
  return (
    <>
      {can('billing:manage') && <div className="mb-3 flex justify-end"><Button onClick={() => setOpen(true)}>New promo code</Button></div>}
      <DataTable loading={isPending} rows={data ?? []} columns={[
        { key: 'code', header: 'Code', render: (r) => <span className="font-mono">{r.code}</span> },
        { key: 'off', header: 'Discount', render: (r) => (r.percentOff ? `${Number(r.percentOff)}%` : npr(r.amountOff)) },
        { key: 'plans', header: 'Plans', render: (r) => r.planCodes.join(', ') || 'All' },
        { key: 'use', header: 'Used', render: (r) => `${r.redemptions}${r.maxRedemptions ? ` / ${r.maxRedemptions}` : ''}` },
        { key: 'validUntil', header: 'Valid until', render: (r) => dt(r.validUntil) },
        { key: 'isActive', header: 'Active', render: (r) => <Checkbox checked={r.isActive} disabled={!can('billing:manage')} onChange={(e) => toggle.mutate({ id: r.id, isActive: e.target.checked })} aria-label="Active" /> },
      ]} />
      <FormDialog open={open} onClose={() => setOpen(false)} title="New promo code" fields={[
        { name: 'code', label: 'Code', required: true }, { name: 'description', label: 'Description' },
        { name: 'percentOff', label: 'Percent off', type: 'number', hint: 'Use either percent or amount' }, { name: 'amountOff', label: 'Amount off (NPR)', type: 'number' },
        { name: 'planCodes', label: 'Limit to plans (comma-separated codes)', type: 'tags' }, { name: 'maxRedemptions', label: 'Max uses', type: 'number' },
        { name: 'validFrom', label: 'Valid from', type: 'datetime' }, { name: 'validUntil', label: 'Valid until', type: 'datetime' },
      ]} loading={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} />
    </>
  );
}

// =========================================================================== CRM
const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'DEMO_SCHEDULED', 'PROPOSAL', 'WON', 'LOST'];
export function Leads() {
  const { can } = useAuth();
  const nav = useNavigate();
  const list = useList('/leads');
  const [open, setOpen] = useState(false);
  const create = useAction((b) => api.post('/leads', b), { success: 'Lead created', invalidate: ['/leads'], onDone: () => setOpen(false) });
  const { data: report } = useQuery({ queryKey: ['crm-report'], queryFn: () => api.get('/crm/report') });
  return (
    <>
      <PageHeader title="Sales CRM" description="Leads from the website, demos, quotations and manual entries" actions={can('crm:manage') && <Button onClick={() => setOpen(true)}>Add lead</Button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        {(report?.pipeline ?? []).sort((a, b) => LEAD_STATUSES.indexOf(a.status) - LEAD_STATUSES.indexOf(b.status)).map((p) => (
          <button key={p.status} type="button" onClick={() => list.set({ status: p.status })} className="rounded-lg border border-line bg-white px-3 py-2 text-left hover:border-brand-200">
            <p className="text-xs text-ink-500">{p.status.replace('_', ' ').toLowerCase()}</p><p className="font-semibold">{p.count}</p>
          </button>
        ))}
      </div>
      <Filters list={list} selects={[{ name: 'status', label: 'Any status', options: LEAD_STATUSES }, { name: 'source', label: 'Any source', options: ['CONTACT', 'DEMO', 'ENTERPRISE_QUOTE', 'CALLBACK', 'SIGNUP', 'MANUAL', 'REFERRAL'] }, { name: 'due', label: 'All', options: [{ value: 'true', label: 'Follow-up due' }] }]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/crm/leads/${r.id}`)}
        columns={[
          { key: 'name', header: 'Lead', render: (r) => <><p className="font-medium text-ink-900">{r.company || r.name}</p><p className="text-xs text-ink-400">{r.name} · {r.email}</p></> },
          { key: 'source', header: 'Source', render: (r) => r.source.replace('_', ' ').toLowerCase() },
          { key: 'employeeCount', header: 'Employees', align: 'right' },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'followUpAt', header: 'Follow-up', render: (r) => <span className={r.followUpAt && new Date(r.followUpAt) < new Date() && !['WON', 'LOST'].includes(r.status) ? 'font-medium text-danger-600' : ''}>{dt(r.followUpAt)}</span> },
          { key: 'createdAt', header: 'Created', render: (r) => dt(r.createdAt) },
        ]} />
      <FormDialog open={open} onClose={() => setOpen(false)} title="Add lead" initial={{ source: 'MANUAL' }} fields={[
        { name: 'name', label: 'Contact name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'company', label: 'Company' }, { name: 'phone', label: 'Phone' },
        { name: 'employeeCount', label: 'Employees', type: 'number' }, { name: 'source', label: 'Source', type: 'select', options: ['MANUAL', 'REFERRAL', 'CALLBACK', 'CONTACT'].map((x) => ({ value: x, label: x.toLowerCase() })) },
        { name: 'message', label: 'Notes', type: 'textarea' },
      ]} loading={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} />
    </>
  );
}

export function LeadDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const key = ['lead', id];
  const { data: l, isPending } = useQuery({ queryKey: key, queryFn: () => api.get(`/leads/${id}`) });
  const { data: staff } = useQuery({ queryKey: ['staff'], queryFn: () => api.get('/staff'), enabled: can('platform_users:manage') });
  const { data: plans } = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get('/plans') });
  const [dlg, setDlg] = useState(null);
  const [note, setNote] = useState({ type: 'NOTE', body: '' });
  const update = useAction((b) => api.patch(`/leads/${id}`, b), { success: 'Lead updated', invalidate: [key, '/leads'], onDone: () => setDlg(null) });
  const activity = useAction((b) => api.post(`/leads/${id}/activities`, b), { invalidate: [key], onDone: () => setNote({ type: 'NOTE', body: '' }) });
  const convert = useAction((b) => api.post(`/leads/${id}/convert`, b), { success: 'Converted to a company', invalidate: [key], onDone: (r) => nav(`/tenants/${r.tenantId}`) });
  if (isPending) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title={l.company || l.name} description={`${l.source.replace('_', ' ').toLowerCase()} lead · ${dt(l.createdAt, true)}`} actions={can('crm:manage') && (
        <><Button variant="secondary" onClick={() => setDlg('edit')}>Update</Button>{!l.convertedTenantId && can('tenants:manage') && <Button onClick={() => setDlg('convert')}>Convert to company</Button>}</>
      )} />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card><CardHeader title="Details" actions={<StatusBadge value={l.status} />} /><CardBody>
          <KV items={[['Contact', l.name], ['Email', <a href={`mailto:${l.email}`}>{l.email}</a>], ['Phone', l.phone], ['Industry', l.industry], ['Employees', l.employeeCount], ['Branches', l.branchCount], ['Interested plan', l.interestedPlan], ['Modules', l.modules.join(', ')], ['Preferred time', dt(l.preferredAt, true)], ['Demo', dt(l.demoAt, true)], ['Follow-up', dt(l.followUpAt, true)], ['Estimated value', npr(l.estimatedValue)], l.lostReason && ['Lost reason', l.lostReason], ['UTM', Object.entries(l.utm || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '—']]} />
          {l.message && <p className="mt-4 whitespace-pre-wrap rounded-md bg-subtle p-3 text-sm">{l.message}</p>}
        </CardBody></Card>
        <Card><CardHeader title="Activity" /><CardBody>
          {can('crm:manage') && (
            <form className="mb-4 space-y-2" onSubmit={(e) => { e.preventDefault(); if (note.body.trim()) activity.mutate(note); }}>
              <div className="flex gap-2"><Select value={note.type} onChange={(e) => setNote({ ...note, type: e.target.value })} className="w-32" aria-label="Activity type" options={['NOTE', 'CALL', 'EMAIL', 'MEETING', 'QUOTE'].map((x) => ({ value: x, label: x.toLowerCase() }))} /><Textarea rows={2} value={note.body} onChange={(e) => setNote({ ...note, body: e.target.value })} placeholder="Log a call, email or note…" aria-label="Activity" /></div>
              <div className="flex justify-end"><Button size="sm" type="submit" loading={activity.isPending}>Log activity</Button></div>
            </form>
          )}
          <ol className="space-y-3">{l.activities.map((a) => <li key={a.id} className="border-l-2 border-line pl-3 text-sm"><p className="text-xs text-ink-400">{a.type.toLowerCase()} · {dt(a.createdAt, true)}</p><p className="whitespace-pre-wrap">{a.body}</p></li>)}</ol>
        </CardBody></Card>
      </div>
      <FormDialog open={dlg === 'edit'} onClose={() => setDlg(null)} title="Update lead" initial={{ status: l.status, assignedTo: l.assignedTo ?? '', estimatedValue: l.estimatedValue ?? '', lostReason: l.lostReason ?? '', interestedPlan: l.interestedPlan ?? '' }} fields={[
        { name: 'status', label: 'Status', type: 'select', options: LEAD_STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ').toLowerCase() })) },
        { name: 'assignedTo', label: 'Sales rep', type: 'select', placeholder: 'Unassigned', options: (staff ?? []).map((s) => ({ value: s.id, label: s.fullName })) },
        { name: 'followUpAt', label: 'Follow-up', type: 'datetime' }, { name: 'demoAt', label: 'Demo scheduled', type: 'datetime' },
        { name: 'estimatedValue', label: 'Estimated annual value (NPR)', type: 'number' }, { name: 'interestedPlan', label: 'Interested plan' },
        { name: 'lostReason', label: 'Lost reason (required if lost)', type: 'textarea' },
      ]} loading={update.isPending} error={update.error} onSubmit={(b) => update.mutate(b)} />
      <FormDialog open={dlg === 'convert'} onClose={() => setDlg(null)} title="Convert to company" description={`Creates a workspace and emails an invitation to ${l.email}.`} initial={{ planCode: l.interestedPlan || 'STANDARD', billingCycle: 'MONTHLY', trial: true, slug: (l.company || l.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) }} fields={[
        { name: 'slug', label: 'Workspace', required: true }, { name: 'planCode', label: 'Plan', type: 'select', options: (plans ?? []).map((p) => ({ value: p.code, label: p.name })) },
        { name: 'billingCycle', label: 'Billing', type: 'select', options: [{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual' }] },
        { name: 'maxEmployees', label: 'Negotiated employee limit', type: 'number' }, { name: 'maxBranches', label: 'Negotiated branch limit', type: 'number' }, { name: 'trial', type: 'checkbox', checkLabel: 'Start with trial' },
      ]} submitLabel="Create company" loading={convert.isPending} error={convert.error} onSubmit={(b) => convert.mutate(b)} />
    </>
  );
}

// =========================================================================== CMS
const CMS_TYPES = ['PAGE', 'BLOG_POST', 'FAQ', 'TESTIMONIAL', 'CUSTOMER_LOGO', 'ANNOUNCEMENT', 'FEATURE', 'INDUSTRY', 'CHANGELOG'];
export function Cms() {
  const list = useList('/cms', { sort: 'updatedAt' });
  const [edit, setEdit] = useState(null);
  const save = useAction(({ id, ...b }) => (id ? api.patch(`/cms/${id}`, b) : api.post('/cms', b)), { success: 'Content saved', invalidate: ['/cms'], onDone: () => setEdit(null) });
  const del = useAction((id) => api.del(`/cms/${id}`), { success: 'Deleted', invalidate: ['/cms'], onDone: () => setEdit(null) });
  return (
    <>
      <PageHeader title="Website content" description="Blog posts, FAQs, testimonials, legal pages, announcements and feature-page overrides. Published changes appear on the website within a minute." actions={<Button onClick={() => setEdit({ type: 'BLOG_POST', locale: 'en', status: 'DRAFT', data: {}, seo: {} })}>New entry</Button>} />
      <Filters list={list} selects={[{ name: 'type', label: 'Any type', options: CMS_TYPES }, { name: 'status', label: 'Any status', options: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] }]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => setEdit(r)}
        columns={[
          { key: 'title', header: 'Title', render: (r) => <><p className="font-medium text-ink-900">{r.title}</p><p className="font-mono text-xs text-ink-400">{r.slug}</p></> },
          { key: 'type', header: 'Type', render: (r) => r.type.replace('_', ' ').toLowerCase() },
          { key: 'locale', header: 'Lang' },
          { key: 'status', header: 'Status', render: (r) => <>{<StatusBadge value={r.status} />}{r.publishAt && new Date(r.publishAt) > new Date() && <Badge tone="info">scheduled</Badge>}</> },
          { key: 'updatedAt', header: 'Updated', render: (r) => dt(r.updatedAt, true) },
        ]} />
      {edit && (
        <FormDialog open onClose={() => setEdit(null)} title={edit.id ? 'Edit content' : 'New content'} initial={{ ...edit, publishAt: edit.publishAt ? edit.publishAt.slice(0, 16) : '', data: JSON.stringify(edit.data ?? {}, null, 2), seoTitle: edit.seo?.title ?? '', seoDescription: edit.seo?.description ?? '' }}
          fields={[
            { name: 'type', label: 'Type', type: 'select', options: CMS_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ').toLowerCase() })) }, { name: 'slug', label: 'Slug (url-name)', required: true },
            { name: 'title', label: 'Title', required: true, span: 2 }, { name: 'summary', label: 'Summary', type: 'textarea', rows: 2 },
            { name: 'body', label: 'Body (Markdown)', type: 'textarea', rows: 12 },
            { name: 'data', label: 'Structured data (JSON) — e.g. {"tags":["guide"],"coverUrl":"…"} / {"role":"HR Manager","company":"…"} / {"category":"Pricing"}', type: 'json' },
            { name: 'seoTitle', label: 'SEO title' }, { name: 'seoDescription', label: 'SEO description' },
            { name: 'status', label: 'Status', type: 'select', options: ['DRAFT', 'PUBLISHED', 'ARCHIVED'].map((s) => ({ value: s, label: s.toLowerCase() })) },
            { name: 'publishAt', label: 'Publish at (optional, schedules publication)', type: 'datetime' },
            { name: 'locale', label: 'Language', type: 'select', options: [{ value: 'en', label: 'English' }, { value: 'ne', label: 'Nepali' }] }, { name: 'sortOrder', label: 'Sort order', type: 'number' },
          ]}
          loading={save.isPending} error={save.error}
          onSubmit={({ seoTitle, seoDescription, ...b }) => save.mutate({ id: edit.id, ...b, seo: { ...(seoTitle && { title: seoTitle }), ...(seoDescription && { description: seoDescription }) } })} />
      )}
      {edit?.id && <div className="fixed bottom-6 left-6 z-[60]"><Button variant="danger" size="sm" onClick={() => { if (window.confirm('Delete this entry permanently?')) del.mutate(edit.id); }}>Delete entry</Button></div>}
    </>
  );
}

// =========================================================================== support
export function Support() {
  const nav = useNavigate();
  const list = useList('/support', { status: 'OPEN' });
  return (
    <>
      <PageHeader title="Support tickets" />
      <Filters list={list} selects={[{ name: 'status', label: 'Any status', options: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'] }, { name: 'priority', label: 'Any priority', options: ['URGENT', 'HIGH', 'NORMAL', 'LOW'] }, { name: 'breached', label: 'All', options: [{ value: 'true', label: 'SLA breached' }] }]} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/support/${r.id}`)}
        columns={[
          { key: 'number', header: '#', render: (r) => `#${r.number}` },
          { key: 'subject', header: 'Subject', render: (r) => <><p className="font-medium text-ink-900">{r.subject}</p><p className="text-xs text-ink-400">{r.tenant?.name} · {r.category.toLowerCase()}</p></> },
          { key: 'priority', header: 'Priority', render: (r) => <StatusBadge value={r.priority} /> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
          { key: 'sla', header: 'First response', render: (r) => (r.firstRespondedAt ? dt(r.firstRespondedAt, true) : <span className={new Date(r.firstResponseDueAt) < new Date() ? 'font-medium text-danger-600' : ''}>due {dt(r.firstResponseDueAt, true)}</span>) },
        ]} />
    </>
  );
}

export function TicketDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const key = ['ticket', id];
  const { data: t, isPending } = useQuery({ queryKey: key, queryFn: () => api.get(`/support/${id}`) });
  const [msg, setMsg] = useState({ body: '', isInternal: false, status: '' });
  const reply = useAction((b) => api.post(`/support/${id}/messages`, b), { success: 'Sent', invalidate: [key, '/support'], onDone: () => setMsg({ body: '', isInternal: false, status: '' }) });
  const patch = useAction((b) => api.patch(`/support/${id}`, b), { success: 'Ticket updated', invalidate: [key, '/support'] });
  if (isPending) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title={`#${t.number} ${t.subject}`} description={`${t.tenant.name} · ${t.category.toLowerCase()} · opened ${dt(t.createdAt, true)}`} actions={can('support:manage') && (
        <><Select aria-label="Priority" value={t.priority} onChange={(e) => patch.mutate({ priority: e.target.value })} options={['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((x) => ({ value: x, label: x.toLowerCase() }))} className="w-32" />
          <Select aria-label="Status" value={t.status} onChange={(e) => patch.mutate({ status: e.target.value })} options={['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'].map((x) => ({ value: x, label: x.replace(/_/g, ' ').toLowerCase() }))} className="w-48" /></>
      )} />
      <div className="space-y-3">
        {t.messages.map((m) => (
          <div key={m.id} className={`rounded-lg border p-4 ${m.isInternal ? 'border-warning-600/30 bg-warning-50' : m.authorType === 'PLATFORM_USER' ? 'border-brand-200 bg-brand-50' : 'border-line bg-white'}`}>
            <p className="mb-1 text-xs text-ink-500">{m.isInternal ? 'Internal note' : m.authorType === 'PLATFORM_USER' ? 'Support' : 'Customer'} · {dt(m.createdAt, true)}</p>
            <p className="whitespace-pre-wrap text-sm">{m.body}</p>
          </div>
        ))}
      </div>
      {can('support:manage') && (
        <form className="mt-4 space-y-2 rounded-lg border border-line bg-white p-4" onSubmit={(e) => { e.preventDefault(); if (msg.body.trim()) reply.mutate({ body: msg.body, isInternal: msg.isInternal, ...(msg.status && { status: msg.status }) }); }}>
          <Textarea rows={4} value={msg.body} onChange={(e) => setMsg({ ...msg, body: e.target.value })} placeholder="Write a reply…" aria-label="Reply" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Checkbox label="Internal note (not visible to customer)" checked={msg.isInternal} onChange={(e) => setMsg({ ...msg, isInternal: e.target.checked })} />
            <div className="flex gap-2">
              {!msg.isInternal && <Select aria-label="Set status" value={msg.status} onChange={(e) => setMsg({ ...msg, status: e.target.value })} placeholder="Keep status" options={[{ value: 'WAITING_ON_CUSTOMER', label: 'Waiting on customer' }, { value: 'RESOLVED', label: 'Resolved' }]} className="w-48" />}
              <Button type="submit" loading={reply.isPending}>{msg.isInternal ? 'Add note' : 'Send reply'}</Button>
            </div>
          </div>
        </form>
      )}
    </>
  );
}

// =========================================================================== settings, staff, audit
export function Settings() {
  const { data, isPending, refetch } = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/settings') });
  const save = useAction(({ key, value }) => api.put(`/settings/${encodeURIComponent(key)}`, { value }), { success: 'Setting saved', onDone: () => refetch() });
  if (isPending) return <Skeleton className="h-96" />;
  return (
    <>
      <PageHeader title="Platform settings" description="VAT, seller details printed on invoices, bank accounts for transfers, support SLAs and sign-up." />
      <div className="space-y-3">{Object.entries(data).map(([k, v]) => <SettingRow key={k} k={k} v={v} onSave={(value) => save.mutate({ key: k, value })} saving={save.isPending} />)}</div>
    </>
  );
}
function SettingRow({ k, v, onSave, saving }) {
  const isObj = typeof v === 'object';
  const [val, setVal] = useState(isObj ? JSON.stringify(v, null, 2) : String(v));
  const [err, setErr] = useState('');
  const submit = () => {
    setErr('');
    try { onSave(isObj ? JSON.parse(val) : typeof v === 'number' ? Number(val) : typeof v === 'boolean' ? val === 'true' : val); } catch { setErr('Invalid JSON'); }
  };
  return (
    <Card><CardBody className="grid gap-3 sm:grid-cols-[220px_1fr_auto] sm:items-start">
      <p className="font-mono text-sm">{k}</p>
      <Field error={err}>{isObj ? <Textarea rows={Math.min(10, val.split('\n').length + 1)} className="font-mono text-xs" value={val} onChange={(e) => setVal(e.target.value)} aria-label={k} /> : typeof v === 'boolean' ? <Select value={val} onChange={(e) => setVal(e.target.value)} options={[{ value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }]} aria-label={k} /> : <Input value={val} onChange={(e) => setVal(e.target.value)} aria-label={k} />}</Field>
      <Button size="sm" onClick={submit} loading={saving}>Save</Button>
    </CardBody></Card>
  );
}

export function Staff() {
  const { me } = useAuth();
  const { data, isPending, refetch } = useQuery({ queryKey: ['staff'], queryFn: () => api.get('/staff') });
  const { data: roles } = useQuery({ queryKey: ['staff-roles'], queryFn: () => api.get('/staff/roles') });
  const [open, setOpen] = useState(false);
  const create = useAction((b) => api.post('/staff', b), { success: 'Staff member created', onDone: () => { setOpen(false); refetch(); } });
  const upd = useAction(({ id, ...b }) => api.patch(`/staff/${id}`, b), { success: 'Updated', onDone: () => refetch() });
  return (
    <>
      <PageHeader title="Lishnu Tech staff" description="Who can access this portal, and what they can do" actions={<Button onClick={() => setOpen(true)}>Add staff</Button>} />
      <DataTable loading={isPending} rows={data ?? []} columns={[
        { key: 'fullName', header: 'Name', render: (r) => <><p className="font-medium">{r.fullName}</p><p className="text-xs text-ink-400">{r.email}</p></> },
        { key: 'roles', header: 'Roles', render: (r) => r.roles.map((x) => x.name).join(', ') },
        { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        { key: 'lastLoginAt', header: 'Last sign-in', render: (r) => dt(r.lastLoginAt, true) },
        { key: 'a', header: '', render: (r) => r.id !== me.user.id && <Button size="sm" variant="ghost" onClick={() => upd.mutate({ id: r.id, status: r.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })}>{r.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button> },
      ]} />
      <FormDialog open={open} onClose={() => setOpen(false)} title="Add staff member" fields={[
        { name: 'fullName', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'password', label: 'Temporary password', type: 'password', required: true, hint: 'Ask them to change it after first sign-in' },
        { name: 'role', label: 'Role', type: 'select', options: (roles ?? []).map((r) => ({ value: r.key, label: r.name })), required: true },
      ]} loading={create.isPending} error={create.error} onSubmit={({ role, ...b }) => create.mutate({ ...b, roleKeys: [role] })} />
    </>
  );
}

export function Audit() {
  const list = useList('/audit-logs');
  return (
    <>
      <PageHeader title="Audit log" description="Every privileged action across the platform. Entries cannot be edited or deleted." />
      <div className="mb-4 flex gap-2"><Input placeholder="Filter by action, e.g. tenant.suspend" className="max-w-sm" onChange={(e) => list.set({ action: e.target.value || undefined })} aria-label="Action filter" /></div>
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} columns={[
        { key: 'createdAt', header: 'When', render: (r) => dt(r.createdAt, true) },
        { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-xs">{r.action}</span> },
        { key: 'actorType', header: 'Actor', render: (r) => r.actorType.toLowerCase().replace('_', ' ') },
        { key: 'entity', header: 'Entity', render: (r) => (r.entityType ? `${r.entityType} ${String(r.entityId ?? '').slice(0, 8)}` : '—') },
        { key: 'ip', header: 'IP' },
      ]} />
    </>
  );
}
