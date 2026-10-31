import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{title}</h2>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'good' | 'warn' | 'bad' }) {
  const toneClass = {
    default: 'text-slate-900 dark:text-slate-50',
    good: 'text-emerald-600 dark:text-emerald-400',
    warn: 'text-amber-600 dark:text-amber-400',
    bad: 'text-rose-600 dark:text-rose-400',
  }[tone];
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className={cx('tabular mt-1 break-words text-lg font-semibold sm:text-2xl', toneClass)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

const BADGE_TONES: Record<string, string> = {
  succeeded: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  processed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  healthy: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  completed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  initiated: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  queued: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  received: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  running: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  probing: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  created: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  expired: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  error: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  rejected: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
  degraded: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
};

export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', BADGE_TONES[value] ?? BADGE_TONES.created)}>
      {children ?? value.replaceAll('_', ' ')}
    </span>
  );
}

export function Button({ variant = 'primary', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300 dark:disabled:bg-indigo-900',
    secondary:
      'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700',
    danger: 'bg-rose-600 text-white hover:bg-rose-500',
  }[variant];
  return (
    <button
      {...props}
      className={cx('inline-flex items-center justify-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed', styles, className)}
    />
  );
}

export const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900';

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}
