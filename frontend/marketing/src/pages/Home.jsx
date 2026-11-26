import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Container, Section, Seo, ButtonLink, Icon, Pill, Check, CtaBand } from '../components/core.jsx';
import { DashboardPreview, PlanCards, PlanCardsSkeleton, CycleToggle, FaqList, usePlans, useContent } from '../components/commerce.jsx';
import { FEATURES } from '../content/features.js';
import { INDUSTRIES } from '../content/industries.js';

const CHALLENGES = [
  ['Spreadsheet payroll errors', 'Tax, SSF and allowance mistakes eat hours every month and erode trust.', 'Rule-based payroll with versioned Nepal tax and SSF configuration, a preview and approval before anything is final.'],
  ['Attendance you can’t trust', 'Paper registers and WhatsApp messages make late arrivals and overtime impossible to verify.', 'Phone and web clock-in with geofencing, automatic late/overtime rules and manager-approved corrections.'],
  ['HR stuck answering questions', '“What’s my leave balance?” “Can I get my payslip?” all day long.', 'A self-service app on every employee’s phone for balances, payslips, requests and announcements.'],
  ['Branches running their own way', 'Each office keeps separate records, so head office never sees the full picture.', 'One system for all branches, with branch managers who see only their own people.'],
];

const NEPAL = [
  ['Landmark', 'Nepal income tax & TDS', 'Tax slabs, rebates and exemptions stored by fiscal year, updated without software changes.'],
  ['ShieldCheck', 'SSF, PF & CIT', 'Configurable contribution schemes for Social Security Fund, Provident Fund and CIT.'],
  ['CalendarDays', 'Bikram Sambat calendar', 'BS and AD dates, Shrawan–Ashadh fiscal year and Nepal public holidays.'],
  ['Wallet', 'NPR & local payments', 'Prices in NPR with 13% VAT invoices. Pay with eSewa, Khalti or bank transfer.'],
  ['FileText', 'Bank salary sheets', 'Generate bank transfer sheets and statutory reports from each payroll run.'],
  ['Languages', 'English & Nepali', 'Payslips and notifications in English or Nepali.'],
];

function Testimonials() {
  const { data } = useContent('TESTIMONIAL');
  if (!data?.length) return null; // only real, approved customer quotes are ever shown
  return (
    <Section eyebrow="Customers" title="What our customers say" center className="bg-white">
      <div className="grid gap-6 md:grid-cols-3">
        {data.slice(0, 3).map((t) => (
          <figure key={t.slug} className="rounded-xl border border-line bg-canvas p-6">
            <Icon name="Quote" className="size-6 text-brand-500" />
            <blockquote className="mt-3 text-ink-700">{t.body}</blockquote>
            <figcaption className="mt-4 text-sm"><span className="font-semibold text-ink-900">{t.title}</span>{t.data?.role && <span className="text-ink-500"> · {t.data.role}{t.data.company ? `, ${t.data.company}` : ''}</span>}</figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

function TrustStrip() {
  const { data } = useContent('CUSTOMER_LOGO');
  if (data?.length) {
    return (
      <Container className="py-10">
        <p className="text-center text-sm font-medium text-ink-500">Trusted by teams across Nepal</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-6">
          {data.map((l) => (l.data?.logoUrl ? <img key={l.slug} src={l.data.logoUrl} alt={l.title} className="h-8 opacity-70 grayscale" loading="lazy" /> : <span key={l.slug} className="font-semibold text-ink-500">{l.title}</span>))}
        </div>
      </Container>
    );
  }
  return (
    <Container className="py-10">
      <div className="grid grid-cols-2 gap-6 text-center md:grid-cols-4">
        {[['Built in Nepal', 'for Nepali labour & tax rules'], ['Data isolated', 'per company, at database level'], ['Mobile-first', 'self-service for every employee'], ['Free trial', 'no payment details needed']].map(([a, b]) => (
          <div key={a}><p className="font-semibold text-ink-900">{a}</p><p className="text-sm text-ink-500">{b}</p></div>
        ))}
      </div>
    </Container>
  );
}

function Announcement() {
  const { data } = useContent('ANNOUNCEMENT');
  const a = data?.[0];
  if (!a) return null;
  return (
    <Link to={a.data?.link || '/pricing'} className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-sm text-brand-700 hover:bg-brand-100">
      <Pill>New</Pill>{a.title}<Icon name="ArrowRight" className="size-4" />
    </Link>
  );
}

export default function Home() {
  const [cycle, setCycle] = useState('MONTHLY');
  const { data: plans, isPending } = usePlans();
  const maxSave = Math.max(0, ...(plans ?? []).map((p) => p.annualSavings?.percent ?? 0));
  const core = FEATURES.filter((f) => ['employee-management', 'attendance-management', 'leave-management', 'payroll-management', 'shift-management', 'employee-self-service', 'recruitment', 'performance-management', 'hr-analytics'].includes(f.slug));

  return (
    <>
      <Seo description="Manage employees, attendance, leave and Nepal payroll in one HR platform. SSF, income tax, Bikram Sambat and mobile self-service built in. Start a free trial." path="/" />

      {/* hero */}
      <section className="relative overflow-hidden border-b border-line bg-white">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[linear-gradient(180deg,var(--color-brand-50),transparent)]" />
        <Container className="relative pb-16 pt-14 text-center sm:pt-20">
          <Announcement />
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-ink-900 sm:text-6xl">One platform to manage your entire workforce.</h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-ink-500 sm:text-xl">Manage employees, attendance, payroll, recruitment and workforce operations through one intelligent, customisable HR platform built for businesses in Nepal.</p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <ButtonLink to="/signup">Get started free<Icon name="ArrowRight" className="size-4" /></ButtonLink>
            <ButtonLink to="/demo" variant="secondary">Book a demo</ButtonLink>
            <ButtonLink to="/features" variant="ghost">Explore features</ButtonLink>
          </div>
          <p className="mt-4 text-sm text-ink-500">Free trial · No payment details needed · Set up in minutes</p>
          <div className="mx-auto mt-14 max-w-5xl"><DashboardPreview /></div>
        </Container>
      </section>

      <TrustStrip />

      {/* challenges → solutions */}
      <Section eyebrow="Why teams switch" title="Stop fighting spreadsheets, registers and chat threads" intro="The HR problems growing Nepali businesses tell us about, and how we solve them." className="bg-white">
        <div className="grid gap-5 md:grid-cols-2">
          {CHALLENGES.map(([t, p, s]) => (
            <div key={t} className="rounded-xl border border-line p-6">
              <p className="flex items-center gap-2 text-sm font-semibold text-danger-600"><Icon name="AlertCircle" className="size-4" />{t}</p>
              <p className="mt-2 text-ink-500">{p}</p>
              <p className="mt-4 flex gap-2 text-ink-900"><Icon name="CheckCircle2" className="mt-0.5 size-5 shrink-0 text-success-600" />{s}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* modules */}
      <Section eyebrow="Product" title="Everything HR, in one place" intro="Turn on the modules you need today and add more as you grow.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {core.map((f) => (
            <Link key={f.slug} to={`/features/${f.slug}`} className="group rounded-xl border border-line bg-white p-6 transition hover:border-brand-200 hover:shadow-card">
              <div className="flex items-center justify-between">
                <span className="grid size-10 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon name={f.icon} /></span>
                {f.status !== 'available' && <Pill tone="soon">Coming soon</Pill>}
              </div>
              <h3 className="mt-4 font-semibold text-ink-900">{f.name}</h3>
              <p className="mt-1 text-sm text-ink-500">{f.tagline}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-brand-700 opacity-0 transition group-hover:opacity-100">Learn more <Icon name="ArrowRight" className="size-4" /></span>
            </Link>
          ))}
        </div>
        <div className="mt-8 text-center"><ButtonLink to="/features" variant="secondary" size="md">See all 20 modules</ButtonLink></div>
      </Section>

      {/* payroll & attendance showcase */}
      <Section className="bg-white">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <Pill>Payroll + Attendance</Pill>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">From clock-in to payslip, without re-typing a number</h2>
            <p className="mt-4 text-lg text-ink-500">Attendance, approved leave and overtime flow straight into payroll. Review the preview, fix anomalies, approve, and publish payslips to every employee’s phone.</p>
            <ul className="mt-6 space-y-3">
              <Check>Payable days, overtime and late deductions calculated automatically</Check>
              <Check>Income tax, SSF, PF and CIT from versioned rules</Check>
              <Check>Maker–checker approval with a complete audit trail</Check>
              <Check>Finalised payroll is never silently changed, only adjusted or reversed</Check>
            </ul>
            <div className="mt-8"><ButtonLink to="/features/payroll-management" size="md">Explore payroll</ButtonLink></div>
          </div>
          <ol className="relative space-y-4 border-l border-line pl-8">
            {[['Clock', 'Attendance captured', 'Web, phone or biometric devices'], ['CalendarDays', 'Leave approved', 'Balances and attendance update instantly'], ['Calculator', 'Payroll calculated', 'Tax, SSF and deductions applied'], ['ShieldCheck', 'Reviewed & approved', 'Anomaly checks, then sign-off'], ['Smartphone', 'Payslips published', 'Employees download on their phones']].map(([icon, t, d], i) => (
              <li key={t} className="relative rounded-xl border border-line bg-canvas p-4">
                <span className="absolute -left-[45px] top-4 grid size-8 place-items-center rounded-full border border-line bg-white text-brand-600"><Icon name={icon} className="size-4" /></span>
                <p className="text-xs font-semibold text-ink-400">STEP {i + 1}</p>
                <p className="font-semibold text-ink-900">{t}</p>
                <p className="text-sm text-ink-500">{d}</p>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* Nepal */}
      <Section eyebrow="Made for Nepal" title="Local rules, built in, not bolted on" intro="International-quality software that understands how Nepali businesses actually pay and manage people.">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {NEPAL.map(([icon, t, d]) => (
            <div key={t} className="rounded-xl border border-line bg-white p-6">
              <Icon name={icon} className="size-6 text-brand-600" />
              <h3 className="mt-3 font-semibold text-ink-900">{t}</h3>
              <p className="mt-1 text-sm text-ink-500">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* industries */}
      <Section eyebrow="Industries" title="One HRMS, configured for your industry" className="bg-white">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {INDUSTRIES.map((i) => (
            <Link key={i.slug} to={`/industries/${i.slug}`} className="flex items-center gap-3 rounded-lg border border-line p-4 text-sm font-medium text-ink-900 hover:border-brand-200 hover:bg-brand-50">
              <Icon name={i.icon} className="size-5 text-brand-600" />{i.name}
            </Link>
          ))}
        </div>
      </Section>

      {/* pricing preview */}
      <Section eyebrow="Pricing" title="Simple plans that grow with you" center>
        <div className="mb-8 flex justify-center"><CycleToggle cycle={cycle} setCycle={setCycle} maxSavePercent={maxSave} /></div>
        {isPending || !plans ? <PlanCardsSkeleton /> : <PlanCards plans={plans} cycle={cycle} />}
        <p className="mt-6 text-center text-sm text-ink-500">Prices in NPR, excluding 13% VAT. <Link to="/pricing" className="font-medium text-brand-700">Compare all features and estimate your price →</Link></p>
      </Section>

      <Testimonials />

      <Section eyebrow="FAQ" title="Questions, answered" className="bg-white">
        <div className="mx-auto max-w-3xl"><FaqList limit={6} /></div>
        <p className="mt-6 text-center"><Link to="/faq" className="text-sm font-medium text-brand-700">View all FAQs →</Link></p>
      </Section>

      <CtaBand />
    </>
  );
}
