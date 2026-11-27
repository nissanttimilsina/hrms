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

export const SCREENS = {
  'attendance-management': (
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
  'leave-management': (
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
  'payroll-management': (
      <Screen title="Payroll, Mangsir 2083" meta="42 employees">
        <ol className="grid grid-cols-2 gap-2 text-xs sm:flex sm:items-center">
          {['Calculated', 'Submitted', 'Approved', 'Paid'].map((s, i) => <li key={s} className="flex flex-1 items-center gap-2"><span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold', i < 2 ? 'bg-brand-600 text-white' : 'bg-subtle text-ink-500')}>{i + 1}</span><span className={i < 2 ? 'text-ink-900' : 'text-ink-500'}>{s}</span></li>)}
        </ol>
        <dl className="mt-5 grid grid-cols-2 gap-3">
          {[['Gross pay', '24,86,500'], ['Income tax', '1,12,340'], ['SSF (employee + employer)', '6,77,180'], ['Net pay', '20,93,810']].map(([k, v]) => <div key={k} className="rounded-lg bg-canvas p-3"><dt className="text-xs text-ink-500">{k}</dt><dd className="mt-0.5 font-semibold tabular-nums text-ink-900">NPR {v}</dd></div>)}
        </dl>
        <p className="mt-4 flex items-center gap-2 rounded-lg bg-warning-50 p-3 text-xs text-warning-700"><Icon name="AlertCircle" className="size-4 shrink-0" />2 employees have no PAN. Add it before approval.</p>
      </Screen>
  ),
  'biometric-attendance': (
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
  'hr-analytics': (
      <Screen title="Payroll cost by month" meta="FY 2083/84">
        <div className="flex h-40 items-end gap-3">
          {[62, 64, 71, 69, 76].map((h, i) => <div key={i} className="flex flex-1 flex-col items-center gap-1.5"><div className="w-full rounded-t-md bg-brand-500/85" style={{ height: `${h * 1.8}px` }} /><span className="text-[11px] text-ink-500">{['Shr', 'Bha', 'Asw', 'Kar', 'Man'][i]}</span></div>)}
        </div>
        <div className="mt-4 flex gap-2 text-xs">{['PDF', 'Excel', 'CSV'].map((x) => <span key={x} className="rounded-md border border-line px-2.5 py-1 font-medium text-ink-700">{x}</span>)}</div>
      </Screen>
  ),

  'employee-management': (
    <Screen title="Ram Thapa" meta="EMP-0142">
      <div className="flex items-center gap-4">
        <span className="grid size-12 place-items-center rounded-full bg-brand-100 font-semibold text-brand-700">RT</span>
        <div><p className="font-medium text-ink-900">Senior accountant</p><p className="text-sm text-ink-500">Finance, Baneshwor branch</p></div>
      </div>
      <dl className="mt-5 grid grid-cols-3 gap-2 text-sm">
        {[['PAN', '6012 34 567'], ['Joined', '15 Baishakh 2079'], ['SSF', 'Enrolled']].map(([k, v]) => <div key={k} className="rounded-lg bg-canvas p-2.5"><dt className="text-xs text-ink-500">{k}</dt><dd className="mt-0.5 text-ink-900">{v}</dd></div>)}
      </dl>
      <p className="mt-5 text-xs font-medium text-ink-500">History</p>
      <ol className="mt-2 space-y-2.5 border-l border-line pl-4 text-sm">
        {[['1 Shrawan 2083', 'Promoted to senior accountant'], ['1 Shrawan 2083', 'Salary revised to NPR 65,000'], ['3 Magh 2081', 'Transferred from Pokhara'], ['15 Baishakh 2079', 'Joined as accountant']].map(([d, t], i) => (
          <li key={i} className="relative"><span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-brand-500" /><span className="text-ink-900">{t}</span><span className="block text-xs text-ink-500">{d}</span></li>
        ))}
      </ol>
    </Screen>
  ),
  'employee-self-service': (
    <div className="mx-auto w-64 rounded-[2.2rem] border-[6px] border-ink-900 bg-white p-4 shadow-[0_30px_80px_-40px_rgba(15,23,41,.6)]">
      <p className="text-xs text-ink-500">Thursday, 11 Mangsir</p>
      <p className="mt-0.5 text-lg font-semibold text-ink-900">Namaste, Sita</p>
      <div className="mt-4 rounded-2xl bg-brand-600 p-4 text-white"><p className="text-xs text-white/75">Clocked in at</p><p className="text-2xl font-semibold tabular-nums">09:52</p><p className="mt-2 inline-block rounded-md bg-white/15 px-2 py-1 text-xs">Clock out</p></div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl bg-canvas p-3"><p className="text-xs text-ink-500">Home leave</p><p className="font-semibold text-ink-900">7.5 days</p></div>
        <div className="rounded-xl bg-canvas p-3"><p className="text-xs text-ink-500">Sick leave</p><p className="font-semibold text-ink-900">9 days</p></div>
      </div>
      <div className="mt-2 flex items-center justify-between rounded-xl border border-line p-3 text-sm"><div><p className="text-xs text-ink-500">Kartik payslip</p><p className="font-semibold text-ink-900">NPR 49,050</p></div><Icon name="ChevronRight" className="size-4 text-ink-400" /></div>
    </div>
  ),
  'document-management': (
    <Screen title="Documents" meta="Expiring soon first">
      <ul className="divide-y divide-line text-sm">
        {[['Employment contract', 'Bikash KC', 'Expires in 21 days', 'late'], ['Work permit', 'Anita Gurung', 'Expires in 48 days', 'late'], ['Citizenship copy', 'Ram Thapa', 'Verified', 'ok'], ['Nursing licence', 'Hari Shrestha', 'Valid to Chaitra 2085', 'ok']].map(([d, n, st, tone]) => (
          <li key={d} className="flex items-center gap-3 py-3"><Icon name="FileText" className="size-4 text-ink-400" /><div className="flex-1"><p className="text-ink-900">{d}</p><p className="text-xs text-ink-500">{n}</p></div><Tag tone={tone}>{st}</Tag></li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-ink-500">Files are private to the employee, HR and anyone you allow.</p>
    </Screen>
  ),
  'organization-management': (
    <Screen title="Organisation" meta="3 branches, 42 people">
      <ul className="space-y-3 text-sm">
        {[['Head office, Baneshwor', [['Finance', 6], ['Sales', 9], ['HR & Admin', 4]]], ['Factory, Hetauda', [['Production', 14], ['Stores', 3]]], ['Showroom, Pokhara', [['Sales', 6]]]].map(([b, deps]) => (
          <li key={b} className="rounded-xl border border-line p-3">
            <p className="flex items-center gap-2 font-medium text-ink-900"><Icon name="Building2" className="size-4 text-brand-600" />{b}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-6">{deps.map(([d, n]) => <span key={d} className="rounded-md bg-canvas px-2 py-1 text-xs text-ink-700">{d} <span className="text-ink-400">{n}</span></span>)}</div>
          </li>
        ))}
      </ul>
    </Screen>
  ),
  'shift-management': (
    <Screen title="Roster, ward 2" meta="Week of 9 Mangsir">
      <div className="grid grid-cols-[5rem_repeat(7,1fr)] gap-1 text-center text-xs">
        <span />{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <span key={d} className="pb-1 text-ink-500">{d}</span>)}
        {[['Sita', 'MMEENOO'], ['Ram', 'EENNOMM'], ['Anita', 'NNOMMEE'], ['Hari', 'OMMEENN']].map(([n, row]) => (
          <div key={n} className="contents"><span className="py-1.5 text-left text-ink-700">{n}</span>
            {row.split('').map((c, i) => <span key={i} className={cn('rounded-md py-1.5 font-medium', { M: 'bg-brand-100 text-brand-700', E: 'bg-warning-50 text-warning-700', N: 'bg-ink-900 text-white', O: 'bg-subtle text-ink-400' }[c])}>{c === 'O' ? 'Off' : c}</span>)}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-ink-500">M 07:00 to 15:00, E 15:00 to 23:00, N 23:00 to 07:00. Lateness is judged against each person’s shift.</p>
    </Screen>
  ),
};

const TABS = [
  { key: 'attendance', label: 'Attendance', icon: 'Clock', slug: 'attendance-management', title: 'Know who is in, without asking around', points: ['Clock-in from phone, web or fingerprint and face devices', 'Late, early and missing punches flagged against each branch’s hours', 'Corrections go to the manager for approval'] },
  { key: 'leave', label: 'Leave', icon: 'CalendarDays', slug: 'leave-management', title: 'Leave balances everyone can see', points: ['Home, sick, maternity and your own leave types, preset to the Labour Act', 'Monthly accrual, carry-forward caps and encashment through payroll', 'One or two approval levels, with the team calendar in view'] },
  { key: 'payroll', label: 'Payroll', icon: 'Calculator', slug: 'payroll-management', title: 'Close the month in an afternoon', points: ['Income tax, SSF, PF and CIT from rules kept per fiscal year', 'Unpaid days explained line by line: leave, absence, lateness rule', 'Prepared by one person, approved by another, then locked'] },
  { key: 'devices', label: 'Devices', icon: 'Fingerprint', slug: 'biometric-attendance', title: 'Your fingerprint machines, connected', points: ['ZKTeco and compatible terminals push punches over the internet', 'Every branch and device on one screen, with offline alerts', 'Fingerprints and faces never leave the device'] },
  { key: 'reports', label: 'Reports', icon: 'BarChart3', slug: 'hr-analytics', title: 'Numbers you can hand to the owner', points: ['Headcount, turnover, lateness, leave and payroll cost', 'Filter by branch, department and dates', 'Export to PDF, Excel or CSV'] },
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
      <div key={t.key} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${t.key}`} className="tour-panel mt-10 grid grid-cols-1 items-center [&>*]:min-w-0 gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-16">
        <div>
          <h3 className="text-2xl font-semibold tracking-tight text-ink-900 sm:text-3xl">{t.title}</h3>
          <ul className="mt-6 space-y-4">
            {t.points.map((p) => <li key={p} className="flex gap-3 text-ink-700"><Icon name="Check" className="mt-1 size-4 shrink-0 text-brand-600" />{p}</li>)}
          </ul>
          <Link to={`/features/${t.slug}`} className="mt-8 inline-flex items-center gap-1.5 font-medium text-brand-700 hover:text-brand-600">More about {t.label.toLowerCase()}<Icon name="ArrowRight" className="size-4" /></Link>
        </div>
        {SCREENS[t.slug]}
      </div>
    </div>
  );
}
