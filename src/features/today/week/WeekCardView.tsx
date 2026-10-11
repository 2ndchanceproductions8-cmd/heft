import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { CalendarDays, Dumbbell } from 'lucide-react';
import type { Unit } from '../../../types';
import { Sheet, cx } from '../../../components/ui';
import { dayStart } from '../../../lib/nutrition/math';
import { formatDuration } from '../../../lib/units';
import { ProgressCard } from '../../progress/components/shared';
import { formatKcal } from '../../nutrition/ui';
import { dayLabel } from '../../nutrition/diary/day';
import type { WeekDay } from '../../../lib/today';
import { goalKind } from '../body/format';
import { DayDetail } from './DayDetail';
import {
  bodyWeightText,
  colPct,
  columnLabel,
  foodGeometry,
  rangeText,
  rateText,
  shortDuration,
  trendGeometry,
  weekModel,
  yPct,
  type WeekInput,
  type WeekModel,
} from './model';

/*
 * "Last 7 days": body, food and training lined up by day, today in the rightmost column. Three lanes share seven
 * columns; every column is one button (the transparent layer on top) that opens that day in a sheet. Plain
 * HTML/SVG, no Recharts (this is the landing page). The SVG stretches to the lane (preserveAspectRatio none) and
 * only draws lines, with non-scaling strokes; dots and bars are HTML positioned in percent, so they stay round.
 */

// Fixed heights so the loading skeleton takes the same room as the card (the page doesn't jump).
const HEADER_H = 44;
const LABEL_H = 20;
const LANE_GAP = 8;
const WEIGHT_H = 56;
const FOOD_H = 64;
const TRAIN_H = 48;
export const CHART_H = HEADER_H + 3 * (LANE_GAP + LABEL_H) + WEIGHT_H + FOOD_H + TRAIN_H;
/** The summary's usual height (three stats with two lines each, plus the footnote); the skeleton reserves it. */
export const SUMMARY_H = 98;

const TITLE_ICON = <CalendarDays className="h-[18px] w-[18px] text-accent" />;

/** In-progress fill (today's bar): soft tint with diagonal stripes in the text color. */
const HATCH: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 1.5px, transparent 1.5px 4.5px)',
};

export type WeekCardViewProps = WeekInput & { unit: Unit };

/** The card with its data in hand (pure: plain props; the live WeekCard reads IndexedDB and renders this). */
export function WeekCardView(props: WeekCardViewProps) {
  const { today, meals, workouts, measurements, targets, unit } = props;
  const model = useMemo(
    () => weekModel({ today, meals, workouts, measurements, targets }),
    [today, meals, workouts, measurements, targets],
  );
  const navigate = useNavigate();
  const [openDay, setOpenDay] = useState<string | null>(null);
  const selected = openDay ? (model.days.find((d) => d.day === openDay) ?? null) : null;
  const go = (to: string) => {
    setOpenDay(null);
    navigate(to);
  };

  return (
    <ProgressCard
      title="Last 7 days"
      icon={TITLE_ICON}
      right={<span className="shrink-0 text-[13px] text-muted tabular-nums">{rangeText(model.days.map((d) => d.day))}</span>}
    >
      <div className="relative isolate" style={{ height: CHART_H }} data-week-chart>
        <div aria-hidden className="pointer-events-none">
          {/* Today's column, behind everything. */}
          <div className="absolute inset-y-0 right-0 -z-10 w-[calc(100%/7)] rounded-xl bg-accent-soft/60" />
          <DayHeader days={model.days} today={today} />
          <WeightLane model={model} unit={unit} />
          <FoodLane model={model} />
          <TrainingLane model={model} />
        </div>
        <div className="absolute inset-0 z-10 grid grid-cols-7">
          {model.days.map((d) => (
            <button
              key={d.day}
              type="button"
              data-day={d.day}
              aria-label={columnLabel(d, today, unit)}
              aria-haspopup="dialog"
              onClick={() => setOpenDay(d.day)}
              className="rounded-xl transition-colors active:bg-fg/5"
            />
          ))}
        </div>
      </div>
      <Summary model={model} unit={unit} />
      <Sheet open={selected != null} onClose={() => setOpenDay(null)} title={selected ? dayLabel(selected.day, today) : undefined}>
        {selected ? (
          <DayDetail
            day={selected}
            today={today}
            unit={unit}
            targetKcal={model.targetKcal}
            targetProteinG={model.targetProteinG}
            workouts={model.workoutsByDay[selected.day] ?? []}
            onGo={go}
          />
        ) : null}
      </Sheet>
    </ProgressCard>
  );
}

/** Loading state: the card's frame at its full height. */
export function WeekCardSkeleton() {
  return (
    <ProgressCard title="Last 7 days" icon={TITLE_ICON}>
      <div data-loading className="animate-pulse" style={{ height: CHART_H }} aria-hidden>
        <div className="grid grid-cols-7" style={{ height: HEADER_H }}>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="flex items-center justify-center">
              <span className="h-6 w-6 rounded-full bg-surface-2" />
            </div>
          ))}
        </div>
        {[WEIGHT_H, FOOD_H, TRAIN_H].map((h) => (
          <div key={h} style={{ marginTop: LANE_GAP }}>
            <div className="flex items-center" style={{ height: LABEL_H }}>
              <span className="h-2.5 w-14 rounded-full bg-surface-2" />
            </div>
            <div className="rounded-xl bg-surface-2/60" style={{ height: h }} />
          </div>
        ))}
      </div>
      <div className="mt-3 border-t border-line pt-3" style={{ minHeight: SUMMARY_H }} aria-hidden>
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-surface-2" />
          ))}
        </div>
      </div>
    </ProgressCard>
  );
}

// ------------------------------------------------------------------ chart pieces

function DayHeader({ days, today }: { days: WeekDay[]; today: string }) {
  return (
    <div className="relative grid grid-cols-7" style={{ height: HEADER_H }}>
      {days.map((d) => {
        const isToday = d.day === today;
        const ms = dayStart(d.day);
        return (
          <div key={d.day} className="flex flex-col items-center justify-center gap-0.5">
            <span className={cx('text-[11px] leading-none font-semibold', isToday ? 'text-accent' : 'text-muted')}>
              {format(ms, 'EEEEE')}
            </span>
            <span
              className={cx(
                'flex h-6 w-6 items-center justify-center rounded-full text-[14px] font-semibold tabular-nums',
                isToday ? 'bg-accent text-on-accent' : 'text-fg',
              )}
            >
              {format(ms, 'd')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Lane({ label, right, height, children, name }: { label: string; right?: ReactNode; height: number; children: ReactNode; name: string }) {
  return (
    <div className="relative" style={{ marginTop: LANE_GAP }} data-lane={name}>
      <div className="flex items-center justify-between gap-2 text-[12px] leading-4" style={{ height: LABEL_H }}>
        <span className="shrink-0 font-semibold text-muted">{label}</span>
        {right ? <span className="min-w-0 truncate text-right text-muted tabular-nums">{right}</span> : null}
      </div>
      <div className="relative" style={{ height }}>
        {children}
      </div>
    </div>
  );
}

const pathOf = (pts: { i: number; kg: number }[], range: { lo: number; hi: number }) =>
  pts.map((p, k) => `${k ? 'L' : 'M'}${(colPct(p.i) * 7).toFixed(1)} ${yPct(p.kg, range).toFixed(2)}`).join(' ');

function WeightLane({ model, unit }: { model: WeekModel; unit: Unit }) {
  const geo = useMemo(() => trendGeometry(model.days, model.trendIn), [model.days, model.trendIn]);
  const right =
    model.trendKg != null ? (
      <>
        trend <span className="font-semibold text-fg">{bodyWeightText(model.trendKg, unit)}</span>
      </>
    ) : null;

  if (!model.everWeighed || !geo) {
    return (
      <Lane name="weight" label="Weight" right={right} height={WEIGHT_H}>
        <div className="absolute inset-0 flex items-center justify-center text-[13px] text-muted">No weigh-ins yet</div>
      </Lane>
    );
  }

  const { range, line, tail, dots } = geo;
  const from = line[0].i;
  const to = tail ? tail[1].i : line[line.length - 1].i;
  return (
    <Lane name="weight" label="Weight" right={right} height={WEIGHT_H}>
      <div className="absolute inset-x-0 top-1.5 bottom-1.5">
        <svg
          data-trend={`${from}-${to}`}
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox="0 0 700 100"
          preserveAspectRatio="none"
        >
          {line.length > 1 ? (
            <path
              d={pathOf(line, range)}
              className="stroke-accent"
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {tail ? (
            <path
              data-trend-tail
              d={pathOf(tail, range)}
              className="stroke-accent"
              fill="none"
              strokeWidth={2}
              strokeOpacity={0.55}
              strokeDasharray="2 5"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {dots.map((p) => (
          <span
            key={p.day}
            data-weighin={p.day}
            className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] border-accent bg-surface"
            style={{ left: `${colPct(p.i)}%`, top: `${yPct(p.kg, range)}%` }}
          />
        ))}
      </div>
      {model.weighInDays === 0 && model.lastWeighIn ? (
        <div className="absolute inset-x-0 bottom-0 text-center text-[11px] leading-none text-muted">
          Last weigh-in {dayLabel(model.lastWeighIn.day, model.today)}
        </div>
      ) : null}
    </Lane>
  );
}

function FoodLane({ model }: { model: WeekModel }) {
  const { bars, targetPct } = useMemo(
    () => foodGeometry(model.days, model.targetKcal, model.today),
    [model.days, model.targetKcal, model.today],
  );
  // With nothing logged the lane is just dashes; a lone target line over them would only be noise.
  const showTarget = model.targetKcal != null && model.loggedDays > 0;
  const parts: ReactNode[] = [];
  if (model.loggedDays === 0) parts.push('nothing logged');
  if (showTarget && model.targetKcal != null) {
    parts.push(
      <span key="t" className="inline-flex items-center gap-1">
        <span className="inline-block w-3 border-t border-dashed border-muted" />
        target <span className="font-semibold text-fg">{formatKcal(model.targetKcal)}</span>
      </span>,
    );
  }
  const right = parts.length ? (
    <>
      {parts.map((p, k) => (
        <span key={k}>
          {k ? ' · ' : ''}
          {p}
        </span>
      ))}
    </>
  ) : null;

  return (
    <Lane name="food" label="Food" right={right} height={FOOD_H}>
      {bars.map((b, i) => {
        const left = `${colPct(i)}%`;
        if (b.kind === 'none') {
          return (
            <span
              key={b.day}
              data-food-day={b.day}
              data-bar="none"
              className="absolute bottom-0 h-[3px] w-3 -translate-x-1/2 rounded-full bg-faint"
              style={{ left }}
            />
          );
        }
        const inProgress = b.kind === 'today';
        return (
          <span
            key={b.day}
            data-food-day={b.day}
            data-bar={b.kind}
            data-h={b.heightPct.toFixed(1)}
            data-over={b.overShare > 0 ? 'true' : undefined}
            className="absolute bottom-0 flex w-4 -translate-x-1/2 flex-col overflow-hidden rounded-t-[5px]"
            style={{ left, height: `${b.heightPct}%` }}
          >
            {b.overShare > 0 ? (
              <span
                data-part="over"
                className={cx('shrink-0', inProgress ? 'bg-danger-soft text-danger' : 'bg-danger')}
                style={{ height: `${b.overShare * 100}%`, ...(inProgress ? HATCH : null) }}
              />
            ) : null}
            <span
              data-part="under"
              className={cx('min-h-0 flex-1', inProgress ? 'bg-accent-soft text-accent' : 'bg-accent')}
              style={inProgress ? HATCH : undefined}
            />
          </span>
        );
      })}
      {showTarget && targetPct != null ? (
        <span
          data-target-line
          className="absolute inset-x-0 border-t border-dashed border-muted"
          style={{ bottom: `${targetPct}%` }}
        />
      ) : null}
    </Lane>
  );
}

function TrainingLane({ model }: { model: WeekModel }) {
  return (
    <Lane name="training" label="Training" right={model.workoutCount === 0 ? 'no workouts' : null} height={TRAIN_H}>
      {model.days.map((d, i) => {
        const left = `${colPct(i)}%`;
        const n = d.training.workouts;
        if (!n) {
          return (
            <span
              key={d.day}
              data-rest={d.day}
              className="absolute top-[11px] h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-faint"
              style={{ left }}
            />
          );
        }
        const time = shortDuration(d.training.durationSec);
        return (
          <span
            key={d.day}
            data-train={d.day}
            data-workouts={n}
            className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
            style={{ left }}
          >
            <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent">
              <Dumbbell className="h-3.5 w-3.5" strokeWidth={2.4} />
              {n > 1 ? (
                <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] leading-none font-bold text-on-accent tabular-nums">
                  {n}
                </span>
              ) : null}
            </span>
            {time ? <span className="mt-0.5 text-[11px] leading-4 whitespace-nowrap text-muted tabular-nums">{time}</span> : null}
          </span>
        );
      })}
    </Lane>
  );
}

// ------------------------------------------------------------------ summary

function Stat({ label, value, unit, lines, name }: { label: string; value: string; unit?: string; lines: string[]; name: string }) {
  return (
    <div className="min-w-0 px-2.5 first:pl-0 last:pr-0" data-stat={name}>
      <div className="truncate text-[12px] leading-4 font-medium text-muted">{label}</div>
      <div className="mt-0.5 truncate leading-6 tabular-nums">
        <span className="text-[18px] font-bold">{value}</span>
        {unit ? <span className="ml-1 text-[12px] font-medium text-muted">{unit}</span> : null}
      </div>
      {lines.map((l) => (
        <div key={l} className="text-[12px] leading-4 text-pretty text-muted tabular-nums">
          {l}
        </div>
      ))}
    </div>
  );
}

function Summary({ model, unit }: { model: WeekModel; unit: Unit }) {
  if (model.empty) {
    return (
      <div className="mt-3 border-t border-line pt-3">
        <p className="text-[13px] leading-snug text-muted">
          Fills in as you log meals, workouts and weigh-ins. Tap a day to see it.
        </p>
      </div>
    );
  }

  const avg = model.average;
  const todayLogged = model.days[model.days.length - 1]?.intake.logged ?? false;
  const foodLines = [
    avg ? `${avg.days} ${avg.days === 1 ? 'day' : 'days'} logged` : todayLogged ? 'only today so far' : 'nothing logged',
    model.targetKcal != null ? `target ${formatKcal(model.targetKcal)}` : 'no target set',
  ];

  const rate = model.rateKgPerWeek;
  const goal = model.goalRateKgPerWeek;
  const trendLines = [rate != null ? 'over 4 weeks' : model.everWeighed ? 'not enough weigh-ins yet' : 'no weigh-ins'];
  // The Body card's maintain band (|goal| < 0.11 kg/wk), so both cards call the same target "hold".
  if (goal != null) trendLines.push(goalKind(goal) === 'maintain' ? 'goal: hold' : `goal ${rateText(goal, unit)}/wk`);

  const n = model.workoutCount;
  return (
    <div className="mt-3 border-t border-line pt-3">
      {model.trendKg != null ? (
        // The chart is hidden from screen readers; its key number (the lane's right label) is read here.
        <p className="sr-only">Smoothed weight now {bodyWeightText(model.trendKg, unit)}.</p>
      ) : null}
      <div className="grid grid-cols-3 divide-x divide-line">
        <Stat name="food" label="Avg eaten" value={avg ? formatKcal(avg.kcal) : '—'} unit={avg ? 'kcal' : undefined} lines={foodLines} />
        <Stat
          name="trend"
          label="Weekly rate"
          value={rate != null ? rateText(rate, unit) : '—'}
          unit={rate != null ? `${unit}/wk` : undefined}
          lines={trendLines}
        />
        <Stat
          name="training"
          label="Training"
          value={String(n)}
          unit={n === 1 ? 'workout' : 'workouts'}
          lines={[n ? formatDuration(model.durationSec) : 'none this week']}
        />
      </div>
      {avg ? <p className="mt-2 text-[12px] leading-4 text-faint">The average leaves out today until it's over.</p> : null}
    </div>
  );
}
