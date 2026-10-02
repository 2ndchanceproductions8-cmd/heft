import { useId, useMemo, useState } from 'react';
import { format, subMonths, subYears } from 'date-fns';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { ExerciseType, Unit } from '../../types';
import type { ExerciseSession } from '../../lib/calc';
import { Chip, cx } from '../../components/ui';
import { useSettings } from '../../lib/settings';
import { displayDistanceAny, distanceUnitForType, formatClock, formatNumber, kgToUnit, round, type AnyDistanceUnit } from '../../lib/units';
import { METRICS, metricsFor, type MetricFormat, type MetricKey } from './stats';

type RangeKey = '3M' | '1Y' | 'All';
const RANGES: RangeKey[] = ['3M', '1Y', 'All'];

interface Point {
  date: number;
  value: number;
  workoutName: string;
}

/**
 * Canonical value (kg / s / m / reps) → number in the user's display unit. `du` is the exercise type's distance
 * unit (`distanceUnitForType`): m/yd for carries and sleds, km/mi for runs.
 */
export function toDisplay(v: number, f: MetricFormat, unit: Unit, du: AnyDistanceUnit): number {
  switch (f) {
    case 'weight':
      return round(kgToUnit(v, unit), 1);
    case 'volume':
      return Math.round(kgToUnit(v, unit));
    case 'reps':
      return Math.round(v);
    case 'duration':
      return Math.round(v);
    case 'distance':
      return displayDistanceAny(v, du) ?? 0;
  }
}

const isShortDistance = (du: AnyDistanceUnit) => du === 'm' || du === 'yd';

export function formatValue(v: number, f: MetricFormat, unit: Unit, du: AnyDistanceUnit): string {
  switch (f) {
    case 'weight':
      return `${formatNumber(v, 1)} ${unit}`;
    case 'volume':
      return `${Math.round(v).toLocaleString()} ${unit}`;
    case 'reps':
      return `${v} ${v === 1 ? 'rep' : 'reps'}`;
    case 'duration':
      return formatClock(v);
    case 'distance':
      return `${formatNumber(v, isShortDistance(du) ? 1 : 2)} ${du}`; // same rounding as displayDistanceAny
  }
}

export function formatAxis(v: number, f: MetricFormat, du: AnyDistanceUnit): string {
  switch (f) {
    case 'weight':
      return formatNumber(v, 1);
    case 'volume':
      return Math.abs(v) >= 10000 ? `${formatNumber(v / 1000, 0)}k` : Math.abs(v) >= 1000 ? `${formatNumber(v / 1000, 1)}k` : String(Math.round(v));
    case 'reps':
      return String(Math.round(v));
    case 'duration':
      return formatClock(v);
    case 'distance':
      return formatNumber(v, isShortDistance(du) ? 0 : 1);
  }
}

/** Progress chart for one exercise: metric chips (by exercise type), 3M / 1Y / All range, area line. */
export function ExerciseChart({ sessions, type }: { sessions: ExerciseSession[]; type: ExerciseType }) {
  const { unit, distanceUnit } = useSettings();
  const du = distanceUnitForType(type, distanceUnit); // m|yd for weight_distance, km|mi otherwise
  const keys = metricsFor(type);
  const [picked, setPicked] = useState<MetricKey>(keys[0]);
  const metric = keys.includes(picked) ? picked : keys[0];
  const def = METRICS[metric];
  const [rangePick, setRangePick] = useState<RangeKey | null>(null);
  const gradientId = 'g' + useId().replace(/[^a-zA-Z0-9_-]/g, '');

  // Default to the last 3 months when there's enough recent data to draw a line, else all time.
  const range: RangeKey = useMemo(() => {
    if (rangePick) return rangePick;
    const cutoff = subMonths(Date.now(), 3).getTime();
    return sessions.filter((s) => s.date >= cutoff).length >= 2 ? '3M' : 'All';
  }, [rangePick, sessions]);

  const points: Point[] = useMemo(() => {
    const cutoff = range === '3M' ? subMonths(Date.now(), 3).getTime() : range === '1Y' ? subYears(Date.now(), 1).getTime() : 0;
    return sessions
      .filter((s) => s.date >= cutoff)
      .map((s) => ({ date: s.date, value: toDisplay(def.get(s), def.format, unit, du), workoutName: s.workoutName }))
      .filter((p) => p.value > 0);
  }, [sessions, range, def, unit, du]);

  const first = points[0];
  const last = points[points.length - 1];
  const delta = first && last && points.length > 1 ? last.value - first.value : 0;
  const best = points.reduce((m, p) => Math.max(m, p.value), 0);

  const minDate = first?.date ?? 0;
  const maxDate = last?.date ?? 0;
  const pad = minDate === maxDate ? 3 * 86400000 : 0;
  const longSpan = maxDate - minDate > 300 * 86400000;

  const renderTooltip = (props: TooltipContentProps) => {
    const p = props.active ? (props.payload?.[0]?.payload as Point | undefined) : undefined;
    if (!p) return null;
    return (
      <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 shadow-lg">
        <div className="text-[12px] text-muted">{format(p.date, 'EEE, MMM d, yyyy')}</div>
        <div className="text-[15px] font-semibold tabular-nums">{formatValue(p.value, def.format, unit, du)}</div>
        <div className="max-w-40 truncate text-[12px] text-faint">{p.workoutName}</div>
      </div>
    );
  };

  return (
    <div>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-3" role="group" aria-label="Chart metric">
        {keys.map((k) => (
          <Chip key={k} active={k === metric} onClick={() => setPicked(k)}>
            {METRICS[k].label}
          </Chip>
        ))}
      </div>

      {last ? (
        <div className="flex items-end justify-between gap-3 pb-2">
          <div className="min-w-0">
            <div className="text-[26px] leading-tight font-bold tabular-nums">{formatValue(last.value, def.format, unit, du)}</div>
            <div className="text-[13px] text-muted">
              {def.label} · {format(last.date, 'MMM d')}
            </div>
          </div>
          {points.length > 1 ? (
            <div
              className={cx(
                'flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums',
                delta > 0 ? 'bg-success-soft text-success' : delta < 0 ? 'bg-danger-soft text-danger' : 'bg-surface-2 text-muted',
              )}
              title={`Change since ${format(first.date, 'MMM d, yyyy')}`}
            >
              {delta > 0 ? <TrendingUp className="h-3.5 w-3.5" /> : delta < 0 ? <TrendingDown className="h-3.5 w-3.5" /> : null}
              {delta > 0 ? '+' : delta < 0 ? '−' : '±'}
              {formatValue(Math.abs(round(delta, 2)), def.format, unit, du)}
            </div>
          ) : null}
        </div>
      ) : null}

      {points.length ? (
        <div className="-ml-1 h-[200px]" role="img" aria-label={`${def.label} over time, best ${formatValue(best, def.format, unit, du)}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={points} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--c-accent)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--c-accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--c-line)" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                type="number"
                scale="time"
                domain={[minDate - pad, maxDate + pad]}
                tickFormatter={(d: number) => format(d, longSpan ? 'MMM yy' : 'MMM d')}
                tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickMargin={8}
                minTickGap={28}
              />
              <YAxis
                width={46}
                domain={['auto', 'auto']}
                allowDecimals={def.format === 'weight' || (def.format === 'distance' && !isShortDistance(du))}
                tickFormatter={(v: number) => formatAxis(v, def.format, du)}
                tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickCount={4}
              />
              <Tooltip
                content={renderTooltip}
                cursor={{ stroke: 'var(--c-faint)', strokeWidth: 1, strokeDasharray: '3 3' }}
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--c-accent)"
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={points.length <= 40 ? { r: 3.5, fill: 'var(--c-accent)', stroke: 'var(--c-surface)', strokeWidth: 2 } : false}
                activeDot={{ r: 5.5, fill: 'var(--c-accent)', stroke: 'var(--c-surface)', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-[160px] flex-col items-center justify-center rounded-xl bg-surface-2 px-6 text-center">
          <div className="text-[15px] font-semibold">No {def.label.toLowerCase()} data {range === 'All' ? 'yet' : 'in this range'}</div>
          {range !== 'All' ? (
            <button type="button" onClick={() => setRangePick('All')} className="mt-2 text-[14px] font-semibold text-accent active:opacity-60">
              Show all time
            </button>
          ) : (
            <div className="mt-1 text-[13px] text-muted">Log sets with this value to chart it.</div>
          )}
        </div>
      )}

      <div className="mt-3 flex gap-2" role="group" aria-label="Chart range">
        {RANGES.map((r) => (
          <Chip key={r} active={r === range} onClick={() => setRangePick(r)} className="flex-1 justify-center">
            {r === 'All' ? 'All time' : r === '3M' ? '3 months' : '1 year'}
          </Chip>
        ))}
      </div>
    </div>
  );
}
