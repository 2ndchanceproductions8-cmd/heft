import { useDayMeals, useTargets } from '../../lib/nutrition/store';
import { useInterruptedAnalyses } from './fuel/interrupted';
import { FuelCardView } from './fuel/FuelCardView';

export { FuelCardView, type FuelCardViewProps } from './fuel/FuelCardView';

/**
 * Today's Food card, live. Today's meals in every status come from one query (the unfinished ones are the
 * non-done rows of the same day, so the totals and the "not counted yet" lines always agree).
 */
export function FuelCard({ today, now }: { today: string; now: number }) {
  void now; // nothing here depends on the time of day; `today` rolls over at midnight
  const meals = useDayMeals(today);
  const targets = useTargets();
  const interrupted = useInterruptedAnalyses(meals);
  return <FuelCardView meals={meals} targets={targets} interrupted={interrupted} />;
}
