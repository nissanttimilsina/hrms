import { createContext, useContext, useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ICONS } from './icons.js';
import ReactMarkdown from 'react-markdown';
import { Button, Input, cn } from '@hrms/shared-ui';
import { SITE, api } from '../lib/site.js';
import { FEATURES, FEATURE_CATEGORIES } from '../content/features.js';
import { INDUSTRIES } from '../content/industries.js';

export const Icon = ({ name, className = 'size-5', ...p }) => {
  const C = ICONS[name] ?? ICONS.Circle;
  return <C className={className} aria-hidden="true" {...p} />;
};

// --------------------------------------------------------------------------- SEO (works in prerender + browser)
export const HeadContext = createContext(null);
export function Seo({ title, description, path, image, noindex }) {
  const fullTitle = title ? `${title} | ${SITE.name}` : `${SITE.name} — HR, Attendance & Payroll Software for Nepal`;
  const url = `${SITE.url}${path ?? ''}`;
  const head = useContext(HeadContext);
  if (head) Object.assign(head, { title: fullTitle, description, url, image, noindex }); // server render
  useEffect(() => {
    document.title = fullTitle;
    const set = (sel, attr, key, value) => {
      if (!value) return;
      let el = document.head.querySelector(sel);
      if (!el) { el = document.createElement(sel.startsWith('link') ? 'link' : 'meta'); el.setAttribute(attr, key); document.head.appendChild(el); }
      el.setAttribute(sel.startsWith('link') ? 'href' : 'content', value);
    };
    set('meta[name="description"]', 'name', 'description', description);
    set('meta[property="og:title"]', 'property', 'og:title', fullTitle);
    set('meta[property="og:description"]', 'property', 'og:description', description);
    set('meta[property="og:url"]', 'property', 'og:url', url);
    set('link[rel="canonical"]', 'rel', 'canonical', url);
    set('meta[name="robots"]', 'name', 'robots', noindex ? 'noindex' : 'index,follow');
  }, [fullTitle, description, url, noindex]);
  return null;
}

export function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

// --------------------------------------------------------------------------- layout primitives
export const Container = ({ className, children }) => <div className={cn('mx-auto w-full max-w-6xl px-5 sm:px-8', className)}>{children}</div>;

export function Section({ eyebrow, title, intro, center, className, children, id }) {
  return (
    <section id={id} className={cn('py-16 sm:py-24', className)}>
      <Container>
        {(eyebrow || title) && (
          <div className={cn('mb-10 max-w-2xl sm:mb-14', center && 'mx-auto text-center')}>
            {eyebrow && <p className="text-sm font-medium text-brand-700">{eyebrow}</p>}
            {title && <h2 className="mt-2 text-3xl font-semibold tracking-tight text-ink-900 sm:text-[2.6rem] sm:leading-[1.1]">{title}</h2>}
            {intro && <p className="mt-4 text-lg text-ink-700">{intro}</p>}
          </div>
        )}
        {children}
      </Container>
    </section>
  );
}

export const ButtonLink = ({ to, variant = 'primary', size = 'lg', className, children, external }) => {
  const cls = cn('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
    size === 'lg' ? 'h-12 px-6 text-base' : 'h-10 px-4 text-sm',
    variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
    variant === 'secondary' && 'border border-line-strong bg-surface text-ink-900 hover:bg-subtle',
    variant === 'ghost' && 'text-ink-700 hover:bg-subtle',
    variant === 'inverse' && 'bg-white text-brand-700 hover:bg-brand-50', className);
  return external ? <a href={to} className={cls}>{children}</a> : <Link to={to} className={cls}>{children}</Link>;
};

export const Pill = ({ children, tone = 'brand' }) => (
  <span className={cn('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold',
    tone === 'brand' && 'bg-brand-50 text-brand-700', tone === 'muted' && 'bg-subtle text-ink-500', tone === 'soon' && 'bg-warning-50 text-warning-700')}>{children}</span>
);

export const Check = ({ children, className }) => (
  <li className={cn('flex gap-2.5 text-ink-700', className)}>
    <Icon name="Check" className="mt-0.5 size-4 shrink-0 text-success-600" />
    <span>{children}</span>
  </li>
);

/** Markdown from the CMS. react-markdown does not render raw HTML, so CMS content cannot inject scripts. */
export const Markdown = ({ children }) => (
  <div className="prose-hrms">
    <ReactMarkdown components={{ a: ({ href, children: c }) => <a href={href} rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}>{c}</a> }}>{children || ''}</ReactMarkdown>
  </div>
);

// --------------------------------------------------------------------------- header
function MegaMenu({ label, children }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-ink-700 hover:text-ink-900" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}<Icon name="ChevronDown" className="size-4" />
      </button>
      {open && <div className="absolute left-1/2 top-full z-40 -translate-x-1/2 pt-2">{children}</div>}
    </div>
  );
}

export function Header() {
  const [mobile, setMobile] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setMobile(false), [pathname]);
  const navCls = ({ isActive }) => cn('rounded-md px-3 py-2 text-sm font-medium', isActive ? 'text-brand-700' : 'text-ink-700 hover:text-ink-900');
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-white/90 backdrop-blur">
      <Container className="flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-semibold text-ink-900" aria-label={`${SITE.name} home`}>
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white"><Icon name="Users" className="size-4.5" /></span>
          {SITE.name}
        </Link>
        <nav className="hidden items-center lg:flex" aria-label="Main">
          <MegaMenu label="Product">
            <div className="grid w-[720px] grid-cols-3 gap-1 rounded-xl border border-line bg-white p-4 shadow-pop">
              {FEATURE_CATEGORIES.map((cat) => (
                <div key={cat} className="p-2">
                  <p className="mb-1 px-2 text-xs font-medium text-ink-400">{cat}</p>
                  {FEATURES.filter((f) => f.category === cat).map((f) => (
                    <Link key={f.slug} to={`/features/${f.slug}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-700 hover:bg-subtle">
                      <Icon name={f.icon} className="size-4 text-brand-600" />{f.name}
                    </Link>
                  ))}
                </div>
              ))}
              <Link to="/features" className="col-span-3 mt-1 rounded-md bg-subtle px-3 py-2 text-sm font-medium text-brand-700">See all features →</Link>
            </div>
          </MegaMenu>
          <MegaMenu label="Industries">
            <div className="grid w-[520px] grid-cols-2 gap-1 rounded-xl border border-line bg-white p-3 shadow-pop">
              {INDUSTRIES.map((i) => (
                <Link key={i.slug} to={`/industries/${i.slug}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-700 hover:bg-subtle">
                  <Icon name={i.icon} className="size-4 text-brand-600" />{i.name}
                </Link>
              ))}
            </div>
          </MegaMenu>
          <NavLink to="/pricing" className={navCls}>Pricing</NavLink>
          <NavLink to="/customers" className={navCls}>Customers</NavLink>
          <NavLink to="/resources" className={navCls}>Resources</NavLink>
        </nav>
        <div className="hidden items-center gap-2 lg:flex">
          <ButtonLink to="/login" variant="ghost" size="md">Sign in</ButtonLink>
          <ButtonLink to="/demo" variant="secondary" size="md">Book a demo</ButtonLink>
          <ButtonLink to="/signup" size="md">Start free trial</ButtonLink>
        </div>
        <button type="button" className="rounded-md p-2 text-ink-700 lg:hidden" onClick={() => setMobile((m) => !m)} aria-label="Menu" aria-expanded={mobile}>
          <Icon name={mobile ? 'X' : 'Menu'} />
        </button>
      </Container>
      {mobile && (
        <div className="border-t border-line bg-white lg:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {[['/features', 'Features'], ['/industries', 'Industries'], ['/pricing', 'Pricing'], ['/customers', 'Customers'], ['/resources', 'Resources'], ['/about', 'About'], ['/contact', 'Contact'], ['/login', 'Sign in']].map(([to, l]) => (
              <Link key={to} to={to} className="rounded-md px-2 py-2 text-ink-700 hover:bg-subtle">{l}</Link>
            ))}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <ButtonLink to="/demo" variant="secondary" size="md">Book a demo</ButtonLink>
              <ButtonLink to="/signup" size="md">Start free trial</ButtonLink>
            </div>
          </Container>
        </div>
      )}
    </header>
  );
}

// --------------------------------------------------------------------------- footer
function Newsletter() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState('idle');
  const submit = async (e) => {
    e.preventDefault();
    setState('loading');
    try { await api.post('/newsletter', { email }); setState('done'); } catch { setState('error'); }
  };
  if (state === 'done') return <p className="text-sm text-success-700">Thanks. You're subscribed to product updates.</p>;
  return (
    <form onSubmit={submit} className="flex gap-2" aria-label="Newsletter">
      <label htmlFor="nl-email" className="sr-only">Work email</label>
      <Input id="nl-email" type="email" required placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Button type="submit" loading={state === 'loading'}>Subscribe</Button>
      {state === 'error' && <span role="alert" className="sr-only">Subscription failed</span>}
    </form>
  );
}

export function Footer() {
  const cols = [
    ['Product', [['/features', 'All features'], ['/features/payroll-management', 'Payroll'], ['/features/attendance-management', 'Attendance'], ['/features/leave-management', 'Leave'], ['/features/employee-self-service', 'Self-service app'], ['/pricing', 'Pricing'], ['/changelog', 'Changelog']]],
    ['Solutions', INDUSTRIES.slice(0, 7).map((i) => [`/industries/${i.slug}`, i.name])],
    ['Resources', [['/blog', 'Blog'], ['/resources', 'HR guides'], ['/faq', 'FAQ'], ['/help', 'Help center'], ['/status', 'System status'], ['/security', 'Security']]],
    ['Company', [['/about', 'About us'], ['/customers', 'Customer stories'], ['/contact', 'Contact'], ['/demo', 'Book a demo'], ['/privacy', 'Privacy policy'], ['/terms', 'Terms of service']]],
  ];
  return (
    <footer className="border-t border-line bg-white">
      <Container className="grid gap-10 py-14 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="space-y-4">
          <Link to="/" className="flex items-center gap-2 font-semibold text-ink-900">
            <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white"><Icon name="Users" className="size-4.5" /></span>{SITE.name}
          </Link>
          <p className="max-w-xs text-sm text-ink-500">HR, attendance and payroll software for businesses in Nepal, with Nepal tax, SSF and the Bikram Sambat calendar built in.</p>
          <div className="max-w-sm"><p className="mb-2 text-sm font-medium text-ink-900">Product updates</p><Newsletter /></div>
        </div>
        {cols.map(([title, links]) => (
          <div key={title}>
            <p className="text-sm font-semibold text-ink-900">{title}</p>
            <ul className="mt-3 space-y-2">{links.map(([to, l]) => <li key={to}><Link to={to} className="text-sm text-ink-500 hover:text-ink-900">{l}</Link></li>)}</ul>
          </div>
        ))}
      </Container>
      <div className="border-t border-line">
        <Container className="flex flex-col justify-between gap-2 py-6 text-sm text-ink-500 sm:flex-row">
          <p>© {new Date().getFullYear()} {SITE.company}. All rights reserved.</p>
          <p>{SITE.address} · <a href={`mailto:${SITE.email}`} className="hover:text-ink-900">{SITE.email}</a></p>
        </Container>
      </div>
    </footer>
  );
}

export function CtaBand({ title = 'Run next month’s payroll on Lishnu HRMS', text = 'Set up your company, add your people and try every feature free. No payment details needed.' }) {
  return (
    <section className="grain bg-night text-white">
      <Container className="flex flex-col gap-8 py-16 sm:py-20 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-[2.6rem] sm:leading-[1.1]">{title}</h2>
          <p className="mt-4 text-lg text-white/70">{text}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
          <ButtonLink to="/signup" variant="inverse">Start free trial</ButtonLink>
          <ButtonLink to="/demo" variant="secondary" className="border-white/25 bg-transparent text-white hover:bg-white/10">Book a demo</ButtonLink>
        </div>
      </Container>
    </section>
  );
}
