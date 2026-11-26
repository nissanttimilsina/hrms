import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, DataTable, Skeleton, Badge, EmptyState, UsageMeter, Select, Checkbox, Textarea, Field, Input, useToast } from '@hrms/shared-ui';
import { api, useAuth, useList, useAction, FormDialog, PageHeader, StatusBadge, KV, npr, dt, fullName } from '../lib.jsx';

// =========================================================================== users & roles
const SCOPES = ['OWN', 'DIRECT_REPORTS', 'DEPARTMENT', 'BRANCH', 'COMPANY'];
export function Access() {
  const a = useAuth();
  const [tab, setTab] = useState('users');
  const users = useList('/users', { sort: 'fullName', order: 'asc' });
  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: () => api.get('/roles') });
  const { data: perms } = useQuery({ queryKey: ['permissions'], queryFn: () => api.get('/permissions'), enabled: tab === 'roles' });
  const [dlg, setDlg] = useState(null);
  const invite = useAction((b) => api.post('/users/invitations', b), { success: (r) => `Invitation sent to ${r.email}`, invalidate: ['/users'], onDone: () => setDlg(null) });
  const assign = useAction(({ id, roleIds }) => api.put(`/users/${id}/roles`, { roleIds }), { success: 'Roles updated', invalidate: ['/users'], onDone: () => setDlg(null) });
  const roleOpts = (roles ?? []).map((r) => ({ value: r.id, label: r.name }));
  return (
    <>
      <PageHeader title="Users & roles" description="Who can sign in, and what each role can see and do" actions={tab === 'users' ? a.can('users:create') && <Button onClick={() => setDlg({ t: 'invite' })}>Invite user</Button> : a.can('roles:create') && <Button onClick={() => setDlg({ t: 'role', role: { name: '', grants: [] } })}>New custom role</Button>} />
      <div className="mb-4 flex gap-1 border-b border-line">{[['users', 'Users'], ['roles', 'Roles']].map(([k, l]) => <button key={k} type="button" onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{l}</button>)}</div>
      {tab === 'users' ? (
        <DataTable loading={users.loading} rows={users.rows} meta={users.meta} onPage={users.page} columns={[
          { key: 'fullName', header: 'Name', render: (r) => <><p className="font-medium">{r.fullName}</p><p className="text-xs text-ink-400">{r.email}</p></> },
          { key: 'roles', header: 'Roles', render: (r) => r.roles.map((x) => x.name).join(', ') || '—' },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> }, { key: 'lastLoginAt', header: 'Last sign-in', render: (r) => dt(r.lastLoginAt, true) },
          { key: 'x', header: '', render: (r) => a.can('users:manage') && <Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'roles', user: r, sel: r.roles.map((x) => x.id) })}>Change roles</Button> },
        ]} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(roles ?? []).map((r) => (
            <Card key={r.id}><CardBody>
              <div className="flex items-start justify-between"><div><p className="font-medium">{r.name}</p><p className="text-xs text-ink-400">{r.isSystem ? 'Default role' : 'Custom role'} · {r.grants.length} permissions</p></div>
                {a.can('roles:edit') && r.key !== 'company_owner' && <Button size="sm" variant="ghost" onClick={() => setDlg({ t: 'role', role: r })}>Edit</Button>}</div>
            </CardBody></Card>
          ))}
        </div>
      )}
      <FormDialog open={dlg?.t === 'invite'} onClose={() => setDlg(null)} title="Invite user" description="For employees, use 'Give login access' on their profile so the account is linked." fields={[{ name: 'fullName', label: 'Full name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'roleId', label: 'Role', type: 'select', options: roleOpts, required: true }]} loading={invite.isPending} error={invite.error} onSubmit={(b) => invite.mutate(b)} />
      {dlg?.t === 'roles' && (
        <FormDialog open onClose={() => setDlg(null)} title={`Roles for ${dlg.user.fullName}`} initial={Object.fromEntries((roles ?? []).map((r) => [r.id, dlg.sel.includes(r.id)]))}
          fields={(roles ?? []).map((r) => ({ name: r.id, type: 'checkbox', checkLabel: r.name, span: 1 }))} loading={assign.isPending} error={assign.error}
          onSubmit={(b) => assign.mutate({ id: dlg.user.id, roleIds: Object.entries(b).filter(([, v]) => v).map(([k]) => k) })} />
      )}
      {dlg?.t === 'role' && <RoleEditor role={dlg.role} perms={perms ?? []} onClose={() => setDlg(null)} />}
    </>
  );
}

function RoleEditor({ role, perms, onClose }) {
  const [name, setName] = useState(role.name);
  const [grants, setGrants] = useState(() => Object.fromEntries(role.grants.map((g) => [g.permission, g.scope])));
  const save = useAction((b) => (role.id ? api.put(`/roles/${role.id}/permissions`, { grants: b.grants }) : api.post('/roles', b)), { success: 'Role saved', invalidate: [['roles']], onDone: onClose });
  const groups = useMemo(() => perms.reduce((m, p) => ({ ...m, [p.key.split(':')[0]]: [...(m[p.key.split(':')[0]] ?? []), p] }), {}), [perms]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-label="Edit role">
      <div className="flex max-h-[90dvh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-pop">
        <div className="border-b border-line p-5">{role.id ? <h2 className="font-semibold">{role.name}</h2> : <Field label="Role name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>}
          <p className="mt-1 text-xs text-ink-500">Choose actions and how far each reaches. You can only grant what you hold yourself.</p></div>
        <div className="flex-1 space-y-4 overflow-auto p-5">
          {Object.entries(groups).map(([res, list]) => (
            <div key={res}><p className="mb-1 text-sm font-semibold capitalize">{res.replace('_', ' ')}{list.some((p) => !p.availableInPlan) && <Badge tone="warning">not in plan</Badge>}</p>
              <div className="grid gap-1 sm:grid-cols-2">{list.map((p) => (
                <div key={p.key} className="flex items-center gap-2 text-sm">
                  <Checkbox label={p.action} checked={p.key in grants} onChange={(e) => setGrants((g) => { const n = { ...g }; if (e.target.checked) n[p.key] = 'COMPANY'; else delete n[p.key]; return n; })} />
                  {p.key in grants && p.supportsScope && <Select className="h-8 w-40 text-xs" value={grants[p.key]} onChange={(e) => setGrants({ ...grants, [p.key]: e.target.value })} options={SCOPES.map((s) => ({ value: s, label: s.replace('_', ' ').toLowerCase() }))} aria-label={`${p.key} scope`} />}
                </div>))}</div></div>
          ))}
        </div>
        {save.error && <p className="px-5 text-sm text-danger-600">{save.error.message}</p>}
        <div className="flex justify-end gap-2 border-t border-line p-4"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ name, grants: Object.entries(grants).map(([permission, scope]) => ({ permission, scope })) })}>Save role</Button></div>
      </div>
    </div>
  );
}

// =========================================================================== announcements
export function Announcements() {
  const a = useAuth();
  const { data, isPending } = useQuery({ queryKey: ['announcements'], queryFn: () => api.get('/announcements') });
  const [open, setOpen] = useState(false);
  const post = useAction((b) => api.post('/announcements', b), { success: 'Announcement published', invalidate: [['announcements'], ['dashboard']], onDone: () => setOpen(false) });
  const del = useAction((id) => api.del(`/announcements/${id}`), { success: 'Removed', invalidate: [['announcements']] });
  return (
    <>
      <PageHeader title="Announcements" actions={a.can('announcements:create') && <Button onClick={() => setOpen(true)}>New announcement</Button>} />
      {isPending ? <Skeleton className="h-40" /> : !data.length ? <EmptyState title="No announcements yet" /> : (
        <div className="space-y-3">{data.map((x) => (
          <Card key={x.id}><CardBody>
            <div className="flex items-start justify-between gap-3"><div><p className="font-semibold">{x.pinned && <Badge tone="brand">Pinned</Badge>} {x.title}</p><p className="text-xs text-ink-400">{dt(x.publishedAt, true)}</p></div>{a.can('announcements:delete') && <Button size="sm" variant="ghost" onClick={() => del.mutate(x.id)}>Delete</Button>}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">{x.body}</p>
          </CardBody></Card>))}</div>
      )}
      <FormDialog open={open} onClose={() => setOpen(false)} title="New announcement" initial={{ notify: true }} fields={[{ name: 'title', label: 'Title', required: true, span: 2 }, { name: 'body', label: 'Message', type: 'textarea', rows: 6, required: true }, { name: 'pinned', type: 'checkbox', checkLabel: 'Pin to top' }, { name: 'notify', type: 'checkbox', checkLabel: 'Notify everyone' }]}
        loading={post.isPending} error={post.error} onSubmit={(b) => post.mutate({ ...b, pinned: !!b.pinned, notify: !!b.notify })} />
    </>
  );
}

// =========================================================================== billing
function postToProvider({ action, fields }) {
  const f = Object.assign(document.createElement('form'), { method: 'POST', action });
  Object.entries(fields).forEach(([k, v]) => f.appendChild(Object.assign(document.createElement('input'), { type: 'hidden', name: k, value: v })));
  document.body.appendChild(f); f.submit();
}

export function Billing() {
  const a = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data: b, isPending, refetch } = useQuery({ queryKey: ['billing'], queryFn: () => api.get('/billing') });
  const { data: invoices, refetch: refetchInv } = useQuery({ queryKey: ['invoices'], queryFn: () => api.get('/billing/invoices') });
  const [cycle, setCycle] = useState('MONTHLY');
  const [preview, setPreview] = useState(null);
  const [pay, setPay] = useState(null);
  const [profile, setProfile] = useState(false);
  useEffect(() => {
    const p = params.get('payment');
    if (!p) return;
    if (p === 'success') { toast.success('Payment confirmed', 'Your subscription has been updated.'); a.reload(); }
    else if (p === 'pending') toast.info('Payment pending', 'We are confirming it with the provider. This page updates automatically.');
    else toast.error('Payment not completed', 'No money was taken, or it could not be verified. You can try again.');
    setParams({}, { replace: true }); refetch(); refetchInv();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const checkout = useAction((x) => api.post('/billing/checkout', x), { onDone: (r) => { setPreview(null); refetchInv(); refetch(); if (r.scheduled) toast.success('Downgrade scheduled', `Takes effect on ${dt(r.effectiveAt)}`); else setPay(r.invoice); } });
  const start = useAction(({ id, ...x }) => api.post(`/billing/invoices/${id}/pay`, x), {
    onDone: (r) => {
      if (r.redirect?.method === 'POST') postToProvider(r.redirect);
      else if (r.redirect?.url) window.location.assign(r.redirect.url);
      else { toast.success('Transfer details submitted', 'Our finance team will verify it within one business day.'); setPay(null); refetchInv(); }
    },
  });
  const saveProfile = useAction((x) => api.put('/billing/profile', x), { success: 'Billing details saved', onDone: () => { setProfile(false); refetch(); } });
  if (isPending) return <Skeleton className="h-96" />;
  const s = b.subscription;
  const usage = a.me.subscription.usage;
  const lim = a.me.subscription.limits;
  const manage = a.can('subscription:manage');
  return (
    <>
      <PageHeader title="Subscription" description={`${s.planName} · ${s.billingCycle.toLowerCase()} · ${s.status === 'TRIAL' ? `trial ends ${dt(s.trialEndsAt)}` : `renews ${dt(s.currentPeriodEnd)}`}`} actions={manage && <Button variant="secondary" onClick={() => setProfile(true)}>Billing details</Button>} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2"><CardHeader title="Current plan" actions={<StatusBadge value={s.status} />} /><CardBody>
          <KV items={[['Plan', s.planName], ['Billing', s.billingCycle.toLowerCase()], ['Access', <StatusBadge value={b.access.state} />], ['Period ends', dt(s.currentPeriodEnd)], b.pendingDowngrade && ['Scheduled change', `${b.pendingDowngrade.name} at renewal`]]} />
          {b.pendingDowngrade && manage && <Button size="sm" variant="ghost" className="mt-3" onClick={async () => { await api.post('/billing/cancel-downgrade', {}); refetch(); }}>Keep current plan</Button>}
        </CardBody></Card>
        <Card><CardHeader title="Usage" /><CardBody className="space-y-4"><UsageMeter label="Employees" used={usage.employees} limit={lim.employees} /><UsageMeter label="Branches" used={usage.branches} limit={lim.branches} /><UsageMeter label="Storage (MB)" used={usage.storageMb} limit={lim.storageMb} /></CardBody></Card>
      </div>
      {b.openInvoices.length > 0 && manage && (
        <Card className="mt-4 border-warning-600/40"><CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm"><strong>Invoice {b.openInvoices[0].number}</strong> for {npr(b.openInvoices[0].total)} is due {dt(b.openInvoices[0].dueAt)}.</p>
          <Button onClick={() => setPay(b.openInvoices[0])}>Pay now</Button>
        </CardBody></Card>
      )}
      {manage && (
        <>
          <div className="mb-3 mt-8 flex items-end justify-between"><h2 className="font-semibold">Change plan</h2>
            <div className="w-36 shrink-0"><Select value={cycle} onChange={(e) => setCycle(e.target.value)} aria-label="Billing cycle" options={[{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual' }]} /></div></div>
          <div className="grid gap-3 md:grid-cols-4">
            {b.plans.map((p) => {
              const price = cycle === 'ANNUAL' ? p.prices.annual : p.prices.monthly;
              const current = p.code === s.planCode && cycle === s.billingCycle;
              return (
                <Card key={p.code} className={current ? 'ring-2 ring-brand-500' : ''}><CardBody>
                  <p className="font-semibold">{p.name}</p><p className="text-xs text-ink-500">{p.limits.employees ? `Up to ${p.limits.employees} employees` : 'Custom capacity'}</p>
                  <p className="mt-2 text-xl font-semibold">{p.contactSales ? 'Custom' : npr(price)}</p>{!p.contactSales && <p className="text-xs text-ink-400">per {cycle === 'ANNUAL' ? 'year' : 'month'} + VAT</p>}
                  <Button size="sm" className="mt-3 w-full" variant={current ? 'secondary' : 'primary'} disabled={p.contactSales}
                    onClick={async () => { try { setPreview({ plan: p, ...(await api.post('/billing/preview', { planCode: p.code, billingCycle: cycle })) }); } catch (e) { toast.error('Not available', e.message); } }}>
                    {p.contactSales ? 'Contact sales' : current ? 'Renew' : 'Choose'}
                  </Button>
                </CardBody></Card>
              );
            })}
          </div>
        </>
      )}
      <h2 className="mb-3 mt-8 font-semibold">Invoices</h2>
      <DataTable rows={invoices ?? []} empty={<EmptyState title="No invoices yet" />} columns={[
        { key: 'number', header: 'Invoice', render: (r) => <span className="font-mono text-xs">{r.number}</span> }, { key: 'kind', header: 'Type', render: (r) => r.kind.toLowerCase().replace('_', ' ') },
        { key: 'issuedAt', header: 'Issued', render: (r) => dt(r.issuedAt) }, { key: 'total', header: 'Total', align: 'right', render: (r) => npr(r.total) }, { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        { key: 'x', header: '', render: (r) => <div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => api.download(`/billing/invoices/${r.id}/pdf`, `${r.number}.pdf`)}>PDF</Button>{r.status === 'OPEN' && manage && <Button size="sm" onClick={() => setPay(r)}>Pay</Button>}</div> },
      ]} />
      {preview && (
        <FormDialog open onClose={() => setPreview(null)} title={`Switch to ${preview.plan.name}`} submitLabel={preview.kind === 'DOWNGRADE' ? 'Schedule change' : 'Continue to payment'}
          description={preview.kind === 'DOWNGRADE' ? `Your plan changes at renewal on ${dt(preview.effectiveAt)}. No charge now.` : `${preview.description}. Subtotal ${npr(preview.subtotal)} + VAT ${npr(preview.tax)} = ${npr(preview.total)}.`}
          fields={preview.kind === 'DOWNGRADE' ? [] : [{ name: 'couponCode', label: 'Promo code (optional)' }]} loading={checkout.isPending} error={checkout.error}
          onSubmit={(x) => checkout.mutate({ planCode: preview.plan.code, billingCycle: cycle, ...(x.couponCode && { couponCode: x.couponCode.toUpperCase() }) })} />
      )}
      {pay && <PayDialog invoice={pay} providers={b.providers} bankAccounts={b.bankAccounts} onClose={() => setPay(null)} onPay={(x) => start.mutate({ id: pay.id, ...x })} loading={start.isPending} error={start.error} />}
      <FormDialog open={profile} onClose={() => setProfile(false)} title="Billing details" description="Printed on your invoices." initial={b.profile}
        fields={[{ name: 'name', label: 'Legal name', required: true }, { name: 'pan', label: 'PAN / VAT number' }, { name: 'address', label: 'Address' }, { name: 'email', label: 'Billing email', type: 'email' }, { name: 'phone', label: 'Phone' }]}
        loading={saveProfile.isPending} error={saveProfile.error} onSubmit={(x) => saveProfile.mutate(x)} />
    </>
  );
}

function PayDialog({ invoice, providers, bankAccounts, onClose, onPay, loading, error }) {
  const [method, setMethod] = useState(providers[0]);
  const [proof, setProof] = useState('');
  const label = { ESEWA: 'eSewa', KHALTI: 'Khalti', BANK_TRANSFER: 'Bank transfer' };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink-900/40 p-4" role="dialog" aria-modal="true" aria-label="Pay invoice">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-pop">
        <h2 className="font-semibold">Pay {invoice.number}</h2>
        <p className="mt-1 text-2xl font-semibold">{npr(invoice.total)}</p>
        <div className="mt-4 grid grid-cols-3 gap-2">{providers.map((p) => <button key={p} type="button" onClick={() => setMethod(p)} className={`rounded-md border p-3 text-sm font-medium ${method === p ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-line'}`}>{label[p]}</button>)}</div>
        {method === 'BANK_TRANSFER' && (
          <div className="mt-4 space-y-3 text-sm">
            {bankAccounts.length ? bankAccounts.map((acc, i) => <div key={i} className="rounded-md bg-subtle p-3"><p className="font-medium">{acc.bank}</p><p>{acc.accountName} · {acc.accountNumber}</p>{acc.branch && <p className="text-ink-500">{acc.branch}</p>}</div>) : <p className="text-ink-500">Contact billing for our bank details.</p>}
            <p className="text-ink-500">Use <strong>{invoice.number}</strong> as the remark. After transferring, tell us the bank, date and transaction reference:</p>
            <Textarea rows={3} value={proof} onChange={(e) => setProof(e.target.value)} aria-label="Transfer details" placeholder="e.g. NIC Asia, 26 Nov, ref 123456" />
          </div>
        )}
        {method !== 'BANK_TRANSFER' && <p className="mt-4 text-sm text-ink-500">You'll be taken to {label[method]} to pay securely. We confirm the payment directly with {label[method]} before your plan changes.</p>}
        {error && <p className="mt-3 text-sm text-danger-600">{error.message}</p>}
        <div className="mt-6 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={loading} disabled={method === 'BANK_TRANSFER' && proof.trim().length < 5} onClick={() => onPay({ provider: method, ...(method === 'BANK_TRANSFER' && { proofNote: proof }) })}>{method === 'BANK_TRANSFER' ? 'Submit transfer details' : `Pay with ${label[method]}`}</Button></div>
      </div>
    </div>
  );
}

// =========================================================================== support
export function Support() {
  const nav = useNavigate();
  const a = useAuth();
  const list = useList('/support/tickets');
  const [open, setOpen] = useState(false);
  const create = useAction((b) => api.post('/support/tickets', b), { success: (r) => `Ticket #${r.number} created`, invalidate: ['/support/tickets'], onDone: (r) => { setOpen(false); nav(`/support/${r.id}`); } });
  return (
    <>
      <PageHeader title="Help & support" description="Our team typically replies within one business day" actions={a.can('support:create') && <Button onClick={() => setOpen(true)}>New ticket</Button>} />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/support/${r.id}`)} empty={<EmptyState title="No tickets" description="Questions, problems or ideas? Open a ticket." />} columns={[
        { key: 'number', header: '#', render: (r) => `#${r.number}` }, { key: 'subject', header: 'Subject' }, { key: 'category', header: 'Category', render: (r) => r.category.toLowerCase().replace('_', ' ') },
        { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> }, { key: 'updatedAt', header: 'Updated', render: (r) => dt(r.updatedAt, true) },
      ]} />
      <FormDialog open={open} onClose={() => setOpen(false)} title="New support ticket" initial={{ category: 'GENERAL', priority: 'NORMAL' }} fields={[
        { name: 'subject', label: 'Subject', required: true, span: 2 }, { name: 'category', label: 'Category', type: 'select', options: ['GENERAL', 'BILLING', 'TECHNICAL', 'FEATURE_REQUEST', 'BUG', 'ACCOUNT'].map((x) => ({ value: x, label: x.toLowerCase().replace('_', ' ') })) },
        { name: 'priority', label: 'Priority', type: 'select', options: ['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((x) => ({ value: x, label: x.toLowerCase() })) }, { name: 'body', label: 'Describe the issue', type: 'textarea', rows: 6, required: true },
      ]} loading={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} />
    </>
  );
}

export function SupportTicket() {
  const { id } = useParams();
  const key = ['ticket', id];
  const { data: t, isPending } = useQuery({ queryKey: key, queryFn: () => api.get(`/support/tickets/${id}`) });
  const [body, setBody] = useState('');
  const reply = useAction((b) => api.post(`/support/tickets/${id}/messages`, b), { invalidate: [key], onDone: () => setBody('') });
  const rate = useAction((b) => api.post(`/support/tickets/${id}/rate`, b), { success: 'Thanks for your feedback', invalidate: [key] });
  if (isPending) return <Skeleton className="h-64" />;
  return (
    <>
      <PageHeader title={`#${t.number} ${t.subject}`} description={<StatusBadge value={t.status} />} />
      <div className="space-y-3">{t.messages.map((m) => <div key={m.id} className={`rounded-lg border p-4 ${m.authorType === 'PLATFORM_USER' ? 'border-brand-200 bg-brand-50' : 'border-line bg-white'}`}><p className="mb-1 text-xs text-ink-500">{m.authorType === 'PLATFORM_USER' ? 'Lishnu support' : 'You'} · {dt(m.createdAt, true)}</p><p className="whitespace-pre-wrap text-sm">{m.body}</p></div>)}</div>
      {t.status !== 'CLOSED' && <div className="mt-4 space-y-2"><Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Reply" placeholder="Write a reply…" /><Button loading={reply.isPending} disabled={!body.trim()} onClick={() => reply.mutate({ body })}>Send</Button></div>}
      {['RESOLVED', 'CLOSED'].includes(t.status) && !t.satisfaction && <div className="mt-4 flex items-center gap-2 text-sm">How did we do? {[1, 2, 3, 4, 5].map((n) => <Button key={n} size="sm" variant="secondary" onClick={() => rate.mutate({ satisfaction: n })}>{n}</Button>)}</div>}
    </>
  );
}

// =========================================================================== settings, audit, my profile
export function Settings() {
  const a = useAuth();
  const { data, isPending, refetch } = useQuery({ queryKey: ['tenant-settings'], queryFn: () => api.get('/settings') });
  const save = useAction(({ key, value }) => api.put(`/settings/${key}`, { value }), { success: 'Saved', onDone: () => refetch() });
  const [idf, setIdf] = useState(null);
  if (isPending) return <Skeleton className="h-64" />;
  const f = idf ?? data.settings['org.employee_id_format'] ?? { prefix: 'EMP-', padding: 4, next: 1 };
  const edit = a.can('settings:configure');
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader title="Company" /><CardBody><KV items={[['Name', data.company.name], ['Industry', data.company.industry], ['Timezone', data.company.timezone], ['Currency', data.company.currency], ['Calendar', data.company.calendar === 'BS' ? 'Bikram Sambat' : 'Gregorian']]} /></CardBody></Card>
        <Card><CardHeader title="Employee ID format" description={`Next ID: ${f.prefix}${String(f.next).padStart(f.padding, '0')}`} /><CardBody className="grid grid-cols-3 gap-3">
          <Field label="Prefix"><Input value={f.prefix} disabled={!edit} onChange={(e) => setIdf({ ...f, prefix: e.target.value })} /></Field>
          <Field label="Digits"><Input type="number" value={f.padding} disabled={!edit} onChange={(e) => setIdf({ ...f, padding: Number(e.target.value) })} /></Field>
          <Field label="Next number"><Input type="number" value={f.next} disabled={!edit} onChange={(e) => setIdf({ ...f, next: Number(e.target.value) })} /></Field>
          {edit && <Button className="col-span-3 justify-self-start" loading={save.isPending} onClick={() => save.mutate({ key: 'org.employee_id_format', value: f })}>Save</Button>}
        </CardBody></Card>
      </div>
    </>
  );
}

export function Audit() {
  const list = useList('/audit-logs');
  return (
    <>
      <PageHeader title="Audit log" description="Every important change in your workspace. Entries can't be edited or deleted." />
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} columns={[
        { key: 'createdAt', header: 'When', render: (r) => dt(r.createdAt, true) }, { key: 'action', header: 'Action', render: (r) => <span className="font-mono text-xs">{r.action}</span> },
        { key: 'actorType', header: 'By', render: (r) => r.actorType.toLowerCase().replace('_', ' ') }, { key: 'entityType', header: 'Record' }, { key: 'ip', header: 'IP' },
      ]} />
    </>
  );
}

export function MyProfile() {
  const { data: e, isPending, refetch } = useQuery({ queryKey: ['me-emp'], queryFn: () => api.get('/employees/me') });
  const [open, setOpen] = useState(false);
  const save = useAction((b) => api.patch('/employees/me', b), { success: 'Profile updated', onDone: () => { setOpen(false); refetch(); } });
  if (isPending) return <Skeleton className="h-64" />;
  const ec = e.emergencyContacts?.[0];
  return (
    <>
      <PageHeader title="My profile" actions={<Button variant="secondary" onClick={() => setOpen(true)}>Update contact details</Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader title={fullName(e)} description={`${e.employeeCode} · ${e.designation?.name ?? ''}`} /><CardBody><KV items={[['Department', e.department?.name], ['Branch', e.branch?.name], ['Manager', e.manager ? fullName(e.manager) : '—'], ['Joined', dt(e.joinedOn)], ['Employment', e.employmentType?.toLowerCase()]]} /></CardBody></Card>
        <Card><CardHeader title="Personal" /><CardBody><KV items={[['Mobile', e.phone], ['Personal email', e.personalEmail], ['PAN', e.pan], ['Bank', e.bank?.bankName ? `${e.bank.bankName} ****${e.bank.last4 ?? ''}` : '—'], ['Emergency contact', ec ? `${ec.name} (${ec.relation}) ${ec.phone}` : '—']]} /></CardBody></Card>
      </div>
      <FormDialog open={open} onClose={() => setOpen(false)} title="Update contact details" description="For changes to your bank, PAN or job details, contact HR." initial={{ phone: e.phone ?? '', personalEmail: e.personalEmail ?? '', ecName: ec?.name ?? '', ecRelation: ec?.relation ?? '', ecPhone: ec?.phone ?? '' }}
        fields={[{ name: 'phone', label: 'Mobile' }, { name: 'personalEmail', label: 'Personal email', type: 'email' }, { name: 'ecName', label: 'Emergency contact name' }, { name: 'ecRelation', label: 'Relation' }, { name: 'ecPhone', label: 'Emergency phone' }]}
        loading={save.isPending} error={save.error}
        onSubmit={({ ecName, ecRelation, ecPhone, ...b }) => save.mutate({ ...b, ...(ecName && { emergencyContacts: [{ name: ecName, relation: ecRelation ?? '', phone: ecPhone ?? '' }] }) })} />
    </>
  );
}
