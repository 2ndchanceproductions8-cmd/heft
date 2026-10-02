import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, ChevronLeft, Trash2 } from 'lucide-react';
import type { Workout } from '../../types';
import { Button, Loading, Page, SectionHeader, Spinner, TextArea, TextField, TopBar, confirm, toast } from '../../components/ui';
import { db } from '../../db';
import { countDoneSets, workoutVolumeKg } from '../../lib/calc';
import { estimateCalories } from '../../lib/calories';
import { useExercises } from '../../lib/ExerciseProvider';
import { typeFields } from '../../lib/exerciseMeta';
import { deleteMedia } from '../../lib/media';
import { planRoutineUpdate, updateRoutineFromWorkout } from '../../lib/routines';
import { currentBodyweightKg, useSettings } from '../../lib/settings';
import { formatClock, formatVolume } from '../../lib/units';
import { useWorkouts } from '../../lib/workouts';
import {
  EMPTY_FINISH_DRAFT,
  useWorkoutStore,
  type FinishDraft,
  type FinishMeta,
  type LiveWorkout,
} from '../../lib/workoutStore';
import { useBests, useLivePRs } from './LoggerContext';
import { CaloriesCard, PhotoPicker, StartTimeField, SummaryStat } from './SummaryFields';
import { promptDuration } from './prompts';
import { finalizeDoneSets, routineUpdateMessage } from './logic';

/** /workout/finish — "Save Workout": title, time, calories, photos and description. */
export function FinishWorkoutPage() {
  const navigate = useNavigate();
  const index = useExercises();
  const hydrated = useWorkoutStore((s) => s.hydrated);
  const active = useWorkoutStore((s) => s.active);
  const [saving, setSaving] = useState(false);
  // Synchronous guard: a fast double tap fires twice before `saving` re-renders.
  const savingRef = useRef(false);

  // Lives here (not in the form) so it survives the active workout being cleared mid-save.
  const save = async (meta: FinishMeta, routineId: string | null) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    // Read before finish() clears the active workout: which cards were split off by a variant switch (they
    // keep their routine link, so "Update routine" needs this to keep the slot on the original machine).
    const splits = useWorkoutStore.getState().active?.variantSplits;
    let saved: Workout;
    try {
      saved = await useWorkoutStore.getState().finish(meta);
    } catch (e) {
      console.error(e);
      toast('Could not save workout. Please try again.', 'error');
      savingRef.current = false;
      setSaving(false);
      return;
    }
    try {
      const routine = routineId ? await db.routines.get(routineId) : undefined;
      // One path (lib/routines.ts): exercises pair with their routine slot by link, then by exerciseId; a
      // swapped variant takes its slot; sets done on another machine after a split keep the slot's plan.
      const plan = routine ? planRoutineUpdate(routine, saved, splits) : null;
      if (routine && plan?.changed) {
        const update = await confirm({
          title: 'Update routine?',
          message: routineUpdateMessage(routine.name, plan, (id) => index.get(id).name),
          confirmLabel: 'Update Routine',
          cancelLabel: 'Keep Original',
        });
        if (update) {
          await updateRoutineFromWorkout(routine.id, saved, splits);
          toast('Routine updated', 'success');
        }
      }
    } catch (e) {
      console.error(e);
      toast('Workout saved, but the routine could not be updated', 'error');
    }
    navigate(`/history/${saved.id}?celebrate=1`, { replace: true });
  };

  if (!hydrated || (saving && !active)) {
    return (
      <Page>
        <TopBar title="Save Workout" />
        <Loading />
      </Page>
    );
  }
  if (!active) return <Navigate to="/workout" replace />;
  return <FinishForm active={active} saving={saving} onSave={save} />;
}

function FinishForm({
  active,
  saving,
  onSave,
}: {
  active: LiveWorkout;
  saving: boolean;
  onSave: (meta: FinishMeta, routineId: string | null) => Promise<void>;
}) {
  const navigate = useNavigate();
  const index = useExercises();
  const settings = useSettings();
  // undefined while loading (so the "set your body weight" warning doesn't flash), null when not set.
  const bodyweightLoaded = useLiveQuery(() => currentBodyweightKg(), []);
  const bodyweightKg = bodyweightLoaded ?? null;
  const workouts = useWorkouts();
  const setName = useWorkoutStore((s) => s.setName);
  const setNotes = useWorkoutStore((s) => s.setNotes);

  const [openedAt] = useState(() => Date.now());
  // The draft lives in the active workout (persisted with it), so a reload or the app being killed while the
  // camera is open keeps it, and a photo that finishes saving after the user went back to the logger is
  // still attached. Returns false when the workout is no longer active (the caller cleans up).
  const draft: FinishDraft = { ...EMPTY_FINISH_DRAFT, ...active.finishDraft };
  const setDraft = (patch: Partial<FinishDraft> | ((d: FinishDraft) => Partial<FinishDraft>)) =>
    useWorkoutStore.getState().setFinishDraft(active.id, typeof patch === 'function' ? patch : () => patch);

  const autoDuration = Math.max(1, Math.round((openedAt - active.startedAt) / 1000));
  const durationSec = draft.durationSec ?? autoDuration;
  const startedAt = draft.startedAt ?? active.startedAt;

  // Exactly what Save keeps (a ticked set whose value was cleared again is dropped; see finalizeDoneSets).
  const exercises = useMemo(
    () => finalizeDoneSets(active.exercises, (id) => typeFields(index.get(id).type)).exercises,
    [active.exercises, index],
  );
  const volume = useMemo(() => workoutVolumeKg(exercises, (id) => index.get(id).type), [exercises, index]);
  const doneSets = useMemo(() => countDoneSets(exercises), [exercises]);
  const bests = useBests(workouts);
  const prs = useLivePRs(exercises, bests);
  const estimate = estimateCalories({ durationSec, bodyweightKg, exercises, getExercise: index.get });

  const [photoBusy, setPhotoBusy] = useState(false);
  // Nothing to save → this screen shouldn't be reachable, but guard anyway. Wait for photos being processed.
  const canSave = doneSets > 0 && !saving && !photoBusy;

  useEffect(() => {
    // Stop a running rest timer: the workout is over.
    useWorkoutStore.getState().stopRest();
  }, []);

  const leaving = useRef(false);
  const back = () => {
    if (leaving.current) return; // a double tap would go back twice (past the logger)
    leaving.current = true;
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/workout/active', { replace: true });
  };

  const save = () => {
    if (!canSave) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    void onSave(
      {
        name: active.name,
        notes: active.notes,
        startedAt,
        durationSec,
        photoIds: draft.photoIds,
        calories: draft.manualCalories ?? estimate.total,
        caloriesManual: draft.manualCalories != null,
        bodyweightKg,
      },
      active.routineId ?? null,
    );
  };

  const discard = async () => {
    const ok = await confirm({
      title: 'Discard workout?',
      message: 'Everything logged in this workout will be deleted.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    navigate('/workout', { replace: true });
    useWorkoutStore.getState().discard(); // also deletes the photos added here
  };

  const editDuration = async () => {
    const v = await promptDuration(durationSec);
    if (v != null) setDraft({ durationSec: v });
  };

  return (
    <Page>
      <TopBar
        left={
          <button
            type="button"
            aria-label="Back to workout"
            onClick={back}
            className="flex h-10 items-center pr-2 pl-1 text-accent active:opacity-60"
          >
            <ChevronLeft className="h-7 w-7" strokeWidth={2.2} />
          </button>
        }
        title="Save Workout"
        right={
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className="flex h-10 items-center px-3 text-[17px] font-semibold text-accent disabled:opacity-40"
          >
            {saving ? <Spinner className="h-5 w-5 text-accent" /> : 'Save'}
          </button>
        }
      />

      <div className="space-y-4 px-4 pt-4">
        <TextField
          aria-label="Workout title"
          value={active.name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workout title"
          className="h-12 text-[18px] font-semibold"
          maxLength={80}
        />

        <div className="grid grid-cols-4 gap-1 rounded-2xl bg-surface p-2">
          <SummaryStat label="Duration" value={formatClock(durationSec)} onClick={() => void editDuration()} accent />
          <SummaryStat label="Volume" value={formatVolume(volume, settings.unit)} />
          <SummaryStat label="Sets" value={doneSets} />
          <SummaryStat label="Records" value={bests ? prs.length : '-'} />
        </div>

        {doneSets === 0 ? (
          <div className="flex items-start gap-2 rounded-2xl bg-warn-soft px-4 py-3 text-[14px] leading-snug">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            No completed sets yet. Go back and tick off at least one set to save this workout.
          </div>
        ) : null}

        <StartTimeField value={startedAt} onChange={(ms) => setDraft({ startedAt: ms })} />

        <CaloriesCard
          estimate={bodyweightLoaded === undefined ? { ...estimate, assumedBodyweight: false } : estimate}
          manual={draft.manualCalories}
          onManualChange={(kcal) => setDraft({ manualCalories: kcal })}
        />
      </div>

      <SectionHeader>Photos</SectionHeader>
      <div className="px-4">
        <PhotoPicker
          photoIds={draft.photoIds}
          onAdd={(ids) => {
            // Finished saving after the workout was saved or discarded: nothing to attach them to.
            if (!setDraft((d) => ({ photoIds: [...d.photoIds, ...ids] }))) void deleteMedia(ids).catch(() => undefined);
          }}
          onRemove={(id) => {
            setDraft((d) => ({ photoIds: d.photoIds.filter((p) => p !== id) }));
            void deleteMedia([id]).catch(() => undefined);
          }}
          onBusyChange={setPhotoBusy}
        />
      </div>

      <SectionHeader>Description</SectionHeader>
      <div className="px-4">
        <TextArea
          aria-label="Description"
          value={active.notes ?? ''}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="How did it go? Add notes about your workout..."
          rows={3}
        />
      </div>

      <div className="space-y-3 px-4 pt-6">
        <Button block size="lg" onClick={save} disabled={!canSave}>
          {saving ? <Spinner className="h-5 w-5 text-on-accent" /> : null}
          Save Workout
        </Button>
        <Button
          block
          size="lg"
          variant="danger"
          onClick={() => void discard()}
          disabled={saving}
          icon={<Trash2 className="h-5 w-5" />}
        >
          Discard Workout
        </Button>
      </div>
    </Page>
  );
}
