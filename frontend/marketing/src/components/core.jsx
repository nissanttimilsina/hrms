import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ICONS } from './icons.js';
import ReactMarkdown from 'react-markdown';
import { Button, Input, cn } from '@hrms/shared-ui';
import { SITE, api } from '../lib/site.js';
import { FEATURES } from '../content/features.js';
import { INDUSTRIES } from '../content/industries.js';

export const Icon = ({ name, className = 'size-5', ...p }) => {
  const C = ICONS[name] ?? ICONS.Circle;
  return <C className={className} aria-hidden="true" {...p} />;
};

// --------------------------------------------------------------------------- motion
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Calls back once when the element first scrolls into view. Elements already on screen at load report
 * "inView" immediately, so nothing that is visible on the prerendered page ever disappears.
 */
export function useInView(ref, { margin = '0px 0px -12% 0px', play = false } = {}) {
  const [state, setState] = useState('ssr'); // ssr → (below | in)
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined' || reducedMotion()) { setState('in'); return undefined; }
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.92) {
      // `play`: content that arrives after load (e.g. plans from the API) animates even when already on screen.
      if (!play) { setState('in'); return undefined; }
      setState('below');
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setState('in')));
      return () => cancelAnimationFrame(id);
    }
    setState('below');
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setState('in'); io.disconnect(); } }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin, play]);
  return state;
}

/** Fades and lifts its content in when it scrolls into view. `delay` in seconds staggers siblings. */
export function Reveal({ as: Tag = 'div', delay = 0, play = false, className, style, children, ...rest }) {
  const ref = useRef(null);
  const v = useInView(ref, { play });
  return <Tag ref={ref} className={cn(className, v === 'below' && 'reveal-wait', v === 'in' && 'reveal-go')} style={{ ...style, '--d': `${delay}s` }} {...rest}>{children}</Tag>;
}

/**
 * A number that counts up when it scrolls into view and glides to a new value when it changes
 * (monthly ↔ annual). Server render and no-JS show the final value.
 */
export function CountUp({ value, format = (n) => String(n), duration = 900, play = false }) {
  const ref = useRef(null);
  const v = useInView(ref, { margin: '0px 0px -8% 0px', play });
  const [shown, setShown] = useState(value);
  const from = useRef(value); // the value currently on screen
  useEffect(() => {
    if (v === 'below') { from.current = 0; setShown(0); return undefined; }
    if (v !== 'in') return undefined;
    const start = from.current; // 0 if it waited below the fold, otherwise the previous price
    if (start === value || reducedMotion()) { from.current = value; setShown(value); return undefined; }
    let raf; const t0 = performance.now();
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / duration);
      const e = 1 - (1 - k) ** 3;
      const n = Math.round(start + (value - start) * e);
      setShown(n); from.current = n;
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [v, value, duration]);
  return <span ref={ref} className="tabular-nums">{format(shown)}</span>;
}

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
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    // spans the full header height so moving the pointer down to the panel never closes it
    <div className="flex h-16 items-center" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={cn('flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium transition-colors', open ? 'text-ink-900' : 'text-ink-700 hover:text-ink-900')} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {label}<Icon name="ChevronDown" className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="menu-in absolute inset-x-0 top-full z-40 border-b border-line bg-white shadow-[0_24px_48px_-24px_rgba(15,23,41,.25)]">
          <Container>{children}</Container>
        </div>
      )}
    </div>
  );
}

const MenuItem = ({ to, icon, name, text }) => (
  <Link to={to} className="group flex gap-3.5 rounded-xl p-3 transition-colors hover:bg-canvas">
    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 transition-colors group-hover:bg-brand-600 group-hover:text-white"><Icon name={icon} className="size-[18px]" /></span>
    <span className="min-w-0">
      <span className="block text-sm font-medium text-ink-900">{name}</span>
      <span className="mt-0.5 block text-[13px] leading-snug text-ink-500">{text}</span>
    </span>
  </Link>
);

function ProductMenu() {
  const live = FEATURES.filter((f) => f.status === 'available');
  const soon = FEATURES.filter((f) => f.status !== 'available');
  return (
    <div className="grid grid-cols-[1fr_17rem] gap-8 py-6">
      <div>
        <p className="px-3 text-sm text-ink-500">Available today</p>
        <div className="mt-2 grid grid-cols-2 gap-x-4">
          {live.map((f) => <MenuItem key={f.slug} to={`/features/${f.slug}`} icon={f.icon} name={f.name} text={f.tagline} />)}
        </div>
      </div>
      <div className="flex flex-col rounded-2xl bg-canvas p-5">
        <p className="text-sm text-ink-500">On the roadmap</p>
        <ul className="mt-3 space-y-2 text-sm">
          {soon.map((f) => <li key={f.slug}><Link to={`/features/${f.slug}`} className="text-ink-700 hover:text-ink-900">{f.name}</Link></li>)}
        </ul>
        <div className="mt-auto space-y-2 border-t border-line pt-4 text-sm font-medium">
          <Link to="/features" className="flex items-center gap-1.5 text-brand-700 hover:text-brand-600">All features<Icon name="ArrowRight" className="size-4" /></Link>
          <Link to="/pricing" className="flex items-center gap-1.5 text-brand-700 hover:text-brand-600">Compare plans<Icon name="ArrowRight" className="size-4" /></Link>
        </div>
      </div>
    </div>
  );
}

function IndustriesMenu() {
  return (
    <div className="py-6">
      <p className="px-3 text-sm text-ink-500">Set up for your sector</p>
      <div className="mt-2 grid grid-cols-3 gap-x-4">
        {INDUSTRIES.map((i) => <MenuItem key={i.slug} to={`/industries/${i.slug}`} icon={i.icon} name={i.name} text={i.headline} />)}
      </div>
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
          <MegaMenu label="Product"><ProductMenu /></MegaMenu>
          <MegaMenu label="Industries"><IndustriesMenu /></MegaMenu>
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
