import { useSyncExternalStore } from 'react';

/*
 * Which meals runAnalysis (analyze.ts) is analyzing in THIS app session. Tiny and dependency-free on purpose, so
 * the landing page (Today's Fuel card) can read it without loading the whole photo/Claude pipeline.
 */

const running = new Set<string>();
const listeners = new Set<() => void>();

/** Tell subscribers an analysis started or finished. */
export function notifyRunning(): void {
  for (const l of [...listeners]) l();
}

/** Called on every start/finish; returns the unsubscribe. */
export function subscribeRunning(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// runAnalysis's bookkeeping (analyze.ts); it calls notifyRunning itself.
export function addRunning(id: string): void {
  running.add(id);
}

export function deleteRunning(id: string): void {
  running.delete(id);
}

/** True while runAnalysis(mealId) is in flight in THIS app session. */
export function isAnalysisRunning(mealId: string): boolean {
  return running.has(mealId);
}

/**
 * A meal stuck in 'analyzing' with no run in this session was interrupted (iOS killed the app mid-call).
 * Callers show Retry for it instead of a spinner.
 */
export function analysisInterrupted(meal: { id: string; status: string }): boolean {
  return meal.status === 'analyzing' && !running.has(meal.id);
}

/** React hook: re-renders when any analysis starts/finishes; returns isAnalysisRunning(mealId). */
export function useAnalysisRunning(mealId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribeRunning,
    () => (mealId ? running.has(mealId) : false),
    () => false,
  );
}
