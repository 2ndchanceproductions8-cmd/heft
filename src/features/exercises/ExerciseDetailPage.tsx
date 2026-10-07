import { useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArchiveRestore,
  ArrowLeftRight,
  Camera,
  Check,
  ChevronRight,
  Ellipsis,
  Eye,
  EyeOff,
  GitBranch,
  ImageMinus,
  ImagePlus,
  ListOrdered,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  SearchX,
  Timer,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { db } from '../../db';
import { ExerciseAnimation, ExerciseThumb } from '../../components/ExerciseImage';
import { MuscleMap } from '../../components/MuscleMap';
import {
  ActionSheet,
  Button,
  Card,
  EmptyState,
  IconButton,
  Loading,
  Page,
  Segmented,
  Sheet,
  Toggle,
  TopBar,
  confirm,
  cx,
  prompt,
  toast,
  type SheetAction,
} from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import { exerciseSessions } from '../../lib/calc';
import { EQUIPMENT_LABEL, EXERCISE_TYPE_LABEL, MUSCLE_LABEL } from '../../lib/exerciseMeta';
import {
  deleteCustomExercise,
  exerciseUsage,
  setExerciseHidden,
  setExerciseNote,
  setExercisePhotos,
  setExerciseRest,
  updateCustomExercise,
  variantFamily,
  variantRoot,
  setExercisePerSide,
} from '../../lib/exercises';
import { deleteMedia, saveImageFile } from '../../lib/media';
import { useSettings } from '../../lib/settings';
import { restOptionsWith, restSettingLabel } from '../../lib/rest';
import { useExerciseWorkouts } from '../../lib/workouts';
import { VARIANT_EXPLAINER, isRenamed, promptCreateVariant, promptRename, resetName, toggleHidden } from './ExerciseActions';
import { ExerciseChart } from './ExerciseChart';
import { SideBalanceCard } from './SideBalanceCard';
import { MAX_PHOTOS } from './ExerciseForm';
import { HistoryTab } from './HistoryTab';
import { RecordsTab } from './RecordsTab';
import { deleteExerciseCopy, relativeDay } from './format';
import { useGoBack } from './hooks';
import { BackButton, SectionLabel } from './parts';

type DetailTab = 'summary' | 'history' | 'howto' | 'records';
const TABS: { value: DetailTab; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'history', label: 'History' },
  { value: 'howto', label: 'How To' },
  { value: 'records', label: 'Records' },
];

function RestSheet({
  open,
  onClose,
  value,
  defaultSec,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  value: number | undefined;
  defaultSec: number;
  onSelect: (v: number | undefined) => void;
}) {
  // The app-wide option list; a value set elsewhere that isn't in it is added so it shows (checked).
  const options: (number | undefined)[] = [undefined, ...restOptionsWith(value)];
  return (
    <Sheet open={open} onClose={onClose} title="Default Rest Timer">
      <p className="px-5 pb-3 text-center text-[13px] text-muted">Starts automatically after each set of this exercise.</p>
      <div className="px-3 pb-3">
        <div className="overflow-hidden rounded-2xl bg-surface-2">
          {options.map((o, i) => {
            const sel = o === value;
            return (
              <button
                key={o ?? 'default'}
                type="button"
                onClick={() => {
                  onSelect(o);
                  onClose();
                }}
                className={cx(
                  'flex w-full items-center px-4 py-3 text-left text-[16px] tabular-nums transition-colors active:bg-surface-3',
                  i > 0 && 'border-t border-line',
                  sel ? 'font-semibold text-accent' : 'text-fg',
                )}
              >
                <span className="flex-1">{restSettingLabel(o, defaultSec)}</span>
                {sel ? <Check className="h-5 w-5" strokeWidth={2.5} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}

function Pill({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'accent' | 'warn' }) {
  return (
    <span
      className={cx(
        'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[13px] font-medium',
        tone === 'accent' ? 'bg-accent-soft text-accent' : tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-fg',
      )}
    >
      {children}
    </span>
  );
}

export function ExerciseDetailPage() {
  const { id = '' } = useParams();
  // Remount per id: the route element is reused when :id changes, and useLiveQuery keeps returning the
  // previous id's result until the new query emits — stale history / custom record would flash "not found"
  // or "No history yet". A fresh mount starts every query at `undefined`, which renders as loading.
  return <ExerciseDetail key={id} id={id} />;
}

function ExerciseDetail({ id }: { id: string }) {
  const index = useExercises();
  const nav = useNavigate();
  const goBack = useGoBack('/exercises');
  const settings = useSettings();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'summary') as DetailTab;

  const isCustomId = id.startsWith('c_');
  const customRec = useLiveQuery(
    async () => (isCustomId ? (await db.customExercises.get(id)) ?? null : null),
    [id, isCustomId],
  );
  const workouts = useExerciseWorkouts(id);
  const ex = index.byId.get(id);

  const [menuOpen, setMenuOpen] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const sessions = useMemo(() => (ex && workouts ? exerciseSessions(workouts, ex.id, ex.type) : undefined), [ex, workouts]);
  const family = useMemo(() => {
    if (!ex) return [];
    const fam = variantFamily(index, ex.id);
    if (!fam.some((f) => f.id === ex.id)) fam.push(ex);
    return fam;
  }, [index, ex]);
  // Stable object so the memoized MuscleMap doesn't redraw on every render.
  const highlight = useMemo(() => (ex ? { primary: [ex.primary], secondary: ex.secondary } : undefined), [ex]);
  // Cardio / "other" aren't drawn on the body — skip an empty map for e.g. treadmill exercises.
  const hasMapMuscles = !!ex && [ex.primary, ...ex.secondary].some((m) => m !== 'cardio' && m !== 'other');

  // ---- loading / not found
  if (!ex) {
    const loading = isCustomId && customRec !== null;
    return (
      <Page tabBar>
        <TopBar left={<BackButton onClick={goBack} />} title={loading ? '' : 'Exercise'} />
        {loading ? (
          <Loading />
        ) : (
          <EmptyState
            icon={<SearchX className="h-7 w-7" />}
            title="Exercise not found"
            message="It may have been deleted."
            action={<Button onClick={() => nav('/exercises', { replace: true })}>Browse Exercises</Button>}
          />
        )}
      </Page>
    );
  }

  const isCustom = ex.source === 'custom';
  const archived = !!customRec?.archived;
  const ownPhotoIds = isCustom ? customRec?.photoIds ?? [] : ex.photoIds;
  const root = variantRoot(index, ex.id);

  const setTab = (t: DetailTab) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (t === 'summary') next.delete('tab');
        else next.set('tab', t);
        return next;
      },
      { replace: true },
    );

  /**
   * The exercise's OWN photo ids, read fresh from the DB. (The resolved `ex.photoIds` of a variant falls back to
   * its base's photos, and `customRec` may still be loading — building on either could drop the user's photos.)
   */
  const readOwnPhotoIds = async (): Promise<string[]> =>
    isCustom ? (await db.customExercises.get(ex.id))?.photoIds ?? [] : (await db.overrides.get(ex.id))?.photoIds ?? [];

  // ---- actions
  const addPhoto = async (file: File) => {
    setPhotoBusy(true);
    let mediaId: string | null = null;
    try {
      mediaId = await saveImageFile(file);
      const existing = await readOwnPhotoIds();
      const next = [mediaId, ...existing.filter((p) => p !== mediaId)];
      await setExercisePhotos(ex.id, next.slice(0, MAX_PHOTOS));
      mediaId = null;
      await deleteMedia(next.slice(MAX_PHOTOS));
      toast('Photo added', 'success');
    } catch {
      if (mediaId) void deleteMedia([mediaId]).catch(() => {});
      toast('Could not add the photo', 'error');
    } finally {
      setPhotoBusy(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void addPhoto(file);
  };

  const removePhotos = async () => {
    const fallback = ex.variantOf ? 'The pictures from the original exercise will show again.' : ex.images.length ? 'The library pictures will show again.' : undefined;
    if (!(await confirm({ title: 'Remove your photos?', message: fallback, danger: true, confirmLabel: 'Remove' }))) return;
    try {
      const ids = await readOwnPhotoIds();
      await setExercisePhotos(ex.id, []);
      await deleteMedia(ids);
      toast('Photos removed', 'success');
    } catch {
      toast('Could not remove the photos', 'error');
    }
  };

  const editNote = async () => {
    const note = await prompt({
      title: 'Pinned Note',
      message: 'Shown every time you add this exercise to a workout.',
      initial: ex.notes ?? '',
      placeholder: 'e.g. Seat on 4, thigh pad on 2',
      confirmLabel: 'Save',
    });
    if (note == null) return;
    try {
      await setExerciseNote(ex.id, note);
      toast(note.trim() ? 'Note pinned' : 'Note removed', 'success');
    } catch {
      toast('Could not save the note', 'error');
    }
  };

  const setPerSide = async (next: boolean) => {
    try {
      await setExercisePerSide(ex.id, next);
      toast(next ? 'New sets log left and right separately' : 'New sets log both sides together', 'success');
    } catch {
      toast('Could not save', 'error');
    }
  };

  const setRest = async (sec: number | undefined) => {
    try {
      await setExerciseRest(ex.id, sec);
      toast(`Rest timer: ${restSettingLabel(sec, settings.defaultRestSec)}`, 'success');
    } catch {
      toast('Could not save', 'error');
    }
  };

  const createVariant = async () => {
    const created = await promptCreateVariant(index, ex);
    if (created) nav(`/exercises/${created.id}`);
  };

  const restore = async () => {
    try {
      await updateCustomExercise(ex.id, { archived: false });
      if (ex.hidden) await setExerciseHidden(ex.id, false);
      toast('Restored to your library', 'success');
    } catch {
      toast('Could not restore', 'error');
    }
  };

  const remove = async () => {
    // Same check deleteCustomExercise makes, so the dialog says up front whether it is deleted or archived.
    let copy: ReturnType<typeof deleteExerciseCopy>;
    try {
      copy = deleteExerciseCopy(await exerciseUsage(ex.id));
    } catch {
      toast('Could not delete', 'error');
      return;
    }
    const ok = await confirm({
      title: `${copy.archive ? 'Archive' : 'Delete'} “${ex.name}”?`,
      message: copy.message,
      danger: !copy.archive,
      confirmLabel: copy.confirmLabel,
    });
    if (!ok) return;
    try {
      const result = await deleteCustomExercise(ex.id);
      goBack();
      toast(result === 'deleted' ? 'Deleted' : 'Archived — kept for your history', 'success');
    } catch {
      toast('Could not delete', 'error');
    }
  };

  const actions: SheetAction[] = [
    { label: 'Rename', icon: <Pencil className="h-5 w-5" />, hint: 'Renames it everywhere. Your history is kept.', onClick: () => void promptRename(ex) },
    ...(isRenamed(ex)
      ? [{ label: 'Reset Original Name', icon: <RotateCcw className="h-5 w-5" />, hint: ex.originalName, onClick: () => void resetName(ex) }]
      : []),
    { label: 'Create Machine/Brand Variant', icon: <GitBranch className="h-5 w-5" />, hint: VARIANT_EXPLAINER, onClick: () => void createVariant() },
    {
      label: 'Take Photo',
      icon: <Camera className="h-5 w-5" />,
      hint: ownPhotoIds.length >= MAX_PHOTOS ? 'Replaces your oldest photo' : 'Use a photo of the actual machine',
      onClick: () => cameraRef.current?.click(),
      disabled: photoBusy,
    },
    {
      label: 'Choose Photo',
      icon: <ImagePlus className="h-5 w-5" />,
      hint: `From your library · ${ownPhotoIds.length}/${MAX_PHOTOS}`,
      onClick: () => libraryRef.current?.click(),
      disabled: photoBusy,
    },
    ...(ownPhotoIds.length
      ? [{ label: 'Remove My Photos', icon: <ImageMinus className="h-5 w-5" />, hint: 'Go back to the library pictures', onClick: () => void removePhotos() }]
      : []),
    { label: 'Default Rest Timer', icon: <Timer className="h-5 w-5" />, hint: restSettingLabel(ex.restSec, settings.defaultRestSec), onClick: () => setRestOpen(true) },
    { label: ex.notes ? 'Edit Pinned Note' : 'Pin Note', icon: <Pin className="h-5 w-5" />, hint: ex.notes || 'Shown every time you add it to a workout', onClick: () => void editNote() },
    ...(isCustom && !archived ? [{ label: 'Edit', icon: <Pencil className="h-5 w-5" />, hint: 'Name, equipment, muscles, type, steps', onClick: () => nav(`/exercises/${ex.id}/edit`) }] : []),
    archived
      ? { label: 'Restore to Library', icon: <ArchiveRestore className="h-5 w-5" />, onClick: () => void restore() }
      : {
          label: ex.hidden ? 'Unhide' : 'Hide From Library',
          icon: ex.hidden ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />,
          onClick: () => void toggleHidden(ex),
        },
    ...(isCustom && !archived ? [{ label: 'Delete', icon: <Trash2 className="h-5 w-5" />, danger: true, onClick: () => void remove() }] : []),
  ];

  // ---- tabs
  const loadingHistory = !workouts || !sessions;
  // Left vs Right: for exercises logged per side, or with per-side sets in their history.
  const showSides = ex.perSide || !!sessions?.some((x) => x.sides);
  let body: React.ReactNode;
  if (tab === 'summary') {
    const last = sessions?.[sessions.length - 1];
    body = (
      <div className="space-y-4 px-4 pt-4">
        <div className="relative overflow-hidden rounded-2xl">
          <ExerciseAnimation exercise={ex} />
          {ownPhotoIds.length ? (
            <span className="absolute top-2 left-2 rounded-full bg-backdrop px-2.5 py-1 text-[12px] font-semibold text-white">Your photo</span>
          ) : null}
          {photoBusy ? (
            <span className="absolute top-2 right-2 rounded-full bg-backdrop px-2.5 py-1 text-[12px] font-semibold text-white">Saving…</span>
          ) : null}
        </div>

        <div>
          <h2 className="text-[22px] leading-tight font-bold">{ex.name}</h2>
          {isRenamed(ex) ? <p className="mt-0.5 text-[13px] text-muted">Originally: {ex.originalName}</p> : null}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Pill>{EQUIPMENT_LABEL[ex.equipment]}</Pill>
            <Pill>{EXERCISE_TYPE_LABEL[ex.type]}</Pill>
            {ex.brand ? <Pill tone="accent">{ex.brand}</Pill> : null}
            {ex.perSide ? <Pill>Left &amp; right</Pill> : null}
            {archived ? <Pill tone="warn">Archived</Pill> : ex.hidden ? <Pill tone="warn">Hidden</Pill> : null}
          </div>
          {last && sessions ? (
            <p className="mt-2.5 text-[13px] text-muted tabular-nums">
              {sessions.length} {sessions.length === 1 ? 'workout' : 'workouts'} · last performed{' '}
              {relativeDay(last.date).toLowerCase()}
            </p>
          ) : null}
        </div>

        {ex.notes ? (
          <Card onClick={() => void editNote()} className="px-4 py-3">
            <span className="flex items-start gap-2.5">
              <Pin className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <span className="min-w-0 flex-1 text-[15px] leading-snug break-words whitespace-pre-wrap">{ex.notes}</span>
              <Pencil className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
            </span>
          </Card>
        ) : null}

        <Card className="p-4">
          <SectionLabel>Muscles</SectionLabel>
          <p className="text-[15px] leading-snug">
            <span className="text-muted">Primary: </span>
            <span className="font-semibold">{MUSCLE_LABEL[ex.primary]}</span>
            {ex.secondary.length ? (
              <>
                <span className="text-faint"> · </span>
                <span className="text-muted">Secondary: </span>
                <span>{ex.secondary.map((m) => MUSCLE_LABEL[m]).join(', ')}</span>
              </>
            ) : null}
          </p>
          {hasMapMuscles ? (
            <div className="mx-auto mt-3 max-w-[260px]">
              <MuscleMap highlight={highlight} view="both" />
            </div>
          ) : null}
        </Card>

        <Card className="overflow-hidden">
          <div className="px-4 pt-4">
            <SectionLabel>Machine / Brand Variants</SectionLabel>
          </div>
          {family.length > 1 ? (
            <div>
              {family.map((f) => {
                const current = f.id === ex.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => !current && nav(`/exercises/${f.id}${tab === 'summary' ? '' : `?tab=${tab}`}`, { replace: true })}
                    className={cx('flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors', current ? 'bg-accent-soft' : 'active:bg-surface-2')}
                    aria-current={current ? 'page' : undefined}
                  >
                    <ExerciseThumb exercise={f} size={38} />
                    <span className="min-w-0 flex-1">
                      <span className={cx('block truncate text-[15px] font-medium', current && 'text-accent')}>{f.name}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {f.id === root.id ? 'Original' : f.brand ? f.brand : 'Variant'}
                      </span>
                    </span>
                    {current ? <Check className="h-5 w-5 shrink-0 text-accent" strokeWidth={2.5} /> : <ChevronRight className="h-5 w-5 shrink-0 text-faint" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-4 pb-1 text-[14px] leading-snug text-muted">
              Gym has two brands of this machine? Add a variant so their weights never mix.
            </p>
          )}
          <button
            type="button"
            onClick={() => nav(`/exercises/new?variantOf=${encodeURIComponent(root.id)}`)}
            className="mt-1 flex w-full items-center gap-2 border-t border-line px-4 py-3 text-[15px] font-semibold text-accent transition-colors active:bg-surface-2"
          >
            <Plus className="h-5 w-5" />
            Add machine/brand variant
          </button>
          <p className="px-4 pb-3.5 text-[12px] leading-snug text-faint">{VARIANT_EXPLAINER}</p>
        </Card>

        {showSides ? (
          <Card className="p-4">
            <SideBalanceCard exercise={ex} sessions={sessions} onTogglePerSide={(v) => void setPerSide(v)} />
          </Card>
        ) : null}

        <Card className="p-4">
          <SectionLabel>Progress</SectionLabel>
          {loadingHistory ? (
            <Loading />
          ) : sessions!.length ? (
            <ExerciseChart key={ex.id} sessions={sessions!} type={ex.type} />
          ) : (
            <EmptyState
              className="py-8"
              icon={<TrendingUp className="h-7 w-7" />}
              title="No progress yet"
              message="Log this exercise to see your progress."
            />
          )}
        </Card>

        <Card className="overflow-hidden">
          <button type="button" onClick={() => setRestOpen(true)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-surface-2">
            <Timer className="h-5 w-5 text-muted" />
            <span className="flex-1 text-[15px]">Rest timer</span>
            <span className="text-[15px] text-muted tabular-nums">{restSettingLabel(ex.restSec, settings.defaultRestSec)}</span>
            <ChevronRight className="h-5 w-5 text-faint" />
          </button>
          {!showSides ? (
            <div className="flex w-full items-center gap-3 border-t border-line px-4 py-3">
              <ArrowLeftRight className="h-5 w-5 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]">Log left &amp; right separately</span>
                <span className="block text-[12px] text-faint">Single-arm / single-leg: compare each side</span>
              </span>
              <Toggle checked={ex.perSide} onChange={(v) => void setPerSide(v)} label="Log left and right separately" />
            </div>
          ) : null}
          {!ex.notes ? (
            <button type="button" onClick={() => void editNote()} className="flex w-full items-center gap-3 border-t border-line px-4 py-3 text-left active:bg-surface-2">
              <Pin className="h-5 w-5 text-muted" />
              <span className="flex-1 text-[15px]">Pin a note</span>
              <span className="text-[13px] text-faint">e.g. seat height</span>
              <ChevronRight className="h-5 w-5 text-faint" />
            </button>
          ) : null}
        </Card>
      </div>
    );
  } else if (tab === 'history') {
    body = loadingHistory ? <Loading /> : <HistoryTab exercise={ex} workouts={workouts!} />;
  } else if (tab === 'records') {
    body = loadingHistory ? <Loading /> : <RecordsTab exercise={ex} workouts={workouts!} />;
  } else {
    body = ex.instructions.length ? (
      <div className="px-4 pt-4">
        <div className="overflow-hidden rounded-2xl">
          <ExerciseAnimation exercise={ex} />
        </div>
        <ol className="mt-5 space-y-4">
          {ex.instructions.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[14px] font-semibold text-accent tabular-nums">
                {i + 1}
              </span>
              <p className="pt-0.5 text-[15px] leading-relaxed">{step}</p>
            </li>
          ))}
        </ol>
        {isCustom && !archived ? (
          <Button variant="secondary" block className="mt-6" icon={<Pencil className="h-4 w-4" />} onClick={() => nav(`/exercises/${ex.id}/edit`)}>
            Edit Steps
          </Button>
        ) : null}
      </div>
    ) : (
      <EmptyState
        icon={<ListOrdered className="h-7 w-7" />}
        title="No instructions"
        message={
          isCustom
            ? 'Add your own steps — seat height, grip, cues — so you set it up right every time.'
            : 'This exercise has no written steps yet.'
        }
        action={
          isCustom && !archived ? (
            <Button icon={<Plus className="h-5 w-5" />} onClick={() => nav(`/exercises/${ex.id}/edit`)}>
              Add Instructions
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <Page tabBar>
      <TopBar
        left={<BackButton onClick={goBack} />}
        title={ex.name}
        right={
          <IconButton label="Exercise options" onClick={() => setMenuOpen(true)}>
            <Ellipsis className="h-6 w-6" />
          </IconButton>
        }
      >
        <div className="px-4 pb-2.5">
          <Segmented value={tab} onChange={setTab} options={TABS} />
        </div>
      </TopBar>

      {body}

      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={onFile} />

      <ActionSheet open={menuOpen} onClose={() => setMenuOpen(false)} title={<span className="block truncate text-fg">{ex.name}</span>} actions={actions} />
      <RestSheet open={restOpen} onClose={() => setRestOpen(false)} value={ex.restSec} defaultSec={settings.defaultRestSec} onSelect={(v) => void setRest(v)} />
    </Page>
  );
}

