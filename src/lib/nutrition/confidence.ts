import type { Confidence, LookupStatus, NutrientSource } from './types';

/*
 * The confidence shown on a meal. Grounding the numbers in a database raises trust, a weighed portion
 * removes the biggest error source, but portion uncertainty still caps it: WITHOUT a user weight or a scale
 * reference in the photo, a portion is a guess from pixels, so the result is never better than 'medium'
 * (that cap is applied last, always).
 */

const LEVELS: readonly Confidence[] = ['low', 'medium', 'high'];
const rank = (c: Confidence) => LEVELS.indexOf(c);

export interface ConfidenceInput {
  /** What Claude said. */
  model: Confidence;
  items: { source: NutrientSource; lookup?: LookupStatus }[];
  hasUserWeight: boolean;
  hasScaleRef: boolean;
}

/** Every item's numbers come from a database (USDA or a product label). */
export function allItemsMatched(items: ConfidenceInput['items']): boolean {
  return items.length > 0 && items.every((i) => i.source === 'usda' || i.source === 'off');
}

export function finalConfidence({ model, items, hasUserWeight, hasScaleRef }: ConfidenceInput): Confidence {
  const start = rank(model);
  let score = start < 0 ? 0 : start;
  const matched = allItemsMatched(items);
  if (matched) score += 1;
  if (hasUserWeight) score += 1;
  score = Math.min(2, score);
  // Claude unsure about the food itself and a database didn't back every item: don't claim 'high'.
  if (model === 'low' && !matched) score = Math.min(score, 1);
  // No weight and no reference object: the portion is an estimate, whatever else matched.
  if (!hasUserWeight && !hasScaleRef) score = Math.min(score, 1);
  return LEVELS[score];
}
