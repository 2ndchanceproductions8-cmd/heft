import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
  type BlockerFunction,
} from 'react-router-dom';
import { ChevronDown, ClipboardX, Dumbbell, Plus, Trash2 } from 'lucide-react';
import { Button, EmptyState, Field, Loading, Page, SelectField, TextArea, TopBar, confirm, toast } from '../../components/ui';
import { ExercisePicker } from '../exercises/ExercisePicker';
import { db } from '../../db';
import { useExercises } from '../../lib/ExerciseProvider';
import { typeFields } from '../../lib/exerciseMeta';
import { createRoutine, nextRoutineOrder, saveRoutine, useFolders, useRoutine } from '../../lib/routines';
import { useSettings } from '../../lib/settings';
import { useWorkouts } from '../../lib/workouts';
import type { PickedExercise } from '../../lib/workoutStore';
import type { Routine, RoutineExercise } from '../../types';
import { BarTextButton } from './BarButtons';
import { ReorderExercisesSheet, SupersetSheet } from './ExerciseSheets';
import { RoutineExerciseCard, type ExerciseAction } from './RoutineExerciseCard';
import { attempt, confirmDeleteRoutine, promptNewFolder } from './routineActions';
import {
  cleanupSupersets,
  fitSetsToFields,
  joinSuperset,
  leaveSuperset,
  routineExerciseFromSource,
  routineExercisesFromPicks,
  supersetIndex,
} from './routineUtils';

interface Draft {
  name: string;
  folderId: string | null;
  notes: string;
  exercises: RoutineExercise[];
}

type PickerMode = { kind: 'add' } | { kind: 'replace'; reId: string };

const NEW_FOLDER = '__new_folder__';
const snapshot = (d: Draft) => JSON.stringify(d);
/** Position of the current entry in this tab's history (React Router keeps it in history.state). */
const historyIdx = () => (window.history.state as { idx?: number } | null)?.idx ?? 0;

function emptyDraft(folderId: string | null): Draft {
  return { name: '', folderId, notes: '', exercises: [] };
}

function draftFromRoutine(r: Routine): Draft {
  return {
    name: r.name,
    folderId: r.folderId ?? null,
    notes: r.notes ?? '',
    exercises: r.exercises.map((e) => ({ ...e, notes: e.notes ?? '', sets: e.sets.map((s) => ({ ...s })) })),
  };
}

/** Create (/routines/new[?folder=id]) or edit (/routines/:id/edit) a routine. Weights stay in kg in the model. */
export function RoutineEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const nav = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const folderParam = params.get('folder');
  const fromDetail = !!(location.state as { fromDetail?: boolean } | null)?.fromDetail;

  const routine = useRoutine(id);
  const folders = useFolders();
  const workouts = useWorkouts();
  const settings = useSettings();
  const exIndex = useExercises();

  const [draft, setDraft] = useState<Draft | null>(() => (isNew ? emptyDraft(folderParam) : null));
  const [baseline, setBaseline] = useState<string>(() => (isNew ? snapshot(emptyDraft(folderParam)) : ''));
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
  const [supersetFor, setSupersetFor] = useState<string | null>(null);
  const [reorderOpen, setReorderOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollToEnd = useRef(false);

  // Load the routine being edited once (later live updates must not clobber the user's edits).
  useEffect(() => {
    if (isNew || !routine || loadedId === routine.id) return;
    const d = draftFromRoutine(routine);
    setDraft(d);
    setBaseline(snapshot(d));
    setLoadedId(routine.id);
  }, [isNew, routine, loadedId]);

  const dirty = !!draft && snapshot(draft) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // ---------------------------------------------------------------- leaving with unsaved changes
  const leaving = useRef(false);
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      !leaving.current && dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
    [],
  );
  const blocker = useBlocker(shouldBlock);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  const prompting = useRef(false);

  const confirmDiscard = useCallback(
    () =>
      confirm({
        title: 'Discard changes?',
        message: isNew ? 'This routine has not been saved.' : 'Your changes to this routine will be lost.',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep Editing',
        danger: true,
      }),
    [isNew],
  );

  useEffect(() => {
    if (blocker.state !== 'blocked' || prompting.current) return;
    prompting.current = true;
    void confirmDiscard().then((ok) => {
      prompting.current = false;
      const b = blockerRef.current;
      if (b.state !== 'blocked') return;
      if (ok) {
        leaving.current = true;
        b.proceed();
      } else b.reset();
    });
  }, [blocker.state, confirmDiscard]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older Safari / Chrome only prompt when returnValue is set
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  useEffect(() => {
    if (!scrollToEnd.current) return;
    scrollToEnd.current = false;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [draft?.exercises.length]);

  const exit = () => {
    leaving.current = true;
    if (historyIdx() > 0) nav(-1);
    else nav(isNew ? '/workout' : `/routines/${id}`, { replace: true });
  };

  const cancel = async () => {
    if (dirty && !(await confirmDiscard())) return;
    exit();
  };

  // ---------------------------------------------------------------- save
  const save = async () => {
    // Ref guard: a double tap on Save must never create the routine twice.
    if (!draft || savingRef.current) return;
    const name = draft.name.trim();
    if (!name) {
      toast('Give your routine a name', 'error');
      titleRef.current?.focus();
      return;
    }
    if (!draft.exercises.length) {
      toast('Add at least one exercise', 'error');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    // Drop a folder that no longer exists — but never while the folder list is still loading.
    const folderId = draft.folderId && (!folders || folders.some((f) => f.id === draft.folderId)) ? draft.folderId : null;
    const notes = draft.notes.trim() || undefined;
    const exercises = cleanupSupersets(draft.exercises).map((e) => ({ ...e, notes: e.notes?.trim() || undefined }));

    const savedId = await attempt(async () => {
      if (isNew) {
        return createRoutine({ name, folderId, notes, exercises, order: await nextRoutineOrder() });
      }
      const cur = (await db.routines.get(id!)) ?? routine;
      if (!cur) throw new Error('Routine no longer exists');
      const moved = (cur.folderId ?? null) !== folderId;
      await saveRoutine({ ...cur, name, folderId, notes, exercises, order: moved ? await nextRoutineOrder() : cur.order });
      return cur.id;
    }, 'Could not save the routine');
    if (!savedId) {
      savingRef.current = false;
      setSaving(false);
      return;
    }

    // Saved: stay in the "Saving…" state while we navigate away so a late tap can't save a second copy.
    leaving.current = true;
    toast('Routine saved', 'success');
    // Coming from the routine page: just pop back to it (no duplicate history entry).
    if (!isNew && fromDetail && historyIdx() > 0) nav(-1);
    else nav(`/routines/${savedId}`, { replace: true });
  };

  const deleteThis = async () => {
    if (isNew || !routine) return;
    await confirmDeleteRoutine(routine, () => {
      leaving.current = true;
      // Opened from the routine's page: skip back past it too (it would only say "Routine not found").
      if (fromDetail && historyIdx() > 1) nav(-2);
      else if (!fromDetail && historyIdx() > 0) nav(-1);
      else nav('/workout', { replace: true });
    });
  };

  // ---------------------------------------------------------------- exercise operations
  const updateExercise = useCallback(
    (reId: string, fn: (re: RoutineExercise) => RoutineExercise) =>
      setDraft((d) => (d ? { ...d, exercises: d.exercises.map((e) => (e.id === reId ? fn(e) : e)) } : d)),
    [],
  );

  const onAction = useCallback((reId: string, action: ExerciseAction) => {
    switch (action) {
      case 'replace':
        setPickerMode({ kind: 'replace', reId });
        break;
      case 'superset':
        setSupersetFor(reId);
        break;
      case 'unsuperset':
        setDraft((d) => (d ? { ...d, exercises: leaveSuperset(d.exercises, reId) } : d));
        break;
      case 'reorder':
        setReorderOpen(true);
        break;
      case 'remove':
        setDraft((d) => (d ? { ...d, exercises: cleanupSupersets(d.exercises.filter((e) => e.id !== reId)) } : d));
        break;
    }
  }, []);

  const onPick = async (picked: PickedExercise[], opts: { superset: boolean }) => {
    const mode = pickerMode;
    setPickerMode(null);
    if (!mode || !picked.length) return;

    // Load the routines that "from routine" picks came from.
    const routineIds = [...new Set(picked.map((p) => p.fromRoutine?.routineId).filter((x): x is string => !!x))];
    const sources = new Map<string, Routine>();
    if (routineIds.length) {
      const rows = await attempt(() => db.routines.bulkGet(routineIds), 'Could not read that routine');
      for (const r of rows ?? []) if (r) sources.set(r.id, r);
    }
    const sourceOf = (p: PickedExercise) =>
      p.fromRoutine ? sources.get(p.fromRoutine.routineId)?.exercises.find((e) => e.id === p.fromRoutine!.routineExerciseId) : undefined;
    // A just-created exercise may not be in the index yet: its type is then unknown and its sets are left as is.
    const fieldsOf = (exerciseId: string) => {
      const ex = exIndex.byId.get(exerciseId);
      return ex ? typeFields(ex.type) : undefined;
    };

    if (mode.kind === 'replace') {
      const p = picked[0];
      const src = sourceOf(p);
      const next = exIndex.byId.get(p.exerciseId);
      updateExercise(mode.reId, (re) => {
        if (src) {
          // The source's plan (minus its weights when a different machine was picked), in this slot.
          const copy = routineExerciseFromSource(src, p.exerciseId, fieldsOf(p.exerciseId));
          return { ...re, exerciseId: p.exerciseId, sets: copy.sets, notes: copy.notes ?? '', restSec: copy.restSec ?? null };
        }
        if (re.exerciseId === p.exerciseId) return re;
        // Different machine/exercise: keep the plan (set count, types, rep targets) but not the old weights,
        // and drop values the new exercise type has no column for (e.g. reps when swapping in a timed hold).
        const sets = re.sets.map((s) => ({ ...s, weightKg: null }));
        return { ...re, exerciseId: p.exerciseId, sets: next ? fitSetsToFields(sets, typeFields(next.type)) : sets };
      });
      return;
    }

    scrollToEnd.current = true;
    setDraft((d) => {
      if (!d) return d;
      // Routine picks keep their routine's supersets (fresh ids per batch); plain picks mirror the previous
      // session of that exercise instance, exactly like the logger.
      const added = routineExercisesFromPicks(picked, {
        sources,
        existing: d.exercises,
        history: workouts ?? [],
        previousMode: settings.previousValues,
        routineId: id ?? null,
        superset: opts.superset,
        fieldsOf,
      });
      return { ...d, exercises: [...d.exercises, ...added] };
    });
  };

  // ---------------------------------------------------------------- render
  const title = isNew ? 'Create Routine' : 'Edit Routine';
  const bar = (
    <TopBar
      title={title}
      left={<BarTextButton onClick={() => void cancel()}>Cancel</BarTextButton>}
      right={
        <BarTextButton strong onClick={() => void save()} disabled={saving || !draft}>
          {saving ? 'Saving…' : 'Save'}
        </BarTextButton>
      }
    />
  );

  if (!isNew && routine === null) {
    // Just deleted from here: we are already navigating away — don't flash "Routine not found".
    if (leaving.current) return <Page>{null}</Page>;
    return (
      <Page>
        <TopBar title={title} left={<BarTextButton onClick={() => nav('/workout', { replace: true })}>Close</BarTextButton>} />
        <EmptyState
          icon={<ClipboardX className="h-7 w-7" />}
          title="Routine not found"
          message="It may have been deleted."
          action={<Button onClick={() => nav('/workout', { replace: true })}>Back to Workout</Button>}
        />
      </Page>
    );
  }
  if (!draft) {
    return (
      <Page>
        {bar}
        <Loading />
      </Page>
    );
  }

  const ssIndex = supersetIndex(draft.exercises);
  const folderValue = draft.folderId && folders?.some((f) => f.id === draft.folderId) ? draft.folderId : '';

  return (
    <Page>
      {bar}

      <div className="space-y-4 px-4 pt-4">
        <input
          ref={titleRef}
          value={draft.name}
          onChange={(e) => {
            const name = e.target.value;
            setDraft((d) => (d ? { ...d, name } : d));
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          placeholder="Routine title"
          aria-label="Routine title"
          maxLength={80}
          enterKeyHint="done"
          autoComplete="off"
          className="w-full border-b border-line bg-transparent pb-2 text-[26px] font-bold tracking-tight text-fg outline-none placeholder:text-faint focus:border-accent"
        />

        <Field label="Folder">
          <span className="relative block">
            <SelectField
              value={folderValue}
              onChange={async (e) => {
                const v = e.target.value;
                if (v === NEW_FOLDER) {
                  const fid = await promptNewFolder();
                  if (fid) setDraft((d) => (d ? { ...d, folderId: fid } : d));
                  return;
                }
                setDraft((d) => (d ? { ...d, folderId: v || null } : d));
              }}
              className="pr-10"
            >
              <option value="">My Routines</option>
              {(folders ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
              <option value={NEW_FOLDER}>New folder…</option>
            </SelectField>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-5 w-5 -translate-y-1/2 text-muted" aria-hidden />
          </span>
        </Field>

        <Field label="Notes">
          <TextArea
            value={draft.notes}
            onChange={(e) => {
              const notes = e.target.value;
              setDraft((d) => (d ? { ...d, notes } : d));
            }}
            placeholder="Optional — goals, tempo, reminders…"
            rows={2}
          />
        </Field>
      </div>

      {draft.exercises.length === 0 ? (
        <div className="mx-4 mt-6 flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-8 text-center">
          <Dumbbell className="h-10 w-10 text-faint" />
          <div className="mt-2 text-[15px] text-muted">Get started by adding an exercise to your routine.</div>
        </div>
      ) : (
        <div className="mt-5 space-y-3 px-4">
          {draft.exercises.map((re) => {
            const ex = exIndex.get(re.exerciseId);
            return (
              <RoutineExerciseCard
                key={re.id}
                re={re}
                exercise={ex}
                unit={settings.unit}
                distanceUnit={settings.distanceUnit}
                defaultRest={ex.restSec ?? settings.defaultRestSec}
                superset={re.supersetId ? ssIndex.get(re.supersetId) : undefined}
                exerciseCount={draft.exercises.length}
                onUpdate={updateExercise}
                onAction={onAction}
              />
            );
          })}
        </div>
      )}

      <div ref={endRef} className="px-4 pt-4">
        <Button block size="lg" icon={<Plus className="h-5 w-5" strokeWidth={2.6} />} onClick={() => setPickerMode({ kind: 'add' })}>
          Add Exercise
        </Button>
        {!isNew ? (
          <Button block variant="danger" className="mt-8" icon={<Trash2 className="h-4 w-4" />} onClick={() => void deleteThis()}>
            Delete Routine
          </Button>
        ) : null}
      </div>

      <ExercisePicker
        open={!!pickerMode}
        onClose={() => setPickerMode(null)}
        onAdd={(picked, opts) => void onPick(picked, opts)}
        single={pickerMode?.kind === 'replace'}
        title={pickerMode?.kind === 'replace' ? 'Replace Exercise' : 'Add Exercises'}
        excludeRoutineId={id ?? null}
      />
      <SupersetSheet
        forId={supersetFor}
        onClose={() => setSupersetFor(null)}
        exercises={draft.exercises}
        index={exIndex}
        onPick={(partnerId) => {
          const a = supersetFor;
          if (a) setDraft((d) => (d ? { ...d, exercises: joinSuperset(d.exercises, a, partnerId) } : d));
        }}
      />
      <ReorderExercisesSheet
        open={reorderOpen}
        onClose={() => setReorderOpen(false)}
        exercises={draft.exercises}
        index={exIndex}
        onReorder={(ids) =>
          setDraft((d) => {
            if (!d) return d;
            const byId = new Map(d.exercises.map((e) => [e.id, e]));
            const ordered = ids.map((x) => byId.get(x)).filter((e): e is RoutineExercise => !!e);
            const rest = d.exercises.filter((e) => !ids.includes(e.id));
            return { ...d, exercises: [...ordered, ...rest] };
          })
        }
      />
    </Page>
  );
}
