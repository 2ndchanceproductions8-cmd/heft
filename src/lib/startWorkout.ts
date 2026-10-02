import type { NavigateFunction } from 'react-router-dom';
import { confirm } from '../components/ui/dialogs';
import type { Routine, Workout } from '../types';
import { useWorkoutStore } from './workoutStore';

export type StartKind = { type: 'empty' } | { type: 'routine'; routine: Routine } | { type: 'repeat'; workout: Workout };

/**
 * Start a workout and open the logger. If one is already running, asks whether to discard it first
 * (cancel = go back to the running workout). Returns true when a new workout was started.
 */
export async function beginWorkout(kind: StartKind, navigate: NavigateFunction): Promise<boolean> {
  const store = useWorkoutStore.getState();
  if (!store.hydrated) await store.hydrate();
  if (useWorkoutStore.getState().active) {
    const ok = await confirm({
      title: 'Workout in progress',
      message: 'You already have a workout running. Discard it and start a new one?',
      confirmLabel: 'Discard & Start',
      cancelLabel: 'Resume',
      danger: true,
    });
    if (!ok) {
      navigate('/workout/active');
      return false;
    }
  }
  const s = useWorkoutStore.getState();
  if (kind.type === 'empty') s.startEmpty();
  else if (kind.type === 'routine') s.startFromRoutine(kind.routine);
  else s.startFromWorkout(kind.workout);
  navigate('/workout/active');
  return true;
}
