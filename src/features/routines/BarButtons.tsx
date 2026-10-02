import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cx } from '../../components/ui';

/** Back chevron for TopBar `left` (same look as TopBar's built-in one, but with a custom handler). */
export function BackButton({ onClick, label = 'Back' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="flex h-10 items-center pr-2 pl-1 text-accent active:opacity-60">
      <ChevronLeft className="h-7 w-7" strokeWidth={2.2} />
    </button>
  );
}

/** Plain text action for a TopBar ("Cancel", "Save", "Edit"). */
export function BarTextButton({
  onClick,
  children,
  strong,
  disabled,
  className,
}: {
  onClick: () => void;
  children: ReactNode;
  strong?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'flex h-10 items-center rounded-lg px-2.5 text-[17px] text-accent active:opacity-60 disabled:opacity-40',
        strong && 'font-semibold',
        className,
      )}
    >
      {children}
    </button>
  );
}
