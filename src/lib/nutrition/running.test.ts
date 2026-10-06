import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as analyze from './analyze';
import { createMeal } from './store';
import {
  addRunning,
  analysisInterrupted,
  deleteRunning,
  isAnalysisRunning,
  notifyRunning,
  subscribeRunning,
  useAnalysisRunning,
} from './running';

describe('analysis run registry (running.ts)', () => {
  it('imports nothing but react, so Today can read it without loading the pipeline', () => {
    const src = readFileSync(join(__dirname, 'running.ts'), 'utf8');
    const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports).toEqual(['react']);
  });

  it('analyze.ts re-exports the same functions, so existing callers keep working', () => {
    expect(analyze.isAnalysisRunning).toBe(isAnalysisRunning);
    expect(analyze.analysisInterrupted).toBe(analysisInterrupted);
    expect(analyze.useAnalysisRunning).toBe(useAnalysisRunning);
  });

  it('tracks ids and notifies subscribers until they unsubscribe', () => {
    const cb = vi.fn();
    const off = subscribeRunning(cb);
    addRunning('m_x');
    expect(isAnalysisRunning('m_x')).toBe(true);
    expect(analysisInterrupted({ id: 'm_x', status: 'analyzing' })).toBe(false);
    notifyRunning();
    expect(cb).toHaveBeenCalledTimes(1);
    deleteRunning('m_x');
    expect(isAnalysisRunning('m_x')).toBe(false);
    expect(analysisInterrupted({ id: 'm_x', status: 'analyzing' })).toBe(true);
    off();
    notifyRunning();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('runAnalysis registers the run here and notifies on start and finish', async () => {
    const meal = await createMeal({ input: { kind: 'text', description: 'toast' }, status: 'pending' });
    const seen: boolean[] = [];
    const off = subscribeRunning(() => seen.push(isAnalysisRunning(meal.id)));
    const p = analyze.runAnalysis(meal.id, { getApiKey: () => null }); // no key: ends quickly as 'pending'
    expect(isAnalysisRunning(meal.id)).toBe(true);
    await p;
    off();
    expect(isAnalysisRunning(meal.id)).toBe(false);
    expect(seen).toEqual([true, false]);
  });
});
