// CONTRACT STUB (foundation). The engine builder replaces the bodies; signatures are fixed.

/**
 * Analyze a meal end to end: status → 'analyzing' (force) → Claude → USDA grounding → items/totals/confidence
 * → 'done' (or 'failed' with a readable error; photos kept). Safe to call twice: a second call for the same
 * id while one is running returns the same promise. Resolves when finished; never throws.
 */
export async function runAnalysis(_mealId: string): Promise<void> {
  throw new Error('not implemented: analyze.runAnalysis');
}

/** True while runAnalysis(mealId) is in flight in THIS app session. */
export function isAnalysisRunning(_mealId: string): boolean {
  return false;
}

/**
 * A meal stuck in 'analyzing' with no run in this session was interrupted (iOS killed the app mid-call).
 * Callers show Retry for it instead of a spinner.
 */
export function analysisInterrupted(_meal: { id: string; status: string }): boolean {
  return false;
}

/** React hook: re-renders when any analysis starts/finishes; returns isAnalysisRunning(mealId). */
export function useAnalysisRunning(_mealId: string | null | undefined): boolean {
  return false;
}
