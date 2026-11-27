/** Product tour: one tab per everyday job, each with a small, realistic screen. */
import { useState, useId } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@hrms/shared-ui';
import { Icon } from './core.jsx';

const Screen = ({ title, meta, children }) => (
  <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-[0_30px_80px_-40px_rgba(15,23,41,.45)]">
    <div className="flex items-center justify-between border-b border-line bg-canvas px-5 py-3">
      <p className="text-sm font-semibold text-ink-900">{title}</p><p className="text-xs text-ink-500">{meta}</p>
    </div>
    <div className="p-5">{children}</div>
  </div>
);
const Tag = ({ tone, children }) => <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', {
  ok: 'bg-success-50 text-success-700', late: 'bg-warning-50 text-warning-700', info: 'bg-brand-50 text-brand-700', off: 'bg-subtle text-ink-500',
}[tone])}>{children}</span>;

const TABS = [
  {
    key: 'attendance', label: 'Attendance', icon: 'Clock', to: '/features/attendance-management',
    title: 'Know who is in, without asking around',
    points: ['Clock-in from phone, web or fingerprint and face devices', 'Late, early and missing punches flagged against each branch’s hours', 'Corrections go to the manager for approval'],
    screen: (
      <Screen title="Today, Baneshwor branch" meta="Thu 11 Mangsir">
        <div className="mb-4 grid grid-cols-4 gap-2 text-center">
          {[['38', 'In'], ['3', 'Late'], ['2', 'On leave'], ['1', 'Not in']].map(([n, l]) => <div key={l} className="rounded-lg bg-canvas py-2"><p className="text-lg font-semibold tabular-nums text-ink-900">{n}</p><p className="text-xs text-ink-500">{l}</p></div>)}
        </div>
        <ul className="divide-y divide-line text-sm">
          {[['Sita Rai', '09:52', <Tag key="a" tone="ok">On time</Tag>], ['Bikash KC', '10:21', <Tag key="b" tone="late">Late 11 min</Tag>], ['Anita Gurung', '—', <Tag key="c" tone="info">Home leave</Tag>], ['Hari Shrestha', '09:47', <Tag key="d" tone="ok">Device</Tag>]].map(([n, t, s]) => (
            <li key={n} className="flex items-center gap-3 py-2.5"><span className="flex-1 text-ink-900">{n}</span><span className="w-12 tabular-nums text-ink-500">{t}</span>{s}</li>
          ))}
        </ul>
      </Screen>
    ),
  },
  {
    key: 'leave', label: 'Leave', icon: 'CalendarDays', to: '/features/leave-management',
    title: 'Leave balances everyone can see',
    points: ['Home, sick, maternity and your own leave types, preset to the Labour Act', 'Monthly accrual, carry-forward caps and encashment through payroll', 'One or two approval levels, with the team calendar in view'],
    screen: (
      <Screen title="Ram Thapa, leave" meta="FY 2083/84">
        <div className="space-y-3">
          {[['Home leave', 7.5, 18], ['Sick leave', 9, 12], ['Casual leave', 4, 6]].map(([n, left, of]) => (
            <div key={n}><div className="flex justify-between text-sm"><span className="text-ink-700">{n}</span><span className="tabular-nums text-ink-900">{left} of {of} days left</span></div>
              <div className="mt-1.5 h-2 rounded-full bg-subtle"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${(left / of) * 100}%` }} /></div></div>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between rounded-xl border border-line p-3 text-sm">
          <div><p className="font-medium text-ink-900">Home leave, 2 days</p><p className="text-xs text-ink-500">Tihar travel, 15–16 Kartik</p></div>
          <div className="flex gap-2"><span className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-700">Return</span><span className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white">Approve</span></div>
        </div>
      </Screen>
    ),
  },
  {
    key: 'payroll', label: 'Payroll', icon: 'Calculator', to: '/features/payroll-management',
    title: 'Close the month in an afternoon',
    points: ['Income tax, SSF, PF and CIT from rules kept per fiscal year', 'Unpaid days explained line by line: leave, absence, lateness rule', 'Prepared by one person, approved by another, then locked'],
    screen: (
      <Screen title="Payroll, Mangsir 2083" meta="42 employees">
        <ol className="flex items-center gap-2 text-xs">
          {['Calculated', 'Submitted', 'Approved', 'Paid'].map((s, i) => <li key={s} className="flex flex-1 items-center gap-2"><span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold', i < 2 ? 'bg-brand-600 text-white' : 'bg-subtle text-ink-500')}>{i + 1}</span><span className={i < 2 ? 'text-ink-900' : 'text-ink-500'}>{s}</span></li>)}
        </ol>
        <dl className="mt-5 grid grid-cols-2 gap-3">
          {[['Gross pay', '24,86,500'], ['Income tax', '1,12,340'], ['SSF (employee + employer)', '6,77,180'], ['Net pay', '20,93,810']].map(([k, v]) => <div key={k} className="rounded-lg bg-canvas p-3"><dt className="text-xs text-ink-500">{k}</dt><dd className="mt-0.5 font-semibold tabular-nums text-ink-900">NPR {v}</dd></div>)}
        </dl>
        <p className="mt-4 flex items-center gap-2 rounded-lg bg-warning-50 p-3 text-xs text-warning-700"><Icon name="AlertCircle" className="size-4 shrink-0" />2 employees have no PAN. Add it before approval.</p>
      </Screen>
    ),
  },
  {
    key: 'devices', label: 'Devices', icon: 'Fingerprint', to: '/features/biometric-attendance',
    title: 'Your fingerprint machines, connected',
    points: ['ZKTeco and compatible terminals push punches over the internet', 'Every branch and device on one screen, with offline alerts', 'Fingerprints and faces never leave the device'],
    screen: (
      <Screen title="Attendance devices" meta="3 branches">
        <ul className="divide-y divide-line text-sm">
          {[['Head office gate', 'Baneshwor', 'Online', '2 min ago'], ['Factory entrance', 'Hetauda', 'Online', 'just now'], ['Showroom', 'Pokhara', 'Offline', '47 min ago']].map(([n, b, s, t]) => (
            <li key={n} className="flex items-center gap-3 py-3">
              <span className={cn('size-2 rounded-full', s === 'Online' ? 'bg-success-600' : 'bg-danger-600')} />
              <div className="flex-1"><p className="text-ink-900">{n}</p><p className="text-xs text-ink-500">{b}</p></div>
              <span className="text-xs text-ink-500">{t}</span><Tag tone={s === 'Online' ? 'ok' : 'late'}>{s}</Tag>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-500">1,284 punches today · 2 device IDs waiting to be linked</p>
      </Screen>
    ),
  },
  {
    key: 'reports', label: 'Reports', icon: 'BarChart3', to: '/features/hr-analytics',
    title: 'Numbers you can hand to the owner',
    points: ['Headcount, turnover, lateness, leave and payroll cost', 'Filter by branch, department and dates', 'Export to PDF, Excel or CSV'],
    screen: (
      <Screen title="Payroll cost by month" meta="FY 2083/84">
        <div className="flex h-40 items-end gap-3">
          {[62, 64, 71, 69, 76].map((h, i) => <div key={i} className="flex flex-1 flex-col items-center gap-1.5"><div className="w-full rounded-t-md bg-brand-500/85" style={{ height: `${h * 1.8}px` }} /><span className="text-[11px] text-ink-500">{['Shr', 'Bha', 'Asw', 'Kar', 'Man'][i]}</span></div>)}
        </div>
        <div className="mt-4 flex gap-2 text-xs">{['PDF', 'Excel', 'CSV'].map((x) => <span key={x} className="rounded-md border border-line px-2.5 py-1 font-medium text-ink-700">{x}</span>)}</div>
      </Screen>
    ),
  },
];

export function ProductTour() {
  const [active, setActive] = useState('attendance');
  const id = useId();
  const t = TABS.find((x) => x.key === active);
  return (
    <div>
      <div role="tablist" aria-label="Product areas" className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {TABS.map((x) => (
          <button key={x.key} type="button" role="tab" id={`${id}-${x.key}`} aria-selected={active === x.key} aria-controls={`${id}-panel`} onClick={() => setActive(x.key)}
            className={cn('flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
              active === x.key ? 'border-ink-900 bg-ink-900 text-white' : 'border-line bg-white text-ink-700 hover:border-line-strong')}>
            <Icon name={x.icon} className="size-4" />{x.label}
          </button>
        ))}
      </div>
      <div key={t.key} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${t.key}`} className="tour-panel mt-10 grid items-center gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">{t.title}</h3>
          <ul className="mt-6 space-y-4">
            {t.points.map((p) => <li key={p} className="flex gap-3 text-ink-700"><Icon name="Check" className="mt-1 size-4 shrink-0 text-brand-600" />{p}</li>)}
          </ul>
          <Link to={t.to} className="mt-8 inline-flex items-center gap-1.5 font-medium text-brand-700 hover:text-brand-600">More about {t.label.toLowerCase()}<Icon name="ArrowRight" className="size-4" /></Link>
        </div>
        {t.screen}
      </div>
    </div>
  );
}
