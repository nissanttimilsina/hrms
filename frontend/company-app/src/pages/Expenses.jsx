import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Clock3, Download, Paperclip, Receipt, Upload, Wallet, XCircle } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, DataTable, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, Badge, Checkbox, cn, useToast } from '@hrms/shared-ui';
import { api, useAuth, useAction, useList, PageHeader, StatusBadge, KV, npr, dt, todayKtm, addDays } from '../lib.jsx';

const BS_MONTHS = ['Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Asoj', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
const periodLabel = (p) => { const [y, m] = p.split('-').map(Number); return `${BS_MONTHS[m - 1]} ${y}`; };
const STATUS_TEXT = {
  SUBMITTED: 'Waiting for approval', MANAGER_APPROVED: 'With finance', APPROVED: 'Approved, not paid yet', SCHEDULED: 'Paid with salary',
  PAID: 'Paid', REJECTED: 'Rejected', CANCELLED: 'Cancelled',
};

const usePolicy = () => useQuery({ queryKey: ['expense-policy'], queryFn: () => api.get('/expenses/policy'), staleTime: 300_000 });

const SumTile = ({ label, value, hint, icon: Icon, tone }) => (
  <Card className="p-4">
    <div className="flex items-start justify-between gap-2"><p className="text-xs font-medium text-ink-500">{label}</p>{Icon && <Icon className={cn('size-4', tone === 'success' ? 'text-success-600' : tone === 'warning' ? 'text-warning-600' : 'text-ink-400')} />}</div>
    <p className="mt-1.5 text-2xl font-semibold tabular-nums text-ink-900">{value}</p>
    {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
  </Card>
);

// =========================================================================== new claim
export function NewClaimDialog({ open, onClose, onDone }) {
  const { data: policy } = usePolicy();
  const toast = useToast();
  const fileRef = useRef(null);
  const blank = { category: '', title: '', expenseDate: todayKtm(), amount: '', merchant: '', description: '' };
  const [v, setV] = useState(blank);
  const [file, setFile] = useState(null);
  const [errs, setErrs] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setV(blank); setFile(null); setErrs({}); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const cats = (policy?.categories ?? []).filter((c) => c.active);
  const cat = cats.find((c) => c.code === v.category);
  const amount = Number(v.amount) || 0;
  const needsReceipt = policy && amount > policy.receiptRequiredAbove;
  const set = (k) => (e) => setV((p) => ({ ...p, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    const fe = {};
    if (!v.category) fe.category = 'Choose a category';
    if (v.title.trim().length < 3) fe.title = 'Describe the expense in a few words';
    if (!(amount > 0)) fe.amount = 'Enter the amount';
    if (needsReceipt && !file) fe.receipt = `Required above ${npr(policy.receiptRequiredAbove)}`;
    setErrs(fe);
    if (Object.keys(fe).length) return;
    const fd = new FormData();
    Object.entries(v).forEach(([k, x]) => { if (x !== '') fd.append(k, x); });
    if (file) fd.append('receipt', file);
    setBusy(true);
    try {
      const c = await api.post('/expenses', fd);
      toast.success(`Claim ${c.key} submitted`, c.needsManager ? 'Your manager will review it first.' : 'Finance will review it.');
      onDone?.(c);
    } catch (err) {
      setErrs(err.fieldErrors ?? {});
      if (!Object.keys(err.fieldErrors ?? {}).length) toast.error('Could not submit the claim', err.message);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New expense claim" description="Claim money you spent for work. Attach a photo or PDF of the receipt." size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="new-claim" loading={busy}>Submit claim</Button></>}>
      <form id="new-claim" onSubmit={submit} noValidate className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Category" required error={errs.category} hint={cat?.limit ? `Limit per claim: ${npr(cat.limit)}` : undefined}>
          <Select value={v.category} onChange={set('category')} placeholder="Choose" options={cats.map((c) => ({ value: c.code, label: c.name }))} />
        </Field>
        <Field label="Date of expense" required error={errs.expenseDate} hint={policy ? `Within the last ${policy.maxAgeDays} days` : undefined}>
          <Input type="date" value={v.expenseDate} max={todayKtm()} min={policy ? addDays(todayKtm(), -policy.maxAgeDays) : undefined} onChange={set('expenseDate')} />
        </Field>
        <Field label="What was it for?" required error={errs.title} className="sm:col-span-2">
          <Input value={v.title} maxLength={160} placeholder="e.g. Taxi to client meeting in Lalitpur" onChange={set('title')} />
        </Field>
        <Field label="Amount (NPR)" required error={errs.amount} hint={cat?.limit && amount > cat.limit ? `Above the ${npr(cat.limit)} limit. Approvers may approve less.` : undefined}>
          <Input type="number" inputMode="decimal" min="0" step="0.01" value={v.amount} onChange={set('amount')} />
        </Field>
        <Field label="Paid to" error={errs.merchant} hint="Shop, company or person">
          <Input value={v.merchant} maxLength={120} onChange={set('merchant')} />
        </Field>
        <Field label="Notes" error={errs.description} className="sm:col-span-2">
          <Textarea rows={2} value={v.description} maxLength={1000} onChange={set('description')} placeholder="Anything the approver should know" />
        </Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-sm font-medium text-ink-900">Receipt{needsReceipt && <span className="text-danger-600"> *</span>}</p>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,application/pdf" className="sr-only" aria-label="Receipt file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button type="button" onClick={() => fileRef.current?.click()} className={cn('flex w-full items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-left text-sm hover:bg-subtle', errs.receipt ? 'border-danger-600' : 'border-line-strong')}>
            {file ? <Paperclip className="size-5 shrink-0 text-brand-600" /> : <Upload className="size-5 shrink-0 text-ink-400" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-ink-900">{file ? file.name : 'Take a photo or choose a file'}</span>
              <span className="block text-xs text-ink-500">{file ? `${Math.max(1, Math.round(file.size / 1024))} KB · tap to change` : `JPEG, PNG or PDF${policy ? `. Required above ${npr(policy.receiptRequiredAbove)}.` : ''}`}</span>
            </span>
          </button>
          {errs.receipt && <p role="alert" className="mt-1.5 text-xs font-medium text-danger-600">{errs.receipt}</p>}
        </div>
      </form>
    </Dialog>
  );
}

// =========================================================================== employee: my expenses
export function MyExpenses() {
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(new URLSearchParams(loc.search).get('new') === '1');
  const list = useList('/expenses', { view: 'mine' });
  const { data: sum, refetch } = useQuery({ queryKey: ['expense-summary'], queryFn: () => api.get('/expenses/summary') });
  const m = sum?.mine;
  return (
    <>
      <PageHeader title="My expenses" description="Claim work expenses and follow them until they are paid." actions={<Button onClick={() => setOpen(true)}><Receipt className="size-4" />New claim</Button>} />
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3 [&>*]:min-w-0">
        <SumTile label="Waiting for approval" value={m ? npr(m.pendingAmount) : '…'} hint={m ? `${m.pending} claim(s)` : undefined} icon={Clock3} tone="warning" />
        <SumTile label="Approved, to be paid to you" value={m ? npr(m.toReceive) : '…'} icon={Wallet} />
        <SumTile label="Paid this fiscal year" value={m ? npr(m.paidThisYear) : '…'} icon={CheckCircle2} tone="success" />
      </div>
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/me/expenses/${r.id}`)}
        empty={<EmptyState icon={<Receipt className="size-5" />} title="No claims yet" description="Spent money for work? Submit a claim with the receipt and track it here." action={<Button onClick={() => setOpen(true)}>New claim</Button>} />}
        columns={[
          { key: 'key', header: 'Claim', render: (r) => <><p className="font-medium text-ink-900">{r.title}</p><p className="text-xs text-ink-400">{r.key} · {r.categoryName}</p></> },
          { key: 'expenseDate', header: 'Date', render: (r) => dt(r.expenseDate) },
          { key: 'amount', header: 'Amount', align: 'right', render: (r) => <>{npr(r.amount)}{r.approvedAmount != null && r.approvedAmount < r.amount && <p className="text-xs text-warning-700">{npr(r.approvedAmount)} approved</p>}</> },
          { key: 'status', header: 'Status', render: (r) => <><StatusBadge value={r.status} />{r.status === 'SCHEDULED' && <p className="mt-0.5 text-xs text-ink-500">{r.payrollLabel} salary</p>}</> },
        ]} />
      <NewClaimDialog open={open} onClose={() => setOpen(false)} onDone={(c) => { setOpen(false); list.refetch(); refetch(); nav(`/me/expenses/${c.id}`); }} />
    </>
  );
}

// =========================================================================== claim detail (employee and approvers)
export function ExpenseDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const mineView = loc.pathname.startsWith('/me/');
  const key = ['expense', id];
  const { data: c, isPending, error } = useQuery({ queryKey: key, queryFn: () => api.get(`/expenses/${id}`) });
  const [dlg, setDlg] = useState(null);
  const inv = [key, ['/expenses'], ['expense-summary']];
  const done = { invalidate: inv, onDone: () => setDlg(null) };
  const approve = useAction((b) => api.post(`/expenses/${id}/approve`, b), { success: 'Claim approved', ...done });
  const reject = useAction((b) => api.post(`/expenses/${id}/reject`, b), { success: 'Claim rejected', ...done });
  const pay = useAction((b) => api.post(`/expenses/${id}/pay`, b), { success: (r) => (r.status === 'SCHEDULED' ? (r.recalculate ? `Added to ${r.payrollLabel} payroll. Recalculate that payroll to include it.` : `Added to ${r.payrollLabel} payroll`) : 'Marked as paid'), ...done });
  const unschedule = useAction(() => api.post(`/expenses/${id}/unschedule`, {}), { success: 'Removed from payroll', ...done });
  const cancel = useAction(() => api.post(`/expenses/${id}/cancel`, {}), { success: 'Claim cancelled', ...done });
  if (isPending) return <Skeleton className="h-96" />;
  if (error) return <EmptyState title="Claim not found" description={error.message} action={<Button variant="secondary" onClick={() => nav(-1)}>Go back</Button>} />;
  const ab = c.abilities;
  return (
    <>
      <Link to={mineView ? '/me/expenses' : '/expenses'} className="mb-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-900"><ArrowLeft className="size-4" />{mineView ? 'My expenses' : 'Expense claims'}</Link>
      <PageHeader title={c.title} description={`${c.key} · ${c.categoryName}${c.employee && !mineView ? ` · ${c.employee.name}` : ''}`}
        actions={<>
          {ab.cancel && <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel claim</Button>}
          {ab.reject && <Button variant="secondary" onClick={() => setDlg('reject')}><XCircle className="size-4" />Reject</Button>}
          {ab.approve && <Button onClick={() => setDlg('approve')}><CheckCircle2 className="size-4" />Approve</Button>}
          {ab.unschedule && <Button variant="secondary" loading={unschedule.isPending} onClick={() => unschedule.mutate()}>Remove from payroll</Button>}
          {ab.pay && <Button onClick={() => setDlg('pay')}><Wallet className="size-4" />Pay</Button>}
        </>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.5fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-ink-500">Claimed</p>
                <p className="text-3xl font-semibold tabular-nums text-ink-900">{npr(c.amount)}</p>
                {c.approvedAmount != null && c.approvedAmount < c.amount && <p className="text-sm font-medium text-warning-700">{npr(c.approvedAmount)} approved</p>}
                {c.overLimit && <Badge tone="warning" className="mt-1">Above the {npr(c.limit)} category limit</Badge>}
              </div>
              <div className="text-right">
                <StatusBadge value={c.status} />
                <p className="mt-1 text-sm text-ink-500">{c.waitingFor ? `Waiting for ${c.waitingFor.toLowerCase()}` : STATUS_TEXT[c.status]}</p>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <KV items={[
                ['Employee', c.employee ? `${c.employee.name} (${c.employee.code})` : null], ['Date of expense', dt(c.expenseDate)], ['Category', c.categoryName], ['Paid to', c.merchant],
                c.payoutMethod && ['Paid via', c.payoutMethod === 'PAYROLL' ? `Salary, ${c.payrollLabel}` : 'Direct payment'], c.paymentRef && ['Payment reference', c.paymentRef],
              ]} />
              {c.description && <p className="mt-4 whitespace-pre-wrap rounded-md bg-subtle p-3 text-sm text-ink-700">{c.description}</p>}
              <div className="mt-4">
                {c.hasReceipt ? <Button variant="secondary" size="sm" onClick={() => api.download(`/expenses/${c.id}/receipt`, `receipt-${c.key}`)}><Download className="size-4" />Download receipt</Button>
                  : <p className="text-sm text-ink-500">No receipt attached.</p>}
              </div>
            </CardBody>
          </Card>
        </div>
        <Card className="self-start">
          <CardHeader title="History" />
          <CardBody>
            <ol className="relative space-y-4 border-l border-line pl-5">
              {c.timeline.map((e, i) => (
                <li key={i} className="relative">
                  <span className={cn('absolute -left-[26px] top-1 size-3 rounded-full border-2 border-surface', e.label === 'Rejected' ? 'bg-danger-600' : i === c.timeline.length - 1 ? 'bg-brand-600' : 'bg-success-600')} aria-hidden="true" />
                  <p className="text-sm font-medium text-ink-900">{e.label}</p>
                  <p className="text-xs text-ink-500">{dt(e.at, true)}{e.by ? ` · ${e.by}` : ''}</p>
                  {e.note && <p className="mt-1 text-sm text-ink-700">{e.note}</p>}
                </li>
              ))}
              {c.waitingFor && <li className="relative"><span className="absolute -left-[26px] top-1 size-3 rounded-full border-2 border-line-strong bg-surface" aria-hidden="true" /><p className="text-sm text-ink-500">Next: {c.waitingFor.toLowerCase()}</p></li>}
            </ol>
          </CardBody>
        </Card>
      </div>
      {dlg === 'approve' && <ApproveDialog claim={c} action={approve} onClose={() => setDlg(null)} />}
      {dlg === 'reject' && <ReasonDialog title={`Reject ${c.key}?`} label="Reason (the employee sees this)" submitLabel="Reject claim" action={reject} onClose={() => setDlg(null)} />}
      {dlg === 'pay' && <PayDialog claim={c} action={pay} onClose={() => setDlg(null)} />}
    </>
  );
}

function ApproveDialog({ claim, action, onClose }) {
  const [amount, setAmount] = useState(String(claim.amount));
  const [note, setNote] = useState('');
  const fe = action.error?.fieldErrors ?? {};
  const reduced = claim.abilities.changeAmount && Number(amount) < claim.amount;
  return (
    <Dialog open onClose={onClose} title={`Approve ${claim.key}`} description={claim.abilities.changeAmount ? 'You can approve less than the claimed amount. Say why if you do.' : 'Finance will review it next.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={action.isPending} onClick={() => action.mutate({ ...(claim.abilities.changeAmount && Number(amount) !== claim.amount && { amount: Number(amount) }), ...(note.trim() && { note: note.trim() }) })}>Approve</Button></>}>
      <div className="space-y-4">
        {claim.abilities.changeAmount && <Field label="Amount to approve (NPR)" error={fe.amount} hint={`Claimed ${npr(claim.amount)}`}><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
        <Field label={reduced ? 'Why is the amount reduced?' : 'Note (optional)'} required={reduced} error={fe.note}><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function ReasonDialog({ title, label, submitLabel, action, onClose }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog open onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={action.isPending} onClick={() => action.mutate({ reason: reason.trim() })}>{submitLabel}</Button></>}>
      <Field label={label} required error={action.error?.fieldErrors?.reason}><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function bsMonths(todayBS, count = 4) {
  const out = [];
  let y = Number(todayBS.slice(0, 4)); let m = Number(todayBS.slice(5, 7));
  for (let i = 0; i < count; i += 1) {
    const p = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ value: p, label: periodLabel(p) });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function PayDialog({ claim, action, onClose }) {
  const { data: dash } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard') });
  const withSalary = claim.abilities.payWithSalary;
  const [method, setMethod] = useState(withSalary ? 'PAYROLL' : 'DIRECT');
  const months = dash ? bsMonths(dash.todayBS) : [];
  const [period, setPeriod] = useState('');
  const [reference, setReference] = useState('');
  const fe = action.error?.fieldErrors ?? {};
  const chosen = period || months[0]?.value;
  return (
    <Dialog open onClose={onClose} title={`Pay ${npr(claim.payable)} to ${claim.employee?.name ?? 'the employee'}`} description={`${claim.key} · ${claim.title}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={action.isPending} onClick={() => action.mutate(method === 'PAYROLL' ? { method, period: chosen } : { method, reference: reference.trim() })}>{method === 'PAYROLL' ? 'Add to payroll' : 'Mark as paid'}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How to pay">
          {[['PAYROLL', 'With salary', 'Added to the payroll as a non-taxable reimbursement', !withSalary], ['DIRECT', 'Paid directly', 'Cash, cheque or bank transfer you already made', false]].map(([k, t, d, off]) => (
            <button key={k} type="button" role="radio" aria-checked={method === k} disabled={off} onClick={() => setMethod(k)}
              className={cn('rounded-lg border p-3 text-left disabled:cursor-not-allowed disabled:opacity-50', method === k ? 'border-brand-600 bg-brand-50' : 'border-line hover:bg-subtle')}>
              <p className="text-sm font-semibold text-ink-900">{t}</p><p className="mt-0.5 text-xs text-ink-500">{off ? 'Needs payroll on your plan and payroll edit rights' : d}</p>
            </button>
          ))}
        </div>
        {method === 'PAYROLL'
          ? <Field label="Payroll month" error={fe.period} hint="If that payroll is already calculated, recalculate it afterwards."><Select value={chosen ?? ''} onChange={(e) => setPeriod(e.target.value)} options={months} /></Field>
          : <Field label="Payment reference" required error={fe.reference} hint="Cheque, transfer or voucher number"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
      </div>
    </Dialog>
  );
}

// =========================================================================== approvers and finance
export function Expenses() {
  const a = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('queue');
  const queue = useList('/expenses', { view: 'queue' });
  const all = useList('/expenses', { view: 'team' });
  const list = tab === 'queue' ? queue : all;
  const [exp, setExp] = useState(false);
  const finance = (a.scopeOf('expenses:approve') ?? []).includes('COMPANY');
  return (
    <>
      <PageHeader title="Expense claims" description={finance ? 'Approve claims and pay them with salary or directly.' : 'Approve your team\'s claims. Finance pays them afterwards.'}
        actions={<>
          {a.can('expenses:export') && <Button variant="secondary" onClick={() => setExp(true)}><Download className="size-4" />Export</Button>}
          {a.can('expenses:configure') && <Button variant="secondary" onClick={() => nav('/expenses/settings')}>Categories and rules</Button>}
        </>} />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">
        {[['queue', `Needs your action${queue.meta?.total ? ` (${queue.meta.total})` : ''}`], ['all', 'All claims']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-900')}>{l}</button>
        ))}
      </div>
      {tab === 'all' && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Input placeholder="Search…" className="max-w-xs" aria-label="Search" defaultValue={all.params.search ?? ''} onChange={(e) => all.set({ search: e.target.value || undefined })} />
          <div className="w-48"><Select aria-label="Status" placeholder="Any status" value={all.params.status ?? ''} onChange={(e) => all.set({ status: e.target.value || undefined })} options={Object.entries(STATUS_TEXT).map(([value, label]) => ({ value, label }))} /></div>
        </div>
      )}
      <DataTable loading={list.loading} rows={list.rows} meta={list.meta} onPage={list.page} onRowClick={(r) => nav(`/expenses/${r.id}`)}
        empty={<EmptyState icon={<CheckCircle2 className="size-5" />} title={tab === 'queue' ? 'Nothing waiting for you' : 'No claims yet'} description={tab === 'queue' ? 'New claims from your team will appear here.' : undefined} />}
        columns={[
          { key: 'employee', header: 'Employee', render: (r) => <><p className="font-medium text-ink-900">{r.employee.name}</p><p className="text-xs text-ink-400">{r.employee.code}</p></> },
          { key: 'title', header: 'Claim', render: (r) => <><p className="max-w-64 truncate">{r.title}</p><p className="text-xs text-ink-400">{r.key} · {r.categoryName}{r.hasReceipt ? '' : ' · no receipt'}</p></> },
          { key: 'expenseDate', header: 'Date', render: (r) => dt(r.expenseDate) },
          { key: 'amount', header: 'Amount', align: 'right', render: (r) => <>{npr(r.amount)}{r.overLimit && <p className="text-xs text-warning-700">over limit</p>}</> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        ]} />
      {list.meta?.totalAmount > 0 && <p className="mt-2 text-right text-sm text-ink-500">Total of these claims: <span className="font-medium text-ink-900">{npr(list.meta.totalAmount)}</span></p>}
      {exp && <ExportDialog onClose={() => setExp(false)} />}
    </>
  );
}

function ExportDialog({ onClose }) {
  const toast = useToast();
  const [range, setRange] = useState({ from: addDays(todayKtm(), -30), to: todayKtm(), status: '' });
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await api.download(`/expenses/export?from=${range.from}&to=${range.to}${range.status ? `&status=${range.status}` : ''}`, `expenses-${range.from}-to-${range.to}.csv`); onClose(); } catch (e) { toast.error('Export failed', e.message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Export expense claims" description="A CSV file you can open in Excel." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={go}>Download CSV</Button></>}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Expense date from"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        <Field label="Status" className="sm:col-span-2"><Select placeholder="Any status" value={range.status} onChange={(e) => setRange({ ...range, status: e.target.value })} options={Object.entries(STATUS_TEXT).map(([value, label]) => ({ value, label }))} /></Field>
      </div>
    </Dialog>
  );
}

// =========================================================================== settings
export function ExpenseSettings() {
  const { data, isPending } = usePolicy();
  const [p, setP] = useState(null);
  const save = useAction((b) => api.put('/expenses/policy', b), { success: 'Expense rules saved', invalidate: [['expense-policy']], onDone: (v) => setP(v) });
  useEffect(() => { if (data && !p) setP(data); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isPending || !p) return <Skeleton className="h-96" />;
  const setCat = (i, patch) => setP({ ...p, categories: p.categories.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const err = save.error;
  return (
    <>
      <Link to="/expenses" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-900"><ArrowLeft className="size-4" />Expense claims</Link>
      <PageHeader title="Expense categories and rules" actions={<Button loading={save.isPending} onClick={() => save.mutate({ ...p, categories: p.categories.map((c) => ({ ...c, limit: c.limit === '' || c.limit == null ? null : Number(c.limit) })) })}>Save changes</Button>} />
      {err && <p role="alert" className="mb-4 rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{Object.values(err.fieldErrors ?? {})[0] ?? err.message}</p>}
      <Card className="mb-4">
        <CardBody className="grid grid-cols-1 gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label="Receipt required above (NPR)" hint="Claims above this amount must have a receipt"><Input type="number" min="0" value={p.receiptRequiredAbove} onChange={(e) => setP({ ...p, receiptRequiredAbove: Number(e.target.value) })} /></Field>
          <Field label="Claim within (days)" hint="How long after the expense a claim is accepted"><Input type="number" min="1" max="365" value={p.maxAgeDays} onChange={(e) => setP({ ...p, maxAgeDays: Number(e.target.value) })} /></Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Categories" description="A limit is per claim. Claims above it are flagged for approvers, who can approve less." actions={<Button size="sm" variant="secondary" onClick={() => setP({ ...p, categories: [...p.categories, { code: '', name: '', limit: null, active: true }] })}>Add category</Button>} />
        <div className="divide-y divide-line">
          {p.categories.map((c, i) => (
            <div key={i} className="grid grid-cols-2 items-end gap-3 px-5 py-3 sm:grid-cols-[110px_1fr_160px_auto] [&>*]:min-w-0">
              <Field label="Code"><Input value={c.code} maxLength={20} onChange={(e) => setCat(i, { code: e.target.value.toUpperCase() })} /></Field>
              <Field label="Name"><Input value={c.name} maxLength={40} onChange={(e) => setCat(i, { name: e.target.value })} /></Field>
              <Field label="Limit (NPR)"><Input type="number" min="0" placeholder="No limit" value={c.limit ?? ''} onChange={(e) => setCat(i, { limit: e.target.value === '' ? null : e.target.value })} /></Field>
              <div className="pb-2"><Checkbox label="In use" checked={c.active} onChange={(e) => setCat(i, { active: e.target.checked })} /></div>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

/** Small dashboard card for employees: where their claims stand. */
export function ExpensesCard() {
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['expense-summary'], queryFn: () => api.get('/expenses/summary'), retry: false });
  const m = data?.mine;
  if (!m) return null;
  return (
    <Card>
      <CardHeader title="Expenses" actions={<Link to="/me/expenses" className="text-sm font-medium text-brand-700 hover:underline">All</Link>} />
      <CardBody className="space-y-2 text-sm">
        <div className="flex justify-between"><span className="text-ink-500">Waiting for approval</span><span className="font-medium tabular-nums">{m.pending ? npr(m.pendingAmount) : '—'}</span></div>
        <div className="flex justify-between"><span className="text-ink-500">To be paid to you</span><span className="font-medium tabular-nums">{m.toReceive ? npr(m.toReceive) : '—'}</span></div>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => nav('/me/expenses?new=1')}><Receipt className="size-4" />New claim</Button>
      </CardBody>
    </Card>
  );
}
