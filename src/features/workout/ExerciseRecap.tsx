import { useMemo } from 'react';
import { format } from 'date-fns';
import { Trophy } from 'lucide-react';
import type { ExerciseType, Settings } from '../../types';
import { compareTopSets, topSet, topSetKeys, type TopSet } from '../../lib/calc';
import { formatClock, formatDistanceForType, formatWeight } from '../../lib/units';
import { useLogger } from './LoggerContext';
import { formatSetSummary } from './logic';

/*
 * The strip under an exercise card's header: your ALL-TIME BEST (the top set: heaviest weight, more reps breaking a
 * tie — lib/calc.ts topSetKeys), and once a set is ticked today, how today's top set compares to it. Last time lives
 * in the PREVIOUS column only (Justin, 10-27: "remove best from last time. just all time high is fine"). Every
 * instance of the exercise in this workout counts toward today.
 */
export function ExerciseRecap({ exerciseId, type }: { exerciseId: string; type: ExerciseType }) {
  const { recapByExercise, exercises, settings } = useLogger();
  const recap = recapByExercise.get(exerciseId);
  const today = useMemo(
    () =>
      topSet(
        exercises.filter((e) => e.exerciseId === exerciseId).flatMap((e) => e.sets),
        type,
      ),
    [exercises, exerciseId, type],
  );
  if (!recap) return null;

  const { best } = recap;
  if (!best) {
    return <p className="mx-3 mb-1 text-[13px] text-muted">First time logging this — today sets your baseline.</p>;
  }

  const vsBest = today ? compareTopSets(today, best.top, type) : null;

  return (
    <div className="mx-3 mb-1">
      <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-2.5 py-1.5">
        <Trophy className="h-4 w-4 shrink-0 text-gold" strokeWidth={2.5} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-muted">
          ALL-TIME BEST · {format(best.date, 'MMM d, yyyy').toUpperCase()}
        </span>
        <span className="shrink-0 text-[15px] font-semibold tabular-nums">{topText(best.top, type, settings)}</span>
      </div>

      {today && vsBest != null ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] font-semibold" aria-live="polite">
          {vsBest > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-gold-soft px-2 py-0.5 text-gold">
              <Trophy className="h-3.5 w-3.5" strokeWidth={2.5} />
              New best ever
            </span>
          ) : vsBest === 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-gold-soft px-2 py-0.5 text-gold">
              <Trophy className="h-3.5 w-3.5" strokeWidth={2.5} />
              Ties your best
            </span>
          ) : (
            <span className="text-muted">{deltaText(best.top, today, type, settings, true)} to your best</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

type Units = Pick<Settings, 'unit' | 'distanceUnit'>;

/** "135 lb x 8", with the arm/leg on a per-side top set ("50 lb x 10 (L)"). */
export function topText(t: TopSet, type: ExerciseType, s: Units): string {
  const text = formatSetSummary(t, type, s.unit, s.distanceUnit);
  return t.side ? `${text} (${t.side === 'left' ? 'L' : 'R'})` : text;
}

/**
 * The difference on the first value that differs, in topSetKeys order: "+5 lb", "−2 reps", "+0:15", "+0.1 mi".
 * `unsigned` drops the sign ("5 lb to your best").
 */
export function deltaText(a: TopSet, b: TopSet, type: ExerciseType, s: Units, unsigned = false): string {
  for (const k of topSetKeys(type)) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    if (Math.abs(d) <= 1e-6) continue;
    const sign = unsigned ? '' : d > 0 ? '+' : '−';
    const v = Math.abs(d);
    switch (k) {
      case 'weightKg':
        return `${sign}${formatWeight(v, s.unit)}`;
      case 'reps':
        return `${sign}${v} ${v === 1 ? 'rep' : 'reps'}`;
      case 'durationSec':
        return `${sign}${formatClock(v)}`;
      case 'distanceM':
        return `${sign}${formatDistanceForType(v, type, s.distanceUnit)}`;
    }
  }
  return '';
}
