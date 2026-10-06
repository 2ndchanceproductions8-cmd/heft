import { format } from 'date-fns';
import type { Unit } from '../../../types';
import { cx } from '../../../components/ui';
import { dayStart } from '../../../lib/nutrition/math';
import { CHART_DAYS, type WeightChartModel } from './chart';
import { fixed1 } from './format';

/*
 * The Body card's 30-day chart, plain SVG + HTML (no Recharts on the landing page). The trend line is an SVG path
 * stretched to the box (non-scaling stroke keeps it 2px); dots and labels are HTML placed by percentage, so they
 * stay round and crisp at any width.
 */

const PLOT_H = 76;
/** Matches the plot's inner box (inset-y-1.5): dots at the very top/bottom aren't clipped. */
const INSET_Y = 6;
const INNER_H = PLOT_H - INSET_Y * 2;
/** Min/max labels closer than this (px) are pushed apart. */
const LABEL_GAP = 13;

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function WeightChart({ model, unit }: { model: WeightChartModel; unit: Unit }) {
  const { dots, line, hi, lo, yHi, yLo, startDay } = model;
  const single = fixed1(hi) === fixed1(lo);
  let hiPos = yHi;
  let loPos = yLo;
  const minGap = LABEL_GAP / INNER_H;
  if (!single && loPos - hiPos < minGap) {
    const mid = (hiPos + loPos) / 2;
    hiPos = mid - minGap / 2;
    loPos = mid + minGap / 2;
  }
  const d = line.map((p, i) => `${i ? 'L' : 'M'}${(p.x * 100).toFixed(2)} ${(p.y * 100).toFixed(2)}`).join('');
  // Spoken range from the weigh-ins only: during a cut the trend starts above every reading in the window.
  const rHi = fixed1(model.readingHi);
  const rLo = fixed1(model.readingLo);
  const label = `Last ${CHART_DAYS} days: ${dots.length} weigh-ins, ${rHi === rLo ? rHi : `${rLo} to ${rHi}`} ${unit}`;

  return (
    <div role="img" aria-label={label} data-chart="weight-30d">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1" style={{ height: PLOT_H }}>
          <div className="absolute inset-x-1 inset-y-1.5">
            <div className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: pct(yHi) }} />
            {single ? null : <div className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: pct(yLo) }} />}
            <svg
              className="absolute inset-0 h-full w-full overflow-visible"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden
            >
              <path
                d={d}
                className="fill-none stroke-accent"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {dots.map((p, i) => (
              <span
                key={i}
                className={cx(
                  'absolute -translate-x-1/2 -translate-y-1/2 rounded-full',
                  p.latest ? 'h-2.5 w-2.5 bg-accent ring-2 ring-surface' : 'h-1.5 w-1.5 border border-accent bg-surface',
                )}
                style={{ left: pct(p.x), top: pct(p.y) }}
              />
            ))}
          </div>
        </div>
        <div className="relative w-10 shrink-0" style={{ height: PLOT_H }}>
          <div className="absolute inset-x-0 inset-y-1.5 text-[11px] leading-none text-faint tabular-nums">
            <span className="absolute right-0 -translate-y-1/2" style={{ top: pct(hiPos) }}>
              {fixed1(hi)}
            </span>
            {single ? null : (
              <span className="absolute right-0 -translate-y-1/2" style={{ top: pct(loPos) }}>
                {fixed1(lo)}
              </span>
            )}
          </div>
        </div>
      </div>
      {/* Right padding = the label column (w-10) + gap-2, left = the plot's inset, so the dates sit under the ends. */}
      <div className="mt-1 flex justify-between pr-[52px] pl-1 text-[11px] text-faint tabular-nums">
        <span>{format(dayStart(startDay), 'MMM d')}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
