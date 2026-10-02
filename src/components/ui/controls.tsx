import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { cx } from './Button';

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cx('flex rounded-xl bg-surface-2 p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex-1 rounded-[9px] px-2 py-1.5 text-[14px] font-semibold transition-colors',
            o.value === value ? 'bg-surface-3 text-fg shadow-sm' : 'text-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({
  active,
  onClick,
  children,
  className,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3.5 text-[14px] font-medium whitespace-nowrap transition-colors',
        active ? 'bg-accent text-on-accent' : 'bg-surface-2 text-fg active:bg-surface-3',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors', checked ? 'bg-success' : 'bg-surface-3')}
    >
      <span
        className={cx(
          'absolute top-[2px] left-[2px] h-[27px] w-[27px] rounded-full bg-white shadow transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </button>
  );
}

export function Field({ label, children, hint }: { label?: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      {label ? <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span> : null}
      {children}
      {hint ? <span className="mt-1 block text-[12px] text-faint">{hint}</span> : null}
    </label>
  );
}

export function TextField({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        'h-11 w-full rounded-xl border border-line bg-surface-2 px-3.5 text-fg outline-none placeholder:text-faint focus:border-accent',
        className,
      )}
    />
  );
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cx(
        'min-h-20 w-full rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-fg outline-none placeholder:text-faint focus:border-accent',
        className,
      )}
    />
  );
}

export function SelectField({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={cx('h-11 w-full appearance-none rounded-xl border border-line bg-surface-2 px-3.5 text-fg outline-none focus:border-accent', className)}
    >
      {children}
    </select>
  );
}

/** Grouped list row (settings / menus). */
export function ListRow({
  icon,
  title,
  subtitle,
  right,
  onClick,
  chevron,
  danger,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  danger?: boolean;
  className?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cx('flex w-full items-center gap-3 px-4 py-3 text-left', onClick && 'transition-colors active:bg-surface-2', className)}
    >
      {icon ? <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center', danger ? 'text-danger' : 'text-muted')}>{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className={cx('block truncate text-[16px]', danger && 'text-danger')}>{title}</span>
        {subtitle ? <span className="block truncate text-[13px] text-muted">{subtitle}</span> : null}
      </span>
      {right}
      {chevron ? <ChevronRight className="h-5 w-5 shrink-0 text-faint" /> : null}
    </Tag>
  );
}

/** Rounded group of ListRows with hairline dividers. */
export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-4 divide-y divide-line overflow-hidden rounded-2xl bg-surface', className)}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  message,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center px-8 py-12 text-center', className)}>
      {icon ? <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">{icon}</div> : null}
      <div className="text-[17px] font-semibold">{title}</div>
      {message ? <div className="mt-1 max-w-xs text-[14px] leading-snug text-muted">{message}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-6 w-6 animate-spin text-muted', className)} />;
}

/** Centered loading state for pages waiting on IndexedDB. */
export function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

/** Big stat number with a small label (workout summaries). */
export function Stat({ label, value, className }: { label: ReactNode; value: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className="truncate text-[17px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}
