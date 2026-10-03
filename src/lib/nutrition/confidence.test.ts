import { describe, expect, it } from 'vitest';
import { finalConfidence, type ConfidenceInput } from './confidence';
import type { Confidence, NutrientSource } from './types';

const usda = { source: 'usda' as const, lookup: 'ok' as const };
const est = { source: 'estimate' as const, lookup: 'no_match' as const };

describe('finalConfidence', () => {
  it.each<[string, ConfidenceInput, Confidence]>([
    ['all matched lifts medium → high when a scale ref anchors the portion', { model: 'medium', items: [usda, usda], hasUserWeight: false, hasScaleRef: true }, 'high'],
    ['all matched but no weight / scale ref → capped at medium', { model: 'medium', items: [usda, usda], hasUserWeight: false, hasScaleRef: false }, 'medium'],
    ['model high, nothing anchoring the portion → medium', { model: 'high', items: [usda], hasUserWeight: false, hasScaleRef: false }, 'medium'],
    ['model high + scale ref stays high', { model: 'high', items: [est], hasUserWeight: false, hasScaleRef: true }, 'high'],
    ['a user weight lifts one level when every item matched', { model: 'low', items: [usda], hasUserWeight: true, hasScaleRef: false }, 'high'],
    ['low + weight but an unmatched item → low (the weight lifts only grounded items)', { model: 'low', items: [usda, est], hasUserWeight: true, hasScaleRef: true }, 'low'],
    ['medium + weight, every item Claude’s estimate → medium, not high', { model: 'medium', items: [est, est], hasUserWeight: true, hasScaleRef: false }, 'medium'],
    ['low + weight, Claude’s estimate → low', { model: 'low', items: [est], hasUserWeight: true, hasScaleRef: false }, 'low'],
    ['medium + weight, one item matched and one not → medium', { model: 'medium', items: [usda, est], hasUserWeight: true, hasScaleRef: false }, 'medium'],
    ['low + matched + scale ref → medium', { model: 'low', items: [usda], hasUserWeight: false, hasScaleRef: true }, 'medium'],
    ['low + unmatched → low', { model: 'low', items: [est], hasUserWeight: false, hasScaleRef: true }, 'low'],
    ['medium + one estimate, scale ref → medium', { model: 'medium', items: [usda, est], hasUserWeight: false, hasScaleRef: true }, 'medium'],
    ['label products count as matched', { model: 'medium', items: [{ source: 'off', lookup: 'ok' }], hasUserWeight: true, hasScaleRef: false }, 'high'],
    ['no items never counts as matched', { model: 'medium', items: [], hasUserWeight: false, hasScaleRef: true }, 'medium'],
    ['rate-limited lookups are not matches', { model: 'medium', items: [{ source: 'estimate', lookup: 'rate_limited' }], hasUserWeight: false, hasScaleRef: true }, 'medium'],
  ])('%s', (_label, input, expected) => {
    expect(finalConfidence(input)).toBe(expected);
  });

  it('property: without a user weight AND without a scale reference the result is never high', () => {
    const models: Confidence[] = ['low', 'medium', 'high'];
    const sources: NutrientSource[] = ['usda', 'off', 'estimate', 'manual'];
    // every item list of length 0..3 over the four sources
    const lists: NutrientSource[][] = [[]];
    for (let len = 1; len <= 3; len++) {
      const prev = lists.filter((l) => l.length === len - 1);
      for (const p of prev) for (const s of sources) lists.push([...p, s]);
    }
    let checked = 0;
    for (const model of models)
      for (const list of lists) {
        const items = list.map((source) => ({ source, lookup: source === 'estimate' ? ('no_match' as const) : ('ok' as const) }));
        expect(finalConfidence({ model, items, hasUserWeight: false, hasScaleRef: false })).not.toBe('high');
        // and the anchors never LOWER the result
        const base = finalConfidence({ model, items, hasUserWeight: false, hasScaleRef: false });
        const order = { low: 0, medium: 1, high: 2 };
        for (const [w, s] of [[true, false], [false, true], [true, true]] as const) {
          expect(order[finalConfidence({ model, items, hasUserWeight: w, hasScaleRef: s })]).toBeGreaterThanOrEqual(order[base]);
        }
        checked++;
      }
    expect(checked).toBe(3 * (1 + 4 + 16 + 64));
  });

  it('property: a user weight never raises confidence unless every item matched a database', () => {
    const models: Confidence[] = ['low', 'medium', 'high'];
    const sources: NutrientSource[] = ['usda', 'off', 'estimate', 'manual'];
    const lists: NutrientSource[][] = [[]];
    for (let len = 1; len <= 3; len++) {
      const prev = lists.filter((l) => l.length === len - 1);
      for (const p of prev) for (const s of sources) lists.push([...p, s]);
    }
    let ungrounded = 0;
    for (const model of models)
      for (const list of lists) {
        if (list.length && list.every((s) => s === 'usda' || s === 'off')) continue;
        const items = list.map((source) => ({ source }));
        // with a scale reference the no-anchor cap is off either way, so only the weight differs
        expect(finalConfidence({ model, items, hasUserWeight: true, hasScaleRef: true })).toBe(finalConfidence({ model, items, hasUserWeight: false, hasScaleRef: true }));
        ungrounded++;
      }
    expect(ungrounded).toBe(3 * (1 + 2 + 12 + 56)); // lists that are empty or contain an estimate / manual item
  });
});
