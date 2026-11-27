/**
 * The hero: one working day flowing through the product, played once on load.
 * Device punches arrive → the month's register fills → the month closes into a Nepal payslip.
 * Figures are a worked example for FY 2083/84 (SSF member, so the 1% social security tax is waived).
 */
import { cn } from '@hrms/shared-ui';
import { Icon } from './core.jsx';

const d = (s) => ({ '--d': `${s}s` });

const PUNCHES = [
  ['09:52', 'Sita Rai', 'In', 'on time'],
  ['10:04', 'Ram Thapa', 'In', 'within grace'],
  ['10:21', 'Bikash KC', 'In', 'late 11 min'],
  ['17:36', 'Sita Rai', 'Out', '7 h 44 m'],
];

// 4 people × 15 working days of Mangsir: P present, L late, V leave, O weekly off
const ROWS = [
  ['Sita', 'PPPPOPPPPVPOPPP'],
  ['Ram', 'PPLPOPPPPPPOPPP'],
  ['Bikash', 'PLPPOPLPPPPOLPP'],
  ['Anita', 'PPPPOVVPPPPOPPP'],
];
const CELL = { P: 'bg-brand-500', L: 'bg-marigold', V: 'bg-success-600', O: 'bg-line' };

export function HeroScene() {
  return (
    <div className="relative mx-auto w-full max-w-[560px] select-none" aria-hidden="true">
      {/* device feed */}
      <div className="scene-in rounded-2xl border border-line bg-white p-4 shadow-[0_24px_60px_-28px_rgba(15,23,41,.35)]" style={d(0)}>
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink-900"><Icon name="Fingerprint" className="size-4 text-brand-600" />Head office gate</p>
          <span className="flex items-center gap-1.5 text-xs font-medium text-success-700"><span className="live-dot size-1.5 rounded-full bg-success-600" />Online</span>
        </div>
        <ul className="mt-3 divide-y divide-line">
          {PUNCHES.map(([t, n, k, note], i) => (
            <li key={t + n} className="scene-in flex items-center gap-3 py-2 text-sm" style={d(0.35 + i * 0.32)}>
              <span className="w-12 font-medium tabular-nums text-ink-900">{t}</span>
              <span className="flex-1 text-ink-700">{n}</span>
              <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', k === 'In' ? 'bg-brand-50 text-brand-700' : 'bg-subtle text-ink-700')}>{k}</span>
              <span className={cn('w-24 text-right text-xs', note.startsWith('late') ? 'font-semibold text-warning-700' : 'text-ink-500')}>{note}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* register */}
      <div className="scene-in relative z-10 -mt-3 ml-6 mr-[-12px] rounded-2xl border border-line bg-white p-4 shadow-[0_24px_60px_-28px_rgba(15,23,41,.35)] sm:ml-14" style={d(1.6)}>
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-ink-900">Attendance register</p>
          <p className="text-xs text-ink-500">Mangsir 2083</p>
        </div>
        <div className="mt-3 space-y-1.5">
          {ROWS.map(([name, days], r) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-12 text-xs text-ink-500">{name}</span>
              <div className="grid flex-1 grid-cols-15 gap-1" style={{ gridTemplateColumns: 'repeat(15, minmax(0, 1fr))' }}>
                {[...days].map((c, i) => <span key={i} className={cn('scene-pop aspect-square rounded-[3px]', CELL[c])} style={d(1.9 + i * 0.045 + r * 0.06)} />)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-500">
          {[['bg-brand-500', 'Present'], ['bg-marigold', 'Late'], ['bg-success-600', 'Paid leave'], ['bg-line', 'Weekly off']].map(([c, l]) => <span key={l} className="flex items-center gap-1.5"><span className={cn('size-2 rounded-[2px]', c)} />{l}</span>)}
        </div>
      </div>

      {/* payslip */}
      <div className="scene-in relative z-20 -mt-4 mr-6 rounded-2xl border border-night/10 bg-night p-5 text-white shadow-[0_30px_70px_-30px_rgba(11,26,63,.7)] sm:mr-16" style={d(2.75)}>
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold">Payslip, Sita Rai</p>
          <p className="text-xs text-white/60">Mangsir 2083</p>
        </div>
        <dl className="mt-3 space-y-1.5 text-sm">
          {[['Basic salary', '45,000'], ['Dearness allowance', '9,000'], ['SSF, employee 11%', '−4,950'], ['Social security tax 1%', 'waived, SSF member']].map(([k, v], i) => (
            <div key={k} className="scene-in flex justify-between gap-4" style={d(3 + i * 0.12)}>
              <dt className="text-white/70">{k}</dt><dd className={cn('tabular-nums', v.startsWith('waived') && 'text-marigold')}>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-3 h-px bg-white/15"><div className="scene-draw h-px bg-marigold" style={d(3.5)} /></div>
        <div className="scene-in mt-3 flex items-baseline justify-between" style={d(3.7)}>
          <span className="text-sm text-white/70">Net pay</span>
          <span className="text-2xl font-semibold tabular-nums tracking-tight">NPR 49,050</span>
        </div>
      </div>
    </div>
  );
}
