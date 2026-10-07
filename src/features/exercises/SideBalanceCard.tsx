import { useMemo } from 'react';
import { format } from 'date-fns';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { Exercise, Side } from '../../types';
import { sideBalance, type ExerciseSession, type SideMetric } from '../../lib/calc';
import { cx, Toggle } from '../../components/ui';
import { useSettings } from '../../lib/settings';
import { SIDE_LABEL } from '../../lib/sides';
import { distanceUnitForType, formatNumber } from '../../lib/units';
import { formatAxis, formatValue, toDisplay } from './ExerciseChart';
import type { MetricFormat } from './stats';
import { SectionLabel } from './parts';

const METRIC: Record<SideMetric, { label: string; format: MetricFormat }> = {
  best1RM: { label: 'Est. 1RM', format: 'weight' },
  heaviestKg: { label: 'Heaviest', format: 'weight' },
  maxReps: { label: 'Most reps', format: 'reps' },
  maxDuration: { label: 'Longest hold', format: 'duration' },
  maxDistance: { label: 'Longest distance', format: 'distance' },
};

/** Line colors: left = accent, right = the drop-set violet (both themed tokens). */
const COLOR: Record<Side, string> = { left: 'var(--c-accent)', right: 'var(--c-drop)' };
const TEXT: Record<Side, string> = { left: 'text-accent', right: 'text-drop' };

/** How big a left/right gap is: under 5 % reads as balanced, 10 % and over as an imbalance worth working on. */
export function gapTone(gapPct: number): { label: string; cls: string } {
  if (gapPct < 5) return { label: 'Balanced', cls: 'bg-success-soft text-success' };
  if (gapPct < 10) return { label: 'Slight gap', cls: 'bg-warn-soft text-warn' };
  return { label: 'Imbalance', cls: 'bg-danger-soft text-danger' };
}

/**
 * Left vs Right for a single-arm / single-leg exercise: the latest session's two sides on the type's metric
 * (estimated 1RM for weighted reps; reps, hold time or distance otherwise), how far apart they are, both sides
 * over time, and the switch that makes new sets log each side.
 */
export function SideBalanceCard({
  exercise,
  sessions,
  onTogglePerSide,
}: {
  exercise: Exercise;
  sessions: ExerciseSession[] | undefined;
  onTogglePerSide(next: boolean): void;
}) {
  const { unit, distanceUnit } = useSettings();
  const du = distanceUnitForType(exercise.type, distanceUnit);
  const balance = useMemo(() => (sessions ? sideBalance(sessions, exercise.type) : null), [sessions, exercise.type]);
  const m = METRIC[balance?.metric ?? 'best1RM'];
  const show = (v: number) => formatValue(toDisplay(v, m.format, unit, du), m.format, unit, du);
  const points = useMemo(
    () =>
      (balance?.points ?? []).map((p) => ({
        date: p.date,
        left: toDisplay(p.left, m.format, unit, du),
        right: toDisplay(p.right, m.format, unit, du),
      })),
    [balance, m.format, unit, du],
  );
  const last = balance?.points[balance.points.length - 1];

  const renderTooltip = (props: TooltipContentProps) => {
    const p = props.active ? (props.payload?.[0]?.payload as (typeof points)[number] | undefined) : undefined;
    if (!p) return null;
    return (
      <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 shadow-lg">
        <div className="text-[12px] text-muted">{format(p.date, 'EEE, MMM d, yyyy')}</div>
        {(['left', 'right'] as const).map((side) => (
          <div key={side} className="text-[14px] font-semibold tabular-nums">
            <span className={TEXT[side]}>{SIDE_LABEL[side]}</span> {formatValue(p[side], m.format, unit, du)}
          </div>
        ))}
      </div>
    );
  };

  const minDate = points[0]?.date ?? 0;
  const maxDate = points[points.length - 1]?.date ?? 0;
  const longSpan = maxDate - minDate > 300 * 86400000;

  return (
    <div>
      <SectionLabel>Left vs Right</SectionLabel>

      {last && balance ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            {(['left', 'right'] as const).map((side) => {
              const v = side === 'left' ? last.left : last.right;
              const weaker = balance.weaker === side;
              return (
                <div key={side} className={cx('rounded-xl px-3 py-2.5', weaker ? 'bg-surface-2' : 'bg-accent-soft')}>
                  <div className={cx('text-[12px] font-semibold tracking-wide uppercase', TEXT[side])}>{SIDE_LABEL[side]}</div>
                  <div className="text-[22px] leading-tight font-bold tabular-nums">{show(v)}</div>
                  <div className="text-[12px] text-muted tabular-nums">
                    Best {show(side === 'left' ? balance.bestLeft : balance.bestRight)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-2.5 flex items-center gap-2">
            {balance.gapPct != null ? (
              <span className={cx('shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold', gapTone(balance.gapPct).cls)}>
                {gapTone(balance.gapPct).label}
              </span>
            ) : null}
            <p className="min-w-0 text-[13px] leading-snug text-muted">
              {balance.weaker && balance.gapPct != null
                ? `${SIDE_LABEL[balance.weaker]} side is ${formatNumber(balance.gapPct, balance.gapPct < 10 ? 1 : 0)}% weaker`
                : 'Both sides match'}{' '}
              · {m.label}, {format(last.date, 'MMM d')}
            </p>
          </div>

          {points.length > 1 ? (
            <div className="mt-3 -ml-1 h-[170px]" role="img" aria-label={`${m.label}, left and right side over time`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--c-line)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    type="number"
                    scale="time"
                    domain={[minDate, maxDate]}
                    tickFormatter={(d: number) => format(d, longSpan ? 'MMM yy' : 'MMM d')}
                    tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    width={40}
                    domain={['auto', 'auto']}
                    tickFormatter={(v: number) => formatAxis(v, m.format, du)}
                    tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip content={renderTooltip} cursor={{ stroke: 'var(--c-line)' }} />
                  {(['left', 'right'] as const).map((side) => (
                    <Line
                      key={side}
                      dataKey={side}
                      name={SIDE_LABEL[side]}
                      type="monotone"
                      stroke={COLOR[side]}
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: COLOR[side], strokeWidth: 0 }}
                      activeDot={{ r: 5 }}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-[14px] leading-snug text-muted">
          {exercise.perSide
            ? 'Each set logs your left and right side. Finish a workout with this exercise to compare them.'
            : 'Single-arm or single-leg? Log each side separately to see if one side is weaker.'}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">Log left &amp; right separately</span>
          <span className="block text-[12px] text-faint">New sets get an L and an R line</span>
        </span>
        <Toggle checked={exercise.perSide} onChange={onTogglePerSide} label="Log left and right separately" />
      </div>
    </div>
  );
}
