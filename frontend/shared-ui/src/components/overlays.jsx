import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../cn.js';
import { Button } from './primitives.jsx';

// --------------------------------------------------------------------------- Dialog
/** Accessible modal: aria-modal, labelled, Escape to close, focus moved in and restored. */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }) {
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const focusable = () => panel.current?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable()?.[0]?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key === 'Tab') {
        const els = [...(focusable() ?? [])];
        if (!els.length) return;
        const [first, last] = [els[0], els.at(-1)];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-ink-900/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dlg-title"
        aria-describedby={description ? 'dlg-desc' : undefined}
        className={cn('relative flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-xl bg-surface shadow-pop', size === 'sm' ? 'max-w-sm' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg')}
      >
        <div className={cn('shrink-0 px-6 pt-5', children ? 'pb-4' : 'pb-5', footer && children && 'border-b border-line')}>
          <h2 id="dlg-title" className="text-lg font-semibold">{title}</h2>
          {description && <p id="dlg-desc" className="mt-1 text-sm text-ink-500">{description}</p>}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>}
        {footer && <div className="flex shrink-0 justify-end gap-2 rounded-b-xl border-t border-line bg-canvas px-6 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onCancel, onConfirm, title, description, confirmLabel = 'Confirm', destructive, loading }) {
  return (
    <Dialog
      open={open} onClose={onCancel} title={title} description={description} size="sm"
      footer={(
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>Cancel</Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      )}
    />
  );
}

// --------------------------------------------------------------------------- Toasts
const ToastCtx = createContext(null);
const TOAST_TONE = {
  success: 'border-l-success-600', error: 'border-l-danger-600', info: 'border-l-brand-600', warning: 'border-l-warning-600',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, tone: 'info', ...toast }]);
    setTimeout(() => dismiss(id), toast.duration ?? 5000);
    return id;
  }, [dismiss]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={cn('pointer-events-auto rounded-md border border-line border-l-4 bg-surface p-3 shadow-pop', TOAST_TONE[t.tone])}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink-900">{t.title}</p>
                {t.message && <p className="mt-0.5 text-sm text-ink-500">{t.message}</p>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="text-ink-400 hover:text-ink-700" aria-label="Dismiss">×</button>
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => {
  const push = useContext(ToastCtx);
  if (!push) throw new Error('useToast must be used inside <ToastProvider>');
  return {
    success: (title, message) => push({ tone: 'success', title, message }),
    error: (title, message) => push({ tone: 'error', title, message }),
    info: (title, message) => push({ tone: 'info', title, message }),
    warning: (title, message) => push({ tone: 'warning', title, message }),
  };
};
