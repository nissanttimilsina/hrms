import { forwardRef, useId, cloneElement, isValidElement } from 'react';
import { cn } from '../cn.js';

// --------------------------------------------------------------------------- Button
const BTN_VARIANT = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-200',
  secondary: 'bg-surface text-ink-900 border border-line-strong hover:bg-subtle disabled:text-ink-400',
  ghost: 'text-ink-700 hover:bg-subtle disabled:text-ink-400',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 disabled:opacity-50',
};
const BTN_SIZE = { sm: 'h-8 px-3 text-sm gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-11 px-5 text-base gap-2' };

export const Spinner = ({ className }) => (
  <svg className={cn('size-4 animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, icon, className, children, type = 'button', ...props }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        BTN_VARIANT[variant], BTN_SIZE[size], className,
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

// --------------------------------------------------------------------------- Form fields
/**
 * Field wires label, required marker, hint and error to its control via ids and
 * aria-describedby / aria-invalid. Pass exactly one control as the child.
 */
export function Field({ label, required, hint, error, children, className }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
      id,
      required,
      'aria-invalid': error ? true : undefined,
      'aria-describedby': [hintId, errId].filter(Boolean).join(' ') || undefined,
      invalid: !!error,
    })
    : children;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-ink-900">
          {label}
          {required && <span className="ml-0.5 text-danger-600" aria-hidden="true">*</span>}
        </label>
      )}
      {control}
      {hint && !error && <p id={hintId} className="text-xs text-ink-500">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs font-medium text-danger-600">{error}</p>}
    </div>
  );
}

const controlBase = 'w-full rounded-md border bg-surface text-sm text-ink-900 placeholder:text-ink-400 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:bg-subtle disabled:text-ink-500';
const controlState = (invalid) => (invalid ? 'border-danger-600 focus:border-danger-600' : 'border-line-strong focus:border-brand-500');

export const Input = forwardRef(function Input({ invalid, className, ...props }, ref) {
  return <input ref={ref} className={cn(controlBase, controlState(invalid), 'h-10 px-3', className)} {...props} />;
});

export const Textarea = forwardRef(function Textarea({ invalid, className, rows = 4, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(controlBase, controlState(invalid), 'px-3 py-2', className)} {...props} />;
});

export const Select = forwardRef(function Select({ invalid, className, options = [], placeholder, ...props }, ref) {
  return (
    <select ref={ref} className={cn(controlBase, controlState(invalid), 'h-10 px-3 pr-8', className)} {...props}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  );
});

export const Checkbox = forwardRef(function Checkbox({ label, className, invalid, ...props }, ref) {
  return (
    <label className={cn('inline-flex items-center gap-2 text-sm text-ink-700', className)}>
      <input ref={ref} type="checkbox" className="size-4 rounded border-line-strong accent-brand-600" {...props} />
      {label}
    </label>
  );
});

// --------------------------------------------------------------------------- Display
export const Card = ({ className, children, ...p }) => (
  <section className={cn('rounded-lg border border-line bg-surface shadow-card', className)} {...p}>{children}</section>
);
export const CardHeader = ({ title, description, actions, className }) => (
  <header className={cn('flex items-start justify-between gap-4 border-b border-line px-5 py-4', className)}>
    <div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </header>
);
export const CardBody = ({ className, children }) => <div className={cn('px-5 py-4', className)}>{children}</div>;

const BADGE = {
  neutral: 'bg-subtle text-ink-700', brand: 'bg-brand-50 text-brand-700', success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700', danger: 'bg-danger-50 text-danger-700', info: 'bg-info-50 text-info-600',
};
export const Badge = ({ tone = 'neutral', dot, className, children }) => (
  <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', BADGE[tone], className)}>
    {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
    {children}
  </span>
);

export const Skeleton = ({ className }) => <div aria-hidden="true" className={cn('animate-shimmer rounded bg-subtle', className)} />;

export function EmptyState({ icon, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-3 grid size-11 place-items-center rounded-full bg-subtle text-ink-500">{icon}</div>}
      <h4 className="text-sm font-semibold">{title}</h4>
      {description && <p className="mt-1 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, delta, tone = 'neutral', hint, loading }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      {loading ? <Skeleton className="mt-2 h-7 w-20" /> : <p className="mt-1 text-2xl font-semibold text-ink-900 tabular-nums">{value}</p>}
      {(delta || hint) && (
        <p className="mt-1 text-xs text-ink-500">
          {delta && <span className={cn('font-medium', tone === 'success' && 'text-success-600', tone === 'danger' && 'text-danger-600')}>{delta} </span>}
          {hint}
        </p>
      )}
    </Card>
  );
}
