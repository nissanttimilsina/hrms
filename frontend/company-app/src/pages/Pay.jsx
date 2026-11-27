import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, DataTable, Skeleton, Stat, Badge, EmptyState, Dialog, Select, useToast } from '@hrms/shared-ui';
import { api, useAuth, useAction, FormDialog, PageHeader, StatusBadge, npr, dt, fullName } from '../lib.jsx';

const BS_MONTHS = ['Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Asoj', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
const label = (p) => { const [y, m] = p.split('-').map(Number); return `${BS_MONTHS[m - 1]} ${y}`; };

const ADJ_TYPES = [['BONUS', 'Bonus'], ['INCENTIVE', 'Incentive'], ['ARREARS', 'Arrears'], ['REIMBURSEMENT', 'Reimbursement'], ['FINE', 'Fine (deduction)'], ['OTHER', 'Other']];

export function PayrollRuns() {
  const a = useAuth();
  const nav = useNavigate();
  const { data, isPending } = useQuery({ queryKey: ['runs'], queryFn: () => api.get('/payroll/runs') });
  const { data: dash } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get('/dashboard') });
  const [open, setOpen] = useState(false);
  const bsYear = dash ? Number(dash.todayBS.slice(0, 4)) : 2083;
  const bsMonth = dash ? Number(dash.todayBS.slice(5, 7)) : 1;
  const create = useAction((b) => api.post('/payroll/runs', b), { success: (r) => `Payroll ${r.label} created`, invalidate: [['runs']], onDone: (r) => { setOpen(false); nav(`/payroll/runs/${r.id}`); } });
  const opts = [];
  for (let i = 0; i < 6; i += 1) { let m = bsMonth - i; let y = bsYear; if (m < 1) { m += 12; y -= 1; } const p = `${y}-${String(m).padStart(2, '0')}`; opts.push({ value: p, label: label(p) }); }
  return (
    <>
      <PageHeader title="Payroll" description="Monthly payroll by Nepali month, with maker–checker approval" actions={<>
        {a.can('payroll:configure') && <Link to="/payroll/setup"><Button variant="secondary">Salary components</Button></Link>}
        {a.can('payroll:create') && <Button onClick={() => setOpen(true)}>Run payroll</Button>}
      </>} />
      <DataTable loading={isPending} rows={data ?? []} onRowClick={(r) => nav(`/payroll/runs/${r.id}`)} empty={<EmptyState title="No payroll runs yet" description="Set salaries on employee profiles, then run payroll for a month." />} columns={[
        { key: 'period', header: 'Month', render: (r) => <><p className="font-medium">{label(r.period)}</p><p className="text-xs text-ink-400">{dt(r.periodStart)} – {dt(r.periodEnd)}</p></> },
        { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        { key: 'emp', header: 'Employees', align: 'right', render: (r) => r.totals.employees ?? '—' },
        { key: 'gross', header: 'Gross', align: 'right', render: (r) => npr(r.totals.gross) }, { key: 'net', header: 'Net pay', align: 'right', render: (r) => npr(r.totals.net) },
        { key: 'anomalies', header: 'Checks', render: (r) => (r.anomalies ? <Badge tone="warning">{r.anomalies} to review</Badge> : r.calculatedAt ? <Badge tone="success">OK</Badge> : '—') },
      ]} />
      <FormDialog open={open} onClose={() => setOpen(false)} title="Run payroll" description="Attendance, approved leave, overtime and adjustments for the month are pulled in automatically." initial={{ period: opts[1]?.value }}
        fields={[{ name: 'period', label: 'Month (BS)', type: 'select', options: opts, required: true }, { name: 'notes', label: 'Notes', type: 'textarea', rows: 2 }]} loading={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} />
    </>
  );
}

export function PayrollRunDetail() {
  const { id } = useParams();
  const a = useAuth();
  const key = ['run', id];
  const { data, isPending } = useQuery({ queryKey: key, queryFn: () => api.get(`/payroll/runs/${id}`) });
  const [dlg, setDlg] = useState(null);
  const [item, setItem] = useState(null);
  const done = { invalidate: [key, ['runs']], onDone: () => setDlg(null) };
  const act = (path, msg) => useAction((b) => api.post(`/payroll/runs/${id}/${path}`, b ?? {}), { success: msg, ...done }); // eslint-disable-line react-hooks/rules-of-hooks
  const calc = act('calculate', 'Payroll calculated');
  const submit = act('submit', 'Submitted for approval');
  const approve = act('approve', 'Payroll approved');
  const reject = act('reject', 'Returned for changes');
  const publish = act('publish', 'Payslips published to employees');
  const paid = act('mark-paid', 'Marked as paid');
  const voidR = act('void', 'Payroll voided');
  const adj = useAction((b) => api.post('/payroll/adjustments', b), { success: 'Adjustment added; recalculate to apply', onDone: () => setDlg(null) });
  if (isPending) return <Skeleton className="h-96" />;
  const { run, items } = data;
  const t = run.totals;
  const st = run.status;
  const mine = run.submittedBy === a.me.user.id;
  return (
    <>
      <PageHeader title={`Payroll · ${run.label}`} description={`${dt(run.periodStart)} – ${dt(run.periodEnd)} · FY ${run.fiscalYear}`} actions={<>
        <StatusBadge value={st} />
        {['DRAFT', 'CALCULATED'].includes(st) && a.can('payroll:create') && <Button variant="secondary" loading={calc.isPending} onClick={() => calc.mutate()}>{st === 'DRAFT' ? 'Calculate' : 'Recalculate'}</Button>}
        {st === 'CALCULATED' && a.can('payroll:edit') && <Button variant="secondary" onClick={() => setDlg('adj')}>Add adjustment</Button>}
        {st === 'CALCULATED' && a.can('payroll:create') && <Button onClick={() => submit.mutate()} loading={submit.isPending}>Submit for approval</Button>}
        {st === 'SUBMITTED' && a.can('payroll:approve') && !mine && <><Button onClick={() => approve.mutate()} loading={approve.isPending}>Approve</Button><Button variant="secondary" onClick={() => setDlg('reject')}>Return</Button></>}
        {st === 'SUBMITTED' && mine && <span className="text-sm text-ink-500">Waiting for another approver</span>}
        {['APPROVED', 'PAID'].includes(st) && !run.publishedAt && a.can('payroll:manage') && <Button onClick={() => publish.mutate()} loading={publish.isPending}>Publish payslips</Button>}
        {st === 'APPROVED' && a.can('payroll:manage') && <Button variant="secondary" onClick={() => setDlg('paid')}>Mark paid</Button>}
        {['DRAFT', 'CALCULATED', 'SUBMITTED'].includes(st) && a.can('payroll:manage') && <Button variant="ghost" onClick={() => setDlg('void')}>Void</Button>}
      </>} />
      {run.notes && <p className="mb-4 rounded-md bg-warning-50 p-3 text-sm text-warning-700">{run.notes}</p>}
      {t.employees != null && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-6"><Stat label="Employees" value={t.employees} /><Stat label="Gross" value={npr(t.gross)} /><Stat label="TDS" value={npr(t.tax)} /><Stat label="SSF (11% + 20%)" value={npr(t.ssfEmployee + t.ssfEmployer)} /><Stat label="Net pay" value={npr(t.net)} /><Stat label="Employer cost" value={npr(t.employerCost)} /></div>}
      {t.skipped?.length > 0 && <Card className="mb-4"><CardBody className="text-sm"><p className="font-medium text-warning-700">Skipped: {t.skipped.length} employee(s) without a salary</p><p className="text-ink-500">{t.skipped.map((s) => s.name).join(', ')}</p></CardBody></Card>}
      {a.can('payroll:export') && t.employees != null && (
        <div className="mb-4 flex flex-wrap gap-2">
          {[['salary-sheet', 'Salary sheet'], ['tds', 'TDS report'], ['ssf', 'SSF report'], ['bank-transfer', 'Bank transfer file']].map(([k, l]) => (
            <Button key={k} size="sm" variant="secondary" disabled={k === 'bank-transfer' && !['APPROVED', 'PAID'].includes(st)} onClick={() => api.download(`/payroll/runs/${id}/reports/${k}`, `${k}-${run.period}.csv`)}>{l}</Button>
          ))}
        </div>
      )}
      <DataTable rows={items} onRowClick={setItem} empty={<EmptyState title="Not calculated yet" action={a.can('payroll:create') && <Button onClick={() => calc.mutate()}>Calculate now</Button>} />} columns={[
        { key: 'e', header: 'Employee', render: (r) => <><p className="font-medium">{fullName(r.employee)}</p><p className="text-xs text-ink-400">{r.employee.employeeCode}</p></> },
        { key: 'days', header: 'Paid days', align: 'right', render: (r) => `${(r.attendance.periodDays - r.attendance.unpaidDays).toFixed(1)}/${r.attendance.periodDays}` },
        { key: 'gross', header: 'Gross', align: 'right', render: (r) => npr(r.gross) }, { key: 'tax', header: 'TDS', align: 'right', render: (r) => npr(r.tax) },
        { key: 'ssf', header: 'SSF', align: 'right', render: (r) => npr(r.ssfEmployee) }, { key: 'net', header: 'Net', align: 'right', render: (r) => <strong>{npr(r.net)}</strong> },
        { key: 'an', header: 'Checks', render: (r) => (r.anomalies.length ? <Badge tone="warning">{r.anomalies.length}</Badge> : '—') },
      ]} />
      {item && (
        <Dialog open onClose={() => setItem(null)} title={`${fullName(item.employee)} · ${run.label}`} size="lg" footer={<Button variant="secondary" onClick={() => api.download(`/payroll/payslips/${item.id}/pdf`, `payslip-${run.period}.pdf`)}>Download payslip</Button>}>
          {item.anomalies.length > 0 && <ul className="mb-3 rounded-md bg-warning-50 p-3 text-sm text-warning-700">{item.anomalies.map((x) => <li key={x}>• {x}</li>)}</ul>}
          <p className="mb-3 text-xs text-ink-500">Attendance: {item.attendance.present ?? 0} present · {item.attendance.late ?? 0} late · {item.attendance.absent ?? 0} absent · {item.attendance.paidLeave ?? 0} paid leave · {item.attendance.unpaidLeave ?? 0} unpaid leave · {((item.attendance.overtimeMinutes ?? 0) / 60).toFixed(1)} h overtime</p>
          <div className="grid gap-4 text-sm sm:grid-cols-2">
            {['EARNING', 'DEDUCTION'].map((k) => <div key={k}><p className="mb-1 text-xs font-semibold uppercase text-ink-400">{k === 'EARNING' ? 'Earnings' : 'Deductions'}</p>{item.lines.filter((l) => l.kind === k).map((l, i) => <p key={i} className="flex justify-between"><span>{l.name}</span><span className="tabular-nums">{npr(l.amount)}</span></p>)}</div>)}
          </div>
          <details className="mt-4 text-sm"><summary className="cursor-pointer text-brand-700">How tax was calculated</summary>
            <div className="mt-2 space-y-1 text-ink-700">
              <p>Projected annual assessable income: {npr(item.taxDetail.projectedAssessable)} (incl. employer contributions)</p>
              <p>Retirement deduction (SSF/PF/CIT, capped): −{npr(item.taxDetail.retirementDeduction)} · insurance: −{npr(item.taxDetail.insuranceDeduction)}</p>
              <p>Annual taxable income: <strong>{npr(item.taxDetail.annualTaxable)}</strong></p>
              {item.taxDetail.bands.map((b, i) => <p key={i} className="pl-3 text-ink-500">{npr(b.taxable)} @ {b.rate}%{b.sst ? ' (social security tax)' : ''} = {npr(b.tax)}</p>)}
              {item.taxDetail.femaleRebate > 0 && <p>Female rebate: −{npr(item.taxDetail.femaleRebate)}</p>}
              <p>Annual tax {npr(item.taxDetail.annualTax)} − paid this FY {npr(item.taxDetail.ytdTaxPaid)} ÷ {item.taxDetail.monthsRemaining} months = <strong>{npr(item.taxDetail.monthTax)}</strong> this month</p>
            </div>
          </details>
        </Dialog>
      )}
      <FormDialog open={dlg === 'reject'} onClose={() => setDlg(null)} title="Return payroll" fields={[{ name: 'reason', label: 'What needs fixing?', type: 'textarea', required: true }]} submitLabel="Return" loading={reject.isPending} error={reject.error} onSubmit={(b) => reject.mutate(b)} />
      <FormDialog open={dlg === 'paid'} onClose={() => setDlg(null)} title="Mark payroll as paid" fields={[{ name: 'paymentRef', label: 'Bank batch / reference', required: true }]} loading={paid.isPending} error={paid.error} onSubmit={(b) => paid.mutate(b)} />
      <FormDialog open={dlg === 'void'} onClose={() => setDlg(null)} title="Void payroll" description="Use this if the run was created for the wrong month." fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]} submitLabel="Void" loading={voidR.isPending} error={voidR.error} onSubmit={(b) => voidR.mutate(b)} />
      <FormDialog open={dlg === 'adj'} onClose={() => setDlg(null)} title="One-off pay item" description="Bonus, incentive, arrears, reimbursement or a deduction, for this month only." initial={{ code: 'BONUS', kind: 'EARNING', taxable: true }}
        fields={[{ name: 'employeeId', label: 'Employee', type: 'select', required: true, options: items.map((i) => ({ value: i.employeeId, label: fullName(i.employee) })) },
          { name: 'code', label: 'Kind', type: 'select', options: ADJ_TYPES.map(([v, l]) => ({ value: v, label: l })) }, { name: 'kind', label: 'Earning or deduction', type: 'select', options: [{ value: 'EARNING', label: 'Earning' }, { value: 'DEDUCTION', label: 'Deduction' }] },
          { name: 'description', label: 'Description', required: true }, { name: 'amount', label: 'Amount (NPR)', type: 'number', required: true }, { name: 'taxable', type: 'checkbox', checkLabel: 'Taxable' }]}
        loading={adj.isPending} error={adj.error} onSubmit={(b) => adj.mutate({ ...b, period: run.period, taxable: !!b.taxable })} />
    </>
  );
}

export function PayrollSetup() {
  const { data, isPending } = useQuery({ queryKey: ['components'], queryFn: () => api.get('/payroll/components') });
  const { data: rules } = useQuery({ queryKey: ['tax-rules'], queryFn: () => api.get('/payroll/rules') });
  const [edit, setEdit] = useState(null);
  const save = useAction((b) => (edit?.id ? api.patch(`/payroll/components/${edit.id}`, b) : api.post('/payroll/components', b)), { success: 'Saved', invalidate: [['components']], onDone: () => setEdit(null) });
  return (
    <>
      <PageHeader title="Salary components" actions={<Button onClick={() => setEdit({ kind: 'EARNING', taxable: true, prorated: true, isActive: true })}>Add component</Button>} />
      <DataTable loading={isPending} rows={data ?? []} onRowClick={setEdit} columns={[
        { key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'kind', header: 'Type', render: (r) => r.kind.toLowerCase() },
        { key: 'taxable', header: 'Taxable', render: (r) => (r.taxable ? 'Yes' : 'No') }, { key: 'prorated', header: 'Reduced for unpaid days', render: (r) => (r.prorated ? 'Yes' : 'No') }, { key: 'isActive', header: 'Active', render: (r) => (r.isActive ? 'Yes' : 'No') },
      ]} />
      <Loans />
      <Card className="mt-6"><CardHeader title="Statutory rules in use" description="Maintained by Lishnu HRMS from the Finance Act each year. Confirm with your tax advisor." /><CardBody className="space-y-3 text-sm">
        {(rules ?? []).map((r) => <div key={r.id}><p className="font-medium">FY {r.fiscalYear} <span className="font-normal text-ink-400">({dt(r.effectiveFrom)} – {dt(r.effectiveTo)})</span></p><p className="text-ink-500">{r.rules.slabs.SINGLE.map((s) => `${s.rate}%${s.upTo ? ` to ${npr(s.upTo)}` : ' above'}`).join(' · ')} · SSF {r.rules.ssf.employeePercent}% + {r.rules.ssf.employerPercent}%</p><p className="text-xs text-ink-400">{r.sourceNote}</p></div>)}
      </CardBody></Card>
      {edit && <FormDialog open onClose={() => setEdit(null)} title={edit.id ? `Edit ${edit.name}` : 'New component'} initial={edit}
        fields={[...(edit.id ? [] : [{ name: 'code', label: 'Code', required: true }, { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'EARNING', label: 'Earning' }, { value: 'DEDUCTION', label: 'Deduction' }] }]), { name: 'name', label: 'Name', required: true }, { name: 'sortOrder', label: 'Order', type: 'number' },
          { name: 'taxable', type: 'checkbox', checkLabel: 'Taxable' }, { name: 'prorated', type: 'checkbox', checkLabel: 'Reduce for unpaid days' }, { name: 'isActive', type: 'checkbox', checkLabel: 'Active' }]}
        loading={save.isPending} error={save.error} onSubmit={(b) => save.mutate({ ...b, taxable: !!b.taxable, prorated: !!b.prorated, isActive: !!b.isActive })} />}
    </>
  );
}

function Loans() {
  const a = useAuth();
  const [status, setStatus] = useState('ACTIVE');
  const { data, isPending, refetch } = useQuery({ queryKey: ['loans', status], queryFn: () => api.get(`/payroll/loans?status=${status}`) });
  const [dlg, setDlg] = useState(null);
  const [q, setQ] = useState('');
  const { data: emps } = useQuery({ queryKey: ['emp-search-loan', q], queryFn: () => api.get(`/employees?pageSize=50&search=${encodeURIComponent(q)}`), enabled: dlg === 'new' });
  const create = useAction((b) => api.post('/payroll/loans', b), { success: 'Recorded; instalments are deducted from payroll', onDone: () => { setDlg(null); refetch(); } });
  const cancel = useAction(({ id, reason }) => api.post(`/payroll/loans/${id}/cancel`, { reason }), { success: 'Cancelled', onDone: () => { setDlg(null); refetch(); } });
  return (
    <Card className="mt-6"><CardHeader title="Salary advances & loans" description="Recovered automatically from each payroll in monthly instalments (never below zero net pay)."
      actions={<div className="flex gap-2"><div className="w-36"><Select value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'CLOSED', label: 'Closed' }, { value: 'CANCELLED', label: 'Cancelled' }]} aria-label="Status" /></div>{a.can('payroll:create') && <Button size="sm" onClick={() => setDlg('new')}>New advance / loan</Button>}</div>} />
      <CardBody>
        <DataTable loading={isPending} rows={data ?? []} empty={<EmptyState title="Nothing here" />} columns={[
          { key: 'employee', header: 'Employee', render: (r) => fullName(r.employee) }, { key: 'title', header: 'For', render: (r) => <>{r.title} <Badge tone="neutral">{r.kind.toLowerCase()}</Badge></> },
          { key: 'principal', header: 'Amount', align: 'right', render: (r) => npr(r.principal) }, { key: 'installmentAmount', header: 'Per month', align: 'right', render: (r) => npr(r.installmentAmount) },
          { key: 'startPeriod', header: 'From' }, { key: 'recovered', header: 'Recovered', align: 'right', render: (r) => npr(r.recovered) }, { key: 'balance', header: 'Balance', align: 'right', render: (r) => <strong>{npr(r.balance)}</strong> },
          { key: 'x', header: '', render: (r) => r.status === 'ACTIVE' && a.can('payroll:edit') && <Button size="sm" variant="ghost" onClick={() => setDlg(r)}>Cancel</Button> },
        ]} />
      </CardBody>
      {dlg === 'new' && (
        <FormDialog open onClose={() => setDlg(null)} title="New salary advance or loan" initial={{ kind: 'ADVANCE' }}
          fields={[
            { name: 'search', label: 'Find employee', hint: 'Type a name, then pick below' },
            { name: 'employeeId', label: 'Employee', type: 'select', required: true, options: (emps ?? []).map((e) => ({ value: e.id, label: `${fullName(e)} (${e.employeeCode})` })) },
            { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'ADVANCE', label: 'Salary advance' }, { value: 'LOAN', label: 'Loan' }] }, { name: 'title', label: 'Purpose', required: true },
            { name: 'principal', label: 'Amount (NPR)', type: 'number', required: true }, { name: 'installmentAmount', label: 'Monthly instalment (NPR)', type: 'number', required: true },
            { name: 'startPeriod', label: 'First recovery month (BS, e.g. 2083-08)', required: true }, { name: 'note', label: 'Note', type: 'textarea', rows: 2 },
          ]}
          loading={create.isPending} error={create.error}
          onChange={(v) => { if (v.search !== undefined && v.search !== q) setQ(v.search); }}
          onSubmit={({ search, ...b }) => create.mutate(b)} />
      )}
      {dlg && dlg !== 'new' && <FormDialog open onClose={() => setDlg(null)} title={`Cancel ${dlg.title}?`} description={`Remaining balance NPR ${dlg.balance} will no longer be deducted.`} fields={[{ name: 'reason', label: 'Reason', required: true }]} submitLabel="Cancel recovery" loading={cancel.isPending} error={cancel.error} onSubmit={(b) => cancel.mutate({ id: dlg.id, ...b })} />}
    </Card>
  );
}

export function MyPayslips() {
  const { data, isPending } = useQuery({ queryKey: ['my-payslips'], queryFn: () => api.get('/payroll/payslips/me') });
  const { data: loans } = useQuery({ queryKey: ['my-loans'], queryFn: () => api.get('/payroll/loans/me') });
  return (
    <>
      <PageHeader title="My payslips" actions={<Link to="/me/tax"><Button variant="secondary">My tax this year</Button></Link>} />
      {(loans ?? []).filter((l) => l.status === 'ACTIVE').map((l) => <Card key={l.id} className="mb-3"><CardBody className="text-sm"><strong>{l.title}</strong>: {npr(l.balance)} still to repay at {npr(l.installmentAmount)} per month.</CardBody></Card>)}
      {isPending ? <Skeleton className="h-40" /> : !data.length ? <EmptyState title="No payslips yet" description="Payslips appear here once payroll is approved and published." /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((p) => (
            <Card key={p.id}><CardBody>
              <p className="text-sm text-ink-500">{p.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{npr(p.net)}</p>
              <p className="text-xs text-ink-400">Gross {npr(p.gross)} · Tax {npr(p.tax)}</p>
              <Button size="sm" variant="secondary" className="mt-3" onClick={() => api.download(`/payroll/payslips/${p.id}/pdf`, `payslip-${p.run.period}.pdf`)}>Download PDF</Button>
            </CardBody></Card>
          ))}
        </div>
      )}
    </>
  );
}

// =========================================================================== ESS: my tax
export function MyTax() {
  const toast = useToast();
  const [fy, setFy] = useState('');
  const { data: s, isPending } = useQuery({ queryKey: ['tax-statement', fy], queryFn: () => api.get(`/payroll/tax-statement${fy ? `?fy=${encodeURIComponent(fy)}` : ''}`) });
  const download = async () => {
    try { await api.download(`/payroll/tax-statement/pdf?fy=${encodeURIComponent(s.fiscalYear)}`, `tax-statement-${s.fiscalYear.replace('/', '-')}.pdf`); } catch (e) { toast.error('Could not download the statement', e.message); }
  };
  if (isPending) return <Skeleton className="h-96" />;
  const p = s.projection;
  const t = s.totals;
  const pct = p && p.annualTax > 0 ? Math.min(100, Math.round((t.tds / p.annualTax) * 100)) : 0;
  return (
    <>
      <PageHeader title="My tax" description={`Income tax deducted from your salary, fiscal year ${s.fiscalYear}`}
        actions={<>
          {s.years.length > 1 && <div className="w-36"><Select aria-label="Fiscal year" value={s.fiscalYear} onChange={(e) => setFy(e.target.value)} options={s.years.map((y) => ({ value: y, label: `FY ${y}` }))} /></div>}
          <Button variant="secondary" disabled={!s.months.length} onClick={download}>Download statement</Button>
        </>} />
      {!s.months.length ? (
        <Card><EmptyState title={`No payslips for FY ${s.fiscalYear} yet`} description="Your tax summary appears here once your first payslip of the year is published." /></Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Tax paid so far" value={npr(t.tds)} hint={`${s.months.length} month(s)`} />
            <Stat label="Estimated for the year" value={p ? npr(p.annualTax) : '—'} hint={p ? `As of ${p.asOf}` : undefined} />
            <Stat label="Still to be deducted" value={p ? npr(p.remaining) : '—'} hint={p && p.monthsRemaining ? `Over ${p.monthsRemaining} more month(s)` : undefined} />
            <Stat label="Next month (estimate)" value={p ? npr(p.nextMonthEstimate) : '—'} hint="Changes if your pay changes" />
          </div>
          {p && p.annualTax > 0 && (
            <Card><CardBody>
              <div className="flex justify-between text-sm"><span className="text-ink-700">Paid {pct}% of this year's estimated tax</span><span className="tabular-nums text-ink-500">{npr(t.tds)} of {npr(p.annualTax)}</span></div>
              <div className="mt-2 h-2 rounded-full bg-subtle"><div className="h-full rounded-full bg-brand-600" style={{ width: `${pct}%` }} /></div>
            </CardBody></Card>
          )}
          <DataTable rows={s.months} rowKey="period" columns={[
            { key: 'label', header: 'Month', render: (m) => <span className="font-medium text-ink-900">{m.label}</span> },
            { key: 'gross', header: 'Gross', align: 'right', render: (m) => npr(m.gross) },
            { key: 'ssf', header: 'SSF', align: 'right', render: (m) => npr(m.ssf) },
            { key: 'pf', header: 'PF + CIT', align: 'right', render: (m) => npr(m.pf + m.cit) },
            { key: 'tds', header: 'Tax (TDS)', align: 'right', render: (m) => <strong>{npr(m.tds)}</strong> },
            { key: 'net', header: 'Net pay', align: 'right', render: (m) => npr(m.net) },
          ]} />
          {p && (
            <Card>
              <CardHeader title="How your yearly tax is estimated" description={`Based on your ${p.asOf} payslip. It assumes the same pay for the rest of the year.`} />
              <CardBody className="space-y-1.5 text-sm text-ink-700">
                <p className="flex justify-between gap-3"><span>Estimated income for the year (incl. employer contributions)</span><span className="tabular-nums">{npr(p.projectedIncome)}</span></p>
                <p className="flex justify-between gap-3"><span>Less retirement savings (SSF, PF, CIT, within the legal cap)</span><span className="tabular-nums">−{npr(p.retirementDeduction)}</span></p>
                {p.insuranceDeduction > 0 && <p className="flex justify-between gap-3"><span>Less insurance premiums</span><span className="tabular-nums">−{npr(p.insuranceDeduction)}</span></p>}
                <p className="flex justify-between gap-3 border-t border-line pt-1.5 font-medium text-ink-900"><span>Taxable income</span><span className="tabular-nums">{npr(p.annualTaxable)}</span></p>
                {p.bands.map((b, i) => <p key={i} className="flex justify-between gap-3 pl-3 text-ink-500"><span>{npr(b.taxable)} at {b.rate}%{b.sst ? (p.sstWaived ? ' (social security tax, waived for SSF members)' : ' (social security tax)') : ''}</span><span className="tabular-nums">{npr(b.tax)}</span></p>)}
                {p.femaleRebate > 0 && <p className="flex justify-between gap-3"><span>Less 10% rebate for women</span><span className="tabular-nums">−{npr(p.femaleRebate)}</span></p>}
                <p className="flex justify-between gap-3 border-t border-line pt-1.5 font-semibold text-ink-900"><span>Estimated tax for the year</span><span className="tabular-nums">{npr(p.annualTax)}</span></p>
                <p className="pt-2 text-xs text-ink-500">To lower your tax legally, ask HR about CIT contributions or recording your life and health insurance premiums. Tax rules come from the Finance Act and are checked each year.</p>
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
