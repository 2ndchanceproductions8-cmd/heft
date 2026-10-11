import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight, Plus, TrendingDown, TrendingUp, Weight } from 'lucide-react';
import type { Unit } from '../../../types';
import type { BodySummary } from '../../../lib/today';
import { Card, cx } from '../../../components/ui';
import { dayKey } from '../../../lib/nutrition/math';
import { kgToUnit } from '../../../lib/units';
import { relativeDay } from '../../progress/format';
import { WeightChart } from './WeightChart';
import { weightChartModel } from './chart';
import {
  bodyFatChange,
  fixed1,
  formatGoal,
  formatRate,
  onTrack,
  rateDirection,
  staleNudge,
  weighInWhen,
  weightText,
} from './format';

/*
 * Today → Body: where the scale says the owner stands. The latest weigh-in (typed in), the smoothed trend and its
 * weekly pace against the calorie target's pace, body fat, and 30 days of weigh-ins. Until today's weight is in,
 * the card ends with "Log today's weight". Tapping the big number opens the Weigh-ins sheet (every reading of the
 * last two weeks, each one deletable); the rest of the card opens Measurements. Siblings, never nested: no button
 * inside a link.
 * Pure view: everything arrives as props (BodyCard reads the data).
 */

export const MEASUREMENTS = '/progress/measurements';
/** Opens the Measurements page with the new-entry sheet already up. */
export const ADD_WEIGH_IN = '/progress/measurements?add=1';

export interface BodyCardViewProps {
  today: string;
  now: number;
  unit: Unit;
  /** bodySummary(measurements, today); undefined while the data loads. */
  summary: BodySummary | undefined;
  /** The hand-typed profile weight (Settings.bodyweightKg), shown when there are no weigh-ins. */
  profileKg: number | null;
  /** goalRateKgPerWeek(targets): the pace the calorie target is built for; null without targets. */
  goalRateKg: number | null;
  /** Opens the Weigh-ins sheet; the big number is its button. Without it the number is plain text. */
  onShowWeighIns?: () => void;
  /** Opens the new weigh-in sheet in place. Without it the log buttons link to Measurements' Add sheet. */
  onLogWeight?: () => void;
}

export function BodyCardView({
  today,
  now,
  unit,
  summary,
  profileKg,
  goalRateKg,
  onShowWeighIns,
  onLogWeight,
}: BodyCardViewProps) {
  let body: ReactNode;
  if (summary === undefined) body = <BodyLoading />;
  else if (summary.latest)
    body = (
      <BodyNormal
        today={today}
        now={now}
        unit={unit}
        summary={summary}
        goalRateKg={goalRateKg}
        onShowWeighIns={onShowWeighIns}
        onLogWeight={onLogWeight}
      />
    );
  else body = <BodyEmpty unit={unit} profileKg={profileKg} onLogWeight={onLogWeight} />;
  return <Card className="overflow-hidden">{body}</Card>;
}

// ------------------------------------------------------------------ pieces

function TitleRow({ chevron = true }: { chevron?: boolean }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <h2 className="flex min-w-0 items-center gap-2 text-[17px] font-semibold">
        <Weight className="h-[18px] w-[18px] shrink-0 text-accent" aria-hidden />
        <span className="truncate">Body</span>
      </h2>
      {chevron ? <ChevronRight className="h-5 w-5 shrink-0 text-faint" aria-hidden /> : null}
    </div>
  );
}

/** The big number: "184.2 lb". */
function BigWeight({ kg, unit }: { kg: number; unit: Unit }) {
  return (
    <div className="flex items-baseline gap-1 tabular-nums">
      <span className="text-[30px] leading-none font-bold" data-weight>
        {fixed1(kgToUnit(kg, unit))}
      </span>
      <span className="text-[15px] font-semibold text-muted">{unit}</span>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 px-3 py-2">
      <div className="truncate text-[12px] font-medium text-muted">{label}</div>
      <div className="truncate text-[17px] leading-tight font-semibold tabular-nums">{value}</div>
      {sub ? <div className="mt-0.5 truncate text-[12px] text-muted tabular-nums">{sub}</div> : null}
    </div>
  );
}

/** Weekly pace of the trend; success-coloured only when it goes where the calorie target points (never red). */
function RatePill({ rateKg, goalRateKg, unit }: { rateKg: number; goalRateKg: number | null; unit: Unit }) {
  const good = onTrack(rateKg, goalRateKg, unit);
  const dir = rateDirection(rateKg, unit);
  const Arrow = dir < 0 ? TrendingDown : dir > 0 ? TrendingUp : ArrowRight;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold whitespace-nowrap tabular-nums',
        good ? 'bg-success-soft text-success' : 'bg-surface-2 text-fg',
      )}
      data-on-track={good ? 'true' : 'false'}
    >
      <Arrow className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {formatRate(rateKg, unit)}
    </span>
  );
}

const actionLink =
  'inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-accent-soft px-4 text-[15px] font-semibold text-accent active:brightness-110';

/** A log-a-weigh-in action: opens the sheet in place (onLogWeight), else links to Measurements' Add sheet. */
function LogWeight({ onLogWeight, className, children }: { onLogWeight?: () => void; className?: string; children: ReactNode }) {
  const inner = (
    <>
      <Plus className="h-4 w-4" aria-hidden />
      {children}
    </>
  );
  return onLogWeight ? (
    <button type="button" onClick={onLogWeight} aria-haspopup="dialog" className={cx(actionLink, className)} data-action="log-weight">
      {inner}
    </button>
  ) : (
    <Link to={ADD_WEIGH_IN} className={cx(actionLink, className)} data-action="log-weight">
      {inner}
    </Link>
  );
}

// ------------------------------------------------------------------ states

function BodyLoading() {
  // Roughly the loaded card's height, so the cards below don't jump when the weigh-ins arrive.
  return (
    <div className="p-4" aria-busy="true" data-state="loading">
      <TitleRow chevron={false} />
      <div className="mt-3 h-[52px] w-36 rounded-lg bg-surface-2" />
      <div className="mt-3 h-[58px] rounded-xl bg-surface-2" />
      <div className="mt-4 h-[96px] rounded-xl bg-surface-2" />
    </div>
  );
}

function BodyEmpty({ unit, profileKg, onLogWeight }: { unit: Unit; profileKg: number | null; onLogWeight?: () => void }) {
  const hasProfile = profileKg != null && Number.isFinite(profileKg) && profileKg > 0;
  return (
    <div data-state={hasProfile ? 'profile' : 'empty'}>
      <Link to={MEASUREMENTS} className="block px-4 pt-4 pb-3 transition-colors active:bg-surface-2">
        <TitleRow />
      </Link>
      {hasProfile ? (
        <div className="flex items-end justify-between gap-3 px-4 pb-4">
          <div className="min-w-0">
            <BigWeight kg={profileKg} unit={unit} />
            <div className="mt-1.5 truncate text-[13px] text-muted">From your profile</div>
          </div>
          <LogWeight onLogWeight={onLogWeight}>Log a weigh-in</LogWeight>
        </div>
      ) : (
        <div className="px-4 pb-4">
          <p className="text-[14px] text-muted">Weigh in to start your trend.</p>
          <LogWeight onLogWeight={onLogWeight} className="mt-3">
            Add your weight
          </LogWeight>
        </div>
      )}
    </div>
  );
}

function BodyNormal({
  today,
  now,
  unit,
  summary,
  goalRateKg,
  onShowWeighIns,
  onLogWeight,
}: {
  today: string;
  now: number;
  unit: Unit;
  summary: BodySummary;
  goalRateKg: number | null;
  onShowWeighIns?: () => void;
  onLogWeight?: () => void;
}) {
  const latest = summary.latest!;
  const daysAgo = summary.daysSinceWeighIn ?? 0;
  const nudge = staleNudge(summary.daysSinceWeighIn);
  const chart = weightChartModel(summary, today, unit);
  const showTrend = summary.weighIns.length >= 2 && summary.trendKg != null;
  const fat = summary.bodyFat;
  // An older reading says when first (the 4-week change would hide that it's stale), else its 4-week change.
  const fatSub =
    fat == null
      ? null
      : dayKey(fat.at) !== latest.day
        ? relativeDay(fat.at, now)
        : summary.bodyFatRatePerWeek != null
          ? bodyFatChange(summary.bodyFatRatePerWeek)
          : null;

  const when = weighInWhen(latest.at, daysAgo, now);
  const number = (
    <>
      <BigWeight kg={latest.kg} unit={unit} />
      <div className="mt-1.5 flex min-w-0 items-center gap-0.5 text-[13px] text-muted tabular-nums">
        <span className="truncate">{when}</span>
        {onShowWeighIns ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden /> : null}
      </div>
    </>
  );
  const tap = 'transition-colors active:bg-surface-2';

  return (
    <div data-state="normal">
      <Link to={MEASUREMENTS} className={cx('block px-4 pt-4 pb-2', tap)}>
        <TitleRow />
      </Link>

      <div className="flex items-stretch">
        {onShowWeighIns ? (
          <button
            type="button"
            onClick={onShowWeighIns}
            aria-haspopup="dialog"
            className={cx('min-w-0 flex-1 py-1 pr-2 pl-4 text-left', tap)}
            data-action="weigh-ins"
          >
            {number}
            <span className="sr-only">. Show weigh-ins</span>
          </button>
        ) : (
          <div className="min-w-0 flex-1 py-1 pr-2 pl-4">{number}</div>
        )}
        <Link to={MEASUREMENTS} className={cx('flex min-w-0 flex-col items-end py-1 pr-4 pl-2 text-right', tap)}>
          {summary.rateKgPerWeek != null ? (
            <RatePill rateKg={summary.rateKgPerWeek} goalRateKg={goalRateKg} unit={unit} />
          ) : (
            <span className="py-1 text-[13px] text-muted">Not enough weigh-ins yet</span>
          )}
          {goalRateKg != null ? (
            <span className="mt-1.5 text-[12px] text-muted tabular-nums">{formatGoal(goalRateKg, unit)}</span>
          ) : null}
        </Link>
      </div>

      <Link to={MEASUREMENTS} className={cx('flow-root px-4 pb-4', tap)} data-part="details">
        {nudge ? (
          <p className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] leading-snug text-muted" data-nudge="stale">
            <Weight className="h-4 w-4 shrink-0" aria-hidden />
            <span className="min-w-0">{nudge}</span>
          </p>
        ) : null}

        {showTrend || fat ? (
          <div className={cx('mt-3 grid gap-2', showTrend && fat ? 'grid-cols-2' : 'grid-cols-1')}>
            {showTrend ? <Tile label="Trend weight" value={weightText(summary.trendKg!, unit)} /> : null}
            {fat ? <Tile label="Body fat" value={`${fixed1(fat.pct)}%`} sub={fatSub} /> : null}
          </div>
        ) : null}

        {chart ? (
          <div className="mt-4">
            <WeightChart model={chart} unit={unit} />
          </div>
        ) : nudge ? null : (
          <p className="mt-3 text-[13px] text-muted">Weigh in again to start the 30-day chart.</p>
        )}
      </Link>

      {latest.day !== today ? (
        <div className="border-t border-line px-4 pt-3 pb-4" data-part="log-today">
          <LogWeight onLogWeight={onLogWeight} className="w-full">
            Log today's weight
          </LogWeight>
        </div>
      ) : null}
    </div>
  );
}
