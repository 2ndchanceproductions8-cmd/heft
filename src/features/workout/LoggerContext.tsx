import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { PRKind, PRRecord, SetEntry, Settings, Workout, WorkoutExercise } from '../../types';
import { bestsByExercise, detectPRs, type Bests } from '../../lib/calc';
import { useExercises } from '../../lib/ExerciseProvider';
import type { NewExerciseItem } from '../../lib/workoutStore';
import { previousInstanceSets, type SupersetColor } from './logic';

/** Mutations the exercise cards need. The live store and the saved-workout editor both implement it. */
export interface ExerciseOps {
  addExercises(items: NewExerciseItem[], opts?: { superset?: boolean }): void;
  removeExercise(weId: string): void;
  replaceExercise(weId: string, exerciseId: string): void;
  /** Machine/brand variant switch; `newId` names the instance a split creates (see exerciseListOps). */
  switchVariant(weId: string, exerciseId: string, moveDone: boolean, newId?: string): void;
  reorderExercises(orderedWeIds: string[]): void;
  updateExercise(weId: string, patch: Partial<Omit<WorkoutExercise, 'id' | 'sets'>>): void;
  setSuperset(weIds: string[]): void;
  removeFromSuperset(weId: string): void;
  addSet(weId: string, partial?: Partial<SetEntry>): void;
  removeSet(weId: string, setId: string): void;
  updateSet(weId: string, setId: string, patch: Partial<SetEntry>): void;
}

export type LoggerMode = 'active' | 'edit';

export interface LoggerContextValue {
  mode: LoggerMode;
  ops: ExerciseOps;
  exercises: WorkoutExercise[];
  settings: Settings;
  /** Previous session's sets per exercise INSTANCE id (null = never done before). */
  previousByInstance: Map<string, SetEntry[] | null>;
  /** PR kinds credited to each set id (live). */
  prsBySet: Map<string, PRKind[]>;
  supersetColors: Map<string, SupersetColor>;
  /** Called after a set was ticked off (active mode starts the rest timer). */
  onSetCompleted(weId: string, setId: string, restSec: number): void;
  /** Swap the exercise of an instance (keeps its sets; adapts them when the new type logs other columns). */
  replace(weId: string, exerciseId: string): void;
  /** Switch an instance to another machine/brand variant (asks whether completed sets move along). */
  switchVariant(weId: string, exerciseId: string): void;
  openReorder(): void;
  openReplace(weId: string): void;
  openSuperset(weId: string): void;
}

export const LoggerContext = createContext<LoggerContextValue | null>(null);

export function useLogger(): LoggerContextValue {
  const ctx = useContext(LoggerContext);
  if (!ctx) throw new Error('useLogger must be used inside <LoggerContext.Provider>');
  return ctx;
}

// ------------------------------------------------------------------ data hooks

/** All-time bests per exercise over `history` (undefined while loading). */
export function useBests(history: Workout[] | undefined): Map<string, Bests> | undefined {
  const index = useExercises();
  return useMemo(
    () => (history ? bestsByExercise(history, (id) => index.get(id).type) : undefined),
    [history, index],
  );
}

/** PRs the exercises currently set against `bests` (empty while loading). */
export function useLivePRs(exercises: WorkoutExercise[], bests: Map<string, Bests> | undefined): PRRecord[] {
  const index = useExercises();
  return useMemo(
    () => (bests ? detectPRs(exercises, bests, (id) => index.get(id).type).prs : []),
    [exercises, bests, index],
  );
}

/**
 * Previous session's sets for every exercise instance in the list, keyed by instance id. The Nth instance
 * of an exercise (in list order) maps to the Nth instance of it last time, so a back-off block doesn't show
 * (or auto-fill) the heavy block's weights.
 */
export function usePreviousSets(
  exercises: WorkoutExercise[],
  history: Workout[] | undefined,
  mode: Settings['previousValues'],
  routineId: string | null | undefined,
): Map<string, SetEntry[] | null> {
  const key = JSON.stringify(exercises.map((e) => [e.id, e.exerciseId]));
  return useMemo(() => {
    const map = new Map<string, SetEntry[] | null>();
    if (!history) return map;
    const seen = new Map<string, number>();
    for (const [weId, exId] of JSON.parse(key) as [string, string][]) {
      const occurrence = seen.get(exId) ?? 0;
      seen.set(exId, occurrence + 1);
      map.set(weId, previousInstanceSets(history, exId, { mode, routineId, occurrence }));
    }
    return map;
  }, [key, history, mode, routineId]);
}

/** Current time, re-rendered every `intervalMs` (and immediately when the app becomes visible). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const t = window.setInterval(tick, intervalMs);
    const onVis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [intervalMs]);
  return now;
}
