import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, Input, Select, Checkbox, Skeleton, EmptyState, formatDate } from '@hrms/shared-ui';
import { Container, Section, Seo, ButtonLink, Icon, Check, CtaBand, Markdown } from '../components/core.jsx';
import { LeadForm, FaqList, useContent, usePlans } from '../components/commerce.jsx';
import { PageHero } from './Product.jsx';
import { api, SITE, workspaceUrl, getUtm } from '../lib/site.js';
import { INDUSTRIES } from '../content/industries.js';
import NotFound from './NotFound.jsx';

// =========================================================================== company
export function About() {
  return (
    <>
      <Seo title="About us" description={`${SITE.company} builds ${SITE.name}, HR and payroll software for businesses in Nepal.`} path="/about" />
      <PageHero eyebrow="About us" title="HR software that understands Nepali businesses" intro={`${SITE.name} is built by ${SITE.company} in Kathmandu. We believe every company, from a 10-person restaurant to a multi-branch bank, deserves international-quality HR tools that fit local rules.`} />
      <Section>
        <div className="grid gap-6 md:grid-cols-3">
          {[['Target', 'Our mission', 'Free HR teams from paperwork so they can focus on people.'], ['ShieldCheck', 'Security first', 'Payroll and personal data deserve bank-grade protection. Isolation, encryption and audit trails are built in, not optional.'], ['Globe', 'Local, then global', 'Designed for Nepal’s tax, SSF and calendar, on an architecture ready for international expansion.']].map(([i, t, d]) => (
            <div key={t} className="rounded-xl border border-line bg-white p-6"><Icon name={i} className="size-6 text-brand-600" /><h2 className="mt-3 font-semibold">{t}</h2><p className="mt-1 text-ink-500">{d}</p></div>
          ))}
        </div>
      </Section>
      <CtaBand title="Talk to the team" text="We’d love to understand your HR challenges." />
    </>
  );
}

export function Contact() {
  const [params] = useSearchParams();
  const enterprise = params.get('type') === 'enterprise';
  return (
    <>
      <Seo title={enterprise ? 'Enterprise quotation' : 'Contact us'} description="Contact the Lishnu HRMS team for sales, enterprise quotations, partnerships or support." path="/contact" />
      <PageHero eyebrow={enterprise ? 'Enterprise' : 'Contact'} title={enterprise ? 'Request an enterprise quotation' : 'Get in touch'} intro={enterprise ? 'Tell us about your organisation and we’ll prepare a custom proposal: capacity, modules, integrations and deployment.' : 'Questions about the product, pricing or a partnership? We reply within one business day.'} />
      <Section>
        <div className="grid gap-10 lg:grid-cols-[1.6fr_1fr]">
          <div className="relative rounded-xl border border-line bg-white p-6 sm:p-8">
            <LeadForm source={enterprise ? 'ENTERPRISE_QUOTE' : 'CONTACT'} showModules={enterprise} defaults={{ employees: params.get('employees'), branches: params.get('branches') }} submitLabel={enterprise ? 'Request quotation' : 'Send message'} />
          </div>
          <aside className="space-y-4">
            <div className="rounded-xl border border-line bg-white p-6 text-sm">
              <h2 className="font-semibold text-ink-900">Talk to us</h2>
              <p className="mt-3 flex items-center gap-2"><Icon name="Mail" className="size-4 text-brand-600" /><a href={`mailto:${SITE.email}`}>{SITE.email}</a></p>
              {SITE.phone && <p className="mt-2 flex items-center gap-2"><Icon name="Phone" className="size-4 text-brand-600" /><a href={`tel:${SITE.phone}`}>{SITE.phone}</a></p>}
              <p className="mt-2 flex items-center gap-2"><Icon name="MapPin" className="size-4 text-brand-600" />{SITE.address}</p>
            </div>
            <div className="rounded-xl border border-line bg-white p-6 text-sm">
              <h2 className="font-semibold text-ink-900">Prefer a call back?</h2>
              <p className="mt-1 text-ink-500">Book a demo and pick a time that suits you.</p>
              <ButtonLink to="/demo" variant="secondary" size="md" className="mt-4">Book a demo</ButtonLink>
            </div>
            <div className="rounded-xl border border-line bg-white p-6 text-sm">
              <h2 className="font-semibold text-ink-900">Existing customer?</h2>
              <p className="mt-1 text-ink-500">Open a ticket from the Help menu inside your workspace for the fastest response.</p>
            </div>
          </aside>
        </div>
      </Section>
    </>
  );
}

export function Demo() {
  return (
    <>
      <Seo title="Book a demo" description="See Lishnu HRMS in action. Book a free 30-minute demo tailored to your company." path="/demo" />
      <Section className="bg-white">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">Book a demo</p>
            <h1 className="mt-2 text-4xl font-semibold tracking-tight">See it working with your own processes</h1>
            <p className="mt-4 text-lg text-ink-500">In 30 minutes, a product specialist will walk you through the modules that matter to you and answer every question.</p>
            <ul className="mt-6 space-y-3"><Check>A tour tailored to your industry</Check><Check>Your payroll and attendance scenarios</Check><Check>Pricing and migration plan</Check><Check>No obligation</Check></ul>
          </div>
          <div className="relative rounded-xl border border-line p-6 sm:p-8"><LeadForm source="DEMO" showModules showSlot submitLabel="Book my demo" /></div>
        </div>
      </Section>
    </>
  );
}

export function Customers() {
  const { data: stories, isPending } = useContent('TESTIMONIAL');
  return (
    <>
      <Seo title="Customer stories" description="How businesses use Lishnu HRMS to run HR, attendance and payroll." path="/customers" />
      <PageHero eyebrow="Customers" title="Customer stories" intro="How teams across Nepal run HR with us." />
      <Section>
        {isPending ? <Skeleton className="h-48" /> : stories?.length ? (
          <div className="grid gap-6 md:grid-cols-2">
            {stories.map((s) => (
              <figure key={s.slug} className="rounded-xl border border-line bg-white p-6">
                <blockquote className="text-lg text-ink-700">“{s.body}”</blockquote>
                <figcaption className="mt-4 text-sm"><span className="font-semibold">{s.title}</span>{s.data?.role && ` · ${s.data.role}`}{s.data?.company && `, ${s.data.company}`}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <EmptyState icon={<Icon name="Quote" />} title="Our first customer stories are on their way" description="We’re onboarding our launch customers now. Want to be featured? Start a trial or talk to us." action={<ButtonLink to="/signup" size="md">Start free trial</ButtonLink>} />
        )}
      </Section>
      <CtaBand />
    </>
  );
}

export function Faq() {
  return (
    <>
      <Seo title="FAQ" description="Answers to common questions about pricing, trials, security, Nepal payroll and onboarding." path="/faq" />
      <PageHero eyebrow="FAQ" title="Frequently asked questions" />
      <Section><div className="mx-auto max-w-3xl space-y-10">{['Pricing', 'Product', 'Security', 'Onboarding'].map((c) => <div key={c}><h2 className="mb-4 text-xl font-semibold">{c}</h2><FaqList category={c} /></div>)}</div></Section>
      <CtaBand title="Still have questions?" text="Our team is happy to help." />
    </>
  );
}

export function Help() {
  return (
    <>
      <Seo title="Help center" description="Get help with Lishnu HRMS: guides, FAQs and support." path="/help" />
      <PageHero eyebrow="Help center" title="How can we help?" />
      <Section>
        <div className="grid gap-5 md:grid-cols-3">
          {[['BookOpen', 'HR guides', 'Practical guides on HR and payroll in Nepal.', '/resources'], ['Search', 'FAQs', 'Quick answers to common questions.', '/faq'], ['LifeBuoy', 'Contact support', 'Customers: open a ticket from your workspace Help menu. Everyone else: contact us.', '/contact']].map(([i, t, d, to]) => (
            <Link key={t} to={to} className="rounded-xl border border-line bg-white p-6 hover:border-brand-200"><Icon name={i} className="size-6 text-brand-600" /><h2 className="mt-3 font-semibold">{t}</h2><p className="mt-1 text-sm text-ink-500">{d}</p></Link>
          ))}
        </div>
      </Section>
    </>
  );
}

export function Status() {
  const { data, isPending, isError, dataUpdatedAt } = useQuery({
    queryKey: ['status'], refetchInterval: 30_000,
    queryFn: async () => { const r = await fetch('/health/ready'); return { ok: r.ok, ...(await r.json().catch(() => ({}))) }; },
  });
  const up = !isError && data?.ok;
  return (
    <>
      <Seo title="System status" description="Current availability of Lishnu HRMS services." path="/status" />
      <PageHero eyebrow="Status" title="System status" />
      <Section>
        {isPending ? <Skeleton className="h-24" /> : (
          <div className={`rounded-xl border p-6 ${up ? 'border-success-600/30 bg-success-50' : 'border-warning-600/30 bg-warning-50'}`} role="status">
            <p className="flex items-center gap-2 text-lg font-semibold"><Icon name={up ? 'CheckCircle2' : 'AlertCircle'} className={up ? 'text-success-600' : 'text-warning-600'} />{up ? 'All systems operational' : 'Some services are degraded'}</p>
            <p className="mt-1 text-sm text-ink-500">Checked {new Date(dataUpdatedAt).toLocaleTimeString()} · refreshes every 30 seconds</p>
            {data?.checks && <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-3">{Object.entries({ api: up ? 'ok' : 'degraded', ...data.checks }).map(([k, v]) => <li key={k} className="flex justify-between rounded-md bg-white px-3 py-2"><span className="capitalize">{k}</span><span className={v === 'ok' ? 'text-success-700' : 'text-warning-700'}>{v}</span></li>)}</ul>}
          </div>
        )}
      </Section>
    </>
  );
}

// =========================================================================== CMS content
export function Blog({ tag, title = 'Blog', intro = 'Product news, HR insights and updates from our team.', path = '/blog' }) {
  const { data, isPending } = useContent('BLOG_POST', { tag });
  return (
    <>
      <Seo title={title} description={intro} path={path} />
      <PageHero eyebrow={title} title={tag ? 'HR guides for Nepali businesses' : 'Insights and updates'} intro={intro} />
      <Section>
        {isPending ? <div className="grid gap-6 md:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-56" />)}</div> : data?.length ? (
          <div className="grid gap-6 md:grid-cols-3">
            {data.map((p) => (
              <Link key={p.slug} to={`/blog/${p.slug}`} className="flex flex-col overflow-hidden rounded-xl border border-line bg-white hover:shadow-card">
                {p.data?.coverUrl && <img src={p.data.coverUrl} alt="" className="aspect-[16/9] object-cover" loading="lazy" />}
                <div className="flex flex-1 flex-col p-5">
                  <p className="text-xs text-ink-400">{formatDate(p.publishAt || p.updatedAt)}{p.data?.tags?.length ? ` · ${p.data.tags.join(', ')}` : ''}</p>
                  <h2 className="mt-2 font-semibold text-ink-900">{p.title}</h2>
                  <p className="mt-2 flex-1 text-sm text-ink-500">{p.summary}</p>
                  <span className="mt-4 text-sm font-medium text-brand-700">Read more →</span>
                </div>
              </Link>
            ))}
          </div>
        ) : <EmptyState icon={<Icon name="BookOpen" />} title="Articles coming soon" description="Subscribe to product updates in the footer to hear when we publish." />}
      </Section>
    </>
  );
}

export function BlogPost() {
  const { slug } = useParams();
  const { data: p, isPending, isError } = useQuery({ queryKey: ['post', slug], queryFn: () => api.get(`/content/BLOG_POST/${slug}`), retry: false });
  if (isError) return <NotFound />;
  return (
    <>
      {p && <Seo title={p.seo?.title || p.title} description={p.seo?.description || p.summary} path={`/blog/${slug}`} />}
      <article>
        <Container className="max-w-3xl py-14">
          <Link to="/blog" className="text-sm text-brand-700">← All articles</Link>
          {isPending ? <Skeleton className="mt-6 h-96" /> : (
            <>
              <p className="mt-6 text-sm text-ink-400">{formatDate(p.publishAt || p.updatedAt)}</p>
              <h1 className="mt-2 text-4xl font-semibold tracking-tight">{p.title}</h1>
              {p.summary && <p className="mt-4 text-lg text-ink-500">{p.summary}</p>}
              <div className="mt-10"><Markdown>{p.body}</Markdown></div>
            </>
          )}
        </Container>
      </article>
      <CtaBand />
    </>
  );
}

export function Changelog() {
  const { data, isPending } = useContent('CHANGELOG');
  return (
    <>
      <Seo title="Changelog" description="New features and improvements in Lishnu HRMS." path="/changelog" />
      <PageHero eyebrow="Changelog" title="What’s new" />
      <Section>
        <div className="mx-auto max-w-3xl space-y-8">
          {isPending ? <Skeleton className="h-40" /> : data?.length ? data.map((c) => (
            <article key={c.slug} className="rounded-xl border border-line bg-white p-6">
              <p className="text-sm text-ink-400">{formatDate(c.publishAt || c.updatedAt)}{c.data?.version && ` · v${c.data.version}`}</p>
              <h2 className="mt-1 text-xl font-semibold">{c.title}</h2>
              <div className="mt-3"><Markdown>{c.body}</Markdown></div>
            </article>
          )) : <EmptyState title="No releases published yet" />}
        </div>
      </Section>
    </>
  );
}

export function CmsPage({ slug }) {
  const { data: p, isPending, isError } = useQuery({ queryKey: ['page', slug], queryFn: () => api.get(`/content/PAGE/${slug}`), retry: false });
  if (isError) return <NotFound />;
  return (
    <>
      {p && <Seo title={p.seo?.title || p.title} description={p.seo?.description || p.summary} path={`/${slug === 'privacy-policy' ? 'privacy' : slug === 'terms-of-service' ? 'terms' : slug}`} />}
      <Container className="max-w-3xl py-14">
        {isPending ? <Skeleton className="h-96" /> : (
          <>
            <h1 className="text-4xl font-semibold tracking-tight">{p.title}</h1>
            {p.summary && <p className="mt-3 text-lg text-ink-500">{p.summary}</p>}
            <div className="mt-10"><Markdown>{p.body}</Markdown></div>
          </>
        )}
      </Container>
    </>
  );
}

// =========================================================================== account
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const toSlug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function Signup() {
  const [params] = useSearchParams();
  const { data: plans } = usePlans();
  const [v, setV] = useState({ companyName: '', slug: '', industry: '', employeeCount: '', fullName: '', email: '', phone: '', password: '', planCode: params.get('plan') || 'PROFESSIONAL', billingCycle: params.get('cycle') || 'MONTHLY', acceptTerms: false, website: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugState, setSlugState] = useState(null);
  const [errors, setErrors] = useState({});
  const [state, setState] = useState('idle');
  const [result, setResult] = useState(null);
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  useEffect(() => { if (!slugTouched) setV((x) => ({ ...x, slug: toSlug(x.companyName) })); }, [v.companyName, slugTouched]);
  useEffect(() => {
    if (!v.slug) { setSlugState(null); return undefined; }
    if (!SLUG_RE.test(v.slug)) { setSlugState({ available: false, reason: '3–63 lowercase letters, numbers or hyphens' }); return undefined; }
    const t = setTimeout(async () => { try { setSlugState(await api.get(`/signup/slug-available?slug=${v.slug}`)); } catch { setSlugState(null); } }, 350);
    return () => clearTimeout(t);
  }, [v.slug]);

  const submit = async (e) => {
    e.preventDefault();
    setState('loading'); setErrors({});
    try {
      const body = { ...v, employeeCount: v.employeeCount ? Number(v.employeeCount) : undefined, industry: v.industry || undefined, website: v.website || undefined, utm: getUtm() };
      setResult(await api.post('/signup', body));
      setState('done');
    } catch (err) {
      setErrors({ ...err.fieldErrors, ...(err.code === 'SLUG_TAKEN' && { slug: err.message }) });
      setState(err.code === 'VALIDATION_ERROR' || err.code === 'SLUG_TAKEN' ? 'idle' : 'error');
      if (!['VALIDATION_ERROR', 'SLUG_TAKEN'].includes(err.code)) setErrors((x) => ({ ...x, _form: err.message }));
    }
  };

  if (state === 'done') {
    return (
      <Container className="max-w-xl py-20 text-center">
        <Seo title="Check your email" noindex />
        <Icon name="Mail" className="mx-auto size-12 text-brand-600" />
        <h1 className="mt-4 text-3xl font-semibold">Check your inbox</h1>
        <p className="mt-3 text-ink-700">We sent a confirmation link to <strong>{v.email}</strong>. Click it to activate <strong>{result?.hostname}</strong> and start your {result?.trialDays}-day free trial.</p>
        <ResendVerification email={v.email} />
      </Container>
    );
  }
  const selfServe = (plans ?? []).filter((p) => !p.contactSales);
  return (
    <div className="grid min-h-[calc(100dvh-4rem)] lg:grid-cols-[1fr_1.15fr]">
      <Seo title="Start your free trial" description="Create your HR workspace in minutes. Free trial, no payment details needed." path="/signup" />
      <aside className="hidden flex-col justify-center bg-brand-900 p-12 text-white lg:flex">
        <h1 className="text-3xl font-semibold">Start your free trial</h1>
        <p className="mt-3 text-brand-100">Your own secure workspace, ready in minutes.</p>
        <ul className="mt-8 space-y-4 text-brand-50">{['Free trial with every self-service plan', 'No payment details needed', 'Import employees from Excel', 'Cancel any time; your data stays yours'].map((t) => <li key={t} className="flex gap-2"><Icon name="CheckCircle2" className="mt-0.5 size-5 shrink-0 text-brand-200" />{t}</li>)}</ul>
      </aside>
      <div className="flex items-center justify-center bg-white px-5 py-12">
        <form onSubmit={submit} noValidate className="relative grid w-full max-w-xl gap-4 sm:grid-cols-2">
          <h1 className="text-2xl font-semibold sm:col-span-2 lg:hidden">Start your free trial</h1>
          <Field label="Company name" required error={errors.companyName} className="sm:col-span-2"><Input value={v.companyName} onChange={set('companyName')} autoComplete="organization" /></Field>
          <Field label="Workspace address" required error={errors.slug || (slugState && !slugState.available ? slugState.reason : undefined)} hint={slugState?.available ? `✓ ${v.slug}.${SITE.rootDomain} is available` : `${v.slug || 'yourcompany'}.${SITE.rootDomain}`} className="sm:col-span-2">
            <Input value={v.slug} onChange={(e) => { setSlugTouched(true); setV((x) => ({ ...x, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })); }} />
          </Field>
          <Field label="Industry" error={errors.industry}><Select value={v.industry} onChange={set('industry')} placeholder="Select" options={[...INDUSTRIES.map((i) => ({ value: i.name, label: i.name })), { value: 'Other', label: 'Other' }]} /></Field>
          <Field label="Number of employees" error={errors.employeeCount}><Input type="number" min={1} value={v.employeeCount} onChange={set('employeeCount')} /></Field>
          <Field label="Your full name" required error={errors.fullName}><Input value={v.fullName} onChange={set('fullName')} autoComplete="name" /></Field>
          <Field label="Mobile number" required error={errors.phone}><Input type="tel" value={v.phone} onChange={set('phone')} autoComplete="tel" placeholder="98XXXXXXXX" /></Field>
          <Field label="Work email" required error={errors.email} className="sm:col-span-2"><Input type="email" value={v.email} onChange={set('email')} autoComplete="email" /></Field>
          <Field label="Password" required error={errors.password} hint="At least 10 characters with upper-case, lower-case and a number" className="sm:col-span-2"><Input type="password" value={v.password} onChange={set('password')} autoComplete="new-password" /></Field>
          <Field label="Plan" error={errors.planCode}><Select value={v.planCode} onChange={set('planCode')} options={selfServe.map((p) => ({ value: p.code, label: `${p.name} · up to ${p.limits.employees} employees` }))} /></Field>
          <Field label="Billing after trial"><Select value={v.billingCycle} onChange={set('billingCycle')} options={[{ value: 'MONTHLY', label: 'Monthly' }, { value: 'ANNUAL', label: 'Annual (save more)' }]} /></Field>
          <div aria-hidden="true" className="absolute -left-[9999px]"><label htmlFor="website2">Website</label><input id="website2" tabIndex={-1} autoComplete="off" value={v.website} onChange={set('website')} /></div>
          <div className="sm:col-span-2">
            <Checkbox checked={v.acceptTerms} onChange={set('acceptTerms')} label={<span>I agree to the <Link to="/terms" className="text-brand-700 underline">Terms of Service</Link> and <Link to="/privacy" className="text-brand-700 underline">Privacy Policy</Link>.</span>} />
            {errors.acceptTerms && <p role="alert" className="mt-1 text-xs font-medium text-danger-600">{errors.acceptTerms}</p>}
          </div>
          {errors._form && <p role="alert" className="text-sm text-danger-600 sm:col-span-2">{errors._form}</p>}
          <Button type="submit" size="lg" loading={state === 'loading'} className="sm:col-span-2" disabled={slugState && !slugState.available}>Create my workspace</Button>
          <p className="text-center text-sm text-ink-500 sm:col-span-2">Already have a workspace? <Link to="/login" className="font-medium text-brand-700">Sign in</Link></p>
        </form>
      </div>
    </div>
  );
}

function ResendVerification({ email }) {
  const [sent, setSent] = useState(false);
  return sent ? <p className="mt-6 text-sm text-success-700">If your workspace is awaiting confirmation, we’ve sent a new link.</p>
    : <Button variant="ghost" className="mt-6" onClick={async () => { await api.post('/signup/resend-verification', { email }).catch(() => {}); setSent(true); }}>Didn’t get it? Resend the email</Button>;
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const { data, isPending, isError, error } = useQuery({ queryKey: ['verify', token], queryFn: () => api.post('/signup/verify-email', { token }), enabled: !!token, retry: false, staleTime: Infinity });
  return (
    <Container className="max-w-xl py-20 text-center">
      <Seo title="Confirm your email" noindex />
      {!token || isError ? (
        <>
          <Icon name="AlertCircle" className="mx-auto size-12 text-warning-600" />
          <h1 className="mt-4 text-3xl font-semibold">Link invalid or expired</h1>
          <p className="mt-3 text-ink-700">{error?.message || 'This confirmation link is missing a token.'}</p>
          <ResendForm />
        </>
      ) : isPending ? <p className="text-ink-500">Confirming your email…</p> : (
        <>
          <Icon name="CheckCircle2" className="mx-auto size-12 text-success-600" />
          <h1 className="mt-4 text-3xl font-semibold">Your workspace is active</h1>
          <p className="mt-3 text-ink-700">Sign in at <strong>{data.workspaceUrl.replace('https://', '')}</strong>. Bookmark it for your team.</p>
          <ButtonLink to={`${data.workspaceUrl}/login`} external className="mt-8">Go to my workspace</ButtonLink>
        </>
      )}
    </Container>
  );
}

function ResendForm() {
  const [email, setEmail] = useState('');
  return (
    <div className="mx-auto mt-8 flex max-w-sm gap-2">
      <Input type="email" placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Work email" />
      <ResendVerification email={email} />
    </div>
  );
}

export function Login() {
  const [slug, setSlug] = useState('');
  const [err, setErr] = useState('');
  const go = (e) => {
    e.preventDefault();
    const s = slug.trim().toLowerCase().replace(`.${SITE.rootDomain}`, '');
    if (!SLUG_RE.test(s)) { setErr('Enter your workspace name, e.g. "himal"'); return; }
    window.location.href = workspaceUrl(s, '/login');
  };
  return (
    <Container className="max-w-md py-20">
      <Seo title="Sign in" description="Sign in to your HR workspace." path="/login" />
      <h1 className="text-3xl font-semibold">Sign in to your workspace</h1>
      <p className="mt-2 text-ink-500">Enter your company’s workspace name.</p>
      <form onSubmit={go} className="mt-8 space-y-4">
        <Field label="Workspace" error={err} hint={`${slug || 'yourcompany'}.${SITE.rootDomain}`}><Input value={slug} onChange={(e) => setSlug(e.target.value)} autoFocus /></Field>
        <Button type="submit" size="lg" className="w-full">Continue</Button>
      </form>
      <p className="mt-6 text-center text-sm text-ink-500">New here? <Link to="/signup" className="font-medium text-brand-700">Start a free trial</Link></p>
    </Container>
  );
}

