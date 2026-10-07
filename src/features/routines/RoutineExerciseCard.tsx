import { memo, useCallback, useMemo, useState } from 'react';
import { ArrowLeftRight, ArrowUpDown, ChevronDown, Link2, Link2Off, MoreHorizontal, Plus, Repeat2, Trash2 } from 'lucide-react';
import { ActionSheet, IconButton, confirm, cx, prompt, toast, type SheetAction } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { SET_TYPE_LABEL, typeFields } from '../../lib/exerciseMeta';
import { isSideSet } from '../../lib/calc';
import { setExercisePerSide } from '../../lib/exercises';
import { joinSet, sidesDiffer } from '../../lib/sides';
import { distanceUnitForType } from '../../lib/units';
import type { DistanceUnit, Exercise, RoutineExercise, RoutineSet, SetType, Unit } from '../../types';
import { AutoTextarea, RestTimerSelect } from './EditorFields';
import { RoutineSetRow, setGridStyle } from './RoutineSetRow';
import {
  SET_BADGE_CLASS,
  formatReps,
  nextSet,
  parseRepsInput,
  setBadges,
  supersetLetter,
  supersetStyle,
} from './routineUtils';

export type ExerciseAction = 'replace' | 'superset' | 'unsuperset' | 'reorder' | 'remove';

const SET_TYPE_ORDER: { type: SetType; letter: string }[] = [
  { type: 'warmup', letter: 'W' },
  { type: 'normal', letter: '1' },
  { type: 'failure', letter: 'F' },
  { type: 'drop', letter: 'D' },
];

/** One exercise in the routine editor: header + ⋯ menu, notes, rest timer, set table, "+ Add Set". */
export const RoutineExerciseCard = memo(function RoutineExerciseCard({
  re,
  exercise,
  unit,
  distanceUnit,
  defaultRest,
  superset,
  exerciseCount,
  onUpdate,
  onAction,
}: {
  re: RoutineExercise;
  exercise: Exercise;
  unit: Unit;
  distanceUnit: DistanceUnit;
  /** Rest used when the routine leaves it on "Default" (exercise default, else settings). */
  defaultRest: number;
  /** Superset letter index, when this exercise is in a superset. */
  superset?: number;
  exerciseCount: number;
  onUpdate: (reId: string, fn: (re: RoutineExercise) => RoutineExercise) => void;
  onAction: (reId: string, action: ExerciseAction) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [setMenuFor, setSetMenuFor] = useState<string | null>(null);
  const [repsMenu, setRepsMenu] = useState(false);

  const fields = useMemo(() => typeFields(exercise.type), [exercise.type]);
  // Carries and sleds plan in yd/m, runs in mi/km (same unit the logger uses).
  const dUnit = useMemo(() => distanceUnitForType(exercise.type, distanceUnit), [exercise.type, distanceUnit]);
  const badges = useMemo(() => setBadges(re.sets), [re.sets]);
  const ss = superset != null ? supersetStyle(superset) : null;
  const reId = re.id;

  const updateSet = useCallback(
    (setId: string, patch: Partial<RoutineSet>) =>
      onUpdate(reId, (r) => ({ ...r, sets: r.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) })),
    [onUpdate, reId],
  );
  const deleteSet = useCallback(
    (setId: string) => onUpdate(reId, (r) => ({ ...r, sets: r.sets.filter((s) => s.id !== setId) })),
    [onUpdate, reId],
  );
  const addSet = () => onUpdate(reId, (r) => ({ ...r, sets: [...r.sets, nextSet(r.sets)] }));

  const cols: { key: string; label: string; onClick?: () => void }[] = [];
  if (fields.weight) cols.push({ key: 'w', label: `${fields.weightSign}${unit.toUpperCase()}` });
  if (fields.reps) cols.push({ key: 'r', label: 'REPS', onClick: () => setRepsMenu(true) });
  if (fields.distance) cols.push({ key: 'd', label: dUnit.toUpperCase() });
  if (fields.duration) cols.push({ key: 't', label: 'TIME' });

  // Left / right lines for the whole table: the exercise is per-side, or a set already plans both sides.
  const perSide = exercise.perSide || re.sets.some((s) => isSideSet(s));
  const hasRanges = re.sets.some((s) => s.repsMax != null || s.sides?.left.repsMax != null || s.sides?.right.repsMax != null);
  const applyRange = async () => {
    const working = re.sets.find((s) => s.type !== 'warmup' && s.reps != null);
    const v = await prompt({
      title: 'Rep range for all sets',
      message: 'Applies to every working set. Type a range like 8-12, or a single number.',
      initial: working ? formatReps(working.reps, working.repsMax) : '8-12',
      placeholder: '8-12',
      confirmLabel: 'Apply',
      validate: (t) => (parseRepsInput(t).reps == null ? 'Enter reps, e.g. 8-12' : null),
    });
    if (v == null) return;
    const { reps, repsMax } = parseRepsInput(v);
    onUpdate(reId, (r) => ({
      ...r,
      sets: r.sets.map((s) =>
        s.type === 'warmup'
          ? s
          : {
              ...s,
              reps,
              repsMax,
              ...(s.sides ? { sides: { left: { ...s.sides.left, reps, repsMax }, right: { ...s.sides.right, reps, repsMax } } } : {}),
            },
      ),
    }));
  };

  // Left / right is the exercise's own setting (saved right away, for every routine and workout). Turning it on shows
  // an L and an R line per set (each side starts from the set's values); turning it off folds this routine's sets
  // back into one value each (the better side), after a confirm when the sides differ.
  const togglePerSide = async () => {
    const next = !exercise.perSide;
    if (!next && re.sets.some(sidesDiffer)) {
      const ok = await confirm({
        title: 'Plan both sides together?',
        message: 'Sets with different left and right values keep their stronger side.',
        confirmLabel: 'Combine',
      });
      if (!ok) return;
    }
    try {
      await setExercisePerSide(exercise.id, next);
    } catch {
      toast('Could not change the exercise', 'error');
      return;
    }
    if (!next) onUpdate(reId, (r) => ({ ...r, sets: r.sets.map((s) => joinSet(s, exercise.type)) }));
    toast(next ? `${exercise.name}: left and right separately` : `${exercise.name}: both sides together`, 'success');
  };

  const menuSet = setMenuFor ? re.sets.find((s) => s.id === setMenuFor) : undefined;
  const setActions: SheetAction[] = menuSet
    ? [
        ...SET_TYPE_ORDER.map(({ type, letter }) => ({
          label: SET_TYPE_LABEL[type],
          hint: menuSet.type === type ? 'Current' : undefined,
          icon: (
            <span className={cx('flex h-6 w-6 items-center justify-center rounded-md text-[13px] font-bold', SET_BADGE_CLASS[type])}>
              {letter}
            </span>
          ),
          onClick: () => updateSet(menuSet.id, { type }),
        })),
        { label: 'Remove Set', danger: true, icon: <Trash2 className="h-5 w-5" />, onClick: () => deleteSet(menuSet.id) },
      ]
    : [];

  return (
    <div className="relative rounded-2xl bg-surface px-3 pt-3 pb-3">
      {ss ? <span className={cx('absolute top-3 bottom-3 left-0 w-1 rounded-r-full', ss.bar)} aria-hidden /> : null}

      <div className="flex items-center gap-3 pl-1">
        <ExerciseThumb exercise={exercise} size={42} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[16px] leading-snug font-semibold text-accent">{exercise.name}</div>
          {ss && superset != null ? (
            <div className={cx('text-[12px] font-semibold', ss.text)}>Superset {supersetLetter(superset)}</div>
          ) : null}
          {exercise.perSide ? <div className="text-[12px] text-muted">Left &amp; right</div> : null}
        </div>
        <button
          type="button"
          onClick={() => void togglePerSide()}
          aria-pressed={exercise.perSide}
          aria-label={exercise.perSide ? 'Left and right logged separately. Log both sides together' : 'Log left and right separately'}
          className="flex h-10 shrink-0 items-center"
        >
          <span
            className={cx(
              'flex h-8 items-center gap-1 rounded-full px-2.5 text-[13px] font-semibold transition-colors',
              exercise.perSide ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted active:bg-surface-3',
            )}
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            L/R
          </span>
        </button>
        <IconButton label={`Options for ${exercise.name}`} tone="muted" onClick={() => setMenu(true)}>
          <MoreHorizontal className="h-5 w-5" />
        </IconButton>
      </div>

      <AutoTextarea
        aria-label={`Notes for ${exercise.name}`}
        placeholder="Add routine notes here"
        value={re.notes ?? ''}
        onChange={(e) => {
          const notes = e.target.value;
          onUpdate(reId, (r) => ({ ...r, notes }));
        }}
        className="mt-2 px-1 text-[16px] leading-snug"
      />

      <RestTimerSelect
        className="mt-1"
        value={re.restSec}
        defaultSec={defaultRest}
        onChange={(restSec) => onUpdate(reId, (r) => ({ ...r, restSec }))}
      />

      {re.sets.length ? (
        <div className="mt-1">
          <div className="grid items-center gap-2 px-0.5 pb-1 text-[12px] font-semibold tracking-wide text-muted" style={setGridStyle(cols.length, perSide)}>
            <div className="text-center">SET</div>
            {perSide ? <div aria-hidden /> : null}
            {cols.map((c) =>
              c.onClick ? (
                <button
                  key={c.key}
                  type="button"
                  onClick={c.onClick}
                  className="-my-1 flex h-9 w-full items-center justify-center gap-0.5 rounded-md tracking-wide active:bg-surface-2"
                  aria-label="Rep range options"
                >
                  {c.label}
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : (
                <div key={c.key} className="text-center">
                  {c.label}
                </div>
              ),
            )}
          </div>
          <div className="space-y-0.5">
            {re.sets.map((s, i) => (
              <RoutineSetRow
                key={s.id}
                set={s}
                index={i}
                badge={badges[i]}
                fields={fields}
                unit={unit}
                distanceUnit={dUnit}
                perSide={perSide}
                exerciseType={exercise.type}
                onChange={updateSet}
                onBadge={setSetMenuFor}
                onDelete={deleteSet}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2.5 text-center text-[14px] text-muted">No sets — add one below.</div>
      )}

      <button
        type="button"
        onClick={addSet}
        className="mt-2 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-[15px] font-semibold text-fg transition-colors active:bg-surface-3"
      >
        <Plus className="h-4 w-4" strokeWidth={2.6} />
        Add Set
      </button>

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={exercise.name}
        actions={[
          {
            label: exercise.perSide ? 'Log Both Sides Together' : 'Log Left & Right Separately',
            hint: exercise.perSide ? 'One weight and rep count per set' : 'Its own weight and reps for each side',
            icon: <ArrowLeftRight className="h-5 w-5" />,
            onClick: () => void togglePerSide(),
          },
          { label: 'Replace Exercise', icon: <Repeat2 className="h-5 w-5" />, onClick: () => onAction(reId, 'replace') },
          re.supersetId
            ? { label: 'Remove From Superset', icon: <Link2Off className="h-5 w-5" />, onClick: () => onAction(reId, 'unsuperset') }
            : {
                label: 'Add To Superset',
                icon: <Link2 className="h-5 w-5" />,
                disabled: exerciseCount < 2,
                hint: exerciseCount < 2 ? 'Add another exercise first' : undefined,
                onClick: () => onAction(reId, 'superset'),
              },
          {
            label: 'Reorder Exercises',
            icon: <ArrowUpDown className="h-5 w-5" />,
            disabled: exerciseCount < 2,
            onClick: () => onAction(reId, 'reorder'),
          },
          { label: 'Remove Exercise', icon: <Trash2 className="h-5 w-5" />, danger: true, onClick: () => onAction(reId, 'remove') },
        ]}
      />

      <ActionSheet open={!!menuSet} onClose={() => setSetMenuFor(null)} title={menuSet ? 'Set type' : undefined} actions={setActions} />

      <ActionSheet
        open={repsMenu}
        onClose={() => setRepsMenu(false)}
        title="Reps"
        actions={[
          { label: 'Set rep range for all sets…', hint: 'e.g. 8-12 — or type “8-12” in any REPS box', onClick: () => void applyRange() },
          {
            label: 'Clear rep ranges',
            hint: 'Keep the lower number of each range',
            disabled: !hasRanges,
            onClick: () =>
              onUpdate(reId, (r) => ({
                ...r,
                sets: r.sets.map((s) => ({
                  ...s,
                  repsMax: null,
                  ...(s.sides ? { sides: { left: { ...s.sides.left, repsMax: null }, right: { ...s.sides.right, repsMax: null } } } : {}),
                })),
              })),
          },
        ]}
      />
    </div>
  );
});
