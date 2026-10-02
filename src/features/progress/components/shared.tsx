import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Card, Sheet, cx } from '../../../components/ui';

/** Card with a title row (Progress tab building block). */
export function ProgressCard({
  title,
  icon,
  right,
  children,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cx('p-4', className)}>
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 className="flex min-w-0 items-center gap-2 text-[17px] font-semibold">
          {icon}
          <span className="truncate">{title}</span>
        </h2>
        {right}
      </div>
      {children}
    </Card>
  );
}

/** Floating tooltip body for Recharts charts. */
export function ChartTip({ title, value, sub }: { title: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="pointer-events-none rounded-xl border border-line bg-surface-2/95 px-3 py-2 shadow-xl backdrop-blur">
      <div className="text-[12px] font-medium text-muted">{title}</div>
      <div className="text-[15px] font-semibold tabular-nums">{value}</div>
      {sub ? <div className="text-[12px] text-muted tabular-nums">{sub}</div> : null}
    </div>
  );
}

/** Tiny trend line (oldest → newest). Draws a dot on the latest value. */
export function Sparkline({
  values,
  width = 64,
  height = 26,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const pad = 3;
  if (values.length === 0) return <div style={{ width, height }} className={className} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - pad * 2);
    const y = max === min ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1];
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const area = `${d}L${last[0].toFixed(1)} ${height}L${pts[0][0].toFixed(1)} ${height}Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx('shrink-0 overflow-visible', className)} aria-hidden>
      {pts.length > 1 ? (
        <>
          <path d={area} style={{ fill: 'var(--c-accent)', fillOpacity: 0.12 }} />
          <path d={d} style={{ fill: 'none', stroke: 'var(--c-accent)', strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
        </>
      ) : null}
      <circle cx={last[0]} cy={last[1]} r={2.8} style={{ fill: 'var(--c-accent)' }} />
    </svg>
  );
}

export interface Option<T> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
}

/** Bottom sheet with a single-choice list (iOS settings style). */
export function OptionSheet<T extends string | number>({
  open,
  onClose,
  title,
  value,
  options,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="px-3 pb-3">
        <div className="overflow-hidden rounded-2xl bg-surface-2">
          {options.map((o, i) => (
            <button
              key={String(o.value)}
              type="button"
              onClick={() => {
                onChange(o.value);
                onClose();
              }}
              className={cx(
                'flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-surface-3',
                i > 0 && 'border-t border-line',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[16px]">{o.label}</span>
                {o.hint ? <span className="block text-[13px] text-muted">{o.hint}</span> : null}
              </span>
              {o.value === value ? <Check className="h-5 w-5 shrink-0 text-accent" strokeWidth={2.6} /> : null}
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}

/** Thin horizontal meter (muscle ranking etc.). */
export function Meter({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-surface-2', className)}>
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}
