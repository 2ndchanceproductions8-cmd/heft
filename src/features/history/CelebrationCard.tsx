import { Trophy } from 'lucide-react';
import type { DistanceUnit, Unit, Workout } from '../../types';
import { Button } from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import { PR_LABEL } from '../../lib/calc';
import { formatDuration, formatVolume } from '../../lib/units';
import { formatPRValue, ordinal } from './historyUtils';

/** Shown at the top of the detail page right after finishing (?celebrate=1). */
export function CelebrationCard({
  workout,
  nth,
  unit,
  distanceUnit,
  onDone,
}: {
  workout: Workout;
  /** This workout's position in history (1-based); undefined while counting. */
  nth: number | undefined;
  unit: Unit;
  distanceUnit: DistanceUnit;
  onDone: () => void;
}) {
  const { get } = useExercises();
  const prs = workout.prs ?? [];

  return (
    <section className="relative mx-4 mt-4 animate-pop" aria-label="Workout complete">
      {/* Soft gold glow behind the card */}
      <div aria-hidden className="pointer-events-none absolute -inset-2 rounded-[30px] bg-gold-soft blur-2xl" />
      <div className="relative overflow-hidden rounded-3xl border border-gold/30 bg-surface px-5 pt-6 pb-5 text-center shadow-xl">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 left-1/2 h-48 w-64 -translate-x-1/2 rounded-full bg-gold-soft blur-3xl"
        />
        <div aria-hidden className="pointer-events-none absolute -right-16 -bottom-20 h-40 w-40 rounded-full bg-accent-soft blur-3xl" />

        <div className="relative mx-auto flex h-16 w-16 animate-pop items-center justify-center rounded-full bg-gold-soft text-gold ring-1 ring-gold/30 [animation-delay:120ms] [animation-fill-mode:both]">
          <Trophy className="h-8 w-8" strokeWidth={2.2} />
        </div>
        <h2 className="relative mt-3 text-[26px] leading-tight font-bold tracking-tight">Workout complete</h2>
        <p className="relative mt-1 min-h-[1.4em] text-[15px] text-muted">
          {nth ? (
            <>
              This was your <span className="font-semibold text-fg tabular-nums">{ordinal(nth)}</span> workout
            </>
          ) : (
            ' '
          )}
        </p>

        <div className="relative mt-5 grid grid-cols-2 gap-2">
          <MiniStat label="Duration" value={formatDuration(workout.durationSec)} />
          <MiniStat label="Volume" value={formatVolume(workout.volumeKg, unit)} />
          <MiniStat label="Sets" value={workout.setCount.toLocaleString()} />
          <MiniStat
            label="Calories"
            value={workout.calories != null ? `${Math.round(workout.calories).toLocaleString()} kcal` : '-'}
          />
        </div>

        {prs.length > 0 ? (
          <div className="relative mt-5 text-left">
            <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold tracking-wide text-gold uppercase">
              <Trophy className="h-4 w-4" />
              {prs.length === 1 ? '1 new record' : `${prs.length} new records`}
            </div>
            <ul className="space-y-1.5">
              {prs.map((pr, k) => {
                const ex = get(pr.exerciseId);
                return (
                  <li
                    key={`${pr.setId}-${pr.kind}`}
                    className="flex animate-toast items-center gap-3 rounded-xl bg-gold-soft px-3 py-2.5 [animation-fill-mode:both]"
                    style={{ animationDelay: `${200 + k * 70}ms` }}
                  >
                    <Trophy className="h-5 w-5 shrink-0 text-gold" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-semibold">{ex.name}</div>
                      <div className="text-[13px] text-muted">{PR_LABEL[pr.kind]}</div>
                    </div>
                    <div className="shrink-0 text-[15px] font-semibold text-gold tabular-nums">
                      {formatPRValue(pr.kind, pr.value, ex.type, unit, distanceUnit)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <Button block size="lg" className="relative mt-5" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="truncate text-[17px] font-semibold tabular-nums">{value}</div>
      <div className="text-[12px] font-medium text-muted">{label}</div>
    </div>
  );
}
