import { memo, useEffect } from 'react';
import { useRestTimer } from '../../lib/restTimer';
import { useSettings } from '../../lib/settings';
import { useWakeLock } from '../../lib/wakeLock';
import { useWorkoutStore } from '../../lib/workoutStore';
import { scheduleOrphanMediaSweep } from './mediaSweep';

/**
 * Invisible, mounted once in the app root (AppShell) so it covers every route while a workout runs:
 * - fires the "rest complete" alert (the logger and the mini workout bar also watch the timer; the alert
 *   fires once per rest however many watchers there are);
 * - holds the "Keep screen awake" lock for the whole running workout, not just while the logger is open
 *   (minimized, or checking an exercise during a rest, the phone must not lock and suspend the timer alert);
 * - once per launch, removes photo blobs that nothing refers to any more (see mediaSweep).
 */
export function RestTimerWatcher() {
  useRestTimer();
  useEffect(() => scheduleOrphanMediaSweep(), []);
  return <WorkoutWakeLock />;
}

/** Separate (memoized) so the 4x/s rest ticks and settings reads don't re-render anything else. */
const WorkoutWakeLock = memo(function WorkoutWakeLock() {
  const { keepAwake } = useSettings();
  const running = useWorkoutStore((s) => s.hydrated && !!s.active);
  useWakeLock(keepAwake && running);
  return null;
});
