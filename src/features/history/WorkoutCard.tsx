import { memo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parse } from 'date-fns';
import { Clock, Flame, Trophy, Weight } from 'lucide-react';
import type { DistanceUnit, Unit, Workout, WorkoutExercise } from '../../types';
import { cx } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { useExercises } from '../../lib/ExerciseProvider';
import { useMediaUrl } from '../../lib/media';
import { formatDuration, formatVolume } from '../../lib/units';
import { bestSet, doneSets, formatSetValue, formatWorkoutWhen } from './historyUtils';

const MAX_LINES = 4;

export function StatItem({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap', className)}>
      <span className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      {children}
    </span>
  );
}

/** History list card (Hevy look): title, when, stat row, first exercises with their best set, photo. */
export const WorkoutCard = memo(function WorkoutCard({
  workout,
  unit,
  distanceUnit,
  today,
}: {
  workout: Workout;
  unit: Unit;
  distanceUnit: DistanceUnit;
  /**
   * Today's day key ("2026-10-01") for the "Today" / "Yesterday" labels. A day key rather than a timestamp,
   * so the memoized card only re-renders when the date actually changes (e.g. the app wakes up the next day).
   */
  today: string;
}) {
  const photoId = workout.photoIds?.[0];
  const photo = useMediaUrl(photoId);
  const shown = workout.exercises.slice(0, MAX_LINES);
  const extra = workout.exercises.length - shown.length;
  const prCount = workout.prs?.length ?? 0;

  return (
    <Link
      to={`/history/${workout.id}`}
      className="block rounded-2xl bg-surface p-4 transition-colors active:bg-surface-2"
    >
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] leading-snug font-semibold">{workout.name || 'Workout'}</div>
          <div className="mt-0.5 text-[13px] text-muted">{formatWorkoutWhen(workout.startedAt, parse(today, 'yyyy-MM-dd', new Date()).getTime())}</div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] font-medium text-muted tabular-nums">
            <StatItem icon={<Clock />}>{formatDuration(workout.durationSec)}</StatItem>
            {workout.volumeKg > 0 ? <StatItem icon={<Weight />}>{formatVolume(workout.volumeKg, unit)}</StatItem> : null}
            {workout.calories != null && workout.calories > 0 ? (
              <StatItem icon={<Flame />}>{Math.round(workout.calories).toLocaleString()} kcal</StatItem>
            ) : null}
            {prCount > 0 ? (
              <StatItem icon={<Trophy />} className="font-semibold text-gold">
                {prCount} {prCount === 1 ? 'PR' : 'PRs'}
              </StatItem>
            ) : null}
          </div>
        </div>
        {photoId ? (
          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-surface-2">
            {photo ? <img src={photo} alt="" draggable={false} className="h-full w-full object-cover" /> : null}
          </div>
        ) : null}
      </div>

      {shown.length > 0 ? (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className="mb-1.5 flex justify-between text-[12px] font-medium text-faint">
            <span>Exercise</span>
            <span>Best set</span>
          </div>
          <div className="space-y-2">
            {shown.map((we) => (
              <ExerciseLine key={we.id} we={we} unit={unit} distanceUnit={distanceUnit} />
            ))}
          </div>
          {extra > 0 ? (
            <div className="mt-2.5 text-[13px] font-medium text-muted">
              + {extra} more {extra === 1 ? 'exercise' : 'exercises'}
            </div>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
});

function ExerciseLine({ we, unit, distanceUnit }: { we: WorkoutExercise; unit: Unit; distanceUnit: DistanceUnit }) {
  const { get } = useExercises();
  const ex = get(we.exerciseId);
  const sets = doneSets(we);
  const best = bestSet(sets, ex.type);
  return (
    <div className="flex items-center gap-2.5">
      <ExerciseThumb exercise={ex} size={28} />
      <span className="min-w-0 flex-1 truncate text-[14px]">
        <span className="text-muted tabular-nums">{sets.length} x </span>
        <span className={ex.missing ? 'text-muted' : undefined}>{ex.name}</span>
      </span>
      <span className="shrink-0 text-[14px] text-muted tabular-nums">
        {best ? formatSetValue(best, ex.type, unit, distanceUnit) : '-'}
      </span>
    </div>
  );
}
