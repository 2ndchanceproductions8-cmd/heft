import { Link } from 'react-router-dom';
import { Link2, Trophy } from 'lucide-react';
import type { DistanceUnit, PRKind, SetType, Unit, WorkoutExercise } from '../../types';
import { cx } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { useExercises } from '../../lib/ExerciseProvider';
import { PR_LABEL } from '../../lib/calc';
import { SET_TYPE_LABEL } from '../../lib/exerciseMeta';
import { doneSets, formatE1RM, formatSetValue, setColumnLabel, setLabels } from './historyUtils';

const BADGE: Record<SetType, string> = {
  normal: 'bg-surface-2 text-fg',
  warmup: 'bg-warn-soft text-warn',
  failure: 'bg-danger-soft text-danger',
  drop: 'bg-drop-soft text-drop',
};

/** One exercise of a saved workout: header (thumb + name link), notes, and the read-only set table. */
export function ExerciseLog({
  we,
  supersetLetter,
  prsBySet,
  unit,
  distanceUnit,
}: {
  we: WorkoutExercise;
  supersetLetter?: string;
  prsBySet: Map<string, PRKind[]>;
  unit: Unit;
  distanceUnit: DistanceUnit;
}) {
  const { get } = useExercises();
  const ex = get(we.exerciseId);
  const sets = doneSets(we);
  const labels = setLabels(sets);
  const showE1RM = ex.type === 'weight_reps' && sets.some((s) => (s.reps ?? 0) > 1 && (s.weightKg ?? 0) > 0);
  const to = `/exercises/${encodeURIComponent(ex.id)}`;

  return (
    <div className={cx('rounded-2xl bg-surface p-4', supersetLetter && 'border-l-4 border-drop')}>
      <div className="flex items-center gap-3">
        {ex.missing ? (
          <ExerciseThumb exercise={ex} size={40} />
        ) : (
          <Link to={to} aria-hidden tabIndex={-1} className="shrink-0">
            <ExerciseThumb exercise={ex} size={40} />
          </Link>
        )}
        <div className="min-w-0 flex-1">
          {ex.missing ? (
            <div className="truncate text-[16px] font-semibold text-muted">{ex.name}</div>
          ) : (
            <Link to={to} className="block truncate text-[16px] font-semibold text-accent active:opacity-60">
              {ex.name}
            </Link>
          )}
          {supersetLetter ? (
            <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-drop-soft px-2 py-0.5 text-[11px] font-semibold text-drop">
              <Link2 className="h-3 w-3" />
              Superset {supersetLetter}
            </span>
          ) : null}
        </div>
      </div>

      {we.notes?.trim() ? (
        <p className="mt-2.5 text-[14px] leading-snug break-words whitespace-pre-wrap text-muted">{we.notes.trim()}</p>
      ) : null}

      {sets.length ? (
        <div className="mt-3">
          <div className="grid grid-cols-[2.5rem_1fr_auto] gap-x-3 px-2 pb-1 text-[12px] font-semibold tracking-wide text-faint uppercase">
            <span className="text-center">Set</span>
            <span>{setColumnLabel(ex.type)}</span>
            <span className="text-right">{showE1RM ? 'e1RM' : ''}</span>
          </div>
          <div className="space-y-0.5">
            {sets.map((s, k) => {
              const kinds = prsBySet.get(s.id) ?? [];
              const e1rm = showE1RM ? formatE1RM(s, ex.type, unit) : null;
              return (
                <div
                  key={s.id}
                  className={cx(
                    'grid grid-cols-[2.5rem_1fr_auto] items-center gap-x-3 rounded-lg px-2 py-1.5',
                    kinds.length ? 'bg-gold-soft' : k % 2 === 1 && 'bg-surface-2/60',
                  )}
                >
                  <span
                    title={SET_TYPE_LABEL[s.type]}
                    aria-label={s.type === 'normal' ? `Set ${labels[k]}` : SET_TYPE_LABEL[s.type]}
                    className={cx(
                      'mx-auto flex h-7 min-w-7 items-center justify-center rounded-md px-1 text-[13px] font-bold tabular-nums',
                      BADGE[s.type],
                    )}
                  >
                    {labels[k]}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold tabular-nums">
                      {formatSetValue(s, ex.type, unit, distanceUnit)}
                      {s.rpe != null ? <span className="ml-1.5 text-[13px] font-medium text-muted">@ RPE {s.rpe}</span> : null}
                    </div>
                    {kinds.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {kinds.map((kind) => (
                          <span
                            key={kind}
                            className="inline-flex items-center gap-1 rounded-full bg-gold-soft px-2 py-0.5 text-[11px] font-semibold text-gold ring-1 ring-gold/30"
                          >
                            <Trophy className="h-3 w-3" />
                            {PR_LABEL[kind]}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <span className="text-right text-[13px] text-muted tabular-nums">{e1rm ?? ''}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[14px] text-muted">No completed sets.</p>
      )}
    </div>
  );
}
