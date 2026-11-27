import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Skeleton } from '@hrms/shared-ui';
import { SCREENS } from '../components/tour.jsx';
import { Container, Section, Seo, ButtonLink, Icon, Pill, Check, CtaBand } from '../components/core.jsx';
import { usePlans, PlanCards, PlanCardsSkeleton, CycleToggle, ComparisonTable, PricingCalculator, FaqList, useContent } from '../components/commerce.jsx';
import { FEATURES, FEATURE_CATEGORIES, featureBySlug } from '../content/features.js';
import { INDUSTRIES, industryBySlug } from '../content/industries.js';
import NotFound from './NotFound.jsx';

const PageHero = ({ eyebrow, title, intro, children }) => (
  <section className="border-b border-line bg-[linear-gradient(180deg,#f4f7ff_0%,#ffffff_85%)]">
    <Container className="py-16 sm:py-24">
      {eyebrow && <p className="text-sm font-medium text-brand-700">{eyebrow}</p>}
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.03em] text-ink-900 sm:text-[3.4rem] sm:leading-[1.08]">{title}</h1>
      {intro && <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-700 sm:text-xl">{intro}</p>}
      {children}
    </Container>
  </section>
);
export { PageHero };

/** Which plans include a feature, computed from the live catalogue. */
function PlanAvailability({ featureKey }) {
  const { data: plans } = usePlans();
  if (!plans) return <p className="h-5" aria-hidden />;
  const incl = plans.filter((p) => p.features.some((f) => f.key === featureKey));
  if (!incl.length) return <p className="text-sm text-ink-500">Available as an add-on. <Link to="/contact" className="font-medium text-brand-700">Ask sales</Link></p>;
  const names = incl.map((p) => p.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return <p className="text-sm text-ink-500">Included in {list}. <Link to="/pricing" className="font-medium text-brand-700 hover:text-brand-600">See pricing</Link></p>;
}

// --------------------------------------------------------------------------- features
export function Features() {
  const live = FEATURES.filter((f) => f.status === 'available');
  const soon = FEATURES.filter((f) => f.status !== 'available');
  const cats = FEATURE_CATEGORIES.filter((c) => live.some((f) => f.category === c));
  return (
    <>
      <Seo title="Features" description="Employee records, attendance, fingerprint devices, leave, shifts, Nepal payroll, self-service and reports in one HR system." path="/features" />
      <PageHero eyebrow="Features" title="Everything you need to run HR and payroll" intro="Every module works from the same employee record, so attendance becomes leave balances and leave becomes payroll, without typing anything twice." />
      <section className="bg-white py-16 sm:py-24">
        <Container>
          {cats.map((c) => (
            <div key={c} className="grid gap-4 border-t border-line py-10 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_1fr] lg:gap-10">
              <h2 className="text-lg font-semibold text-ink-900">{c}</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {live.filter((f) => f.category === c).map((f) => (
                  <Link key={f.slug} to={`/features/${f.slug}`} className="group flex gap-4 rounded-2xl p-4 transition-colors hover:bg-canvas">
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-600 group-hover:text-white"><Icon name={f.icon} /></span>
                    <span>
                      <span className="flex items-center gap-1.5 font-semibold text-ink-900">{f.name}<Icon name="ArrowRight" className="size-4 -translate-x-1 text-brand-600 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" /></span>
                      <span className="mt-1 block text-ink-500">{f.tagline}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </Container>
      </section>
      <section className="border-t border-line bg-canvas py-16 sm:py-20">
        <Container className="grid gap-8 lg:grid-cols-[16rem_1fr] lg:gap-10">
          <div>
            <h2 className="text-lg font-semibold text-ink-900">On the roadmap</h2>
            <p className="mt-2 text-sm text-ink-500">Not in the product yet. Each one is announced in the <Link to="/changelog" className="font-medium text-brand-700">changelog</Link> when it ships.</p>
          </div>
          <ul className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {soon.map((f) => (
              <li key={f.slug} className="border-b border-line">
                <Link to={`/features/${f.slug}`} className="flex items-center gap-3 py-3.5 text-ink-700 hover:text-ink-900"><Icon name={f.icon} className="size-4 text-ink-400" />{f.name}</Link>
              </li>
            ))}
          </ul>
        </Container>
      </section>
      <CtaBand />
    </>
  );
}

export function FeatureDetail() {
  const { slug } = useParams();
  const f = featureBySlug(slug);
  const { data: cms } = useContent('FEATURE');
  if (!f) return <NotFound />;
  const live = f.status === 'available';
  const override = cms?.find((c) => c.slug === slug);
  const related = f.related.map(featureBySlug).filter(Boolean);
  const screen = SCREENS[slug];
  return (
    <>
      <Seo title={override?.seo?.title || f.name} description={override?.seo?.description || `${f.tagline} ${f.overview.slice(0, 110)}`} path={`/features/${slug}`} />

      <section className="relative overflow-hidden border-b border-line bg-[linear-gradient(180deg,#f4f7ff_0%,#ffffff_80%)]">
        <Container className="grid grid-cols-1 items-center [&>*]:min-w-0 gap-14 py-14 sm:py-20 lg:grid-cols-[1fr_1.05fr] lg:gap-16 lg:py-24">
          <div className="scene-in" style={{ '--d': '0s' }}>
            <p className="flex items-center gap-2 text-sm text-ink-500">
              <Link to="/features" className="hover:text-ink-900">Features</Link><Icon name="ChevronRight" className="size-3.5 text-ink-400" /><span className="text-brand-700">{f.category}</span>
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-[-0.03em] text-ink-900 sm:text-[3.4rem] sm:leading-[1.06]">{override?.title || f.name}</h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-700 sm:text-xl">{override?.summary || f.tagline}</p>
            {live ? (
              <>
                <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                  <ButtonLink to="/signup">Start free trial</ButtonLink>
                  <ButtonLink to="/demo" variant="secondary">Book a demo</ButtonLink>
                </div>
                <div className="mt-5"><PlanAvailability featureKey={f.key} /></div>
              </>
            ) : (
              <div className="mt-8 max-w-xl rounded-2xl border border-warning-600/20 bg-warning-50 p-5">
                <p className="font-semibold text-warning-700">On the roadmap, not available yet</p>
                <p className="mt-1 text-sm text-ink-700">This page describes what we plan to build. Tell us how you would use it and we will contact you when it ships.</p>
                <ButtonLink to="/contact" variant="secondary" size="md" className="mt-4">Tell us what you need</ButtonLink>
              </div>
            )}
          </div>
          {screen ? (
            <div className="scene-in" style={{ '--d': '.25s' }}>{screen}</div>
          ) : (
            <div className="scene-in rounded-2xl border border-dashed border-line-strong bg-white/70 p-7" style={{ '--d': '.25s' }}>
              <span className="grid size-12 place-items-center rounded-xl bg-subtle text-ink-500"><Icon name={f.icon} /></span>
              <p className="mt-5 font-semibold text-ink-900">Planned for {f.name.toLowerCase()}</p>
              <ul className="mt-4 space-y-2.5 text-sm text-ink-700">{f.capabilities.slice(0, 5).map((c) => <li key={c} className="flex gap-2.5"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-ink-400" />{c}</li>)}</ul>
            </div>
          )}
        </Container>
      </section>

      <section className="bg-white py-16 sm:py-24">
        <Container className="grid gap-12 lg:grid-cols-[1.25fr_1fr] lg:gap-20">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.4rem] sm:leading-[1.12]">{live ? 'What it does' : 'What we plan'}</h2>
            <p className="mt-5 text-lg leading-relaxed text-ink-700">{f.overview}</p>
          </div>
          <div>
            <h3 className="text-sm font-medium text-ink-500">{live ? 'Why teams use it' : 'Why it matters'}</h3>
            <ul className="mt-4 divide-y divide-line border-y border-line">
              {f.benefits.map((b) => <li key={b} className="py-3.5 text-ink-900">{b}</li>)}
            </ul>
          </div>
        </Container>
      </section>

      <section className="border-y border-line bg-canvas py-16 sm:py-24">
        <Container>
          <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.4rem]">{live ? 'In detail' : 'Planned capabilities'}</h2>
          <ul className="mt-10 grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
            {f.capabilities.map((c) => <li key={c} className="flex gap-3 border-t border-line py-4 text-ink-700"><Icon name="Check" className="mt-0.5 size-4 shrink-0 text-brand-600" />{c}</li>)}
          </ul>
          {override?.data?.screenshots?.length > 0 && (
            <div className="mt-14 space-y-6">
              {override.data.screenshots.map((sc) => <img key={sc.url} src={sc.url} alt={sc.alt || f.name} className="rounded-2xl border border-line" loading="lazy" />)}
            </div>
          )}
        </Container>
      </section>

      <section className="bg-white py-16 sm:py-24">
        <Container>
          <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.4rem]">How it works</h2>
          <ol className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {f.workflow.map((w, i) => (
              <li key={w} className="bg-white p-6">
                <span className="text-sm font-semibold tabular-nums text-brand-600">{i + 1}</span>
                <p className="mt-3 font-medium text-ink-900">{w}</p>
              </li>
            ))}
          </ol>
          {related.length > 0 && (
            <div className="mt-16">
              <h3 className="text-sm font-medium text-ink-500">Works together with</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {related.map((r) => (
                  <Link key={r.slug} to={`/features/${r.slug}`} className="group flex items-center gap-3 rounded-xl border border-line p-4 transition-colors hover:border-brand-500">
                    <Icon name={r.icon} className="size-5 text-brand-600" />
                    <span className="flex-1 font-medium text-ink-900">{r.name}</span>
                    {r.status !== 'available' && <span className="text-xs text-ink-400">Roadmap</span>}
                    <Icon name="ArrowRight" className="size-4 text-ink-400 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ))}
              </div>
            </div>
          )}
        </Container>
      </section>

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
      <Seo title="Pricing" description="Transparent HRMS pricing in NPR. Basic, Professional, Business and Enterprise plans with monthly or annual billing and a free trial." path="/pricing" />
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
