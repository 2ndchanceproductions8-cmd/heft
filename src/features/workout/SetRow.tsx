import { useState } from 'react';
import { Check, Trophy } from 'lucide-react';
import type { Exercise, SetEntry, SetType, WorkoutExercise } from '../../types';
import { ActionSheet, DurationCell, NumberCell, cx, toast, type SheetAction } from '../../components/ui';
import { SET_TYPE_LABEL, type TypeFields } from '../../lib/exerciseMeta';
import { unlockAudio } from '../../lib/restTimer';
import { PR_LABEL } from '../../lib/calc';
import { anyToMeters, distanceUnitForType, formatClock, metersToAny, round, unitToKg } from '../../lib/units';
import { useLogger } from './LoggerContext';
import { SwipeToDelete } from './SwipeToDelete';
import {
  distanceText,
  filledValues,
  formatSetSummary,
  missingValueMessage,
  setGridStyle,
  weightText,
  type SetBadge,
  type ValueColumn,
} from './logic';

const TYPE_ORDER: SetType[] = ['warmup', 'normal', 'failure', 'drop'];
const TYPE_BADGE: Record<SetType, { letter: string; cls: string }> = {
  warmup: { letter: 'W', cls: 'text-warn' },
  normal: { letter: '1', cls: 'text-fg' },
  failure: { letter: 'F', cls: 'text-danger' },
  drop: { letter: 'D', cls: 'text-drop' },
};

export function SetRow({
  we,
  set,
  exercise,
  fields,
  cols,
  badge,
  prevSet,
  aboveSet,
  restSec,
}: {
  we: WorkoutExercise;
  set: SetEntry;
  exercise: Exercise;
  fields: TypeFields;
  cols: ValueColumn[];
  badge: SetBadge;
  prevSet: SetEntry | null;
  /** The set right above in this exercise — "same as last set" when there is no plan or history. */
  aboveSet?: SetEntry | null;
  restSec: number;
}) {
  const { ops, settings, prsBySet, onSetCompleted } = useLogger();
  const [typeMenu, setTypeMenu] = useState(false);
  const { unit, distanceUnit } = settings;
  // Carries/sleds are entered in yd/m, runs in mi/km.
  const du = distanceUnitForType(exercise.type, distanceUnit);
  const t = set.target;
  const done = set.done;
  const prKinds = prsBySet.get(set.id);

  const update = (patch: Partial<SetEntry>) => ops.updateSet(we.id, set.id, patch);
  const remove = () => ops.removeSet(we.id, set.id);

  // Fallback values per field: last session's matching set (warm-ups match warm-ups), else the set above
  // (unless it is a warm-up feeding a working set).
  const above = aboveSet && !(aboveSet.type === 'warmup' && set.type !== 'warmup') ? aboveSet : null;
  const fb = (k: 'weightKg' | 'reps' | 'durationSec' | 'distanceM') => prevSet?.[k] ?? above?.[k] ?? null;
  const fallback: SetEntry | null =
    prevSet || above
      ? { ...set, weightKg: fb('weightKg'), reps: fb('reps'), durationSec: fb('durationSec'), distanceM: fb('distanceM') }
      : null;

  // Placeholders: planned target first, then last session's values, then the set above.
  const ph = {
    weight: weightText(t?.weightKg ?? fallback?.weightKg, unit),
    reps:
      t?.reps != null
        ? t.repsMax != null && t.repsMax > t.reps
          ? `${t.reps}-${t.repsMax}`
          : String(t.reps)
        : fallback?.reps != null
          ? String(fallback.reps)
          : '',
    distance: distanceText(t?.distanceM ?? fallback?.distanceM, exercise.type, distanceUnit),
    duration:
      t?.durationSec != null
        ? formatClock(t.durationSec)
        : fallback?.durationSec != null
          ? formatClock(fallback.durationSec)
          : '',
  };

  // A ticked set whose required value was cleared again: Finish/Save would drop it, so don't let the green
  // row look complete. (It stays ticked so backspace-then-retype doesn't restart the rest timer.)
  const missing = done && !!missingValueMessage(fields, filledValues(set, null, fields));
  const invalid = (c: ValueColumn) =>
    missing &&
    (c === 'reps' ? fields.reps : !fields.reps && ((c === 'duration' && fields.duration) || (c === 'distance' && fields.distance)));
  const ring = (c: ValueColumn) => (invalid(c) ? 'ring-2 ring-danger' : undefined);

  const toggleDone = () => {
    // Only touch audio when the beep is wanted (creating an AudioContext can interrupt music on iOS).
    if (settings.restTimerSound) unlockAudio();
    if (done) {
      update({ done: false });
      return;
    }
    const values = filledValues(set, fallback, fields);
    const msg = missingValueMessage(fields, values);
    if (msg) {
      toast(msg, 'error');
      return;
    }
    navigator.vibrate?.(10);
    update({ ...values, done: true });
    onSetCompleted(we.id, set.id, restSec);
  };

  const copyPrevious = () => {
    if (!prevSet) return;
    update({
      weightKg: fields.weight ? prevSet.weightKg ?? null : set.weightKg ?? null,
      reps: fields.reps ? prevSet.reps ?? null : set.reps ?? null,
      durationSec: fields.duration ? prevSet.durationSec ?? null : set.durationSec ?? null,
      distanceM: fields.distance ? prevSet.distanceM ?? null : set.distanceM ?? null,
    });
  };

  const typeActions: SheetAction[] = [
    ...TYPE_ORDER.map((type) => ({
      label: SET_TYPE_LABEL[type],
      hint: set.type === type ? 'Current' : undefined,
      icon: (
        <span className={cx('text-[15px] font-bold', TYPE_BADGE[type].cls)}>
          {type === 'normal' ? '#' : TYPE_BADGE[type].letter}
        </span>
      ),
      onClick: () => update({ type }),
    })),
    { label: 'Remove Set', danger: true, onClick: remove },
  ];

  return (
    <>
      <SwipeToDelete onDelete={remove} contentClassName="bg-surface">
        <div
          className={cx('grid items-center gap-1.5 px-3 py-1 transition-colors', done && 'bg-success-soft')}
          style={setGridStyle(cols)}
        >
          {/* SET */}
          <button
            type="button"
            onClick={() => setTypeMenu(true)}
            aria-label={`Set ${badge.label}: ${SET_TYPE_LABEL[set.type]}. Change set type`}
            className={cx(
              // after: widens the tap target to ~42x40 without widening the 30px column.
              'relative flex h-9 w-[30px] items-center justify-center rounded-lg text-[15px] font-bold tabular-nums after:absolute after:-inset-x-1.5 after:-inset-y-0.5 active:bg-surface-3',
              !done && 'bg-surface-2',
              badge.className,
            )}
          >
            {badge.label}
            {prKinds?.length ? (
              <span
                className="absolute -top-1 -right-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-gold-soft"
                title={prKinds.map((k) => PR_LABEL[k]).join(', ')}
              >
                <Trophy className="h-3 w-3 text-gold" strokeWidth={2.5} />
              </span>
            ) : null}
          </button>

          {/* PREVIOUS */}
          <button
            type="button"
            onClick={copyPrevious}
            disabled={!prevSet}
            aria-label={prevSet ? 'Use previous values' : 'No previous values'}
            className="h-9 min-w-0 truncate rounded-lg px-1 text-center text-[13px] font-medium text-muted tabular-nums active:bg-surface-3 disabled:active:bg-transparent"
          >
            {prevSet ? formatSetSummary(prevSet, exercise.type, unit, distanceUnit) : '-'}
          </button>

          {cols.map((c) => {
            switch (c) {
              case 'weight':
                return (
                  <NumberCell
                    key={c}
                    ariaLabel={`Weight (${unit})`}
                    done={done}
                    value={set.weightKg == null ? null : Number(weightText(set.weightKg, unit))}
                    placeholder={ph.weight}
                    onChange={(v) => update({ weightKg: v == null ? null : unitToKg(v, unit) })}
                  />
                );
              case 'reps':
                return (
                  <NumberCell
                    key={c}
                    integer
                    ariaLabel="Reps"
                    done={done}
                    className={ring(c)}
                    value={set.reps}
                    placeholder={ph.reps}
                    onChange={(v) => update({ reps: v })}
                  />
                );
              case 'distance':
                return (
                  <NumberCell
                    key={c}
                    ariaLabel={`Distance (${du})`}
                    done={done}
                    className={ring(c)}
                    // Edited at 2 dp (like the routine editor), not the 1 dp yd/m display rounding: a typed 40.25 yd must
                    // not snap to 40.3 on blur.
                    value={set.distanceM == null ? null : round(metersToAny(set.distanceM, du), 2)}
                    placeholder={ph.distance}
                    onChange={(v) => update({ distanceM: v == null ? null : anyToMeters(v, du) })}
                  />
                );
              case 'duration':
                return (
                  <DurationCell
                    key={c}
                    ariaLabel="Time"
                    done={done}
                    className={ring(c)}
                    value={set.durationSec}
                    placeholder={ph.duration || '0:00'}
                    onChange={(v) => update({ durationSec: v })}
                  />
                );
              case 'rpe':
                return (
                  <NumberCell
                    key={c}
                    ariaLabel="RPE"
                    done={done}
                    value={set.rpe}
                    placeholder=""
                    onChange={(v) => update({ rpe: v == null ? null : Math.min(10, Math.max(1, v)) })}
                  />
                );
            }
          })}

          {/* ✓ */}
          <button
            type="button"
            onClick={toggleDone}
            aria-label={done ? 'Mark set as not completed' : 'Complete set'}
            aria-pressed={done}
            className={cx(
              'flex h-9 w-10 items-center justify-center rounded-lg transition-colors',
              done ? 'bg-success text-white active:brightness-90' : 'bg-surface-2 text-muted active:bg-surface-3',
            )}
          >
            <Check className="h-5 w-5" strokeWidth={3} />
          </button>
        </div>
      </SwipeToDelete>
      <ActionSheet open={typeMenu} onClose={() => setTypeMenu(false)} title="Set Type" actions={typeActions} />
    </>
  );
}
