import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import type { Workout, WorkoutExercise } from '../../types';
import {
  Button,
  EmptyState,
  Loading,
  Page,
  SectionHeader,
  Spinner,
  TextArea,
  TextField,
  TopBar,
  confirm,
  toast,
} from '../../components/ui';
import { countDoneSets, workoutVolumeKg } from '../../lib/calc';
import { estimateCalories } from '../../lib/calories';
import { useExercises } from '../../lib/ExerciseProvider';
import { typeFields } from '../../lib/exerciseMeta';
import { deleteMedia } from '../../lib/media';
import { useBodyweightKg, useSettings } from '../../lib/settings';
import { formatClock, formatVolume } from '../../lib/units';
import { saveWorkout, useWorkout, useWorkouts } from '../../lib/workouts';
import { completedExercises, exerciseListOps as L } from '../../lib/workoutStore';
import { WorkoutExerciseList } from './ExerciseList';
import { useBests, useLivePRs, type ExerciseOps } from './LoggerContext';
import { CaloriesCard, PhotoPicker, StartTimeField, SummaryStat } from './SummaryFields';
import { promptDuration } from './prompts';
import { finalizeDoneSets } from './logic';

/**
 * Unsaved edits per workout id, kept in memory so tapping an exercise name (→ exercise detail) and coming
 * back doesn't lose them. Cleared on save / cancel.
 */
interface EditSession {
  draft: Workout;
  initialJson: string;
  /** Photos added during this edit (deleted again if the edit is cancelled). */
  addedPhotos: string[];
  /** Original photos removed during this edit (deleted for real only on save). */
  removedPhotos: string[];
}
const sessions = new Map<string, EditSession>();

function startSession(w: Workout): EditSession {
  const draft: Workout = {
    ...w,
    // Saved sets are completed; make sure the editor shows them that way.
    exercises: w.exercises.map((we) => ({ ...we, sets: we.sets.map((s) => ({ ...s, done: true, target: null })) })),
    photoIds: [...(w.photoIds ?? [])],
  };
  return { draft, initialJson: JSON.stringify(draft), addedPhotos: [], removedPhotos: [] };
}

/** /history/:id/edit — edit a saved workout with the same cards as the live logger. */
export function EditWorkoutPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const workout = useWorkout(id);
  if (workout === undefined) {
    return (
      <Page>
        <TopBar title="Edit Workout" back />
        <Loading />
      </Page>
    );
  }
  if (workout === null) {
    return (
      <Page>
        <TopBar title="Edit Workout" back />
        <EmptyState
          icon={<SearchX className="h-7 w-7" />}
          title="Workout not found"
          message="It may have been deleted."
          action={<Button onClick={() => navigate('/history', { replace: true })}>Go to History</Button>}
        />
      </Page>
    );
  }
  return <EditForm key={workout.id} original={workout} />;
}

function EditForm({ original }: { original: Workout }) {
  const navigate = useNavigate();
  const index = useExercises();
  const settings = useSettings();
  const currentBodyweight = useBodyweightKg();
  const allWorkouts = useWorkouts();

  const restored = useRef(sessions.has(original.id));
  const [session, setSession] = useState<EditSession>(() => sessions.get(original.id) ?? startSession(original));
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  // Synchronous guard against a double tap (two saves would navigate back twice).
  const busy = useRef(false);
  const leaving = useRef(false);
  const draft = session.draft;

  useEffect(() => {
    if (!restored.current) return;
    restored.current = false;
    toast('Restored your unsaved changes', 'info');
  }, []);

  const update = (fn: (s: EditSession) => EditSession) =>
    setSession((s) => {
      const next = fn(s);
      sessions.set(original.id, next);
      return next;
    });
  const patchDraft = (patch: Partial<Workout> | ((d: Workout) => Partial<Workout>)) =>
    update((s) => ({ ...s, draft: { ...s.draft, ...(typeof patch === 'function' ? patch(s.draft) : patch) } }));
  const mapExercises = (fn: (list: WorkoutExercise[]) => WorkoutExercise[]) =>
    patchDraft((d) => ({ exercises: fn(d.exercises) }));

  const ops = useMemo<ExerciseOps>(
    () => ({
      addExercises: (items, opts) => mapExercises((l) => L.addExercises(l, items, opts)),
      removeExercise: (weId) => mapExercises((l) => L.removeExercise(l, weId)),
      replaceExercise: (weId, exId) => mapExercises((l) => L.replaceExercise(l, weId, exId)),
      switchVariant: (weId, exId, moveDone, newId) => mapExercises((l) => L.switchVariant(l, weId, exId, moveDone, newId)),
      reorderExercises: (ids) => mapExercises((l) => L.reorderExercises(l, ids)),
      updateExercise: (weId, patch) => mapExercises((l) => L.updateExercise(l, weId, patch)),
      setSuperset: (ids) => mapExercises((l) => L.setSuperset(l, ids)),
      removeFromSuperset: (weId) => mapExercises((l) => L.removeFromSuperset(l, weId)),
      addSet: (weId, partial) => mapExercises((l) => L.addSet(l, weId, { done: true, ...partial })),
      removeSet: (weId, setId) => mapExercises((l) => L.removeSet(l, weId, setId)),
      updateSet: (weId, setId, patch) => mapExercises((l) => L.updateSet(l, weId, setId, patch)),
    }),
    // setSession is stable and the form is keyed by workout id, so these never go stale.
    [],
  );

  // History for PREVIOUS / PRs: only workouts before this one.
  const history = useMemo(
    () => allWorkouts?.filter((w) => w.id !== original.id && w.startedAt < draft.startedAt),
    [allWorkouts, original.id, draft.startedAt],
  );
  const bests = useBests(history);
  const prs = useLivePRs(draft.exercises, bests);

  const bodyweightKg = draft.bodyweightKg ?? currentBodyweight;
  const estimate = estimateCalories({
    durationSec: draft.durationSec,
    bodyweightKg,
    exercises: draft.exercises,
    getExercise: index.get,
  });
  const volume = useMemo(
    () => workoutVolumeKg(draft.exercises, (id) => index.get(id).type),
    [draft.exercises, index],
  );
  const doneSets = useMemo(() => countDoneSets(draft.exercises), [draft.exercises]);
  const dirty = JSON.stringify(draft) !== session.initialJson;

  const close = () => {
    // Leaving for good: block further Save/Cancel taps (a second navigate(-1) would skip past the detail page).
    leaving.current = true;
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(`/history/${original.id}`, { replace: true });
  };

  const cancel = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await cancelEdit();
    } finally {
      if (!leaving.current) busy.current = false;
    }
  };

  const cancelEdit = async () => {
    if (dirty) {
      const ok = await confirm({
        title: 'Discard changes?',
        message: 'Your edits to this workout will be lost.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        danger: true,
      });
      if (!ok) return;
    }
    sessions.delete(original.id);
    if (session.addedPhotos.length) void deleteMedia(session.addedPhotos).catch(() => undefined);
    close();
  };

  const save = async () => {
    if (busy.current) return;
    if (photoBusy) {
      toast('Wait for the photo to finish adding', 'info');
      return;
    }
    busy.current = true;
    try {
      await saveChanges();
    } finally {
      if (!leaving.current) busy.current = false;
    }
  };

  const saveChanges = async () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    // Same rule as Finish in the logger: ticked sets with empty inputs take their placeholder values, and
    // ones still missing a required value are dropped (with the unticked ones).
    const undone = draft.exercises.reduce((n, we) => n + we.sets.filter((s) => !s.done).length, 0);
    const finalized = finalizeDoneSets(draft.exercises, (id) => typeFields(index.get(id).type));
    const dropped = undone + finalized.dropped;
    const exercises = completedExercises(finalized.exercises);
    if (!exercises.length) {
      toast('A workout needs at least one completed set', 'error');
      return;
    }
    if (dropped > 0) {
      const ok = await confirm({
        title: 'Remove unfinished sets?',
        message:
          dropped === 1
            ? "1 set is not completed (or empty) and won't be saved."
            : `${dropped} sets are not completed (or empty) and won't be saved.`,
        confirmLabel: 'Save anyway',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      const calories = draft.caloriesManual
        ? draft.calories ?? 0
        : estimateCalories({ durationSec: draft.durationSec, bodyweightKg, exercises, getExercise: index.get }).total;
      const updated: Workout = {
        ...draft,
        name: draft.name.trim() || original.name,
        notes: draft.notes?.trim() || undefined,
        exercises,
        endedAt: draft.startedAt + draft.durationSec * 1000,
        bodyweightKg: bodyweightKg ?? null,
        calories,
        caloriesManual: !!draft.caloriesManual,
      };
      await saveWorkout(updated);
      if (session.removedPhotos.length) await deleteMedia(session.removedPhotos).catch(() => undefined);
      sessions.delete(original.id);
      toast('Workout updated', 'success');
      close();
    } catch (e) {
      console.error(e);
      toast('Could not save changes', 'error');
      setSaving(false);
    }
  };

  const editDuration = async () => {
    const v = await promptDuration(draft.durationSec);
    if (v != null) patchDraft({ durationSec: v });
  };

  return (
    <Page>
      {/* A live workout may be resting in the background: the root RestTimerWatcher (AppShell) covers it. */}
      <TopBar
        left={
          <button
            type="button"
            onClick={() => void cancel()}
            className="flex h-10 items-center px-2 text-[17px] text-accent active:opacity-60"
          >
            Cancel
          </button>
        }
        title="Edit Workout"
        right={
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || photoBusy}
            className="flex h-10 items-center px-3 text-[17px] font-semibold text-accent disabled:opacity-40"
          >
            {saving ? <Spinner className="h-5 w-5 text-accent" /> : 'Save'}
          </button>
        }
      />

      <div className="space-y-4 px-4 pt-4">
        <TextField
          aria-label="Workout title"
          value={draft.name}
          onChange={(e) => patchDraft({ name: e.target.value })}
          placeholder="Workout title"
          className="h-12 text-[18px] font-semibold"
          maxLength={80}
        />
        <div className="grid grid-cols-4 gap-1 rounded-2xl bg-surface p-2">
          <SummaryStat label="Duration" value={formatClock(draft.durationSec)} onClick={() => void editDuration()} accent />
          <SummaryStat label="Volume" value={formatVolume(volume, settings.unit)} />
          <SummaryStat label="Sets" value={doneSets} />
          <SummaryStat label="Records" value={bests ? prs.length : '-'} />
        </div>
        <StartTimeField value={draft.startedAt} onChange={(ms) => patchDraft({ startedAt: ms })} />
        <CaloriesCard
          estimate={estimate}
          manual={draft.caloriesManual ? draft.calories ?? 0 : null}
          onManualChange={(kcal) =>
            patchDraft(kcal == null ? { caloriesManual: false, calories: estimate.total } : { caloriesManual: true, calories: kcal })
          }
        />
      </div>

      <SectionHeader>Photos</SectionHeader>
      <div className="px-4">
        <PhotoPicker
          photoIds={draft.photoIds}
          onAdd={(ids) =>
            update((s) => ({
              ...s,
              addedPhotos: [...s.addedPhotos, ...ids],
              draft: { ...s.draft, photoIds: [...s.draft.photoIds, ...ids] },
            }))
          }
          onRemove={(id) => {
            const isNew = session.addedPhotos.includes(id);
            update((s) => ({
              ...s,
              addedPhotos: s.addedPhotos.filter((p) => p !== id),
              removedPhotos: isNew ? s.removedPhotos : [...s.removedPhotos, id],
              draft: { ...s.draft, photoIds: s.draft.photoIds.filter((p) => p !== id) },
            }));
            if (isNew) void deleteMedia([id]).catch(() => undefined);
          }}
          onBusyChange={setPhotoBusy}
        />
      </div>

      <SectionHeader>Description</SectionHeader>
      <div className="px-4">
        <TextArea
          aria-label="Description"
          value={draft.notes ?? ''}
          onChange={(e) => patchDraft({ notes: e.target.value })}
          placeholder="How did it go? Add notes about your workout..."
          rows={3}
        />
      </div>

      <SectionHeader>Exercises</SectionHeader>
      <div className="-mt-3">
        <WorkoutExerciseList
          mode="edit"
          exercises={draft.exercises}
          ops={ops}
          settings={settings}
          history={history}
          routineId={draft.routineId}
          emptyTitle="No exercises"
          emptyMessage="Add the exercises you did in this workout"
          footer={
            <Button block size="lg" variant="secondary" onClick={() => void save()} disabled={saving || photoBusy}>
              Save Changes
            </Button>
          }
        />
      </div>
    </Page>
  );
}
