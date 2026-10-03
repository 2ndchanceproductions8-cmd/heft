import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cx } from '../../../components/ui';

/**
 * Text button for top-bar / sheet headers ("Cancel"). Stops pointerdown from reaching a Sheet's drag handle
 * so the drag's pointer capture can never swallow the click.
 */
export function HeaderButton({
  children,
  bold,
  className,
  onPointerDown,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { bold?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e);
      }}
      className={cx(
        'flex h-10 items-center rounded-lg px-2 text-[16px] text-accent transition-opacity active:opacity-50 disabled:opacity-40',
        bold && 'font-semibold',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Back chevron matching TopBar's, with a custom handler (flush edits, pick the destination). */
export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="flex h-10 items-center pr-2 pl-1 text-accent active:opacity-60">
      <ChevronLeft className="h-7 w-7" strokeWidth={2.2} />
    </button>
  );
}

/** Rounded notice card (tone = semantic color family). */
export function Notice({
  tone = 'accent',
  icon,
  title,
  children,
  actions,
  className,
}: {
  tone?: 'accent' | 'warn' | 'danger';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const TONE = {
    accent: 'bg-accent-soft text-accent',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
  } as const;
  return (
    <div className={cx('rounded-2xl bg-surface p-4', className)}>
      <div className="flex gap-3">
        {icon ? <div className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', TONE[tone])}>{icon}</div> : null}
        <div className="min-w-0 flex-1">
          {title ? <div className="text-[16px] font-semibold">{title}</div> : null}
          {children ? <div className={cx('text-[14px] leading-snug text-muted', !!title && 'mt-0.5')}>{children}</div> : null}
        </div>
      </div>
      {actions ? <div className="mt-3 flex flex-col gap-2">{actions}</div> : null}
    </div>
  );
}
