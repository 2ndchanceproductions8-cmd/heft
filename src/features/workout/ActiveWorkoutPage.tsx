import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Navigate, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { ChevronDown, Trash2 } from 'lucide-react';
import type { ActiveWorkout } from '../../types';
import { Button, Loading, Page, TopBar, confirm } from '../../components/ui';
import { countDoneSets, workoutVolumeKg } from '../../lib/calc';
import { estimateCalories } from '../../lib/calories';
import { useExercises } from '../../lib/ExerciseProvider';
import { typeFields } from '../../lib/exerciseMeta';
import { useBodyweightKg, useSettings } from '../../lib/settings';
import { formatClock, formatVolume } from '../../lib/units';
import { useWorkouts } from '../../lib/workouts';
import { useWorkoutStore } from '../../lib/workoutStore';
import { WorkoutExerciseList } from './ExerciseList';
import { useNow, type ExerciseOps } from './LoggerContext';
import { RestTimerBar } from './RestTimerBar';
import { REST_BAR_SPACE, finalizeDoneSets, pendingSetCount, supersetContinues } from './logic';

/*
 * Navigation model: the logger is an overlay pushed on top of the page it was opened from (mini bar,
 * Resume card, routine Start...). Minimize goes back one entry instead of pushing /workout, so
 * minimize/resume cycles never grow the history and system Back behaves like Minimize. The "Keep screen
 * awake" lock is held by RestTimerWatcher (mounted at the app root), so it lasts while the logger is minimized.
 */

const historyIdx = () => (window.history.state as { idx?: number } | null)?.idx ?? 0;

/**
 * Where the logger was scrolled to for the running workout. Resuming is a new history entry, which the root
 * ScrollRestoration opens at the top; this puts the user back at the set they were doing.
 */
let scrollMemory: { workoutId: string; y: number } | null = null;

function useLoggerScrollMemory(workoutId: string) {
  // A layout effect of the route runs after the root <ScrollRestoration>'s (it renders before the outlet),
  // so this wins over its scroll-to-top, before anything is painted.
  useLayoutEffect(() => {
    if (scrollMemory?.workoutId === workoutId && scrollMemory.y > 0) window.scrollTo(0, scrollMemory.y);
    // Cleanup runs while the logger's DOM is still in place, so scrollY is still the logger's.
    return () => {
      scrollMemory = { workoutId, y: window.scrollY };
    };
  }, [workoutId]);
}

/** Key of the logger entry a workout was just discarded from (that entry is being replaced by /workout). */
let discardedOnKey: string | null = null;

/** /workout/active — the live workout logger (Hevy "Log Workout"). */
export function ActiveWorkoutPage() {
  const hydrated = useWorkoutStore((s) => s.hydrated);
  const active = useWorkoutStore((s) => s.active);
  if (!hydrated) {
    return (
      <Page>
        <TopBar title="Log Workout" />
        <Loading />
      </Page>
    );
  }
  if (!active) return <NoWorkout />;
  return <Logger active={active} />;
}

/** No running workout: the workout ended, or this is a stale history entry of one. */
function NoWorkout() {
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  // Back/Forward onto the logger entry of a workout that has ended: skip over it rather than stopping on
  // /workout. Not when the workout was just discarded here (that flow is already replacing this entry).
  const skip = navType === 'POP' && historyIdx() > 0 && location.key !== discardedOnKey;
  const skipped = useRef(false);
  useEffect(() => {
    if (!skip || skipped.current) return;
    skipped.current = true;
    navigate(-1);
  }, [skip, navigate]);
  return skip ? null : <Navigate to="/workout" replace />;
}

function Logger({ active }: { active: ActiveWorkout }) {
  const navigate = useNavigate();
  const location = useLocation();
  const settings = useSettings();
  const history = useWorkouts();
  const index = useExercises();
  const resting = !!active.rest;
  useLoggerScrollMemory(active.id);

  const leaving = useRef(false);
  useEffect(() => {
    leaving.current = false;
  }, [location.key]);
  const minimize = () => {
    if (leaving.current) return; // a double tap would go back twice
    leaving.current = true;
    if (historyIdx() > 0) navigate(-1);
    else navigate('/workout', { replace: true }); // deep link / reload: no in-app page below
  };
  /** Leave for good after the workout was thrown away (this entry is replaced, so Back can't return to it). */
  const leaveDiscarded = () => {
    discardedOnKey = location.key;
    navigate('/workout', { replace: true });
    useWorkoutStore.getState().discard(); // also deletes photos added on the Save Workout screen
  };

  // Store actions are stable; route them through the shared ExerciseOps interface.
  const ops = useMemo<ExerciseOps>(() => {
    const s = () => useWorkoutStore.getState();
    return {
      addExercises: (items, opts) => s().addExercises(items, opts),
      removeExercise: (weId) => s().removeExercise(weId),
      replaceExercise: (weId, id) => s().replaceExercise(weId, id),
      switchVariant: (weId, id, moveDone, newId) => s().switchVariant(weId, id, moveDone, newId),
      reorderExercises: (ids) => s().reorderExercises(ids),
      updateExercise: (weId, patch) => s().updateExercise(weId, patch),
      setSuperset: (ids) => s().setSuperset(ids),
      removeFromSuperset: (weId) => s().removeFromSuperset(weId),
      addSet: (weId, partial) => s().addSet(weId, partial),
      removeSet: (weId, setId) => s().removeSet(weId, setId),
      updateSet: (weId, setId, patch) => s().updateSet(weId, setId, patch),
    };
  }, []);

  const onSetCompleted = (weId: string, setId: string, restSec: number) => {
    const st = useWorkoutStore.getState();
    const exercises = st.active?.exercises ?? [];
    // In a superset the rest starts after the last exercise of the round.
    if (restSec > 0 && !supersetContinues(exercises, weId)) st.startRest(weId, setId, restSec);
  };

  // One Finish/Discard flow at a time (a double tap would queue two dialogs / navigate twice).
  const busy = useRef(false);
  /** `fn` resolves true when it navigated away — the lock then stays on until this screen unmounts. */
  const guarded = (fn: () => Promise<boolean>) => async () => {
    if (busy.current) return;
    busy.current = true;
    let left = false;
    try {
      left = await fn();
    } finally {
      if (!left) busy.current = false;
    }
  };

  const discard = guarded(async () => {
    const ok = await confirm({
      title: 'Discard workout?',
      message: 'Everything logged in this workout will be deleted.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return false;
    leaveDiscarded();
    return true;
  });

  const finish = guarded(async () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const exercises = useWorkoutStore.getState().active?.exercises ?? [];
    // What Finish will really save: a ticked set whose required value was cleared again is dropped.
    const { exercises: saved, dropped } = finalizeDoneSets(exercises, (id) => typeFields(index.get(id).type));
    if (countDoneSets(saved) === 0) {
      const discardIt = await confirm({
        title: 'No completed sets',
        message: 'Tick off at least one set to save this workout. Do you want to discard it instead?',
        confirmLabel: 'Discard Workout',
        cancelLabel: 'Keep Logging',
        danger: true,
      });
      if (!discardIt) return false;
      leaveDiscarded();
      return true;
    }
    const pending = pendingSetCount(exercises) + dropped;
    if (pending > 0) {
      const ok = await confirm({
        title: 'Unfinished sets',
        message:
          pending === 1
            ? "1 set is not completed (or empty) and won't be saved."
            : `${pending} sets are not completed (or empty) and won't be saved.`,
        confirmLabel: 'Finish anyway',
      });
      if (!ok) return false;
    }
    useWorkoutStore.getState().stopRest();
    navigate('/workout/finish');
    return true;
  });

  return (
    <Page>
      <div style={{ paddingBottom: resting ? REST_BAR_SPACE : 0 }}>
        <TopBar
          left={
            <button
              type="button"
              aria-label="Minimize"
              title="Minimize"
              onClick={minimize}
              className="flex h-10 w-10 items-center justify-center rounded-full text-fg active:bg-surface-2"
            >
              <ChevronDown className="h-7 w-7" strokeWidth={2.2} />
            </button>
          }
          title="Log Workout"
          right={
            <Button size="md" onClick={() => void finish()} className="mr-1 px-4">
              Finish
            </Button>
          }
        >
          <LiveStats active={active} />
        </TopBar>

        <WorkoutExerciseList
          mode="active"
          exercises={active.exercises}
          ops={ops}
          settings={settings}
          history={history}
          routineId={active.routineId}
          onSetCompleted={onSetCompleted}
          announcePRs
          footer={
            <Button
              block
              variant="danger"
              size="lg"
              onClick={() => void discard()}
              icon={<Trash2 className="h-5 w-5" />}
            >
              Discard Workout
            </Button>
          }
        />
      </div>
      <RestTimerBar />
    </Page>
  );
}

/** Duration / Volume / Sets / Calories — ticks every second (isolated so the cards don't re-render). */
function LiveStats({ active }: { active: ActiveWorkout }) {
  const now = useNow(1000);
  const index = useExercises();
  const settings = useSettings();
  const bodyweightKg = useBodyweightKg();
  const elapsed = Math.max(0, (now - active.startedAt) / 1000);
  const volume = useMemo(
    () => workoutVolumeKg(active.exercises, (id) => index.get(id).type),
    [active.exercises, index],
  );
  const sets = useMemo(() => countDoneSets(active.exercises), [active.exercises]);
  const kcal = estimateCalories({
    durationSec: elapsed,
    bodyweightKg,
    exercises: active.exercises,
    getExercise: index.get,
  }).total;

  return (
    <div className="grid grid-cols-4 gap-1 px-4 pt-0.5 pb-2.5">
      <Cell label="Duration" value={formatClock(elapsed)} accent />
      <Cell label="Volume" value={formatVolume(volume, settings.unit)} />
      <Cell label="Sets" value={String(sets)} />
      <Cell label="Calories" value={`${kcal.toLocaleString()} kcal`} />
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={accent ? 'truncate text-[15px] font-semibold text-accent tabular-nums' : 'truncate text-[15px] font-semibold tabular-nums'}>
        {value}
      </div>
    </div>
  );
}
