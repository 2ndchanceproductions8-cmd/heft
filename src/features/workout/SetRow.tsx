import { Fragment, useState, type CSSProperties } from 'react';
import { Check, Trophy } from 'lucide-react';
import type { Exercise, SetEntry, SetTarget, SetType, Side, SideValues, WorkoutExercise } from '../../types';
import { ActionSheet, DurationCell, NumberCell, cx, toast, type SheetAction } from '../../components/ui';
import { SET_TYPE_LABEL, type TypeFields } from '../../lib/exerciseMeta';
import { unlockAudio } from '../../lib/restTimer';
import { isSideSet, PR_LABEL } from '../../lib/calc';
import { patchSide, SIDE_LABEL, SIDE_LETTER, sideOf, sideTarget, splitSet, syncSideSet } from '../../lib/sides';
import { anyToMeters, distanceUnitForType, formatClock, metersToAny, round, unitToKg } from '../../lib/units';
import { useLogger } from './LoggerContext';
import { SwipeToDelete } from './SwipeToDelete';
import {
  distanceText,
  filledValues,
  formatSetLine,
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

type ValueKey = 'weightKg' | 'reps' | 'durationSec' | 'distanceM';
const SPAN_2: CSSProperties = { gridRow: 'span 2' };

/**
 * One set of the logger. A per-side set (the exercise logs left and right separately, or the set already has
 * `sides`) is two lines - L and R, each with its own previous values, placeholders and inputs - sharing the set
 * badge, the RPE and the one ✓ (a set is done when both sides are).
 */
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
  const done = set.done;
  const prKinds = prsBySet.get(set.id);
  const perSide = exercise.perSide || isSideSet(set);

  const update = (patch: Partial<SetEntry>) => ops.updateSet(we.id, set.id, patch);
  const remove = () => ops.removeSet(we.id, set.id);

  // Fallback values per field: last session's matching set (warm-ups match warm-ups), else the set above
  // (unless it is a warm-up feeding a working set). Per side for a per-side set.
  const above = aboveSet && !(aboveSet.type === 'warmup' && set.type !== 'warmup') ? aboveSet : null;
  const limbFallback = (side: Side | null): SideValues | null => {
    const p = side ? sideOf(prevSet, side) : prevSet;
    const a = side ? sideOf(above, side) : above;
    if (!p && !a) return null;
    const fb = (k: ValueKey) => p?.[k] ?? a?.[k] ?? null;
    return { weightKg: fb('weightKg'), reps: fb('reps'), durationSec: fb('durationSec'), distanceM: fb('distanceM') };
  };
  const fallback: SetEntry | null = perSide
    ? prevSet || above
      ? { ...set, sides: { left: limbFallback('left') ?? {}, right: limbFallback('right') ?? {} } }
      : null
    : prevSet || above
      ? { ...set, ...limbFallback(null) }
      : null;

  // The set as it is ticked: a plain set of a per-side exercise is split first, so each side gets its own values.
  const asLogged = perSide && !isSideSet(set) ? splitSet(set, exercise.type) : set;
  const filled = filledValues(asLogged, fallback, fields);

  // A ticked set whose required value was cleared again: Finish/Save would drop it, so don't let the green
  // row look complete. (It stays ticked so backspace-then-retype doesn't restart the rest timer.)
  const missingFor = (side: Side | null) =>
    done && !!missingValueMessage(fields, side && filled.sides ? filled.sides[side] : { ...filled, sides: null });
  const ring = (c: ValueColumn, side: Side | null) => {
    if (!missingFor(side)) return undefined;
    const bad = c === 'reps' ? fields.reps : !fields.reps && ((c === 'duration' && fields.duration) || (c === 'distance' && fields.distance));
    return bad ? 'ring-2 ring-danger' : undefined;
  };

  const toggleDone = () => {
    // Only touch audio when the beep is wanted (creating an AudioContext can interrupt music on iOS).
    if (settings.restTimerSound) unlockAudio();
    if (done) {
      update({ done: false });
      return;
    }
    const msg = missingValueMessage(fields, filled);
    if (msg) {
      toast(msg, 'error');
      return;
    }
    navigator.vibrate?.(10);
    update(perSide ? syncSideSet({ ...asLogged, ...filled, done: true }, exercise.type) : { ...filled, done: true });
    onSetCompleted(we.id, set.id, restSec);
  };

  /** Write one value: to a side of a per-side set (splitting a plain one), else to the set. */
  const setValue = (side: Side | null, k: ValueKey, v: number | null) => {
    if (!side) {
      update({ [k]: v });
      return;
    }
    const next = patchSide(set, side, { [k]: v }, exercise.type);
    update({ sides: next.sides, weightKg: next.weightKg, reps: next.reps, durationSec: next.durationSec, distanceM: next.distanceM });
  };

  const copyPrevious = (side: Side | null) => {
    const p = side ? sideOf(prevSet, side) : prevSet;
    if (!p) return;
    const cur = side ? sideOf(set, side) : set;
    const values: SideValues = {
      weightKg: fields.weight ? p.weightKg ?? null : cur?.weightKg ?? null,
      reps: fields.reps ? p.reps ?? null : cur?.reps ?? null,
      durationSec: fields.duration ? p.durationSec ?? null : cur?.durationSec ?? null,
      distanceM: fields.distance ? p.distanceM ?? null : cur?.distanceM ?? null,
    };
    if (!side) {
      update(values);
      return;
    }
    const next = patchSide(set, side, values, exercise.type);
    update({ sides: next.sides, weightKg: next.weightKg, reps: next.reps, durationSec: next.durationSec, distanceM: next.distanceM });
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

  /** The PREVIOUS cell + value inputs of one line (side null = a plain set). */
  const line = (side: Side | null) => {
    const cur = (side ? sideOf(set, side) : set) ?? {};
    const t: SetTarget | null = side ? sideTarget(set.target, side) : set.target ?? null;
    const fb = limbFallback(side);
    const prev = side ? sideOf(prevSet, side) : prevSet;
    const sideName = side ? `${SIDE_LABEL[side]} ` : '';
    // Placeholders: planned target first, then last session's values, then the set above.
    const ph = {
      weight: weightText(t?.weightKg ?? fb?.weightKg, unit),
      reps:
        t?.reps != null
          ? t.repsMax != null && t.repsMax > t.reps
            ? `${t.reps}-${t.repsMax}`
            : String(t.reps)
          : fb?.reps != null
            ? String(fb.reps)
            : '',
      distance: distanceText(t?.distanceM ?? fb?.distanceM, exercise.type, distanceUnit),
      duration: t?.durationSec != null ? formatClock(t.durationSec) : fb?.durationSec != null ? formatClock(fb.durationSec) : '',
    };
    const prevText = prev
      ? side
        ? formatSetSummary(prev, exercise.type, unit, distanceUnit)
        : formatSetLine(prevSet!, exercise.type, unit, distanceUnit)
      : '-';

    return (
      <Fragment key={side ?? 'set'}>
        {/* PREVIOUS (with the side letter on a per-side line) */}
        <div className="flex h-9 min-w-0 items-center">
          {side ? (
            <span aria-hidden className="w-3.5 shrink-0 text-center text-[12px] font-bold text-muted">
              {SIDE_LETTER[side]}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => copyPrevious(side)}
            disabled={!prev}
            aria-label={prev ? `Use previous ${sideName.toLowerCase()}values` : `No previous ${sideName.toLowerCase()}values`}
            className="h-9 min-w-0 flex-1 truncate rounded-lg px-1 text-center text-[13px] font-medium text-muted tabular-nums active:bg-surface-3 disabled:active:bg-transparent"
          >
            {prevText}
          </button>
        </div>

        {cols.map((c) => {
          switch (c) {
            case 'weight':
              return (
                <NumberCell
                  key={c}
                  ariaLabel={`${sideName}Weight (${unit})`}
                  done={done}
                  value={cur.weightKg == null ? null : Number(weightText(cur.weightKg, unit))}
                  placeholder={ph.weight}
                  onChange={(v) => setValue(side, 'weightKg', v == null ? null : unitToKg(v, unit))}
                />
              );
            case 'reps':
              return (
                <NumberCell
                  key={c}
                  integer
                  ariaLabel={`${sideName}Reps`}
                  done={done}
                  className={ring(c, side)}
                  value={cur.reps}
                  placeholder={ph.reps}
                  onChange={(v) => setValue(side, 'reps', v)}
                />
              );
            case 'distance':
              return (
                <NumberCell
                  key={c}
                  ariaLabel={`${sideName}Distance (${du})`}
                  done={done}
                  className={ring(c, side)}
                  // Edited at 2 dp (like the routine editor), not the 1 dp yd/m display rounding: a typed 40.25 yd must
                  // not snap to 40.3 on blur.
                  value={cur.distanceM == null ? null : round(metersToAny(cur.distanceM, du), 2)}
                  placeholder={ph.distance}
                  onChange={(v) => setValue(side, 'distanceM', v == null ? null : anyToMeters(v, du))}
                />
              );
            case 'duration':
              return (
                <DurationCell
                  key={c}
                  ariaLabel={`${sideName}Time`}
                  done={done}
                  className={ring(c, side)}
                  value={cur.durationSec}
                  placeholder={ph.duration || '0:00'}
                  onChange={(v) => setValue(side, 'durationSec', v)}
                />
              );
            case 'rpe':
              // One RPE per set: on a per-side set it spans both lines (the right line skips the cell).
              if (side === 'right') return null;
              return (
                <div key={c} style={side ? SPAN_2 : undefined} className="flex h-full items-center">
                  <NumberCell
                    ariaLabel="RPE"
                    done={done}
                    value={set.rpe}
                    placeholder=""
                    onChange={(v) => update({ rpe: v == null ? null : Math.min(10, Math.max(1, v)) })}
                  />
                </div>
              );
          }
        })}
      </Fragment>
    );
  };

  const check = (
    <div style={perSide ? SPAN_2 : undefined} className="flex h-full items-center">
      <button
        type="button"
        onClick={toggleDone}
        aria-label={done ? 'Mark set as not completed' : 'Complete set'}
        aria-pressed={done}
        className={cx(
          'flex w-10 items-center justify-center rounded-lg transition-colors',
          perSide ? 'h-full min-h-9' : 'h-9',
          done ? 'bg-success text-white active:brightness-90' : 'bg-surface-2 text-muted active:bg-surface-3',
        )}
      >
        <Check className="h-5 w-5" strokeWidth={3} />
      </button>
    </div>
  );

  return (
    <>
      <SwipeToDelete onDelete={remove} contentClassName="bg-surface">
        <div
          className={cx(
            'grid items-center gap-x-1.5 px-3 transition-colors',
            perSide ? 'gap-y-1 py-1.5' : 'py-1',
            done && 'bg-success-soft',
          )}
          style={setGridStyle(cols)}
        >
          {/* SET */}
          <div style={perSide ? SPAN_2 : undefined} className="flex h-full items-center">
            <button
              type="button"
              onClick={() => setTypeMenu(true)}
              aria-label={`Set ${badge.label}: ${SET_TYPE_LABEL[set.type]}${perSide ? ', left and right' : ''}. Change set type`}
              className={cx(
                // after: widens the tap target to ~42x40 without widening the 30px column.
                'relative flex w-[30px] items-center justify-center rounded-lg text-[15px] font-bold tabular-nums after:absolute after:-inset-x-1.5 after:-inset-y-0.5 active:bg-surface-3',
                perSide ? 'h-full min-h-9' : 'h-9',
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
          </div>

          {perSide ? (
            <>
              {line('left')}
              {check}
              {line('right')}
            </>
          ) : (
            <>
              {line(null)}
              {check}
            </>
          )}
        </div>
      </SwipeToDelete>
      <ActionSheet open={typeMenu} onClose={() => setTypeMenu(false)} title="Set Type" actions={typeActions} />
    </>
  );
}

