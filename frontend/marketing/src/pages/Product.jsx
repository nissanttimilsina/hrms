import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Skeleton } from '@hrms/shared-ui';
import { Container, Section, Seo, ButtonLink, Icon, Pill, Check, CtaBand } from '../components/core.jsx';
import { usePlans, PlanCards, PlanCardsSkeleton, CycleToggle, ComparisonTable, PricingCalculator, FaqList, useContent } from '../components/commerce.jsx';
import { FEATURES, FEATURE_CATEGORIES, featureBySlug } from '../content/features.js';
import { INDUSTRIES, industryBySlug } from '../content/industries.js';
import NotFound from './NotFound.jsx';

const PageHero = ({ eyebrow, title, intro, children }) => (
  <section className="border-b border-line bg-white">
    <Container className="py-14 sm:py-20">
      {eyebrow && <p className="text-sm font-semibold uppercase tracking-wider text-brand-600">{eyebrow}</p>}
      <h1 className="mt-2 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
      {intro && <p className="mt-4 max-w-2xl text-lg text-ink-500">{intro}</p>}
      {children}
    </Container>
  </section>
);
export { PageHero };

/** Which plans include a feature, computed from the live catalogue. */
function PlanAvailability({ featureKey }) {
  const { data: plans } = usePlans();
  if (!plans) return <Skeleton className="h-6 w-64" />;
  const incl = plans.filter((p) => p.features.some((f) => f.key === featureKey));
  if (!incl.length) return <p className="text-sm text-ink-500">Available as an add-on. <Link to="/contact" className="text-brand-700">Ask sales</Link></p>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-ink-500">Included in:</span>
      {incl.map((p) => <Pill key={p.code}>{p.name}</Pill>)}
    </div>
  );
}

// --------------------------------------------------------------------------- features
export function Features() {
  const [cat, setCat] = useState('All');
  const list = cat === 'All' ? FEATURES : FEATURES.filter((f) => f.category === cat);
  return (
    <>
      <Seo title="Features" description="Explore all HRMS modules: employee management, attendance, payroll, leave, recruitment, performance, shifts, self-service and more." path="/features" />
      <PageHero eyebrow="Features" title="Every HR module your business needs" intro="Start with the essentials and switch on more as you grow. Every module shares the same employee record, permissions and audit trail." />
      <Section>
        <div className="mb-8 flex flex-wrap gap-2" role="tablist" aria-label="Feature categories">
          {['All', ...FEATURE_CATEGORIES].map((c) => (
            <button key={c} type="button" role="tab" aria-selected={cat === c} onClick={() => setCat(c)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium ${cat === c ? 'bg-ink-900 text-white' : 'border border-line bg-white text-ink-700 hover:bg-subtle'}`}>{c}</button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((f) => (
            <Link key={f.slug} to={`/features/${f.slug}`} className="group flex flex-col rounded-xl border border-line bg-white p-6 transition hover:border-brand-200 hover:shadow-card">
              <div className="flex items-start justify-between">
                <span className="grid size-10 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon name={f.icon} /></span>
                {f.status !== 'available' && <Pill tone="soon">Coming soon</Pill>}
              </div>
              <h2 className="mt-4 font-semibold text-ink-900">{f.name}</h2>
              <p className="mt-1 flex-1 text-sm text-ink-500">{f.tagline}</p>
              <p className="mt-4 text-xs font-medium uppercase tracking-wide text-ink-400">{f.category}</p>
            </Link>
          ))}
        </div>
      </Section>
      <CtaBand />
    </>
  );
}

export function FeatureDetail() {
  const { slug } = useParams();
  const f = featureBySlug(slug);
  const { data: cms } = useContent('FEATURE');
  if (!f) return <NotFound />;
  const override = cms?.find((c) => c.slug === slug);
  const related = f.related.map(featureBySlug).filter(Boolean);
  return (
    <>
      <Seo title={override?.seo?.title || f.name} description={override?.seo?.description || `${f.tagline} ${f.overview.slice(0, 110)}`} path={`/features/${slug}`} />
      <PageHero eyebrow={f.category} title={override?.title || f.name} intro={override?.summary || f.tagline}>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {f.status === 'available' ? <ButtonLink to="/signup" size="md">Start free trial</ButtonLink> : <Pill tone="soon">Coming soon. Join the early-access list</Pill>}
          <ButtonLink to="/demo" variant="secondary" size="md">Book a demo</ButtonLink>
        </div>
        <div className="mt-6"><PlanAvailability featureKey={f.key} /></div>
      </PageHero>
      <Section>
        <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <h2 className="text-2xl font-semibold">Overview</h2>
            <p className="mt-3 text-lg text-ink-700">{f.overview}</p>
            <h2 className="mt-12 text-2xl font-semibold">What you can do</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">{f.capabilities.map((c) => <Check key={c}>{c}</Check>)}</ul>
            {override?.data?.screenshots?.length > 0 && (
              <div className="mt-12 space-y-4">
                <h2 className="text-2xl font-semibold">Screenshots</h2>
                {override.data.screenshots.map((s) => <img key={s.url} src={s.url} alt={s.alt || f.name} className="rounded-xl border border-line shadow-card" loading="lazy" />)}
              </div>
            )}
          </div>
          <aside className="space-y-6">
            <div className="rounded-xl border border-line bg-white p-6">
              <h2 className="font-semibold">Business benefits</h2>
              <ul className="mt-4 space-y-3 text-sm">{f.benefits.map((b) => <li key={b} className="flex gap-2"><Icon name="TrendingUp" className="mt-0.5 size-4 shrink-0 text-brand-600" />{b}</li>)}</ul>
            </div>
            <div className="rounded-xl border border-line bg-white p-6">
              <h2 className="font-semibold">How it works</h2>
              <ol className="mt-4 space-y-3">{f.workflow.map((w, i) => <li key={w} className="flex items-center gap-3 text-sm"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-600 text-xs font-semibold text-white">{i + 1}</span>{w}</li>)}</ol>
            </div>
          </aside>
        </div>
      </Section>
      {related.length > 0 && (
        <Section title="Works great with" className="bg-white">
          <div className="grid gap-4 sm:grid-cols-3">
            {related.map((r) => (
              <Link key={r.slug} to={`/features/${r.slug}`} className="rounded-xl border border-line p-5 hover:border-brand-200">
                <Icon name={r.icon} className="text-brand-600" /><p className="mt-3 font-semibold">{r.name}</p><p className="text-sm text-ink-500">{r.tagline}</p>
              </Link>
            ))}
          </div>
        </Section>
      )}
      <CtaBand />
    </>
  );
}

// --------------------------------------------------------------------------- industries
export function Industries() {
  return (
    <>
      <Seo title="Industry solutions" description="HRMS configured for IT, hospitals, schools, hotels, restaurants, manufacturing, retail, banks, NGOs, construction and enterprises." path="/industries" />
      <PageHero eyebrow="Industries" title="Built once, configured for your industry" intro="No separate products, no compromises. Shifts, policies, roles and workflows adapt to how your sector works." />
      <Section>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {INDUSTRIES.map((i) => (
            <Link key={i.slug} to={`/industries/${i.slug}`} className="rounded-xl border border-line bg-white p-6 transition hover:border-brand-200 hover:shadow-card">
              <Icon name={i.icon} className="size-7 text-brand-600" />
              <h2 className="mt-4 font-semibold text-ink-900">{i.name}</h2>
              <p className="mt-1 text-sm text-ink-500">{i.headline}</p>
            </Link>
          ))}
        </div>
      </Section>
      <CtaBand />
    </>
  );
}

export function IndustryDetail() {
  const { slug } = useParams();
  const ind = industryBySlug(slug);
  if (!ind) return <NotFound />;
  const mods = ind.modules.map(featureBySlug).filter(Boolean);
  return (
    <>
      <Seo title={`HRMS for ${ind.name}`} description={`${ind.headline}. ${ind.solutions.slice(0, 2).join('. ')}.`} path={`/industries/${slug}`} />
      <PageHero eyebrow={ind.name} title={ind.headline}>
        <div className="mt-6 flex gap-3"><ButtonLink to="/demo" size="md">Book an industry demo</ButtonLink><ButtonLink to="/pricing" variant="secondary" size="md">See pricing</ButtonLink></div>
      </PageHero>
      <Section>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-line bg-white p-6">
            <h2 className="font-semibold">Common challenges</h2>
            <ul className="mt-4 space-y-3">{ind.challenges.map((c) => <li key={c} className="flex gap-2 text-ink-700"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0 text-warning-600" />{c}</li>)}</ul>
          </div>
          <div className="rounded-xl border border-line bg-white p-6">
            <h2 className="font-semibold">How we help</h2>
            <ul className="mt-4 space-y-3">{ind.solutions.map((s) => <Check key={s}>{s}</Check>)}</ul>
          </div>
        </div>
        <h2 className="mt-14 text-2xl font-semibold">Recommended modules</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {mods.map((m) => (
            <Link key={m.slug} to={`/features/${m.slug}`} className="rounded-xl border border-line bg-white p-5 hover:border-brand-200">
              <Icon name={m.icon} className="text-brand-600" /><p className="mt-3 font-semibold">{m.name}</p><p className="text-sm text-ink-500">{m.tagline}</p>
            </Link>
          ))}
        </div>
      </Section>
      <CtaBand title={`See it configured for ${ind.name.toLowerCase()}`} text="Book a 30-minute demo tailored to your workflows." />
    </>
  );
}

// --------------------------------------------------------------------------- pricing
export function Pricing() {
  const [params] = useSearchParams();
  const [cycle, setCycle] = useState(params.get('cycle') === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY');
  const { data: plans, isPending, isError } = usePlans();
  const maxSave = Math.max(0, ...(plans ?? []).map((p) => p.annualSavings?.percent ?? 0));
  return (
    <>
      <Seo title="Pricing" description="Transparent HRMS pricing in NPR. Basic, Standard, Premium and Enterprise plans with monthly or annual billing and a free trial." path="/pricing" />
      <section className="border-b border-line bg-white">
        <Container className="py-14 text-center sm:py-20">
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Plans for every stage of growth</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-500">Start free, pay in NPR, and change plans whenever you need to. Annual billing saves you money.</p>
          <div className="mt-8"><CycleToggle cycle={cycle} setCycle={setCycle} maxSavePercent={maxSave} /></div>
        </Container>
      </section>
      <Section className="pt-12 sm:pt-16">
        {isError ? <p className="text-center text-danger-600">Pricing is temporarily unavailable. Please refresh or contact us.</p> : isPending ? <PlanCardsSkeleton /> : <PlanCards plans={plans} cycle={cycle} />}
        <div className="mt-8 grid gap-4 rounded-xl border border-line bg-white p-6 text-sm text-ink-700 md:grid-cols-3">
          <p><span className="font-semibold text-ink-900">Taxes:</span> prices exclude 13% VAT, shown separately on every invoice.</p>
          <p><span className="font-semibold text-ink-900">Changing plans:</span> upgrades are prorated immediately, downgrades apply at renewal.</p>
          <p><span className="font-semibold text-ink-900">Extra capacity & add-ons:</span> extra employees, branches or modules can be added. <Link to="/contact" className="text-brand-700">Ask sales</Link>.</p>
        </div>
      </Section>
      <Section id="calculator" eyebrow="Calculator" title="Estimate your price" intro="Tell us your size and the modules you need. We’ll recommend a plan using our live pricing." className="bg-white">
        <PricingCalculator />
      </Section>
      <Section eyebrow="Compare" title="Compare features across plans">
        {plans ? <ComparisonTable plans={plans} /> : <Skeleton className="h-96" />}
      </Section>
      <Section title="Pricing questions" className="bg-white"><div className="mx-auto max-w-3xl"><FaqList category="Pricing" /></div></Section>
      <CtaBand title="Need more than 150 employees?" text="Enterprise includes custom capacity, modules, integrations and a dedicated deployment option." />
    </>
  );
}
