import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { cx } from './Button';

/**
 * Sticky translucent header. `title` is centered (iOS style); pass `large` to also render a big title
 * under the bar (tab root pages). `back` shows a back chevron (true = navigate(-1), string = route).
 */
export function TopBar({
  title,
  left,
  right,
  back,
  large,
  className,
  children,
}: {
  title?: ReactNode;
  left?: ReactNode;
  right?: ReactNode;
  back?: boolean | string;
  large?: boolean;
  className?: string;
  /** Extra content rendered inside the sticky bar, under the title row (search fields, tabs...). */
  children?: ReactNode;
}) {
  const nav = useNavigate();
  return (
    <header className={cx('sticky top-0 z-30 border-b border-line/60 bg-bg/85 pt-safe backdrop-blur-xl', className)}>
      <div className="relative flex h-12 items-center px-2">
        <div className="z-10 flex min-w-0 flex-1 items-center gap-1">
          {back ? (
            <button
              type="button"
              aria-label="Back"
              onClick={() => (typeof back === 'string' ? nav(back) : nav(-1))}
              className="flex h-10 items-center pr-2 pl-1 text-accent active:opacity-60"
            >
              <ChevronLeft className="h-7 w-7" strokeWidth={2.2} />
            </button>
          ) : null}
          {left}
        </div>
        {title && !large ? (
          <div className="pointer-events-none absolute inset-x-16 truncate text-center text-[17px] font-semibold">{title}</div>
        ) : null}
        <div className="z-10 flex flex-1 items-center justify-end gap-1">{right}</div>
      </div>
      {large && title ? <h1 className="px-4 pt-1 pb-2 text-[30px] leading-tight font-bold tracking-tight">{title}</h1> : null}
      {children}
    </header>
  );
}

/** Scrollable page body. `tabBar` adds bottom padding so content clears the tab bar + mini workout bar. */
export function Page({ children, className, tabBar }: { children: ReactNode; className?: string; tabBar?: boolean }) {
  return (
    <div
      className={cx('min-h-dvh bg-bg', className)}
      style={tabBar ? { paddingBottom: 'calc(env(safe-area-inset-bottom) + 140px)' } : { paddingBottom: 'calc(env(safe-area-inset-bottom) + 24px)' }}
    >
      {children}
    </div>
  );
}

/** Small uppercase section label. */
export function SectionHeader({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center justify-between px-4 pt-6 pb-2', className)}>
      <h2 className="text-[13px] font-semibold tracking-wide text-muted uppercase">{children}</h2>
      {right}
    </div>
  );
}

export function Card({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cx('block w-full rounded-2xl bg-surface text-left', onClick && 'transition-colors active:bg-surface-2', className)}
    >
      {children}
    </Tag>
  );
}
