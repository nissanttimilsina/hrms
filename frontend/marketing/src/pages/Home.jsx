import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Container, Section, Seo, ButtonLink, Icon, Pill, CtaBand, Reveal } from '../components/core.jsx';
import { PlanCards, PlanCardsSkeleton, CycleToggle, FaqList, usePlans, useContent } from '../components/commerce.jsx';
import { HeroScene } from '../components/scene.jsx';
import { ProductTour } from '../components/tour.jsx';
import { INDUSTRIES } from '../content/industries.js';

const SWITCH = [
  ['Salaries worked out in Excel, then checked again by someone else.', 'Payroll calculates tax, SSF and unpaid days from attendance, and a second person approves it.'],
  ['A paper register at the gate and late arrivals argued over every month.', 'Phone or fingerprint clock-in, with lateness judged against each branch’s hours and grace period.'],
  ['“How much leave do I have?” asked ten times a day.', 'Every employee sees their balance, payslips and requests on their phone.'],
  ['Each branch keeps its own records; head office sees them weeks later.', 'All branches in one place, and each branch manager sees only their own people.'],
];

const NEPAL = [
  ['Bikram Sambat throughout', 'Payroll months run Baishakh to Chaitra; dates show in BS and AD.'],
  ['Income tax and SSF, kept per fiscal year', 'Tax slabs, SSF, PF and CIT are stored as rules for each year, so a new Finance Act means new settings, not new software.'],
  ['Labour Act leave, preset', 'Home, sick, maternity, paternity and mourning leave come configured, ready to adjust.'],
  ['Pay in NPR, the way you already pay', 'Invoices with 13% VAT. Pay by eSewa, Khalti or bank transfer.'],
  ['Bank sheets and statutory reports', 'Salary transfer sheets, TDS and SSF reports from every approved run.'],
];

const MONTH = [
  ['Punches and leave', 'Attendance and approved leave are recorded as the month goes.'],
  ['Calculate', 'Payable days, overtime, tax and SSF for everyone in one step.'],
  ['Check and approve', 'Anything unusual is flagged; a second person approves.'],
  ['Pay and publish', 'Bank sheet for the transfer; payslips go to every phone.'],
];

const SUITE = [
  ['Hire and onboard', 'UserPlus', [['Recruitment', 'recruitment'], ['Onboarding and exits', 'onboarding-offboarding'], ['Documents', 'document-management']]],
  ['Run the month', 'Wallet', [['Attendance and devices', 'attendance-management'], ['Leave', 'leave-management'], ['Nepal payroll', 'payroll-management'], ['Expense claims', 'expense-management']]],
  ['Grow your people', 'Target', [['Tasks and daily reports', 'task-management'], ['Performance reviews', 'performance-management'], ['Training', 'training-development'], ['Surveys and recognition', 'employee-engagement']]],
  ['Keep HR running', 'LifeBuoy', [['HR helpdesk', 'helpdesk'], ['Assets', 'asset-management'], ['Request forms', 'custom-workflows'], ['Workforce planning', 'workforce-planning']]],
];

function Announcement() {
  const { data } = useContent('ANNOUNCEMENT');
  const a = data?.[0];
  if (!a) return null;
  return (
    <Link to={a.data?.link || '/pricing'} className="mb-7 inline-flex items-center gap-2 rounded-full border border-line bg-white py-1 pl-1 pr-3 text-sm text-ink-700 hover:border-line-strong">
      <Pill>New</Pill>{a.title}<Icon name="ArrowRight" className="size-3.5 text-ink-400" />
    </Link>
  );
}

function Testimonials() {
  const { data } = useContent('TESTIMONIAL');
  if (!data?.length) return null; // only real, approved customer quotes are ever shown
  return (
    <Section title="What customers say">
      <div className="grid gap-10 md:grid-cols-3">
        {data.slice(0, 3).map((t) => (
          <figure key={t.slug}>
            <blockquote className="text-lg leading-relaxed text-ink-900">“{t.body}”</blockquote>
            <figcaption className="mt-4 text-sm"><span className="font-semibold text-ink-900">{t.title}</span>{t.data?.role && <span className="block text-ink-500">{t.data.role}{t.data.company ? `, ${t.data.company}` : ''}</span>}</figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

export default function Home() {
  const [cycle, setCycle] = useState('MONTHLY');
  const { data: plans, isPending } = usePlans();
  const maxSave = Math.max(0, ...(plans ?? []).map((p) => p.annualSavings?.percent ?? 0));

  return (
    <>
      <Seo description="HR and payroll for Nepal in one system: attendance and fingerprint devices, leave, payroll with SSF and income tax in Bikram Sambat, recruitment, onboarding, reviews, training and an app for every employee. Start a free trial." path="/" />

      {/* hero */}
      <section className="relative overflow-hidden bg-[linear-gradient(180deg,#f4f7ff_0%,#ffffff_70%)]">
        <Container className="grid grid-cols-1 items-center [&>*]:min-w-0 gap-14 pb-20 pt-12 sm:pt-16 lg:grid-cols-[1.02fr_1fr] lg:gap-10 lg:pb-28 lg:pt-20">
          <div className="scene-in" style={{ '--d': '0s' }}>
            <Announcement />
            <h1 className="text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.035em] text-ink-900 sm:text-6xl lg:text-[4.1rem]">
              HR and payroll that already know Nepal.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-700 sm:text-xl">
              Attendance, leave, payroll and everyday HR in one place, with Bikram Sambat months, SSF and tax worked out for you.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <ButtonLink to="/signup">Start free trial</ButtonLink>
              <ButtonLink to="/demo" variant="secondary">Book a demo</ButtonLink>
            </div>
            <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-500">
              {['14-day free trial', 'No card needed', 'Prices in NPR'].map((t) => <span key={t} className="inline-flex items-center gap-1.5"><Icon name="Check" className="size-3.5 text-success-600" />{t}</span>)}
            </p>
          </div>
          <HeroScene />
        </Container>
      </section>

      {/* the whole suite */}
      <section className="bg-white py-20 sm:py-28">
        <Container>
          <Reveal className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">One system, from the first interview to the last payslip</h2>
            <p className="mt-4 text-lg text-ink-700">Start with attendance and payroll. Switch on the rest when you need it.</p>
          </Reveal>
          <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
            {SUITE.map(([title, icon, items], i) => (
              <Reveal key={title} delay={i * 0.08} className="rounded-2xl border border-line bg-canvas p-6">
                <span className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name={icon} className="size-5" /></span>
                <h3 className="mt-5 font-semibold text-ink-900">{title}</h3>
                <ul className="mt-3 space-y-2">
                  {items.map(([label, slug]) => (
                    <li key={slug}><Link to={`/features/${slug}`} className="group inline-flex items-center gap-1.5 text-sm text-ink-700 hover:text-brand-700">{label}<Icon name="ArrowRight" className="size-3.5 -translate-x-1 opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" /></Link></li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
          <p className="mt-8 text-sm"><Link to="/features" className="font-medium text-brand-700 hover:text-brand-600">See every feature</Link></p>
        </Container>
      </section>

      {/* before / after */}
      <section className="border-y border-line bg-white py-20 sm:py-28">
        <Container>
          <Reveal as="h2" className="max-w-2xl text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">What changes in the first month</Reveal>
          <div className="mt-12 hidden grid-cols-2 gap-10 border-b border-line pb-3 text-sm font-medium text-ink-500 md:grid">
            <p>How it usually works</p><p className="text-brand-700">With Lishnu HRMS</p>
          </div>
          <ul>
            {SWITCH.map(([before, after], i) => (
              <Reveal as="li" delay={i * 0.06} key={before} className="grid gap-2 border-b border-line py-6 md:grid-cols-2 md:gap-10">
                <p className="text-ink-500"><span className="mb-1 block text-xs font-medium text-ink-400 md:hidden">Before</span>{before}</p>
                <p className="text-lg text-ink-900"><span className="mb-1 block text-xs font-medium text-brand-700 md:hidden">With Lishnu HRMS</span>{after}</p>
              </Reveal>
            ))}
          </ul>
        </Container>
      </section>

      {/* product tour */}
      <section className="bg-canvas py-20 sm:py-28">
        <Container>
          <Reveal className="mb-10 max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">See the screens your team will use</h2>
            <p className="mt-4 text-lg text-ink-700">Pick an area.</p>
          </Reveal>
          <ProductTour />
        </Container>
      </section>

      {/* month close: a real sequence */}
      <section className="bg-white py-20 sm:py-28">
        <Container>
          <div className="grid gap-12 lg:grid-cols-[0.9fr_1.6fr] lg:gap-16">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">How a month closes</h2>
              <p className="mt-4 text-lg text-ink-700">Nothing is typed twice. What happens at the gate during the month becomes the payslip at the end of it.</p>
              <ButtonLink to="/features/payroll-management" variant="secondary" size="md" className="mt-8">See how payroll works</ButtonLink>
            </div>
            <ol className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
              {MONTH.map(([t, dsc], i) => (
                <Reveal as="li" delay={i * 0.08} key={t} className="bg-white p-6 sm:p-8">
                  <span className="text-sm font-semibold tabular-nums text-brand-600">{i + 1}</span>
                  <p className="mt-3 text-lg font-semibold text-ink-900">{t}</p>
                  <p className="mt-1.5 text-ink-500">{dsc}</p>
                </Reveal>
              ))}
            </ol>
          </div>
        </Container>
      </section>

      {/* Nepal band */}
      <section className="grain relative overflow-hidden bg-night py-20 text-white sm:py-28">
        <Container className="grid gap-14 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
          <div>
            <p className="text-sm font-medium text-white/60">Fiscal year 2083/84 begins</p>
            <p className="mt-2 text-6xl font-semibold leading-none tracking-[-0.04em] text-marigold sm:text-7xl">Shrawan 1</p>
            <h2 className="mt-10 text-3xl font-semibold tracking-tight text-white sm:text-[2.4rem] sm:leading-[1.15]">Built for how Nepal pays people</h2>
            <p className="mt-4 max-w-md text-lg text-white/70">Not a foreign HR tool with a currency switch. The calendar, the law and the tax year are the starting point.</p>
          </div>
          <dl className="divide-y divide-white/10 border-y border-white/10">
            {NEPAL.map(([t, dsc], i) => (
              <Reveal key={t} delay={i * 0.06} className="grid gap-1 py-5 sm:grid-cols-[0.8fr_1.2fr] sm:gap-8">
                <dt className="font-semibold">{t}</dt><dd className="text-white/70">{dsc}</dd>
              </Reveal>
            ))}
          </dl>
        </Container>
      </section>

      {/* industries */}
      <section className="bg-white py-20 sm:py-24">
        <Container>
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">Set up for the way your business works</h2>
          <ul className="mt-10 flex flex-wrap gap-2.5">
            {INDUSTRIES.map((i) => (
              <li key={i.slug}>
                <Link to={`/industries/${i.slug}`} className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:border-brand-500 hover:text-brand-700">
                  <Icon name={i.icon} className="size-4 text-ink-400" />{i.name}
                </Link>
              </li>
            ))}
          </ul>
        </Container>
      </section>

      {/* pricing */}
      <section className="border-t border-line bg-canvas py-20 sm:py-28">
        <Container>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <Reveal className="max-w-xl">
              <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">Plans for 5 people or 500</h2>
              <p className="mt-4 text-lg text-ink-700">Prices in NPR before 13% VAT. Every plan starts with a free trial.</p>
            </Reveal>
            <CycleToggle cycle={cycle} setCycle={setCycle} maxSavePercent={maxSave} />
          </div>
          <div className="mt-12">{isPending || !plans ? <PlanCardsSkeleton /> : <PlanCards plans={plans} cycle={cycle} />}</div>
          <p className="mt-8 text-sm text-ink-500"><Link to="/pricing" className="font-medium text-brand-700 hover:text-brand-600">Compare every feature and estimate your price</Link></p>
        </Container>
      </section>

      <Testimonials />

      {/* FAQ */}
      <section className="bg-white py-20 sm:py-28">
        <Container className="grid gap-10 lg:grid-cols-[0.8fr_1.6fr] lg:gap-16">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">Questions people ask first</h2>
            <p className="mt-4 text-ink-700">Something else? <Link to="/contact" className="font-medium text-brand-700 hover:text-brand-600">Ask our team</Link> or read <Link to="/faq" className="font-medium text-brand-700 hover:text-brand-600">all FAQs</Link>.</p>
          </div>
          <FaqList limit={6} />
        </Container>
      </section>

      <CtaBand />
    </>
  );
}
