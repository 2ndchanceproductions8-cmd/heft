import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { CustomExercise, Exercise, ExerciseOverride } from '../types';
import { buildExerciseIndex, type ExerciseIndex } from './exercises';

const ExerciseCtx = createContext<ExerciseIndex | null>(null);

/**
 * Loads custom exercises + overrides once and shares the resolved index app-wide. While IndexedDB is still
 * answering (a few ms) unknown ids resolve to a neutral "…" placeholder instead of "Deleted exercise".
 */
export function ExerciseProvider({ children }: { children: ReactNode }) {
  const data = useLiveQuery(
    async (): Promise<[CustomExercise[], ExerciseOverride[]]> => [
      await db.customExercises.toArray(),
      await db.overrides.toArray(),
    ],
    [],
  );
  const index = useMemo(() => (data ? buildExerciseIndex(data[0], data[1]) : buildExerciseIndex([], [], { loading: true })), [data]);
  return <ExerciseCtx.Provider value={index}>{children}</ExerciseCtx.Provider>;
}

export function useExercises(): ExerciseIndex {
  const ctx = useContext(ExerciseCtx);
  if (!ctx) throw new Error('useExercises must be used inside <ExerciseProvider>');
  return ctx;
}

export function useExercise(id: string | null | undefined): Exercise | undefined {
  const index = useExercises();
  return id ? index.get(id) : undefined;
}
