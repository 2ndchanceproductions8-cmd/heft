import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookmarkPlus, ChevronLeft, Ellipsis, FileQuestion, Pencil, Repeat, Trash2, Trophy } from 'lucide-react';
import type { Muscle, PRKind, Workout } from '../../types';
import {
  ActionSheet,
  Button,
  EmptyState,
  IconButton,
  Loading,
  Page,
  SectionHeader,
  Stat,
  TopBar,
  confirm,
  prompt,
  toast,
} from '../../components/ui';
import { MuscleMap } from '../../components/MuscleMap';
import { db } from '../../db';
import { useExercises } from '../../lib/ExerciseProvider';
import { MUSCLE_LABEL } from '../../lib/exerciseMeta';
import { useMediaUrls } from '../../lib/media';
import { useSettings } from '../../lib/settings';
import { beginWorkout } from '../../lib/startWorkout';
import { formatDuration, formatVolume } from '../../lib/units';
import { createRoutineFromWorkout, deleteWorkout, useWorkout } from '../../lib/workouts';
import { CelebrationCard } from './CelebrationCard';
import { SendToHealthButton } from './SendToHealthButton';
import { ExerciseLog } from './ExerciseLog';
import { HistoryErrorBoundary } from './HistoryErrorBoundary';
import { PhotoViewer } from './PhotoViewer';
import { formatWorkoutDateRange, muscleSplit, plural, supersetLetters } from './historyUtils';
import { useScrollMemory } from './useScrollMemory';

export function WorkoutDetailPage() {
  const { id } = useParams();
  return (
    <HistoryErrorBoundary key={id} title="Workout" back="/history">
      <WorkoutDetailScreen id={id} />
    </HistoryErrorBoundary>
  );
}

/**
 * Back: pop when there is in-app history to pop. Right after finishing a workout (celebration, or its
 * dismissed state) the previous entries are the finished workout flow, so go to History instead.
 */
function useGoBack(celebrate: boolean) {
  const navigate = useNavigate();
  const location = useLocation();
  const justFinished = celebrate || !!(location.state as { justFinished?: boolean } | null)?.justFinished;
  return () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (!justFinished && idx > 0) navigate(-1);
    else navigate('/history', { replace: true });
  };
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Back"
      onClick={onClick}
      className="flex h-10 items-center pr-2 pl-1 text-accent active:opacity-60"
    >
      <ChevronLeft className="h-7 w-7" strokeWidth={2.2} />
    </button>
  );
}

function WorkoutDetailScreen({ id }: { id: string | undefined }) {
  const workout = useWorkout(id);
  const [params] = useSearchParams();
  const celebrate = params.get('celebrate') === '1';
  const goBack = useGoBack(celebrate);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  // Back from an exercise / routine / edit screen lands at the same spot in this (long) page.
  useScrollMemory(workout !== undefined);

  if (workout === undefined || (deleting && !workout)) {
    return (
      <Page tabBar>
        <TopBar title="Workout" left={<BackButton onClick={goBack} />} />
        <Loading />
      </Page>
    );
  }
  if (workout === null) {
    return (
      <Page tabBar>
        <TopBar title="Workout" left={<BackButton onClick={goBack} />} />
        <EmptyState
          className="pt-20"
          icon={<FileQuestion className="h-7 w-7" />}
          title="Workout not found"
          message="It may have been deleted."
          action={
            <Button variant="secondary" onClick={() => navigate('/history', { replace: true })}>
              Back to History
            </Button>
          }
        />
      </Page>
    );
  }
  return (
    <WorkoutDetail
      workout={workout}
      celebrate={celebrate}
      onBack={goBack}
      onDeleteStart={() => setDeleting(true)}
      onDeleteFailed={() => setDeleting(false)}
    />
  );
}

/** The loaded detail view (exported for render tests). */
export function WorkoutDetail({
  workout: w,
  celebrate,
  onBack,
  onDeleteStart,
  onDeleteFailed,
}: {
  workout: Workout;
  celebrate: boolean;
  onBack: () => void;
  onDeleteStart: () => void;
  onDeleteFailed: () => void;
}) {
  const navigate = useNavigate();
  const settings = useSettings();
  const { unit, distanceUnit } = settings;
  const exercises = useExercises();
  const [menuOpen, setMenuOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const photoUrls = useMediaUrls(w.photoIds);
  const closeViewer = useCallback(() => setViewerIndex(null), []);
  // How many of the photos are actually stored (keys only, no blobs) — separates "still loading" from
  // "gone", so a dangling media id never leaves pulsing placeholders on screen forever.
  const photoKey = (w.photoIds ?? []).join(',');
  const storedPhotos = useLiveQuery(
    () => (photoKey ? db.media.where('id').anyOf(photoKey.split(',')).count() : 0),
    [photoKey],
  );
  const photoSlots = storedPhotos ?? w.photoIds?.length ?? 0;

  // "This was your Nth workout" — only queried for the celebration card.
  const nth = useLiveQuery<number | null>(
    () => (celebrate ? db.workouts.where('startedAt').belowOrEqual(w.startedAt).count() : null),
    [celebrate, w.startedAt],
  );

  const prsBySet = useMemo(() => {
    const m = new Map<string, PRKind[]>();
    for (const pr of w.prs ?? []) m.set(pr.setId, [...(m.get(pr.setId) ?? []), pr.kind]);
    return m;
  }, [w.prs]);
  const letters = useMemo(() => supersetLetters(w.exercises), [w.exercises]);
  const split = useMemo(() => muscleSplit(w.exercises, exercises.get), [w.exercises, exercises]);

  const saveAsRoutine = async () => {
    const name = await prompt({
      title: 'Save as Routine',
      message: 'Creates a routine with these exercises and sets.',
      initial: w.name,
      placeholder: 'Routine name',
      confirmLabel: 'Save',
      validate: (v) => (v.trim() ? null : 'Give the routine a name.'),
    });
    if (name == null) return;
    try {
      const routineId = await createRoutineFromWorkout(w, name.trim());
      toast('Routine saved', 'success');
      const open = await confirm({
        title: 'Routine created',
        message: `"${name.trim()}" is now in your routines.`,
        confirmLabel: 'Open Routine',
        cancelLabel: 'Not Now',
      });
      if (open) navigate(`/routines/${routineId}`);
    } catch (e) {
      console.error(e);
      toast('Could not save the routine', 'error');
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'Delete workout?',
      message: `"${w.name}" and its photos will be permanently removed. Personal records are recalculated.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    onDeleteStart();
    try {
      await deleteWorkout(w.id);
      toast('Workout deleted', 'success');
      // Keep the calendar month / list length the user was browsing (see HistoryScreen).
      navigate('/history', { replace: true, state: { restoreView: true } });
    } catch (e) {
      console.error(e);
      onDeleteFailed();
      toast('Could not delete the workout', 'error');
    }
  };

  const repeat = () => void beginWorkout({ type: 'repeat', workout: w }, navigate);

  const muscles = (Object.entries(split) as [Muscle, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const muscleTotal = muscles.reduce((n, [, v]) => n + v, 0);
  const muscleMax = muscles[0]?.[1] ?? 0;
  const prCount = w.prs?.length ?? 0;
  // Keep the header's time range consistent with the Duration stat (edits may change either field).
  const endedAt = w.durationSec > 0 ? w.startedAt + w.durationSec * 1000 : w.endedAt;

  return (
    <Page tabBar>
      <TopBar
        title="Workout"
        left={<BackButton onClick={onBack} />}
        right={
          <IconButton label="Workout options" tone="accent" onClick={() => setMenuOpen(true)}>
            <Ellipsis className="h-6 w-6" />
          </IconButton>
        }
      />

      {celebrate ? (
        <CelebrationCard
          workout={w}
          nth={nth ?? undefined}
          unit={unit}
          distanceUnit={distanceUnit}
          onDone={() => navigate(`/history/${w.id}`, { replace: true, state: { justFinished: true } })}
        />
      ) : null}

      <div className="px-4 pt-5">
        <h1 className="text-2xl leading-tight font-bold tracking-tight break-words">{w.name || 'Workout'}</h1>
        <p className="mt-1 text-[14px] text-muted tabular-nums">{formatWorkoutDateRange(w.startedAt, endedAt)}</p>
      </div>

      {/* items-end: if the Calories tag has to wrap under its label on a narrow phone, the values in that
          row still line up. */}
      <div className="mx-4 mt-4 grid grid-cols-3 items-end gap-x-3 gap-y-4 rounded-2xl bg-surface p-4">
        <Stat label="Duration" value={formatDuration(w.durationSec)} />
        <Stat label="Volume" value={formatVolume(w.volumeKg, unit)} />
        <Stat label="Sets" value={w.setCount.toLocaleString()} />
        <Stat
          label={
            <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
              Calories
              {w.calories != null ? (
                <span className="rounded bg-surface-2 px-1 text-[10px] leading-4 font-semibold whitespace-nowrap text-muted uppercase">
                  {w.caloriesManual ? 'manual' : 'est.'}
                </span>
              ) : null}
            </span>
          }
          value={w.calories != null ? `${Math.round(w.calories).toLocaleString()} kcal` : '-'}
        />
        <Stat
          label="Records"
          value={
            <span className={prCount ? 'inline-flex items-center gap-1 text-gold' : undefined}>
              {prCount ? <Trophy className="h-4 w-4" /> : null}
              {prCount}
            </span>
          }
        />
        <Stat label="Exercises" value={w.exercises.length} />
      </div>

      {/* Right after finishing, the celebration card carries this button. */}
      {celebrate ? null : <SendToHealthButton workout={w} className="mx-4 mt-3 w-[calc(100%-2rem)]" />}

      {w.notes?.trim() ? (
        <p className="mx-4 mt-3 rounded-2xl bg-surface p-4 text-[15px] leading-relaxed break-words whitespace-pre-wrap">
          {w.notes.trim()}
        </p>
      ) : null}

      {photoSlots > 0 ? (
        <>
          <SectionHeader>Photos</SectionHeader>
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-4">
            {photoUrls.length
              ? photoUrls.map((u, k) => (
                  <button
                    key={u}
                    type="button"
                    aria-label={`Open photo ${k + 1}`}
                    onClick={() => setViewerIndex(k)}
                    className="h-28 w-28 shrink-0 overflow-hidden rounded-xl bg-surface-2 active:opacity-80"
                  >
                    <img src={u} alt="" draggable={false} className="h-full w-full object-cover" />
                  </button>
                ))
              : Array.from({ length: photoSlots }, (_, k) => (
                  <div key={k} aria-hidden className="h-28 w-28 shrink-0 animate-pulse rounded-xl bg-surface-2" />
                ))}
          </div>
        </>
      ) : null}

      {muscles.length ? (
        <>
          <SectionHeader>Muscle Split</SectionHeader>
          <div className="mx-4 rounded-2xl bg-surface p-4">
            <MuscleMap values={split} view="both" className="mx-auto w-full max-w-[340px]" />
            <div className="mt-4 space-y-2.5">
              {muscles.map(([m, v]) => (
                <div key={m}>
                  <div className="flex items-baseline justify-between text-[14px]">
                    <span className="font-medium">{MUSCLE_LABEL[m]}</span>
                    <span className="text-muted tabular-nums">{Math.round((v / muscleTotal) * 100)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(v / muscleMax) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <SectionHeader right={<span className="text-[13px] text-muted">{plural(w.exercises.length, 'exercise')}</span>}>
        Exercises
      </SectionHeader>
      {w.exercises.length ? (
        <div className="space-y-3 px-4">
          {w.exercises.map((we) => (
            <ExerciseLog
              key={we.id}
              we={we}
              supersetLetter={we.supersetId ? letters.get(we.supersetId) : undefined}
              prsBySet={prsBySet}
              unit={unit}
              distanceUnit={distanceUnit}
            />
          ))}
        </div>
      ) : (
        <p className="px-4 text-[14px] text-muted">No exercises were logged.</p>
      )}

      <div className="px-4 pt-6">
        <Button variant="secondary" block icon={<Repeat className="h-5 w-5" />} onClick={repeat}>
          Repeat Workout
        </Button>
      </div>

      <ActionSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={w.name}
        actions={[
          { label: 'Edit Workout', icon: <Pencil className="h-5 w-5" />, onClick: () => navigate(`/history/${w.id}/edit`) },
          {
            label: 'Save As Routine',
            hint: 'Reuse these exercises and sets',
            icon: <BookmarkPlus className="h-5 w-5" />,
            onClick: () => void saveAsRoutine(),
          },
          { label: 'Repeat Workout', hint: 'Start a new workout like this one', icon: <Repeat className="h-5 w-5" />, onClick: repeat },
          { label: 'Delete Workout', icon: <Trash2 className="h-5 w-5" />, danger: true, onClick: () => void remove() },
        ]}
      />

      {/* Mounted only while open so it always starts on the tapped photo (no slide from the last one). */}
      {viewerIndex != null && photoUrls.length ? (
        <PhotoViewer urls={photoUrls} startIndex={viewerIndex} onClose={closeViewer} />
      ) : null}
    </Page>
  );
}
