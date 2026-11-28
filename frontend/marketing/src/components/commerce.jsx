import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Field, Input, Select, Skeleton, Textarea, cn } from '@hrms/shared-ui';
import { api, formatPrice, getUtm, SITE } from '../lib/site.js';
import { Icon, ButtonLink, Check, Markdown, Reveal, CountUp } from './core.jsx';
import { FEATURES } from '../content/features.js';
import { INDUSTRIES } from '../content/industries.js';

export const usePlans = () => useQuery({ queryKey: ['plans'], queryFn: () => api.get('/plans'), staleTime: 60_000 });
export const useContent = (type, opts = {}) => useQuery({ queryKey: ['content', type, opts], queryFn: () => api.get(`/content?type=${type}${opts.tag ? `&tag=${opts.tag}` : ''}`), staleTime: 60_000 });

// --------------------------------------------------------------------------- product illustration
/** Stylised illustration of the company dashboard (not a customer screenshot). */
export function DashboardPreview() {
  const bars = [62, 74, 70, 81, 77, 88, 84, 91, 86, 93, 89, 95];
  return (
    <div className="relative rounded-xl border border-line bg-white p-2 shadow-pop" aria-label="Illustration of the HR dashboard" role="img">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        {['#f87171', '#fbbf24', '#34d399'].map((c) => <span key={c} className="size-2.5 rounded-full" style={{ background: c }} />)}
        <span className="ml-3 rounded bg-subtle px-2 py-0.5 text-[11px] text-ink-500">yourcompany.{SITE.rootDomain}</span>
      </div>
      <div className="grid grid-cols-[120px_1fr] gap-0 text-left">
        <div className="hidden space-y-1 border-r border-line p-3 sm:block">
          {['Dashboard', 'Employees', 'Attendance', 'Leave', 'Payroll', 'Reports'].map((l, i) => (
            <div key={l} className={cn('rounded px-2 py-1 text-[11px]', i === 0 ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-500')}>{l}</div>
          ))}
        </div>
        <div className="col-span-2 space-y-3 p-3 sm:col-span-1">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[['Employees', '128'], ['Present today', '112'], ['On leave', '9'], ['Pending approvals', '6']].map(([k, v]) => (
              <div key={k} className="rounded-md border border-line p-2">
                <p className="text-[10px] uppercase tracking-wide text-ink-400">{k}</p>
                <p className="text-lg font-semibold text-ink-900">{v}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-[1.6fr_1fr]">
            <div className="rounded-md border border-line p-2">
              <p className="mb-2 text-[11px] font-medium text-ink-700">Attendance rate · last 12 weeks</p>
              <div className="flex h-24 items-end gap-1">{bars.map((h, i) => <div key={i} className="flex-1 rounded-t bg-brand-500/80" style={{ height: `${h}%` }} />)}</div>
            </div>
            <div className="space-y-1.5 rounded-md border border-line p-2">
              <p className="text-[11px] font-medium text-ink-700">Leave requests</p>
              {[['Annual · 3 days', 'warning'], ['Sick · 1 day', 'success'], ['Casual · 1 day', 'success']].map(([l, t]) => (
                <div key={l} className="flex items-center justify-between text-[11px] text-ink-500">{l}<Badge tone={t}>{t === 'success' ? 'approved' : 'pending'}</Badge></div>
              ))}
              <p className="pt-1 text-[11px] font-medium text-ink-700">Payroll · Mangsir 2083</p>
              <div className="h-1.5 rounded-full bg-subtle"><div className="h-full w-4/5 rounded-full bg-success-600" /></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- plans
export function CycleToggle({ cycle, setCycle, maxSavePercent }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-line bg-white p-1" role="radiogroup" aria-label="Billing cycle">
      {['MONTHLY', 'ANNUAL'].map((c) => (
        <button key={c} type="button" role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)}
          className={cn('rounded-full px-4 py-1.5 text-sm font-medium', cycle === c ? 'bg-brand-600 text-white' : 'text-ink-700 hover:bg-subtle')}>
          {c === 'MONTHLY' ? 'Monthly' : 'Annual'}{c === 'ANNUAL' && maxSavePercent ? <span className={cn('ml-1.5 text-xs', cycle === c ? 'text-brand-100' : 'text-success-600')}>save up to {maxSavePercent}%</span> : null}
        </button>
      ))}
    </div>
  );
}

export function PlanCards({ plans, cycle, compact }) {
  const popular = 'PROFESSIONAL';
  return (
    <div className={cn('grid gap-5', compact ? 'md:grid-cols-2 lg:grid-cols-4' : 'md:grid-cols-2 lg:grid-cols-4')}>
      {plans.map((p, i) => {
        const price = cycle === 'ANNUAL' ? p.prices.annual : p.prices.monthly;
        const isPopular = p.code === popular;
        return (
          <Reveal key={p.code} play delay={i * 0.09} className={cn('relative flex flex-col rounded-2xl border p-6', isPopular ? 'border-night bg-night text-white shadow-[0_30px_70px_-35px_rgba(11,26,63,.8)] [&_.text-ink-900]:text-white [&_.text-ink-500]:text-white/65 [&_.text-ink-400]:text-white/50 [&_.text-ink-700]:text-white/85 [&_svg.text-success-600]:text-marigold' : 'border-line bg-white')}>
            {isPopular && <span className="absolute right-5 top-5 rounded-full bg-marigold px-2.5 py-0.5 text-xs font-semibold text-night">Most chosen</span>}
            <h3 className="text-lg font-semibold text-ink-900">{p.name}</h3>
            <p className="mt-1 min-h-10 text-sm text-ink-500">{p.limits.employees ? `Up to ${p.limits.employees} employees · ${p.limits.branches} branch${p.limits.branches > 1 ? 'es' : ''}` : 'For larger and complex organisations'}</p>
            <div className="mt-4 min-h-16">
              {p.contactSales || price == null ? (
                <p className="text-3xl font-semibold text-ink-900">Custom</p>
              ) : (
                <>
                  <p className="whitespace-nowrap"><span className="text-[1.65rem] font-semibold tabular-nums text-ink-900">NPR <CountUp play value={price} format={formatPrice} duration={1100} /></span><span className="text-sm text-ink-500"> /{cycle === 'ANNUAL' ? 'yr' : 'mo'}</span></p>
                  {cycle === 'ANNUAL' && p.annualSavings?.amount > 0 && <p className="text-sm text-success-600">Save NPR <CountUp play value={p.annualSavings.amount} format={formatPrice} duration={700} /> a year</p>}
                  {cycle === 'MONTHLY' && <p className="text-xs text-ink-400">+13% VAT</p>}
                </>
              )}
            </div>
            <ButtonLink to={p.contactSales ? '/contact?type=enterprise' : `/signup?plan=${p.code}&cycle=${cycle}`} variant={isPopular ? 'inverse' : 'secondary'} size="md" className="mt-5 w-full">
              {p.contactSales ? 'Talk to sales' : `Start ${p.trialDays}-day free trial`}
            </ButtonLink>
            <ul className="mt-6 space-y-2.5 text-sm">{(p.highlights ?? []).map((h) => <Check key={h}>{h}</Check>)}</ul>
          </Reveal>
        );
      })}
    </div>
  );
}

export function PlanCardsSkeleton() {
  return <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-[27rem] rounded-2xl border border-line bg-white p-6"><Skeleton className="h-5 w-24" /><Skeleton className="mt-3 h-4 w-40" /><Skeleton className="mt-6 h-8 w-32" /><Skeleton className="mt-6 h-10 w-full" /><div className="mt-6 space-y-3">{[0, 1, 2, 3, 4].map((j) => <Skeleton key={j} className="h-3.5 w-full" />)}</div></div>)}</div>;
}

/** Feature-by-plan comparison built from the live catalogue. */
/** Plan entitlements that are built and usable today; everything else is shown as "Coming soon". */
const SHIPPED = new Set(['employees', 'organization', 'ess', 'documents', 'reports', 'attendance', 'leave', 'payroll', 'shifts', 'biometric', 'reports_advanced', 'document_expiry_alerts', 'multi_branch',
  'tasks', 'expenses', 'recruitment', 'onboarding', 'performance', 'kpi_appraisal', 'training', 'assets', 'helpdesk', 'engagement', 'workforce_planning', 'workflows']);

export function ComparisonTable({ plans }) {
  const all = useMemo(() => {
    const seen = new Map();
    plans.forEach((p) => p.features.forEach((f) => seen.set(f.key, f)));
    return [...seen.values()];
  }, [plans]);
  const has = (p, key) => p.features.some((f) => f.key === key);
  const fmt = (v, unit) => (v == null ? 'Unlimited' : `${formatPrice(v)}${unit ?? ''}`);
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">Plan comparison</caption>
        <thead className="bg-subtle">
          <tr><th scope="col" className="px-4 py-3 text-left font-semibold text-ink-900">Compare plans</th>{plans.map((p) => <th key={p.code} scope="col" className="px-4 py-3 text-center font-semibold text-ink-900">{p.name}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {[['Employees', (p) => fmt(p.limits.employees)], ['Branches', (p) => fmt(p.limits.branches)], ['Document storage', (p) => (p.limits.storageMb == null ? 'Custom' : `${Math.round(p.limits.storageMb / 1024)} GB`)]].map(([label, fn]) => (
            <tr key={label}><th scope="row" className="px-4 py-2.5 text-left font-medium text-ink-700">{label}</th>{plans.map((p) => <td key={p.code} className="px-4 py-2.5 text-center tabular-nums">{fn(p)}</td>)}</tr>
          ))}
          {all.map((f) => (
            <tr key={f.key}>
              <th scope="row" className="px-4 py-2.5 text-left font-normal text-ink-700">{f.name}{!SHIPPED.has(f.key) && <span className="ml-2 rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink-500">Coming soon</span>}</th>
              {plans.map((p) => <td key={p.code} className="px-4 py-2.5 text-center">{has(p, f.key) ? <Icon name="Check" className="mx-auto size-4 text-success-600" /> : <span className="text-ink-400" aria-label="Not included">—</span>}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------------- calculator
// Only modules that are built. Keys are plan feature keys; the quote API picks the smallest plan that has them all.
const CALC_GROUPS = [
  ['Time and pay', [['attendance', 'Attendance', 'Clock'], ['leave', 'Leave', 'CalendarDays'], ['payroll', 'Nepal payroll', 'Wallet'], ['shifts', 'Shifts', 'CalendarClock'], ['biometric', 'Fingerprint devices', 'Fingerprint'], ['expenses', 'Expense claims', 'Receipt']]],
  ['Hiring and growth', [['recruitment', 'Recruitment', 'UserPlus'], ['onboarding', 'Onboarding and exits', 'DoorOpen'], ['kpi_appraisal', 'Performance reviews', 'Target'], ['training', 'Training', 'GraduationCap'], ['engagement', 'Surveys and recognition', 'HeartHandshake']]],
  ['HR operations', [['helpdesk', 'HR helpdesk', 'LifeBuoy'], ['assets', 'Assets', 'Laptop'], ['workflows', 'Request forms', 'Workflow'], ['workforce_planning', 'Workforce planning', 'Network']]],
];
const CALC_MODULES = CALC_GROUPS.flatMap(([, items]) => items.map(([k]) => k));
const moduleName = (k) => CALC_GROUPS.flatMap(([, items]) => items).find(([key]) => key === k)?.[1] ?? k;
const LADDER = [['BASIC', 'Basic'], ['PROFESSIONAL', 'Professional'], ['BUSINESS', 'Business'], ['ENTERPRISE', 'Enterprise']];

function Stepper({ label, value, onChange, min = 1, max = 100000 }) {
  const set = (v) => onChange(Math.min(max, Math.max(min, Number(v) || min)));
  return (
    <div>
      <p className="text-sm font-medium text-ink-900">{label}</p>
      <div className="mt-2 flex h-11 items-center rounded-xl border border-line-strong bg-white focus-within:border-brand-600 focus-within:ring-2 focus-within:ring-brand-100">
        <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => set(value - 1)} className="grid h-full w-11 place-items-center rounded-l-xl text-ink-500 transition hover:bg-canvas hover:text-ink-900 active:scale-90"><Icon name="Minus" className="size-4" /></button>
        <input aria-label={label} inputMode="numeric" value={value} onChange={(e) => set(e.target.value.replace(/\D/g, ''))} className="h-full min-w-0 flex-1 bg-transparent text-center text-base font-semibold tabular-nums text-ink-900 outline-none" />
        <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => set(value + 1)} className="grid h-full w-11 place-items-center rounded-r-xl text-ink-500 transition hover:bg-canvas hover:text-ink-900 active:scale-90"><Icon name="Plus" className="size-4" /></button>
      </div>
    </div>
  );
}

const Money = ({ value, className }) => (
  <span className={cn('tabular-nums', className)}>NPR <CountUp value={Math.round((value ?? 0) * 100)} format={(c) => formatPrice(c / 100)} duration={600} /></span>
);

export function PricingCalculator() {
  const [form, setForm] = useState({ employees: 25, branches: 1, modules: ['attendance', 'leave', 'payroll'], billingCycle: 'MONTHLY', coupon: '' });
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!(form.employees >= 1 && form.branches >= 1)) return;
      setLoading(true);
      try {
        setQuote(await api.post('/pricing/quote', { ...form, coupon: form.coupon || undefined }));
        setError(null);
      } catch (e) { setError(e.message); } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [form]);

  const toggle = (k) => setForm((f) => ({ ...f, modules: f.modules.includes(k) ? f.modules.filter((m) => m !== k) : [...f.modules, k] }));
  const planCode = quote ? (quote.contactSales ? 'ENTERPRISE' : quote.recommended) : null;
  const rung = Math.max(0, LADDER.findIndex(([c]) => c === planCode));
  const annual = form.billingCycle === 'ANNUAL';

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-3xl border border-line bg-white shadow-card lg:grid-cols-[1.35fr_1fr] [&>*]:min-w-0">
      {/* inputs */}
      <div className="space-y-8 p-6 sm:p-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_1fr_auto] [&>*]:min-w-0">
          <Stepper label="Employees" value={form.employees} onChange={(v) => setForm((f) => ({ ...f, employees: v }))} />
          <Stepper label="Branches" value={form.branches} max={1000} onChange={(v) => setForm((f) => ({ ...f, branches: v }))} />
          <div>
            <p className="text-sm font-medium text-ink-900">Billing</p>
            <div className="relative mt-2 grid h-11 grid-cols-2 rounded-xl bg-subtle p-1 text-sm font-medium" role="radiogroup" aria-label="Billing">
              <span className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-lg bg-white shadow-sm transition-transform duration-300 ease-out" style={{ transform: annual ? 'translateX(100%)' : 'none' }} aria-hidden />
              {[['MONTHLY', 'Monthly'], ['ANNUAL', 'Annual']].map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={form.billingCycle === v} onClick={() => setForm((f) => ({ ...f, billingCycle: v }))} className={cn('relative z-10 px-4 transition-colors', form.billingCycle === v ? 'text-ink-900' : 'text-ink-500 hover:text-ink-700')}>{l}</button>
              ))}
            </div>
          </div>
        </div>

        <fieldset>
          <legend className="flex w-full items-baseline justify-between gap-3">
            <span className="text-sm font-medium text-ink-900">Modules you need</span>
            <span className="text-xs text-ink-500">{form.modules.length} selected</span>
          </legend>
          <div className="mt-3 space-y-5">
            {CALC_GROUPS.map(([title, items]) => (
              <div key={title}>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{title}</p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
                  {items.map(([k, label, icon]) => {
                    const on = form.modules.includes(k);
                    return (
                      <button key={k} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(k)}
                        className={cn('group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left text-sm transition duration-200 active:scale-[0.97]',
                          on ? 'border-brand-600 bg-brand-50 text-ink-900 shadow-[0_0_0_1px_var(--color-brand-600)]' : 'border-line bg-white text-ink-700 hover:border-line-strong hover:bg-canvas')}>
                        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg transition-colors duration-200', on ? 'bg-brand-600 text-white' : 'bg-subtle text-ink-500 group-hover:text-ink-700')}>
                          <Icon name={on ? 'Check' : icon} className="size-4" />
                        </span>
                        <span className="min-w-0 truncate font-medium">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-500">Employee records, documents, the self-service app and reports come with every plan.</p>
        </fieldset>

        <Field label="Promo code" error={error && form.coupon ? error : undefined}><Input value={form.coupon} onChange={(e) => setForm((f) => ({ ...f, coupon: e.target.value.toUpperCase() }))} placeholder="Optional" className="max-w-48" /></Field>
      </div>

      {/* summary */}
      <div className="relative flex flex-col bg-[#0f1729] p-6 text-white sm:p-8" aria-live="polite">
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-brand-600/30 blur-3xl" />
        <p className="relative text-sm text-white/60">Recommended plan</p>
        {/* plan ladder: the pill slides to the recommended plan */}
        <div className="relative mt-3 grid grid-cols-4 rounded-xl bg-white/5 p-1 text-center text-xs font-medium">
          <span aria-hidden className="absolute inset-y-1 left-1 w-[calc(25%-2px)] rounded-lg bg-white transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)]" style={{ transform: `translateX(${rung * 100}%)`, opacity: quote ? 1 : 0 }} />
          {LADDER.map(([c, l], k) => <span key={c} className={cn('relative z-10 truncate px-1 py-2 transition-colors duration-300', k === rung && quote ? 'text-ink-900' : 'text-white/55')}>{l}</span>)}
        </div>

        {!quote ? <div className="mt-6 h-40 animate-pulse rounded-xl bg-white/5" /> : quote.contactSales ? (
          <div key="ent" className="calc-in relative mt-6 flex flex-1 flex-col">
            <p className="text-3xl font-semibold tracking-tight">Enterprise</p>
            <p className="mt-3 text-sm text-white/70">Your needs go beyond the standard plans ({quote.reasons.join('; ')}). We'll prepare a quotation for you.</p>
            <ButtonLink to={`/contact?type=enterprise&employees=${form.employees}&branches=${form.branches}`} variant="inverse" className="mt-auto w-full" size="md">Request a quotation</ButtonLink>
          </div>
        ) : (
          <div className="relative mt-6 flex flex-1 flex-col">
            <p key={quote.planName} className="calc-in text-3xl font-semibold tracking-tight">{quote.planName}</p>
            <p className="mt-1 text-sm text-white/60">{form.employees} {form.employees === 1 ? 'employee' : 'employees'} · {form.branches} {form.branches === 1 ? 'branch' : 'branches'} · billed {annual ? 'yearly' : 'monthly'}</p>
            <div className={cn('mt-6 transition-opacity', loading && 'opacity-70')}>
              <p className="text-sm text-white/60">Total per {quote.billingCycle === 'ANNUAL' ? 'year' : 'month'}, with VAT</p>
              <Money value={quote.total} className="mt-1 block text-4xl font-semibold tracking-tight" />
              <dl className="mt-5 space-y-2 border-t border-white/10 pt-4 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-white/60">Plan price</dt><dd><Money value={quote.subtotal} /></dd></div>
                {quote.discount > 0 && <div className="flex justify-between gap-3 text-[#6ee7b7]"><dt>Discount ({quote.coupon})</dt><dd>− <Money value={quote.discount} /></dd></div>}
                <div className="flex justify-between gap-3"><dt className="text-white/60">VAT {quote.taxRate}%</dt><dd><Money value={quote.tax} /></dd></div>
                <div className="flex justify-between gap-3"><dt className="text-white/60">Per employee per month</dt><dd><Money value={quote.perEmployeeMonthly} /></dd></div>
              </dl>
            </div>
            <ButtonLink to={`/signup?plan=${quote.recommended}&cycle=${quote.billingCycle}`} variant="inverse" className="mt-8 w-full" size="md">Start {quote.trialDays}-day free trial</ButtonLink>
            <p className="mt-2 text-center text-xs text-white/50">No payment needed for the trial</p>
          </div>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- lead form
/**
 * One form for contact, demo booking, enterprise quotation and callback requests.
 * Submits to the CRM (POST /public/leads) with UTM attribution and a honeypot.
 */
export function LeadForm({ source = 'CONTACT', defaults = {}, submitLabel = 'Send message', showModules, showSlot }) {
  const [v, setV] = useState({ name: '', company: '', email: '', phone: '', industry: '', employeeCount: defaults.employees ?? '', branchCount: defaults.branches ?? '', message: '', preferredAt: '', modules: [], consent: false, website: '' });
  const [errors, setErrors] = useState({});
  const [state, setState] = useState('idle');
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setState('loading');
    setErrors({});
    const body = {
      source, name: v.name, email: v.email, consent: v.consent, modules: v.modules, website: v.website || undefined,
      ...(v.company && { company: v.company }), ...(v.phone && { phone: v.phone }), ...(v.industry && { industry: v.industry }),
      ...(v.employeeCount && { employeeCount: Number(v.employeeCount) }), ...(v.branchCount && { branchCount: Number(v.branchCount) }),
      ...(v.message && { message: v.message }), ...(v.preferredAt && { preferredAt: new Date(v.preferredAt).toISOString() }), utm: getUtm(),
    };
    try {
      await api.post('/leads', body);
      setState('done');
    } catch (err) {
      setErrors(err.fieldErrors ?? {});
      setState(err.code === 'VALIDATION_ERROR' ? 'idle' : 'error');
    }
  };

  if (state === 'done') {
    return (
      <div className="rounded-xl border border-success-600/30 bg-success-50 p-8 text-center" role="status">
        <Icon name="CheckCircle2" className="mx-auto size-10 text-success-600" />
        <h3 className="mt-3 text-lg font-semibold">Thank you. We've received your request.</h3>
        <p className="mt-1 text-ink-700">Our team will contact you within one business day. We've sent a confirmation to {v.email}.</p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field label="Full name" required error={errors.name}><Input value={v.name} onChange={set('name')} autoComplete="name" /></Field>
      <Field label="Company" required={source !== 'CONTACT'} error={errors.company}><Input value={v.company} onChange={set('company')} autoComplete="organization" /></Field>
      <Field label="Work email" required error={errors.email}><Input type="email" value={v.email} onChange={set('email')} autoComplete="email" /></Field>
      <Field label="Phone" error={errors.phone} hint="We'll only call about your request"><Input type="tel" value={v.phone} onChange={set('phone')} autoComplete="tel" placeholder="98XXXXXXXX" /></Field>
      <Field label="Industry" error={errors.industry}>
        <Select value={v.industry} onChange={set('industry')} placeholder="Select industry" options={[...INDUSTRIES.map((i) => ({ value: i.name, label: i.name })), { value: 'Other', label: 'Other' }]} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Employees" error={errors.employeeCount}><Input type="number" min={1} value={v.employeeCount} onChange={set('employeeCount')} /></Field>
        <Field label="Branches" error={errors.branchCount}><Input type="number" min={1} value={v.branchCount} onChange={set('branchCount')} /></Field>
      </div>
      {showSlot && <Field label="Preferred demo time" hint="Nepal time" error={errors.preferredAt}><Input type="datetime-local" value={v.preferredAt} onChange={set('preferredAt')} /></Field>}
      {showModules && (
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium text-ink-900">Modules you're interested in</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CALC_MODULES.map((k) => <Checkbox key={k} label={moduleName(k)} checked={v.modules.includes(k)} onChange={() => setV((x) => ({ ...x, modules: x.modules.includes(k) ? x.modules.filter((m) => m !== k) : [...x.modules, k] }))} />)}
          </div>
        </fieldset>
      )}
      <Field label="How can we help?" className="sm:col-span-2" error={errors.message}><Textarea value={v.message} onChange={set('message')} rows={4} /></Field>
      {/* honeypot: hidden from people, irresistible to bots */}
      <div aria-hidden="true" className="absolute -left-[9999px]"><label htmlFor="website">Website</label><input id="website" tabIndex={-1} autoComplete="off" value={v.website} onChange={set('website')} /></div>
      <div className="sm:col-span-2">
        <Checkbox checked={v.consent} onChange={set('consent')} label={<span>I agree to the <Link to="/privacy" className="text-brand-700 underline">privacy policy</Link> and to be contacted about my request.</span>} />
        {errors.consent && <p role="alert" className="mt-1 text-xs font-medium text-danger-600">{errors.consent}</p>}
      </div>
      {state === 'error' && <p role="alert" className="text-sm text-danger-600 sm:col-span-2">Something went wrong. Please try again or email us directly.</p>}
      <div className="sm:col-span-2"><Button type="submit" size="lg" loading={state === 'loading'}>{submitLabel}</Button></div>
    </form>
  );
}

// --------------------------------------------------------------------------- FAQ
export function FaqList({ category, limit }) {
  const { data, isPending } = useContent('FAQ');
  const items = (data ?? []).filter((f) => !category || f.data?.category === category).slice(0, limit);
  if (isPending) return <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>;
  return (
    <div className="divide-y divide-line border-y border-line">
      {items.map((f) => (
        <details key={f.slug} className="group py-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-ink-900">
            {f.title}<Icon name="Plus" className="size-4 shrink-0 text-ink-400 transition group-open:rotate-45" />
          </summary>
          <div className="mt-3 text-ink-700"><Markdown>{f.body}</Markdown></div>
        </details>
      ))}
    </div>
  );
}
