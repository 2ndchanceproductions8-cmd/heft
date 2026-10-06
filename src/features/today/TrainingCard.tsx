import { useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';
import { toast } from '../../components/ui';
import { DEFAULT_SETTINGS } from '../../lib/settings';
import { beginWorkout } from '../../lib/startWorkout';
import { useActiveWorkout, useWorkoutStore } from '../../lib/workoutStore';
import { useWorkouts } from '../../lib/workouts';
import { healthNudge } from './training/model';
import { TrainingCardSkeleton, TrainingCardView } from './training/TrainingCardView';

/**
 * Today's Training card: a running workout (Resume), today's finished workouts or the last one, this week vs last
 * week, the Apple Health "not sent" nudge, and Start empty workout / Routines. The look is TrainingCardView.
 */
export function TrainingCard({ today, now }: { today: string; now: number }) {
  const navigate = useNavigate();
  const workouts = useWorkouts();
  // The settings row itself rather than useSettings(): undefined while IndexedDB answers, so a kg user never sees
  // the volume flash in lb (or the week bounds move) when the defaults are swapped for the stored settings.
  const row = useLiveQuery(() => db.settings.get('settings').then((s) => s ?? null), []);
  const settings = useMemo(() => (row ? { ...DEFAULT_SETTINGS, ...row } : DEFAULT_SETTINGS), [row]);
  const active = useActiveWorkout();
  const hydrated = useWorkoutStore((s) => s.hydrated);
  const nudge = useMemo(
    () => (workouts ? healthNudge(workouts, settings, now) : null),
    [workouts, settings, now],
  );

  const starting = useRef(false);
  const startEmpty = async () => {
    if (starting.current) return;
    starting.current = true;
    try {
      await beginWorkout({ type: 'empty' }, navigate);
    } catch (e) {
      console.error(e);
      toast('Could not start the workout', 'error');
    } finally {
      starting.current = false;
    }
  };

  // Wait for the stored active workout too, so "Start empty workout" never flashes before "Resume".
  if (workouts === undefined || row === undefined || !hydrated) return <TrainingCardSkeleton />;

  return (
    <TrainingCardView
      workouts={workouts}
      today={today}
      now={now}
      unit={settings.unit}
      weekStartsOn={settings.weekStartsOn}
      active={active ? { name: active.name, startedAt: active.startedAt } : null}
      nudge={nudge}
      onStartEmpty={() => void startEmpty()}
    />
  );
}
