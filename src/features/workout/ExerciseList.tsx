import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dumbbell, Plus } from 'lucide-react';
import type { PRKind, Settings, Workout, WorkoutExercise } from '../../types';
import { Button, EmptyState, confirm, toast } from '../../components/ui';
import { PR_LABEL } from '../../lib/calc';
import { useExercises } from '../../lib/ExerciseProvider';
import { typeFields } from '../../lib/exerciseMeta';
import { uid } from '../../lib/ids';
import { ExercisePicker } from '../exercises/ExercisePicker';
import type { PickedExercise } from '../../lib/workoutStore';
import { ExerciseCard } from './ExerciseCard';
import {
  LoggerContext,
  useBests,
  useLivePRs,
  usePreviousSets,
  type ExerciseOps,
  type LoggerContextValue,
  type LoggerMode,
} from './LoggerContext';
import { ReorderSheet } from './ReorderSheet';
import { SupersetSheet } from './SupersetSheet';
import { adaptSetsToType, buildExerciseItems, formatPRValue, sameFields, supersetColors } from './logic';

/**
 * The exercise cards of a workout plus everything around them (add/replace picker, reorder and superset
 * sheets, live PR detection). Shared by the live logger (mode "active") and the saved-workout editor
 * (mode "edit") so both look and behave the same.
 */
export function WorkoutExerciseList({
  mode,
  exercises,
  ops,
  settings,
  history,
  routineId,
  onSetCompleted,
  announcePRs,
  emptyTitle = 'Get started',
  emptyMessage = 'Add an exercise to start your workout',
  footer,
}: {
  mode: LoggerMode;
  exercises: WorkoutExercise[];
  ops: ExerciseOps;
  settings: Settings;
  /** Earlier workouts, newest first (PREVIOUS column + PR baseline). undefined while loading. */
  history: Workout[] | undefined;
  routineId?: string | null;
  onSetCompleted?: (weId: string, setId: string, restSec: number) => void;
  /** Toast new PRs as they happen. */
  announcePRs?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  footer?: ReactNode;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [reorderOpen, setReorderOpen] = useState(false);
  const [supersetFor, setSupersetFor] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const index = useExercises();

  const previousByInstance = usePreviousSets(exercises, history, settings.previousValues, routineId);
  const bests = useBests(history);
  const prs = useLivePRs(exercises, bests);
  const colors = useMemo(() => supersetColors(exercises), [exercises]);

  const prsBySet = useMemo(() => {
    const m = new Map<string, PRKind[]>();
    for (const p of prs) m.set(p.setId, [...(m.get(p.setId) ?? []), p.kind]);
    return m;
  }, [prs]);

  // Toast each new PR once (PRs already present when the screen opens are not re-announced).
  const announced = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!bests) return;
    const keys = prs.map((p) => `${p.setId}:${p.kind}`);
    if (!announced.current) {
      announced.current = new Set(keys);
      return;
    }
    if (!announcePRs) return;
    const fresh = new Map<string, typeof prs>();
    for (const p of prs) {
      const k = `${p.setId}:${p.kind}`;
      if (announced.current.has(k)) continue;
      announced.current.add(k);
      fresh.set(p.setId, [...(fresh.get(p.setId) ?? []), p]);
    }
    for (const list of fresh.values()) {
      const [first, ...more] = list;
      const extra = more.length ? ` (+${more.length} more)` : '';
      const value = formatPRValue(first.kind, first.value, index.get(first.exerciseId).type, settings);
      toast(`New PR - ${PR_LABEL[first.kind]}: ${value}${extra}`, 'pr', 3200);
      navigator.vibrate?.([30, 60, 30]);
    }
  }, [prs, bests, announcePRs, settings, index]);

  // Bring a freshly added exercise into view once it has rendered.
  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(`we-${scrollTo}`);
    if (!el) return;
    setScrollTo(null);
    // Let the picker sheet close (and release the body scroll lock) first.
    window.setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }, [scrollTo, exercises]);

  const onAdd = async (picked: PickedExercise[], opts: { superset: boolean }) => {
    setPickerOpen(false);
    if (!picked.length) return;
    try {
      const items = await buildExerciseItems(picked, {
        history,
        previousMode: settings.previousValues,
        routineId,
        done: mode === 'edit',
        existing: exercises,
      });
      ops.addExercises(items, { superset: opts.superset });
      if (items[0]?.id) setScrollTo(items[0].id);
    } catch (e) {
      console.error(e);
      toast('Could not add exercise', 'error');
    }
  };

  const replace = (weId: string, exerciseId: string) => {
    const we = exercises.find((e) => e.id === weId);
    if (!we || we.exerciseId === exerciseId) return;
    ops.replaceExercise(weId, exerciseId);
    // A just-created exercise may not be in the index yet; its type is then unknown — leave the sets alone.
    if (!index.byId.has(exerciseId)) return;
    const to = typeFields(index.get(exerciseId).type);
    if (sameFields(typeFields(index.get(we.exerciseId).type), to)) return;
    for (const { setId, patch } of adaptSetsToType(we.sets, to)) ops.updateSet(weId, setId, patch);
  };

  /**
   * Same movement on another machine/brand. Completed sets were done on the old machine, so in the live
   * logger the user chooses whether they stay there (the rest moves to a new card) or move along.
   */
  const switchVariant = async (weId: string, exerciseId: string) => {
    const we = exercises.find((e) => e.id === weId);
    if (!we || we.exerciseId === exerciseId) return;
    const doneCount = we.sets.filter((s) => s.done).length;
    let moveDone = true;
    if (mode === 'active' && doneCount > 0) {
      const keep = await confirm({
        title: 'Switch machine',
        message: `Keep your ${doneCount} completed ${doneCount === 1 ? 'set' : 'sets'} on ${index.get(we.exerciseId).name} and log the rest on ${index.get(exerciseId).name}?`,
        confirmLabel: 'Only remaining sets',
        cancelLabel: 'Move all sets',
      });
      moveDone = !keep;
    }
    const newId = uid();
    const split = !moveDone && doneCount > 0;
    ops.switchVariant(weId, exerciseId, moveDone, newId);
    // A variant normally logs the same columns; if not, adapt the sets that moved (like Replace does).
    if (index.byId.has(exerciseId)) {
      const to = typeFields(index.get(exerciseId).type);
      if (!sameFields(typeFields(index.get(we.exerciseId).type), to)) {
        const moved = split ? we.sets.filter((s) => !s.done) : we.sets;
        for (const { setId, patch } of adaptSetsToType(moved, to)) ops.updateSet(split ? newId : weId, setId, patch);
      }
    }
    if (split) setScrollTo(newId);
  };

  const onReplace = (picked: PickedExercise[]) => {
    const id = picked[0]?.exerciseId;
    if (replaceId && id) replace(replaceId, id);
    setReplaceId(null);
  };

  const openReorder = useCallback(() => setReorderOpen(true), []);
  const openReplace = useCallback((weId: string) => setReplaceId(weId), []);
  const openSuperset = useCallback((weId: string) => setSupersetFor(weId), []);

  const ctx: LoggerContextValue = {
    mode,
    ops,
    exercises,
    settings,
    previousByInstance,
    prsBySet,
    supersetColors: colors,
    onSetCompleted: onSetCompleted ?? (() => undefined),
    replace,
    switchVariant: (weId, exerciseId) => void switchVariant(weId, exerciseId),
    openReorder,
    openReplace,
    openSuperset,
  };

  return (
    <LoggerContext.Provider value={ctx}>
      {exercises.length ? (
        <div className="space-y-3 px-3 pt-3">
          {exercises.map((we) => (
            <ExerciseCard key={we.id} we={we} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Dumbbell className="h-7 w-7" />}
          title={emptyTitle}
          message={emptyMessage}
          className="pt-16 pb-6"
        />
      )}

      <div className="space-y-3 px-4 pt-5">
        <Button
          block
          size="lg"
          onClick={() => setPickerOpen(true)}
          icon={<Plus className="h-5 w-5" strokeWidth={2.5} />}
        >
          Add Exercise
        </Button>
        {footer}
      </div>

      <ExercisePicker open={pickerOpen} onClose={() => setPickerOpen(false)} onAdd={(p, o) => void onAdd(p, o)} />
      <ExercisePicker
        open={!!replaceId}
        onClose={() => setReplaceId(null)}
        onAdd={(p) => onReplace(p)}
        single
        hideRoutinesTab
        title="Replace Exercise"
      />
      <ReorderSheet
        open={reorderOpen}
        onClose={() => setReorderOpen(false)}
        exercises={exercises}
        colors={colors}
        onReorder={ops.reorderExercises}
      />
      <SupersetSheet
        open={!!supersetFor}
        onClose={() => setSupersetFor(null)}
        weId={supersetFor}
        exercises={exercises}
        colors={colors}
        onPick={(other) => supersetFor && ops.setSuperset([supersetFor, other])}
      />
    </LoggerContext.Provider>
  );
}
