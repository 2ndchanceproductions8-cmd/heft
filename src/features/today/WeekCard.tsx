import { useMemo } from 'react';
import { useTargets } from '../../lib/nutrition/store';
import { useWorkouts } from '../../lib/workouts';
import { lastDays } from '../../lib/today';
import { useMealsInDays, useMeasurements } from './data';
import { WEEK_LEN } from './week/model';
import { WeekCardSkeleton, WeekCardView } from './week/WeekCardView';

/**
 * "Last 7 days" on Today: weigh-ins and the weight trend, kcal eaten vs target, and workouts, lined up by day
 * (week/WeekCardView.tsx draws it; week/model.ts holds the math). Reads its own data; a skeleton of the same
 * height while IndexedDB answers.
 */
export function WeekCard({ today, now }: { today: string; now: number }) {
  void now; // day keys are enough here; the window rolls with `today`
  const first = useMemo(() => lastDays(today, WEEK_LEN)[0], [today]);
  const meals = useMealsInDays(first, today);
  const workouts = useWorkouts();
  const measurements = useMeasurements();
  // Targets come with the stored settings in the same read, so the unit is never the lb default for a moment.
  const targets = useTargets();

  if (!meals || !workouts || !measurements || !targets) return <WeekCardSkeleton />;
  return (
    <WeekCardView
      today={today}
      meals={meals}
      workouts={workouts}
      measurements={measurements}
      targets={targets.targets}
      trainingMarks={targets.profile.trainingDays}
      runningToday={targets.training?.source === 'running'}
      unit={targets.settings.unit}
    />
  );
}
