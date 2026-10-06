import { useMemo, useSyncExternalStore } from 'react';
import { isAnalysisRunning, subscribeRunning } from '../../../lib/nutrition/running';
import type { Meal } from '../../../lib/nutrition/types';
import { interruptedIds } from './model';

/*
 * Which of today's 'analyzing' meals lost their run (iOS killed the app mid-call), so the card says "needs a
 * retry" instead of "still analyzing" forever. Today reads only the tiny in-session run registry
 * (lib/nutrition/running.ts), never the Claude + USDA pipeline, so nothing is loaded on demand and the answer is
 * right on the first paint. It re-renders when a run starts or ends in this session; the status writes that go
 * with a run re-render the card through its live query too.
 */

const NONE: ReadonlySet<string> = new Set();

/** Ids of `meals` stuck in 'analyzing' with no run alive in this app session. */
export function useInterruptedAnalyses(meals: readonly Meal[] | undefined): ReadonlySet<string> {
  // A string snapshot: useSyncExternalStore compares with Object.is, so a fresh Set every call would loop.
  const snapshot = () => [...interruptedIds(meals ?? [], isAnalysisRunning)].join('\n');
  // The same function as the server snapshot, so renderToString (the tests) sees the real value.
  const key = useSyncExternalStore(subscribeRunning, snapshot, snapshot);
  return useMemo(() => (key ? new Set(key.split('\n')) : NONE), [key]);
}
