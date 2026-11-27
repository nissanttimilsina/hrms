import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, DataTable, Skeleton, Stat, Badge, Field, Input, Select, Checkbox, EmptyState, useToast } from '@hrms/shared-ui';
import { api, useAuth, useAction, FormDialog, PageHeader, StatusBadge, dt, fullName, hours, timeOf, todayKtm, addDays } from '../lib.jsx';

const getPosition = () => new Promise((resolve) => {
  if (!navigator.geolocation) return resolve({});
  navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }), () => resolve({}), { enableHighAccuracy: true, timeout: 10_000 });
});

// =========================================================================== clock widget (dashboard + ESS)
export function ClockWidget({ compact }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isPending } = useQuery({ queryKey: ['today'], queryFn: () => api.get('/attendance/me/today'), refetchInterval: 60_000 });
  const [busy, setBusy] = useState(false);
  const punch = async (kind) => {
    setBusy(true);
    try {
      const pos = data?.requireLocation ? await getPosition() : {};
      await api.post(`/attendance/${kind}`, pos);
      toast.success(kind === 'clock-in' ? 'Clocked in' : 'Clocked out', new Date().toLocaleTimeString());
      qc.invalidateQueries({ queryKey: ['today'] }); qc.invalidateQueries({ queryKey: ['my-att'] }); qc.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e) { toast.error('Could not record attendance', e.message); } finally { setBusy(false); }
  };
  if (isPending) return <Skeleton className="h-24" />;
  const r = data.record;
  return (
    <Card>
      <CardBody className={`flex flex-wrap items-center justify-between gap-4 ${compact ? '' : 'py-6'}`}>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Today · {data.schedule.shiftName ?? `${data.schedule.start}–${data.schedule.end}`}</p>
          <p className="mt-1 text-lg font-semibold">{!r ? 'Not clocked in' : r.clockOut ? (r.workedMinutes > 0 ? `Done · ${hours(r.workedMinutes)} worked` : 'Clocked out') : `Clocked in at ${timeOf(r.clockIn)}`}</p>
          {r && <p className="text-sm text-ink-500">In {timeOf(r.clockIn)} · Out {timeOf(r.clockOut)} {r.lateMinutes > 0 && <Badge tone="warning">{r.lateMinutes} min late</Badge>}</p>}
          {data.requireLocation && <p className="mt-1 text-xs text-ink-400">Your location is checked when you clock in.</p>}
        </div>
        {!r && <Button size="lg" loading={busy} onClick={() => punch('clock-in')}>Clock in</Button>}
        {r && !r.clockOut && <Button size="lg" variant="secondary" loading={busy} onClick={() => punch('clock-out')}>Clock out</Button>}
      </CardBody>
    </Card>
  );
}

// =========================================================================== ESS: my attendance
export function MyAttendance() {
  const [range, setRange] = useState({ from: addDays(todayKtm(), -30), to: todayKtm() });
  const [corr, setCorr] = useState(null);
  const { data, isPending } = useQuery({ queryKey: ['my-att', range], queryFn: () => api.get(`/attendance/me?from=${range.from}&to=${range.to}`) });
  const request = useAction((b) => api.post('/attendance/corrections', b), { success: 'Correction requested', invalidate: [['my-att']], onDone: () => setCorr(null) });
  const cancelCorr = useAction((id) => api.post(`/attendance/corrections/${id}/cancel`, {}), { success: 'Request cancelled', invalidate: [['my-att']] });
  const s = data?.summary;
  return (
    <>
      <PageHeader title="My attendance" actions={<Button variant="secondary" onClick={() => setCorr({ workDate: addDays(todayKtm(), -1) })}>Request correction</Button>} />
      <div className="mb-6"><ClockWidget /></div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      {s && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5"><Stat label="Present" value={s.present} /><Stat label="Late" value={s.late} /><Stat label="Absent" value={s.absent} /><Stat label="Leave" value={s.paidLeave + s.unpaidLeave} /><Stat label="Overtime" value={hours(s.overtimeMinutes)} /></div>}
      <DataTable loading={isPending} rows={data?.records ?? []} empty={<EmptyState title="No attendance in this range" />} columns={[
        { key: 'workDate', header: 'Date', render: (r) => dt(r.workDate) }, { key: 'in', header: 'In', render: (r) => timeOf(r.clockIn) }, { key: 'out', header: 'Out', render: (r) => timeOf(r.clockOut) },
        { key: 'workedMinutes', header: 'Worked', render: (r) => hours(r.workedMinutes) }, { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        { key: 'x', header: '', render: (r) => <Button size="sm" variant="ghost" onClick={() => setCorr({ workDate: r.workDate })}>Correct</Button> },
      ]} />
      {data?.corrections?.length > 0 && (
        <Card className="mt-4"><CardHeader title="My correction requests" description="Missed a clock-in or clock-out? Request a correction and your manager reviews it." />
          <ul className="divide-y divide-line">{data.corrections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <span className="w-28 font-medium text-ink-900">{dt(c.workDate)}</span>
              <span className="tabular-nums text-ink-700">{c.clockIn ? `In ${timeOf(c.clockIn)}` : ''}{c.clockIn && c.clockOut ? ' · ' : ''}{c.clockOut ? `Out ${timeOf(c.clockOut)}` : ''}</span>
              <span className="min-w-0 flex-1 truncate text-ink-500">{c.reason}{c.reviewNote ? ` · Reviewer: ${c.reviewNote}` : ''}</span>
              <StatusBadge value={c.status} />
              {c.status === 'PENDING' && <Button size="sm" variant="ghost" loading={cancelCorr.isPending} onClick={() => cancelCorr.mutate(c.id)}>Cancel</Button>}
            </li>
          ))}</ul>
        </Card>
      )}
      <FormDialog open={!!corr} onClose={() => setCorr(null)} title="Request attendance correction" description="Your manager will review it." initial={{ workDate: corr?.workDate, inTime: '', outTime: '' }}
        fields={[{ name: 'workDate', label: 'Date', type: 'date', required: true }, { name: 'inTime', label: 'Correct clock-in', type: 'time', hint: 'Leave empty if it was right' }, { name: 'outTime', label: 'Correct clock-out', type: 'time', hint: 'Leave empty if it was right' }, { name: 'reason', label: 'What happened?', type: 'textarea', required: true, placeholder: 'e.g. Forgot to clock out after the client visit' }]}
        loading={request.isPending} error={request.error}
        onSubmit={({ workDate, inTime, outTime, reason }) => {
          const d = String(workDate).slice(0, 10);
          const iso = (t) => (t ? new Date(`${d}T${t}:00+05:45`).toISOString() : undefined);
          request.mutate({ workDate: d, reason, ...(inTime && { clockIn: iso(inTime) }), ...(outTime && { clockOut: iso(outTime) }) });
        }} />
    </>
  );
}

// =========================================================================== managers / HR: register, summary, corrections, policy
export function AttendanceRegister() {
  const a = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const tab = loc.pathname.split('/')[2] || 'daily';
  const tabs = [['daily', 'Daily register'], ['summary', 'Monthly summary'], a.can('attendance:approve') && ['corrections', 'Corrections'], a.can('attendance:configure') && ['policy', 'Rules']].filter(Boolean);
  return (
    <>
      <PageHeader title="Attendance" />
      <div className="mb-4 flex gap-1 border-b border-line" role="tablist">{tabs.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => nav(`/attendance/${k}`)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-ink-500'}`}>{l}</button>)}</div>
      {tab === 'daily' && <Daily />}{tab === 'summary' && <Summary />}{tab === 'corrections' && <Corrections />}{tab === 'policy' && <Policy />}
    </>
  );
}

function Daily() {
  const a = useAuth();
  const [date, setDate] = useState(todayKtm());
  const [manual, setManual] = useState(null);
  const { data, isPending } = useQuery({ queryKey: ['daily', date], queryFn: () => api.get(`/attendance/daily?date=${date}`) });
  const save = useAction((b) => api.post('/attendance/manual', b), { success: 'Attendance saved', invalidate: [['daily', date]], onDone: () => setManual(null) });
  const t = data?.totals;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3"><Field label="Date"><Input type="date" value={date} max={todayKtm()} onChange={(e) => setDate(e.target.value)} /></Field></div>
      {t && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5"><Stat label="Employees" value={t.employees} /><Stat label="Present" value={t.present} /><Stat label="Late" value={t.late} /><Stat label="On leave" value={t.onLeave} /><Stat label={date === todayKtm() ? 'Not in yet' : 'Absent'} value={t.absent + t.notIn} /></div>}
      <DataTable loading={isPending} rows={(data?.rows ?? []).map((r) => ({ ...r, _k: r.employee.id }))} rowKey="_k" columns={[
        { key: 'name', header: 'Employee', render: (r) => <><p className="font-medium">{r.employee.name}</p><p className="text-xs text-ink-400">{r.employee.code}</p></> },
        { key: 'status', header: 'Status', render: (r) => <>{<StatusBadge value={r.status} />}{r.leave && <span className="ml-1 text-xs text-ink-500">{r.leave.type}</span>}{r.holiday && <span className="ml-1 text-xs text-ink-500">{r.holiday}</span>}</> },
        { key: 'in', header: 'In', render: (r) => timeOf(r.record?.clockIn) }, { key: 'out', header: 'Out', render: (r) => timeOf(r.record?.clockOut) },
        { key: 'late', header: 'Late', render: (r) => (r.record?.lateMinutes ? `${r.record.lateMinutes} min` : '—') }, { key: 'worked', header: 'Worked', render: (r) => hours(r.record?.workedMinutes) },
        { key: 'x', header: '', render: (r) => a.can('attendance:create') && <Button size="sm" variant="ghost" onClick={() => setManual(r)}>Edit</Button> },
      ]}
      />
      <FormDialog open={!!manual} onClose={() => setManual(null)} title={`Manual attendance · ${manual?.employee.name}`} description={dt(date)} initial={{ inTime: manual?.record ? timeOf(manual.record.clockIn) : '10:00', outTime: manual?.record?.clockOut ? timeOf(manual.record.clockOut) : '' }}
        fields={[{ name: 'inTime', label: 'Clock-in (HH:MM)', required: true }, { name: 'outTime', label: 'Clock-out (HH:MM)' }, { name: 'note', label: 'Reason (kept in audit log)', type: 'textarea', required: true }]}
        loading={save.isPending} error={save.error}
        onSubmit={({ inTime, outTime, note }) => save.mutate({ employeeId: manual.employee.id, workDate: date, note, clockIn: new Date(`${date}T${inTime}:00+05:45`).toISOString(), ...(outTime && { clockOut: new Date(`${date}T${outTime}:00+05:45`).toISOString() }) })} />
    </>
  );
}

function Summary() {
  const a = useAuth();
  const [range, setRange] = useState({ from: addDays(todayKtm(), -29), to: todayKtm() });
  const { data, isPending } = useQuery({ queryKey: ['att-sum', range], queryFn: () => api.get(`/attendance/summary?from=${range.from}&to=${range.to}`) });
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        {a.can('attendance:export') && <Button variant="secondary" onClick={() => api.download(`/attendance/summary?from=${range.from}&to=${range.to}&format=csv`, `attendance-${range.from}-${range.to}.csv`)}>Export CSV</Button>}
      </div>
      <DataTable loading={isPending} rows={data ?? []} rowKey="employeeId" columns={[
        { key: 'name', header: 'Employee', render: (r) => <><p className="font-medium">{r.name}</p><p className="text-xs text-ink-400">{r.code}</p></> },
        ...['workingDays', 'present', 'late', 'halfDay', 'absent', 'paidLeave', 'unpaidLeave', 'holidays'].map((k) => ({ key: k, header: k.replace(/([A-Z])/g, ' $1').toLowerCase(), align: 'right' })),
        { key: 'overtimeMinutes', header: 'overtime', align: 'right', render: (r) => hours(r.overtimeMinutes) },
      ]} />
    </>
  );
}

function Corrections() {
  const { data, isPending } = useQuery({ queryKey: ['corrections'], queryFn: () => api.get('/attendance/corrections?status=PENDING') });
  const decide = useAction(({ id, ok }) => api.post(`/attendance/corrections/${id}/${ok ? 'approve' : 'reject'}`, {}), { success: (_, v) => (v.ok ? 'Approved' : 'Rejected'), invalidate: [['corrections']] });
  return <DataTable loading={isPending} rows={data ?? []} empty={<EmptyState title="No pending corrections" />} columns={[
    { key: 'e', header: 'Employee', render: (r) => fullName(r.employee) }, { key: 'workDate', header: 'Date', render: (r) => dt(r.workDate) },
    { key: 'times', header: 'Requested', render: (r) => `${timeOf(r.clockIn)} – ${timeOf(r.clockOut)}` }, { key: 'reason', header: 'Reason' },
    { key: 'x', header: '', render: (r) => <div className="flex gap-1"><Button size="sm" onClick={() => decide.mutate({ id: r.id, ok: true })}>Approve</Button><Button size="sm" variant="ghost" onClick={() => decide.mutate({ id: r.id, ok: false })}>Reject</Button></div> },
  ]} />;
}

function Policy() {
  const { data, isPending } = useQuery({ queryKey: ['att-policy'], queryFn: () => api.get('/attendance/policy') });
  const save = useAction((b) => api.put('/attendance/policy', b), { success: 'Attendance rules saved', invalidate: [['att-policy']] });
  const [v, setV] = useState(null);
  if (isPending) return <Skeleton className="h-64" />;
  const p = v ?? data;
  const set = (k, x) => setV({ ...p, [k]: x });
  const num = (k) => <Input type="number" value={p[k]} onChange={(e) => set(k, Number(e.target.value))} />;
  return (
    <Card><CardBody className="grid gap-4 sm:grid-cols-3">
      <Field label="Work starts"><Input value={p.workStart} onChange={(e) => set('workStart', e.target.value)} /></Field>
      <Field label="Work ends"><Input value={p.workEnd} onChange={(e) => set('workEnd', e.target.value)} /></Field>
      <Field label="Break (minutes)">{num('breakMinutes')}</Field>
      <Field label="Late after (grace minutes)">{num('graceMinutes')}</Field>
      <Field label="Half day below (minutes worked)">{num('halfDayMinutes')}</Field>
      <Field label="Overtime counts after (minutes)">{num('overtimeAfterMinutes')}</Field>
      <Field label="Weekly offs" hint="Comma-separated, e.g. SAT or SAT,SUN"><Input value={p.weeklyOffs.join(',')} onChange={(e) => set('weeklyOffs', e.target.value.toUpperCase().split(',').map((s) => s.trim()).filter(Boolean))} /></Field>
      <Field label="Allowed office IPs" hint="Leave empty to allow any network"><Input value={p.ipAllowlist.join(',')} onChange={(e) => set('ipAllowlist', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></Field>
      <div className="space-y-2 pt-6"><Checkbox label="Deduct absent days from pay" checked={!!p.deductAbsences} onChange={(e) => set('deductAbsences', e.target.checked)} /><Checkbox label="Require location on clock-in" checked={p.requireLocation} onChange={(e) => set('requireLocation', e.target.checked)} /><Checkbox label="Geofence (only near the workplace)" checked={p.geofence.enabled} onChange={(e) => set('geofence', { ...p.geofence, enabled: e.target.checked })} /></div>
      {p.geofence.enabled && <>
        <Field label="Workplace latitude"><Input type="number" step="any" value={p.geofence.lat ?? ''} onChange={(e) => set('geofence', { ...p.geofence, lat: Number(e.target.value) })} /></Field>
        <Field label="Workplace longitude"><Input type="number" step="any" value={p.geofence.lng ?? ''} onChange={(e) => set('geofence', { ...p.geofence, lng: Number(e.target.value) })} /></Field>
        <Field label="Radius (metres)"><Input type="number" value={p.geofence.radiusM} onChange={(e) => set('geofence', { ...p.geofence, radiusM: Number(e.target.value) })} /></Field>
        <Button variant="ghost" onClick={async () => { const pos = await getPosition(); if (pos.lat) set('geofence', { ...p.geofence, lat: pos.lat, lng: pos.lng }); }}>Use my current location</Button>
      </>}
      <div className="sm:col-span-3 border-t border-line pt-4"><p className="font-medium">Lateness, early leave and alerts</p><p className="text-xs text-ink-500">Deductions apply only if switched on here. Every deduction shows on the payslip with the rule that caused it.</p></div>
      <div className="space-y-2"><Checkbox label="Deduct pay for repeated late arrivals" checked={!!p.lateRule?.enabled} onChange={(e) => set('lateRule', { ...p.lateRule, enabled: e.target.checked })} /><Checkbox label="Count early departures as late" checked={!!p.earlyLeaveCountsAsLate} onChange={(e) => set('earlyLeaveCountsAsLate', e.target.checked)} /></div>
      <Field label="Every … late days"><Input type="number" min="1" value={p.lateRule?.everyLateDays ?? 3} disabled={!p.lateRule?.enabled} onChange={(e) => set('lateRule', { ...p.lateRule, everyLateDays: Number(e.target.value) })} /></Field>
      <Field label="… count as unpaid days" hint="0.5 = half a day"><Input type="number" step="0.5" min="0" value={p.lateRule?.deductDays ?? 0.5} disabled={!p.lateRule?.enabled} onChange={(e) => set('lateRule', { ...p.lateRule, deductDays: Number(e.target.value) })} /></Field>
      <Field label="Early leave allowed (minutes)">{num('earlyLeaveGraceMinutes')}</Field>
      <Field label="Alert manager after … late days in a month" hint="0 = off">{num('repeatedLateThreshold')}</Field>
      <div className="space-y-2 pt-6"><Checkbox label="Tell employees when they arrive late" checked={p.notifyLate !== false} onChange={(e) => set('notifyLate', e.target.checked)} /><Checkbox label="Remind about missing check-in/out" checked={p.notifyMissingPunch !== false} onChange={(e) => set('notifyMissingPunch', e.target.checked)} /></div>
      <div className="sm:col-span-3"><Button loading={save.isPending} onClick={() => save.mutate(p)}>Save rules</Button>{save.error && <p className="mt-2 text-sm text-danger-600">{save.error.message}</p>}</div>
    </CardBody></Card>
  );
}

// =========================================================================== leave
export function MyLeave() {
  const { data: bal } = useQuery({ queryKey: ['my-balance'], queryFn: () => api.get('/leave/balances/me') });
  const { data: reqs, isPending } = useQuery({ queryKey: ['my-leave'], queryFn: () => api.get('/leave/requests?mine=true') });
  const [open, setOpen] = useState(false);
  const inv = [['my-balance'], ['my-leave']];
  const apply = useAction((b) => api.post('/leave/requests', b), { success: 'Leave requested', invalidate: inv, onDone: () => setOpen(false) });
  const cancel = useAction((id) => api.post(`/leave/requests/${id}/cancel`, {}), { success: 'Leave cancelled', invalidate: inv });
  const types = (bal?.balances ?? []).map((b) => ({ value: b.leaveTypeId, label: `${b.name}${b.tracked ? ` (${b.available} available)` : ''}` }));
  return (
    <>
      <PageHeader title="My leave" description={bal ? `Fiscal year ${bal.year}` : ''} actions={<Button onClick={() => setOpen(true)}>Apply for leave</Button>} />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">{(bal?.balances ?? []).filter((b) => b.tracked).map((b) => <Stat key={b.code} label={b.name} value={b.available} hint={`${b.used} used · ${b.entitled} entitled${b.pending ? ` · ${b.pending} pending` : ''}`} />)}</div>
      <DataTable loading={isPending} rows={reqs ?? []} empty={<EmptyState title="No leave requests yet" />} columns={[
        { key: 't', header: 'Type', render: (r) => r.leaveType.name }, { key: 'd', header: 'Dates', render: (r) => `${dt(r.startDate)}${r.endDate !== r.startDate ? ` – ${dt(r.endDate)}` : ''}${r.halfDay ? ' (half day)' : ''}` },
        { key: 'days', header: 'Days', align: 'right', render: (r) => Number(r.days) }, { key: 'status', header: 'Status', render: (r) => <StatusBadge value={r.status} /> },
        { key: 'x', header: '', render: (r) => ['PENDING', 'APPROVED'].includes(r.status) && r.startDate > todayKtm() && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button> },
      ]} />
      <FormDialog open={open} onClose={() => setOpen(false)} title="Apply for leave" description="Weekly offs and public holidays are not counted." initial={{ startDate: todayKtm(), endDate: todayKtm() }}
        fields={[{ name: 'leaveTypeId', label: 'Leave type', type: 'select', options: types, required: true }, { name: 'startDate', label: 'From', type: 'date', required: true }, { name: 'endDate', label: 'To', type: 'date', required: true },
          { name: 'halfDay', label: 'Half day (single day only)', type: 'select', placeholder: 'Full day(s)', options: [{ value: 'FIRST_HALF', label: 'First half' }, { value: 'SECOND_HALF', label: 'Second half' }] }, { name: 'reason', label: 'Reason', type: 'textarea' }]}
        loading={apply.isPending} error={apply.error} onSubmit={(b) => apply.mutate({ ...b, startDate: String(b.startDate).slice(0, 10), endDate: String(b.endDate).slice(0, 10) })} />
    </>
  );
}

export function LeaveApprovals() {
  const [status, setStatus] = useState('PENDING');
  const { data, isPending } = useQuery({ queryKey: ['leave-approvals', status], queryFn: () => api.get(`/leave/requests?status=${status}`) });
  const [rej, setRej] = useState(null);
  const decide = useAction(({ id, ok, note }) => api.post(`/leave/requests/${id}/${ok ? 'approve' : 'reject'}`, note ? { note } : {}), { success: (_, v) => (v.ok ? 'Approved' : 'Rejected'), invalidate: [['leave-approvals']], onDone: () => setRej(null) });
  return (
    <>
      <PageHeader title="Leave approvals" actions={<Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status" options={['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => ({ value: s, label: s.toLowerCase() }))} />} />
      <DataTable loading={isPending} rows={data ?? []} empty={<EmptyState title="Nothing waiting for you" />} columns={[
        { key: 'e', header: 'Employee', render: (r) => <><p className="font-medium">{fullName(r.employee)}</p><p className="text-xs text-ink-400">{r.employee.employeeCode}</p></> },
        { key: 't', header: 'Type', render: (r) => <>{r.leaveType.name}{!r.leaveType.isPaid && <Badge tone="warning">unpaid</Badge>}</> },
        { key: 'd', header: 'Dates', render: (r) => `${dt(r.startDate)} – ${dt(r.endDate)}` }, { key: 'days', header: 'Days', align: 'right', render: (r) => Number(r.days) },
        { key: 'reason', header: 'Reason', render: (r) => <span className="line-clamp-2 max-w-56 text-xs">{r.reason}</span> },
        { key: 'lvl', header: 'Stage', render: (r) => (r.status === 'PENDING' ? `Level ${r.currentLevel} of ${r.requiredLevels}` : <StatusBadge value={r.status} />) },
        { key: 'x', header: '', render: (r) => r.status === 'PENDING' && <div className="flex gap-1"><Button size="sm" loading={decide.isPending} onClick={() => decide.mutate({ id: r.id, ok: true })}>Approve</Button><Button size="sm" variant="ghost" onClick={() => setRej(r)}>Reject</Button></div> },
      ]} />
      <FormDialog open={!!rej} onClose={() => setRej(null)} title="Reject leave" fields={[{ name: 'note', label: 'Reason (shared with the employee)', type: 'textarea', required: true }]} submitLabel="Reject" loading={decide.isPending} error={decide.error} onSubmit={(b) => decide.mutate({ id: rej.id, ok: false, note: b.note })} />
    </>
  );
}

export function LeaveSetup() {
  const a = useAuth();
  const { data: types } = useQuery({ queryKey: ['leave-types'], queryFn: () => api.get('/leave/types') });
  const { data: hols } = useQuery({ queryKey: ['holidays'], queryFn: () => api.get('/leave/holidays') });
  const [edit, setEdit] = useState(null);
  const [hol, setHol] = useState(false);
  const saveType = useAction((b) => (edit?.id ? api.patch(`/leave/types/${edit.id}`, b) : api.post('/leave/types', b)), { success: 'Leave type saved', invalidate: [['leave-types']], onDone: () => setEdit(null) });
  const addHol = useAction((b) => api.post('/leave/holidays', b), { success: 'Holiday added', invalidate: [['holidays']], onDone: () => setHol(false) });
  const delHol = useAction((id) => api.del(`/leave/holidays/${id}`), { success: 'Removed', invalidate: [['holidays']] });
  return (
    <>
      <PageHeader title="Leave setup" description="Defaults follow the Labour Act 2074. Adjust them to your company policy." actions={<Button onClick={() => setEdit({ accrual: 'YEARLY', isPaid: true, allowHalfDay: true, approvalLevels: 1, isActive: true })}>Add leave type</Button>} />
      <DataTable rows={types ?? []} onRowClick={setEdit} columns={[
        { key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'annualQuota', header: 'Per year', align: 'right', render: (r) => (r.accrual === 'NONE' ? '—' : Number(r.annualQuota)) },
        { key: 'accrual', header: 'Accrual', render: (r) => r.accrual.toLowerCase() }, { key: 'carryForwardMax', header: 'Carry max', align: 'right', render: (r) => Number(r.carryForwardMax) },
        { key: 'isPaid', header: 'Paid', render: (r) => (r.isPaid ? 'Yes' : 'No') }, { key: 'approvalLevels', header: 'Approvals', align: 'right' }, { key: 'isActive', header: 'Active', render: (r) => (r.isActive ? 'Yes' : 'No') },
      ]} />
      <div className="mt-8 mb-3 flex items-end justify-between"><h2 className="font-semibold">Holidays {hols?.length ? `(${hols.length})` : ''}</h2>{a.can('holidays:create') && <Button variant="secondary" onClick={() => setHol(true)}>Add holiday</Button>}</div>
      <DataTable rows={hols ?? []} empty={<EmptyState title="No holidays this fiscal year" description="Add the public holidays your company observes. They're excluded from leave and attendance." />} columns={[
        { key: 'date', header: 'Date', render: (r) => `${dt(r.date)} (${r.bs} BS)` }, { key: 'name', header: 'Holiday' }, { key: 'isOptional', header: 'Optional', render: (r) => (r.isOptional ? 'Yes' : 'No') },
        { key: 'x', header: '', render: (r) => a.can('holidays:delete') && <Button size="sm" variant="ghost" onClick={() => delHol.mutate(r.id)}>Remove</Button> },
      ]} />
      {edit && <FormDialog open onClose={() => setEdit(null)} title={edit.id ? `Edit ${edit.name}` : 'New leave type'} initial={edit}
        fields={[...(edit.id ? [] : [{ name: 'code', label: 'Code', required: true }]), { name: 'name', label: 'Name', required: true }, { name: 'annualQuota', label: 'Days per year', type: 'number' },
          { name: 'accrual', label: 'Accrual', type: 'select', options: [{ value: 'YEARLY', label: 'Full allocation each year' }, { value: 'MONTHLY', label: 'Accrues monthly' }, { value: 'NONE', label: 'Not tracked (e.g. unpaid)' }] },
          { name: 'carryForwardMax', label: 'Max carry forward', type: 'number' }, { name: 'approvalLevels', label: 'Approval levels', type: 'select', options: [{ value: 1, label: 'Manager only' }, { value: 2, label: 'Manager then HR' }] },
          { name: 'minNoticeDays', label: 'Notice days', type: 'number' }, { name: 'maxConsecutiveDays', label: 'Max consecutive days', type: 'number', nullable: true, keepEmpty: true },
          { name: 'appliesToGender', label: 'Applies to', type: 'select', placeholder: 'Everyone', options: [{ value: 'FEMALE', label: 'Female employees' }, { value: 'MALE', label: 'Male employees' }] },
          { name: 'isPaid', type: 'checkbox', checkLabel: 'Paid leave' }, { name: 'allowHalfDay', type: 'checkbox', checkLabel: 'Allow half days' }, { name: 'encashable', type: 'checkbox', checkLabel: 'Encashable' }, { name: 'isActive', type: 'checkbox', checkLabel: 'Active' }]}
        loading={saveType.isPending} error={saveType.error}
        onSubmit={(b) => saveType.mutate({ ...b, approvalLevels: Number(b.approvalLevels ?? 1), appliesToGender: b.appliesToGender || null, isPaid: !!b.isPaid, allowHalfDay: !!b.allowHalfDay, encashable: !!b.encashable, isActive: !!b.isActive, ...(b.annualQuota != null && { annualQuota: Number(b.annualQuota) }), ...(b.carryForwardMax != null && { carryForwardMax: Number(b.carryForwardMax) }) })} />}
      <FormDialog open={hol} onClose={() => setHol(false)} title="Add holiday" initial={{ kind: 'HOLIDAY' }} fields={[{ name: 'date', label: 'Date (AD)', type: 'date', required: true }, { name: 'name', label: 'Name', required: true }, { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'HOLIDAY', label: 'Holiday (office closed)' }, { value: 'WORKING_DAY', label: 'Special working day (e.g. a make-up Saturday)' }] }, { name: 'isOptional', type: 'checkbox', checkLabel: 'Optional holiday' }]}
        loading={addHol.isPending} error={addHol.error} onSubmit={(b) => addHol.mutate({ ...b, date: String(b.date).slice(0, 10), isOptional: !!b.isOptional })} />
    </>
  );
}
