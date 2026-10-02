import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ChevronRight, Trophy } from 'lucide-react';
import type { DistanceUnit, Exercise, ExerciseType, PRKind, Unit, Workout } from '../../types';
import { Card, EmptyState, Stat } from '../../components/ui';
import { PR_LABEL, estimate1RM, exerciseSessions, prKindsFor, repRecords } from '../../lib/calc';
import { typeFields } from '../../lib/exerciseMeta';
import { useSettings } from '../../lib/settings';
import { formatDistanceForType, formatDuration, formatVolume, formatWeight } from '../../lib/units';
import { formatEstWeight, formatSetValue } from './format';
import { SectionLabel } from './parts';
import { lifetimeTotals, personalRecords } from './stats';

function formatRecord(kind: PRKind, value: number, type: ExerciseType, unit: Unit, du: DistanceUnit, weightSign = ''): string {
  switch (kind) {
    case 'heaviest_weight':
      return weightSign + formatWeight(value, unit);
    case 'best_1rm':
      return formatEstWeight(value, unit);
    case 'best_set_volume':
      return formatVolume(value, unit);
    case 'most_reps':
      return `${value} ${value === 1 ? 'rep' : 'reps'}`;
    case 'longest_duration':
      return formatDuration(value);
    case 'longest_distance':
      return formatDistanceForType(value, type, du); // "40 yd" for a carry, "5 km" for a run
  }
}

/** Personal records, Hevy's "Set Records" (best weight per rep count) and lifetime totals. */
export function RecordsTab({ exercise, workouts }: { exercise: Exercise; workouts: Workout[] }) {
  const nav = useNavigate();
  const { unit, distanceUnit } = useSettings();
  const type = exercise.type;
  const f = typeFields(type);

  const records = useMemo(() => personalRecords(workouts, exercise.id, type), [workouts, exercise.id, type]);
  const sessions = useMemo(() => exerciseSessions(workouts, exercise.id, type), [workouts, exercise.id, type]);
  const totals = useMemo(() => lifetimeTotals(sessions), [sessions]);
  const showRepTable = type === 'weight_reps' || type === 'weighted_bodyweight';
  const reps = useMemo(() => (showRepTable ? repRecords(workouts, exercise.id) : []), [showRepTable, workouts, exercise.id]);

  if (!sessions.length) {
    return (
      <EmptyState
        icon={<Trophy className="h-7 w-7" />}
        title="No records yet"
        message="Log this exercise and your personal records — heaviest weight, best 1RM, most reps — appear here."
      />
    );
  }

  const stats: { label: string; value: string }[] = [
    { label: 'Workouts', value: totals.sessions.toLocaleString() },
    { label: 'Sets', value: totals.sets.toLocaleString() },
  ];
  if (f.reps) stats.push({ label: 'Reps', value: totals.reps.toLocaleString() });
  if (type === 'weight_reps' || type === 'weighted_bodyweight') stats.push({ label: 'Volume', value: formatVolume(totals.volumeKg, unit) });
  if (f.duration) stats.push({ label: 'Total Time', value: formatDuration(totals.durationSec) });
  if (f.distance) stats.push({ label: 'Distance', value: formatDistanceForType(totals.distanceM, type, distanceUnit) });

  return (
    <div className="space-y-6 px-4 pt-4">
      <section>
        <SectionLabel>Personal Records</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          {prKindsFor(type).map((kind) => {
            const r = records.find((x) => x.kind === kind);
            if (!r) {
              return (
                <Card key={kind} className="p-3.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-faint">
                    <Trophy className="h-3.5 w-3.5" />
                    <span className="truncate">{PR_LABEL[kind]}</span>
                  </div>
                  <div className="mt-1 text-[20px] leading-tight font-bold text-faint">–</div>
                  <div className="mt-1 text-[12px] text-faint">Not set yet</div>
                </Card>
              );
            }
            return (
              <Card key={kind} onClick={() => nav(`/history/${r.workoutId}`)} className="p-3.5">
                <div className="flex items-center gap-1.5 text-[12px] font-semibold text-gold">
                  <Trophy className="h-3.5 w-3.5" />
                  <span className="truncate">{PR_LABEL[kind]}</span>
                </div>
                <div className="mt-1 truncate text-[20px] leading-tight font-bold tabular-nums">
                  {formatRecord(kind, r.value, type, unit, distanceUnit, f.weightSign)}
                </div>
                {kind === 'best_1rm' || kind === 'best_set_volume' ? (
                  <div className="truncate text-[13px] text-muted tabular-nums">{formatSetValue(r.set, type, unit, distanceUnit)}</div>
                ) : null}
                <div className="mt-1 flex items-center gap-0.5 text-[12px] text-faint">
                  <span className="truncate">{format(r.date, 'MMM d, yyyy')}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {showRepTable && reps.length ? (
        <section>
          <SectionLabel>Set Records</SectionLabel>
          <Card className="overflow-hidden">
            <div className="grid grid-cols-[3.5rem_1fr_1fr_1.25rem] items-center gap-2 border-b border-line px-4 py-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
              <span>Reps</span>
              <span>Best Weight</span>
              <span>Est. 1RM</span>
              <span />
            </div>
            {reps.map((r) => (
              <button
                key={r.reps}
                type="button"
                onClick={() => nav(`/history/${r.workoutId}`)}
                className="grid w-full grid-cols-[3.5rem_1fr_1fr_1.25rem] items-center gap-2 border-b border-line/60 px-4 py-2.5 text-left text-[15px] tabular-nums transition-colors last:border-b-0 active:bg-surface-2"
              >
                <span className="font-semibold">{r.reps >= 15 ? '15+' : r.reps}</span>
                <span>
                  <span className="block">
                    {type === 'weighted_bodyweight' ? '+' : ''}
                    {formatWeight(r.weightKg, unit)}
                  </span>
                  <span className="block text-[12px] text-faint">{format(r.date, 'MMM d, yyyy')}</span>
                </span>
                <span className="text-muted">{formatEstWeight(estimate1RM(r.weightKg, r.reps), unit)}</span>
                <ChevronRight className="h-4 w-4 text-faint" />
              </button>
            ))}
          </Card>
        </section>
      ) : null}

      <section>
        <SectionLabel>Lifetime</SectionLabel>
        <Card className="p-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {stats.map((s) => (
              <Stat key={s.label} label={s.label} value={s.value} />
            ))}
            <Stat label="First Logged" value={format(sessions[0].date, 'MMM d, yyyy')} />
            <Stat label="Last Logged" value={format(sessions[sessions.length - 1].date, 'MMM d, yyyy')} />
          </div>
        </Card>
      </section>
    </div>
  );
}
