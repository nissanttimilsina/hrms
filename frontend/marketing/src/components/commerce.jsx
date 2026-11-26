import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Checkbox, Field, Input, Select, Skeleton, Textarea, cn } from '@hrms/shared-ui';
import { api, formatPrice, getUtm } from '../lib/site.js';
import { Icon, ButtonLink, Check, Markdown } from './core.jsx';
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
        <span className="ml-3 rounded bg-subtle px-2 py-0.5 text-[11px] text-ink-500">yourcompany.yourhrms.com</span>
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
      {plans.map((p) => {
        const price = cycle === 'ANNUAL' ? p.prices.annual : p.prices.monthly;
        const isPopular = p.code === popular;
        return (
          <div key={p.code} className={cn('relative flex flex-col rounded-xl border bg-white p-6', isPopular ? 'border-brand-500 shadow-pop ring-1 ring-brand-500' : 'border-line shadow-card')}>
            {isPopular && <span className="absolute -top-3 left-6 rounded-full bg-brand-600 px-3 py-0.5 text-xs font-semibold text-white">Most popular</span>}
            <h3 className="text-lg font-semibold">{p.name}</h3>
            <p className="mt-1 min-h-10 text-sm text-ink-500">{p.limits.employees ? `Up to ${p.limits.employees} employees · ${p.limits.branches} branch${p.limits.branches > 1 ? 'es' : ''}` : 'For larger and complex organisations'}</p>
            <div className="mt-4 min-h-16">
              {p.contactSales || price == null ? (
                <p className="text-3xl font-semibold text-ink-900">Custom</p>
              ) : (
                <>
                  <p className="whitespace-nowrap"><span className="text-[1.65rem] font-semibold tabular-nums text-ink-900">NPR {formatPrice(price)}</span><span className="text-sm text-ink-500"> /{cycle === 'ANNUAL' ? 'yr' : 'mo'}</span></p>
                  {cycle === 'ANNUAL' && p.annualSavings?.amount > 0 && <p className="text-sm text-success-600">Save NPR {formatPrice(p.annualSavings.amount)} a year</p>}
                  {cycle === 'MONTHLY' && <p className="text-xs text-ink-400">+13% VAT</p>}
                </>
              )}
            </div>
            <ButtonLink to={p.contactSales ? '/contact?type=enterprise' : `/signup?plan=${p.code}&cycle=${cycle}`} variant={isPopular ? 'primary' : 'secondary'} size="md" className="mt-5 w-full">
              {p.contactSales ? 'Talk to sales' : `Start ${p.trialDays}-day free trial`}
            </ButtonLink>
            <ul className="mt-6 space-y-2.5 text-sm">{(p.highlights ?? []).map((h) => <Check key={h}>{h}</Check>)}</ul>
          </div>
        );
      })}
    </div>
  );
}

export function PlanCardsSkeleton() {
  return <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-96 rounded-xl" />)}</div>;
}

/** Feature-by-plan comparison built from the live catalogue. */
/** Plan entitlements that are built and usable today; everything else is shown as "Coming soon". */
const SHIPPED = new Set(['employees', 'organization', 'ess', 'documents', 'reports', 'attendance', 'leave', 'payroll', 'shifts', 'biometric', 'reports_advanced', 'document_expiry_alerts', 'multi_branch']);

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
const CALC_MODULES = ['attendance', 'leave', 'payroll', 'shifts', 'recruitment', 'expenses', 'performance', 'training', 'assets', 'custom_fields', 'api_integrations', 'analytics_advanced', 'ai_assistant'];
const MODULE_NAMES = { api_integrations: 'API Integrations', analytics_advanced: 'Advanced Analytics', custom_fields: 'Custom Fields', ai_assistant: 'AI HR Assistant' };
const moduleName = (k) => MODULE_NAMES[k] ?? FEATURES.find((f) => f.key === k)?.name ?? k.replace(/_/g, ' ');

export function PricingCalculator() {
  const [form, setForm] = useState({ employees: 25, branches: 1, modules: ['attendance', 'leave'], billingCycle: 'MONTHLY', coupon: '' });
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
    }, 300);
    return () => clearTimeout(t);
  }, [form]);

  const toggle = (k) => setForm((f) => ({ ...f, modules: f.modules.includes(k) ? f.modules.filter((m) => m !== k) : [...f.modules, k] }));
  const num = (k) => (e) => setForm((f) => ({ ...f, [k]: Math.max(1, Number(e.target.value) || 1) }));

  return (
    <div className="grid gap-6 rounded-2xl border border-line bg-white p-6 shadow-card lg:grid-cols-[1.3fr_1fr] lg:p-8">
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Employees" required><Input type="number" min={1} value={form.employees} onChange={num('employees')} /></Field>
          <Field label="Branches" required><Input type="number" min={1} value={form.branches} onChange={num('branches')} /></Field>
          <Field label="Billing">
            <Select value={form.billingCycle} onChange={(e) => setForm((f) => ({ ...f, billingCycle: e.target.value }))} options={[{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual' }]} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink-900">Modules you need</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {CALC_MODULES.map((k) => <Checkbox key={k} label={moduleName(k)} checked={form.modules.includes(k)} onChange={() => toggle(k)} />)}
          </div>
        </fieldset>
        <Field label="Promo code" error={error && form.coupon ? error : undefined}><Input value={form.coupon} onChange={(e) => setForm((f) => ({ ...f, coupon: e.target.value.toUpperCase() }))} placeholder="Optional" className="max-w-48" /></Field>
      </div>
      <div className="flex flex-col rounded-xl bg-subtle p-6" aria-live="polite">
        {!quote ? <Skeleton className="h-40" /> : quote.contactSales ? (
          <>
            <p className="text-sm font-medium text-ink-500">Recommended</p>
            <p className="mt-1 text-2xl font-semibold text-ink-900">Enterprise</p>
            <p className="mt-2 text-sm text-ink-700">Your requirements go beyond our standard packages ({quote.reasons.join('; ')}). We'll prepare a custom quotation.</p>
            <ButtonLink to={`/contact?type=enterprise&employees=${form.employees}&branches=${form.branches}`} className="mt-auto w-full" size="md">Request a quotation</ButtonLink>
          </>
        ) : (
          <>
            <p className="text-sm font-medium text-ink-500">Recommended plan</p>
            <p className="mt-1 text-2xl font-semibold text-ink-900">{quote.planName}</p>
            <dl className={cn('mt-4 space-y-1.5 text-sm', loading && 'opacity-60')}>
              <div className="flex justify-between"><dt className="text-ink-500">Subtotal</dt><dd className="tabular-nums">NPR {formatPrice(quote.subtotal)}</dd></div>
              {quote.discount > 0 && <div className="flex justify-between text-success-700"><dt>Discount ({quote.coupon})</dt><dd className="tabular-nums">− NPR {formatPrice(quote.discount)}</dd></div>}
              <div className="flex justify-between"><dt className="text-ink-500">VAT {quote.taxRate}%</dt><dd className="tabular-nums">NPR {formatPrice(quote.tax)}</dd></div>
              <div className="flex justify-between border-t border-line-strong pt-2 text-base font-semibold text-ink-900"><dt>Total / {quote.billingCycle === 'ANNUAL' ? 'year' : 'month'}</dt><dd className="tabular-nums">NPR {formatPrice(quote.total)}</dd></div>
            </dl>
            <p className="mt-2 text-xs text-ink-500">≈ NPR {formatPrice(quote.perEmployeeMonthly)} per employee per month before VAT</p>
            <ButtonLink to={`/signup?plan=${quote.recommended}&cycle=${quote.billingCycle}`} className="mt-6 w-full" size="md">Start {quote.trialDays}-day free trial</ButtonLink>
            <p className="mt-2 text-center text-xs text-ink-500">No payment needed for the trial</p>
          </>
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
    <div className="divide-y divide-line rounded-xl border border-line bg-white">
      {items.map((f) => (
        <details key={f.slug} className="group p-5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-ink-900">
            {f.title}<Icon name="Plus" className="size-4 shrink-0 text-ink-400 transition group-open:rotate-45" />
          </summary>
          <div className="mt-3 text-ink-700"><Markdown>{f.body}</Markdown></div>
        </details>
      ))}
    </div>
  );
}
