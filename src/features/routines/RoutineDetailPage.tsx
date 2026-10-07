import { Fragment, memo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ClipboardX, Copy, Folder, FolderInput, MoreHorizontal, Pencil, Play, Timer, Trash2 } from 'lucide-react';
import { ActionSheet, Button, EmptyState, IconButton, Loading, Page, SectionHeader, TopBar, cx } from '../../components/ui';
import { ExerciseThumb } from '../../components/ExerciseImage';
import { useExercises } from '../../lib/ExerciseProvider';
import { isSideSet } from '../../lib/calc';
import { typeFields } from '../../lib/exerciseMeta';
import { SIDE_LETTER, SIDES, sideOf } from '../../lib/sides';
import { restSettingLabel } from '../../lib/rest';
import { useFolders, useRoutine, useRoutineLastPerformed } from '../../lib/routines';
import { useSettings } from '../../lib/settings';
import { distanceUnitForType, formatClock, formatDistanceForType, formatWeight } from '../../lib/units';
import type { DistanceUnit, Exercise, RoutineExercise, Side, SideValues, Unit } from '../../types';
import { BackButton, BarTextButton } from './BarButtons';
import { MoveToFolderSheet } from './MoveToFolderSheet';
import { lastPerformedLabel } from './RoutineCard';
import { confirmDeleteRoutine, duplicateWithToast, useGoBack, useStartRoutine } from './routineActions';
import {
  SET_BADGE_CLASS,
  formatReps,
  routineSetCount,
  setBadges,
  supersetIndex,
  supersetLetter,
  supersetStyle,
} from './routineUtils';

/** Rough session length: ~40s per set (or its planned time) plus the rest after it. */
function estimateSeconds(exercises: RoutineExercise[], restFor: (re: RoutineExercise) => number): number {
  let total = 0;
  for (const re of exercises) {
    const rest = restFor(re);
    for (const s of re.sets) total += (s.durationSec ?? 40) + (rest > 0 ? rest : 10);
  }
  return Math.round(total / 300) * 300;
}

/** "~45min", "~1h", "~1h 15min" */
function formatEstimate(sec: number): string {
  const min = Math.max(5, Math.round(sec / 60));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `~${h ? `${h}h${m ? ` ${m}min` : ''}` : `${m}min`}`;
}

export function RoutineDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const routine = useRoutine(id);
  const folders = useFolders();
  const lastMap = useRoutineLastPerformed();
  const settings = useSettings();
  const { get } = useExercises();
  const goBack = useGoBack('/workout');
  const start = useStartRoutine();
  const [menu, setMenu] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // Set once the user deletes this routine: we are already navigating away, so show nothing meanwhile.
  const deleted = useRef(false);

  if (routine === undefined || (routine === null && deleted.current)) {
    return (
      <Page tabBar>
        <TopBar left={<BackButton onClick={goBack} />} title="Routine" />
        <Loading />
      </Page>
    );
  }
  if (routine === null) {
    return (
      <Page tabBar>
        <TopBar left={<BackButton onClick={goBack} />} title="Routine" />
        <EmptyState
          icon={<ClipboardX className="h-7 w-7" />}
          title="Routine not found"
          message="It may have been deleted."
          action={<Button onClick={() => nav('/workout', { replace: true })}>Back to Workout</Button>}
        />
      </Page>
    );
  }

  const folder = routine.folderId ? folders?.find((f) => f.id === routine.folderId) : undefined;
  const last = lastMap ? lastMap.get(routine.id) ?? null : routine.lastPerformedAt;
  const restFor = (re: RoutineExercise) => re.restSec ?? get(re.exerciseId).restSec ?? settings.defaultRestSec;
  const setCount = routineSetCount(routine);
  const est = estimateSeconds(routine.exercises, restFor);
  const ssIndex = supersetIndex(routine.exercises);

  return (
    <Page tabBar>
      <TopBar
        left={<BackButton onClick={goBack} />}
        title="Routine"
        right={
          <>
            <BarTextButton onClick={() => nav(`/routines/${routine.id}/edit`, { state: { fromDetail: true } })}>Edit</BarTextButton>
            <IconButton label="Routine options" tone="accent" onClick={() => setMenu(true)}>
              <MoreHorizontal className="h-6 w-6" />
            </IconButton>
          </>
        }
      />

      <div className="px-4 pt-4">
        <h1 className="text-[26px] leading-tight font-bold tracking-tight break-words">{routine.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-muted">
          <span className="inline-flex items-center gap-1">
            <Folder className="h-3.5 w-3.5" />
            {folder?.name ?? 'My Routines'}
          </span>
          <span>{lastPerformedLabel(last)}</span>
        </div>
        {routine.notes?.trim() ? (
          <p className="mt-3 text-[15px] leading-snug whitespace-pre-wrap text-fg">{routine.notes.trim()}</p>
        ) : null}

        <div className="mt-4 grid grid-cols-3 divide-x divide-line rounded-2xl bg-surface py-3 text-center">
          <Metric label="Exercises" value={routine.exercises.length} />
          <Metric label="Sets" value={setCount} />
          <Metric label="Est. Time" value={setCount ? formatEstimate(est) : '-'} />
        </div>

        <Button
          block
          size="lg"
          className="mt-4"
          icon={<Play className="h-5 w-5 fill-current" />}
          onClick={() => void start(routine)}
        >
          Start Routine
        </Button>
      </div>

      <SectionHeader>Exercises</SectionHeader>
      {routine.exercises.length === 0 ? (
        <EmptyState
          title="No exercises yet"
          message="Edit this routine to add exercises."
          action={
            <Button variant="soft" icon={<Pencil className="h-4 w-4" />} onClick={() => nav(`/routines/${routine.id}/edit`, { state: { fromDetail: true } })}>
              Edit Routine
            </Button>
          }
        />
      ) : (
        <div className="space-y-3 px-4">
          {routine.exercises.map((re) => {
            const si = re.supersetId ? ssIndex.get(re.supersetId) : undefined;
            return (
              <ExerciseView
                key={re.id}
                re={re}
                exercise={get(re.exerciseId)}
                unit={settings.unit}
                distanceUnit={settings.distanceUnit}
                restLabel={restSettingLabel(re.restSec, get(re.exerciseId).restSec ?? settings.defaultRestSec)}
                superset={si}
                onOpen={() => nav(`/exercises/${re.exerciseId}`)}
              />
            );
          })}
        </div>
      )}

      <ActionSheet
        open={menu}
        onClose={() => setMenu(false)}
        title={routine.name}
        actions={[
          {
            label: 'Edit Routine',
            icon: <Pencil className="h-5 w-5" />,
            onClick: () => nav(`/routines/${routine.id}/edit`, { state: { fromDetail: true } }),
          },
          {
            label: 'Duplicate',
            icon: <Copy className="h-5 w-5" />,
            onClick: async () => {
              const newId = await duplicateWithToast(routine);
              if (newId) nav(`/routines/${newId}`);
            },
          },
          { label: 'Move To Folder', icon: <FolderInput className="h-5 w-5" />, onClick: () => setMoveOpen(true) },
          {
            label: 'Delete Routine',
            icon: <Trash2 className="h-5 w-5" />,
            danger: true,
            onClick: () =>
              void confirmDeleteRoutine(routine, () => {
                deleted.current = true;
                goBack();
              }),
          },
        ]}
      />
      {moveOpen ? <MoveToFolderSheet routine={routine} open onClose={() => setMoveOpen(false)} /> : null}
    </Page>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 px-2">
      <div className="truncate text-[18px] font-bold tabular-nums">{value}</div>
      <div className="text-[12px] font-medium text-muted">{label}</div>
    </div>
  );
}

/** Read-only exercise block: picture + name (→ exercise detail), rest, notes and the planned sets. */
const ExerciseView = memo(function ExerciseView({
  re,
  exercise,
  unit,
  distanceUnit,
  restLabel,
  superset,
  onOpen,
}: {
  re: RoutineExercise;
  exercise: Exercise;
  unit: Unit;
  distanceUnit: DistanceUnit;
  restLabel: string;
  superset?: number;
  onOpen: () => void;
}) {
  const f = typeFields(exercise.type);
  // Carries and sleds show yd/m, runs mi/km (same unit as the editor and logger).
  const du = distanceUnitForType(exercise.type, distanceUnit);
  const badges = setBadges(re.sets);
  const ss = superset != null ? supersetStyle(superset) : null;
  const cols: { key: string; label: string }[] = [{ key: 'set', label: 'SET' }];
  if (f.weight) cols.push({ key: 'w', label: `${f.weightSign}${unit.toUpperCase()}` });
  if (f.reps) cols.push({ key: 'r', label: 'REPS' });
  if (f.distance) cols.push({ key: 'd', label: du.toUpperCase() });
  if (f.duration) cols.push({ key: 't', label: 'TIME' });
  // Left / right: an L and an R line per set (a plain set planned each side with its values).
  const perSide = exercise.perSide || re.sets.some((s) => isSideSet(s));
  const grid = { gridTemplateColumns: `2.5rem ${perSide ? '0.75rem ' : ''}repeat(${cols.length - 1}, minmax(0, 1fr))` };
  const values = (v: SideValues, key: string) => (
    <Fragment key={key}>
      {f.weight ? <Value text={v.weightKg != null ? formatWeight(v.weightKg, unit, false) : ''} /> : null}
      {f.reps ? <Value text={formatReps(v.reps, v.repsMax)} /> : null}
      {f.distance ? <Value text={v.distanceM != null ? formatDistanceForType(v.distanceM, exercise.type, distanceUnit, false) : ''} /> : null}
      {f.duration ? <Value text={v.durationSec != null ? formatClock(v.durationSec) : ''} /> : null}
    </Fragment>
  );
  const sideLine = (s: RoutineExercise['sets'][number], side: Side) => (
    <Fragment key={side}>
      <span aria-hidden className="text-center text-[12px] font-bold text-muted">
        {SIDE_LETTER[side]}
      </span>
      {values(sideOf(s, side) ?? {}, side)}
    </Fragment>
  );

  return (
    <div className="relative overflow-hidden rounded-2xl bg-surface p-4">
      {ss ? <span className={cx('absolute top-3 bottom-3 left-0 w-1 rounded-r-full', ss.bar)} aria-hidden /> : null}
      <button type="button" onClick={onOpen} className="-m-1 flex w-[calc(100%+0.5rem)] items-center gap-3 rounded-xl p-1 text-left active:bg-surface-2">
        <ExerciseThumb exercise={exercise} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold text-accent">{exercise.name}</span>
          {ss && superset != null ? (
            <span className={cx('block text-[12px] font-semibold', ss.text)}>Superset {supersetLetter(superset)}</span>
          ) : null}
        </span>
      </button>

      {re.notes?.trim() ? <p className="mt-2 text-[14px] leading-snug whitespace-pre-wrap text-muted">{re.notes.trim()}</p> : null}
      <div className="mt-2 flex items-center gap-1.5 text-[14px] font-medium text-accent">
        <Timer className="h-4 w-4" />
        Rest Timer: {restLabel}
      </div>

      {re.sets.length ? (
        <div className="mt-3">
          <div className="grid gap-2 px-0.5 pb-1 text-[12px] font-semibold tracking-wide text-muted" style={grid}>
            {cols.map((c, i) => (
              <Fragment key={c.key}>
                <div className="text-center">{c.label}</div>
                {i === 0 && perSide ? <div aria-hidden /> : null}
              </Fragment>
            ))}
          </div>
          {re.sets.map((s, i) => (
            <div
              key={s.id}
              className={cx('grid items-center gap-x-2 rounded-lg px-0.5 py-1.5', perSide && 'gap-y-1', i % 2 === 1 && 'bg-surface-2/60')}
              style={grid}
            >
              <div className="flex justify-center" style={perSide ? { gridRow: 'span 2' } : undefined}>
                <span className={cx('flex h-7 w-7 items-center justify-center rounded-md text-[14px] font-bold tabular-nums', SET_BADGE_CLASS[s.type])}>
                  {badges[i]}
                </span>
              </div>
              {perSide ? SIDES.map((side) => sideLine(s, side)) : values(s, 'set')}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-[14px] text-faint">No sets planned</div>
      )}
    </div>
  );
});

function Value({ text }: { text: string }) {
  return (
    <div className={cx('truncate text-center text-[15px] font-semibold tabular-nums', !text && 'text-faint')}>{text || '-'}</div>
  );
}
