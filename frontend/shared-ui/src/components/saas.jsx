import { useState } from 'react';
import { cn } from '../cn.js';
import { Button } from './primitives.jsx';
import { Dialog } from './overlays.jsx';
import { formatDate } from '../format.js';

/**
 * Components that speak the API's subscription contract:
 *   X-Subscription-State: FULL | GRACE | READ_ONLY
 *   error.code: LIMIT_REACHED | FEATURE_NOT_IN_PLAN | SUBSCRIPTION_INACTIVE
 */

/** Map an API error body to what the UI should do. */
export function describeApiError(body) {
  const e = body?.error ?? {};
  switch (e.code) {
    case 'LIMIT_REACHED':
      return { kind: 'upgrade', title: 'Plan limit reached', message: e.message, details: e.details };
    case 'FEATURE_NOT_IN_PLAN':
      return { kind: 'upgrade', title: 'Not included in your plan', message: e.message, details: e.details };
    case 'SUBSCRIPTION_INACTIVE':
      return { kind: 'renew', title: 'Subscription inactive', message: e.message };
    case 'VALIDATION_ERROR':
      return { kind: 'form', title: 'Please check the highlighted fields', fieldErrors: Object.fromEntries((e.details ?? []).map((d) => [d.path, d.message])) };
    case 'TOKEN_EXPIRED':
      return { kind: 'refresh' };
    case 'UNAUTHORIZED': case 'SESSION_REVOKED': case 'INVALID_TOKEN': case 'TENANT_MISMATCH':
      return { kind: 'signin', title: 'Please sign in again' };
    default:
      return { kind: 'toast', title: 'Something went wrong', message: e.message, requestId: e.requestId };
  }
}

export function UpgradePrompt({ open, onClose, title, message, onUpgrade }) {
  return (
    <Dialog
      open={open} onClose={onClose} title={title} description={message} size="sm"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Not now</Button>
          <Button onClick={onUpgrade}>View plans</Button>
        </>
      )}
    />
  );
}

/** Top-of-app banner for GRACE / READ_ONLY workspaces. Billing actions stay available. */
export function SubscriptionBanner({ state, reason, graceEndsAt, onRenew, canManageBilling }) {
  const [hidden, setHidden] = useState(false);
  if (hidden || !state || state === 'FULL') return null;
  const readOnly = state === 'READ_ONLY';
  const text = readOnly
    ? 'Your subscription has lapsed. Your data is safe and viewable, but changes are paused until you renew.'
    : reason === 'PAYMENT_PAST_DUE'
      ? 'Your last payment did not go through. Please update your payment to avoid interruption.'
      : `Your subscription has expired. You have full access during the grace period${graceEndsAt ? ` until ${formatDate(graceEndsAt)}` : ''}.`;
  return (
    <div role="status" className={cn('flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm', readOnly ? 'bg-danger-50 text-danger-700' : 'bg-warning-50 text-warning-700')}>
      <span className="flex-1">{text}</span>
      {canManageBilling ? <Button size="sm" variant={readOnly ? 'danger' : 'secondary'} onClick={onRenew}>Renew now</Button>
        : <span className="text-xs">Contact your company administrator to renew.</span>}
      {!readOnly && <button type="button" onClick={() => setHidden(true)} className="text-current/70 hover:text-current" aria-label="Dismiss">×</button>}
    </div>
  );
}

/** Application shell: left sidebar + top bar. Collapses to a drawer on mobile. */
export function AppShell({ brand, nav, activeKey, onNavigate, topbar, banner, children }) {
  const [open, setOpen] = useState(false);
  const navEl = (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-3">
      {nav.map((section) => (
        <div key={section.label ?? 'root'} className="mb-3">
          {section.label && <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{section.label}</p>}
          {section.items.map((it) => (
            <button
              key={it.key} type="button" onClick={() => { onNavigate?.(it.key); setOpen(false); }}
              aria-current={activeKey === it.key ? 'page' : undefined}
              disabled={it.locked}
              title={it.locked ? 'Not included in your plan' : undefined}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm',
                activeKey === it.key ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-700 hover:bg-subtle',
                it.locked && 'cursor-not-allowed text-ink-400 hover:bg-transparent',
              )}
            >
              {it.icon && <span className="size-4 shrink-0" aria-hidden="true">{it.icon}</span>}
              <span className="flex-1 text-left">{it.label}</span>
              {it.locked && <span className="text-[10px] font-semibold uppercase text-ink-400">Upgrade</span>}
              {it.badge}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
  return (
    <div className="flex min-h-dvh bg-canvas">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:block">
        <div className="flex h-14 items-center border-b border-line px-4">{brand}</div>
        {navEl}
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/40" onClick={() => setOpen(false)} aria-hidden="true" />
          <aside className="relative h-full w-64 bg-surface shadow-pop">{navEl}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {banner}
        <header className="flex h-14 items-center gap-3 border-b border-line bg-surface px-4">
          <button type="button" className="rounded-md p-1.5 text-ink-500 hover:bg-subtle lg:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">☰</button>
          {topbar}
        </header>
        <main className="flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

/** Applies a tenant's brand colour at runtime by overriding CSS variables. */
export function BrandProvider({ primary, children }) {
  const style = primary ? { '--color-brand-600': primary, '--color-brand-700': primary, '--color-brand-500': primary } : undefined;
  return <div style={style}>{children}</div>;
}
