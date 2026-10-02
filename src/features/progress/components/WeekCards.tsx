import { useMemo, useState, type ReactNode } from 'react';
import { addDays, format } from 'date-fns';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Dumbbell, Flame, Timer, Weight } from 'lucide-react';
import type { Settings, Workout } from '../../../types';
import { Card, Segmented, cx } from '../../../components/ui';
import { formatDuration, formatNumber, formatVolume, kgToUnit } from '../../../lib/units';
import { weekStreak, weeklyBuckets, type WeekBucket } from '../../../lib/stats';
import { compactNumber, readPref, writePref } from '../format';
import { ChartTip, ProgressCard } from './shared';

// ------------------------------------------------------------------ This week

function Tile({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
        <span className="text-accent [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
        {label}
      </div>
      <div className="mt-0.5 truncate text-[20px] leading-tight font-bold tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 truncate text-[12px] text-faint tabular-nums">{sub}</div> : null}
    </div>
  );
}

const kcal = (n: number) => `${Math.round(n).toLocaleString()} kcal`;

export function ThisWeekCard({ workouts, settings, now }: { workouts: Workout[]; settings: Settings; now: number }) {
  const { unit, weekStartsOn } = settings;
  const [last, cur] = useMemo(() => weeklyBuckets(workouts, 2, weekStartsOn, now), [workouts, weekStartsOn, now]);
  const streak = useMemo(() => weekStreak(workouts, weekStartsOn, now), [workouts, weekStartsOn, now]);
  const range = `${format(cur.weekStart, 'MMM d')} – ${format(addDays(cur.weekStart, 6), 'MMM d')}`;
  const lastWk = (s: string) => `Last week · ${s}`;

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold">This Week</h2>
          <div className="text-[13px] text-muted">{range}</div>
        </div>
        <div
          className={cx(
            'flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums',
            streak > 0 ? 'bg-gold-soft text-gold' : 'bg-surface-2 text-muted',
          )}
          title="Consecutive weeks with at least one workout"
        >
          <Flame className="h-4 w-4" fill={streak > 0 ? 'currentColor' : 'none'} strokeWidth={2} />
          {streak > 0 ? `${streak}-week streak` : 'No streak yet'}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile icon={<Dumbbell />} label="Workouts" value={cur.workouts} sub={lastWk(String(last.workouts))} />
        <Tile
          icon={<Timer />}
          label="Time"
          value={cur.durationSec ? formatDuration(cur.durationSec) : '0min'}
          sub={lastWk(last.durationSec ? formatDuration(last.durationSec) : '0min')}
        />
        <Tile
          icon={<Weight />}
          label="Volume"
          value={formatVolume(cur.volumeKg, unit)}
          sub={lastWk(formatVolume(last.volumeKg, unit))}
        />
        <Tile icon={<Flame />} label="Calories" value={kcal(cur.calories)} sub={lastWk(kcal(last.calories))} />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ Last 12 weeks

type Metric = 'workouts' | 'duration' | 'volume' | 'calories';
const METRICS: readonly Metric[] = ['workouts', 'duration', 'volume', 'calories'];
const WEEKS = 12;

function metricValue(b: WeekBucket, m: Metric, unit: Settings['unit']): number {
  switch (m) {
    case 'workouts':
      return b.workouts;
    case 'duration':
      return b.durationSec / 3600;
    case 'volume':
      return Math.round(kgToUnit(b.volumeKg, unit));
    case 'calories':
      return Math.round(b.calories);
  }
}

function formatMetricValue(v: number, m: Metric, unit: Settings['unit']): string {
  switch (m) {
    case 'workouts':
      return `${formatNumber(v, 1)} ${v === 1 ? 'workout' : 'workouts'}`;
    case 'duration':
      return v > 0 ? formatDuration(v * 3600) : '0min';
    case 'volume':
      return `${Math.round(v).toLocaleString()} ${unit}`;
    case 'calories':
      return kcal(v);
  }
}

function axisTick(v: number, m: Metric): string {
  if (m === 'duration') return `${formatNumber(v, 1)}h`;
  return compactNumber(v);
}

export function WeeklyChartCard({ workouts, settings, now }: { workouts: Workout[]; settings: Settings; now: number }) {
  const { unit, weekStartsOn } = settings;
  const [metric, setMetricState] = useState<Metric>(() => readPref('progress.metric', METRICS, 'workouts'));
  const setMetric = (m: Metric) => {
    setMetricState(m);
    writePref('progress.metric', m);
  };

  const buckets = useMemo(() => weeklyBuckets(workouts, WEEKS, weekStartsOn, now), [workouts, weekStartsOn, now]);
  const data = useMemo(
    () => buckets.map((b, i) => ({ i, weekStart: b.weekStart, value: metricValue(b, metric, unit) })),
    [buckets, metric, unit],
  );
  const total = data.reduce((s, d) => s + d.value, 0);
  const avg = total / WEEKS;
  const empty = total === 0;

  return (
    <ProgressCard title="Last 12 weeks">
      <Segmented<Metric>
        value={metric}
        onChange={setMetric}
        className="[&>button]:px-1 [&>button]:text-[13px]"
        options={[
          { value: 'workouts', label: 'Workouts' },
          { value: 'duration', label: 'Duration' },
          { value: 'volume', label: 'Volume' },
          { value: 'calories', label: 'Calories' },
        ]}
      />
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[22px] font-bold tabular-nums">{formatMetricValue(metric === 'workouts' ? Math.round(avg * 10) / 10 : avg, metric, unit)}</span>
        <span className="text-[13px] text-muted">avg / week</span>
      </div>
      <div className="relative -mx-1 mt-2 h-[190px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--c-line)" strokeDasharray="3 3" />
            <XAxis
              dataKey="i"
              interval={0}
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              tick={{ fill: 'var(--c-muted)', fontSize: 11 }}
              tickFormatter={(i: number) => ((WEEKS - 1 - i) % 3 === 0 && data[i] ? format(data[i].weekStart, 'MMM d') : '')}
            />
            <YAxis
              orientation="right"
              width={38}
              tickLine={false}
              axisLine={false}
              tickCount={4}
              allowDecimals={metric !== 'workouts'}
              tick={{ fill: 'var(--c-faint)', fontSize: 11 }}
              tickFormatter={(v: number) => axisTick(v, metric)}
            />
            <Tooltip
              cursor={{ fill: 'var(--c-surface-2)', radius: 6 }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as (typeof data)[number] | undefined;
                if (!active || !d) return null;
                const label =
                  d.i === WEEKS - 1 ? 'This week' : `Week of ${format(d.weekStart, 'MMM d')}`;
                return <ChartTip title={label} value={formatMetricValue(d.value, metric, unit)} />;
              }}
            />
            <Bar dataKey="value" fill="var(--c-accent)" radius={[6, 6, 0, 0]} maxBarSize={22} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
        {empty ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6 text-[14px] text-muted">
            No workouts in the last 12 weeks
          </div>
        ) : null}
      </div>
    </ProgressCard>
  );
}
