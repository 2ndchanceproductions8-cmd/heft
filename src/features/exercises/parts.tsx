import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cx } from '../../components/ui';

/**
 * Text button for sheet / top-bar headers ("Cancel", "Create", "Save"). Stops pointerdown from reaching the
 * Sheet's drag handle so the drag's pointer capture can never swallow the click.
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

/** Small uppercase label above a form section or card. */
export function SectionLabel({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-2 flex items-center justify-between', className)}>
      <span className="text-[13px] font-semibold tracking-wide text-muted uppercase">{children}</span>
      {right}
    </div>
  );
}

/** Back chevron matching TopBar's, but with a fallback route for deep links (no in-app history). */
export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Back" onClick={onClick} className="flex h-10 items-center pr-2 pl-1 text-accent active:opacity-60">
      <ChevronLeft className="h-7 w-7" strokeWidth={2.2} />
    </button>
  );
}
