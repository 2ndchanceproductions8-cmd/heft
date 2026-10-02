import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, FolderPlus, Plus, Sparkles } from 'lucide-react';
import { Button, Loading, Page, SectionHeader, TopBar, toast } from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import { reorderRoutines, setFolderCollapsed, useFolders, useRoutineLastPerformed, useRoutines } from '../../lib/routines';
import { beginWorkout } from '../../lib/startWorkout';
import type { Routine, RoutineFolder } from '../../types';
import { ActiveWorkoutCard } from './ActiveWorkoutCard';
import { FolderSection } from './FolderSection';
import { RoutineCard } from './RoutineCard';
import { ReorderRow, SortableList } from './SortableList';
import { attempt, promptNewFolder, useLocalFlag } from './routineActions';
import { flattenGroupOrder } from './routineUtils';
import { addStarterRoutines } from './starterRoutines';

const MINE = '__mine';

interface Group {
  key: string;
  title: string;
  folder?: RoutineFolder;
  routines: Routine[];
}

export function WorkoutHomePage() {
  const nav = useNavigate();
  const routines = useRoutines();
  const folders = useFolders();
  const lastPerformed = useRoutineLastPerformed();

  const [reorder, setReorder] = useState(false);
  const [mineCollapsed, setMineCollapsed] = useLocalFlag('heft.routines.myRoutinesCollapsed');
  // Optimistic order while a drag result is being written (avoids a one-frame snap back).
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  useEffect(() => setPendingOrder(null), [routines]);

  const startingEmpty = useRef(false);
  const startEmpty = async () => {
    if (startingEmpty.current) return;
    startingEmpty.current = true;
    try {
      await beginWorkout({ type: 'empty' }, nav);
    } catch (e) {
      console.error(e);
      toast('Could not start the workout', 'error');
    } finally {
      startingEmpty.current = false;
    }
  };

  const groups = useMemo<Group[] | null>(() => {
    if (!routines || !folders) return null;
    let list = routines;
    if (pendingOrder) {
      const idx = new Map(pendingOrder.map((id, i) => [id, i]));
      list = [...routines].sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
    }
    const folderIds = new Set(folders.map((f) => f.id));
    return [
      {
        key: MINE,
        title: 'My Routines',
        // Routines whose folder no longer exists also land here.
        routines: list.filter((r) => !r.folderId || !folderIds.has(r.folderId)),
      },
      ...folders.map((f) => ({ key: f.id, title: f.name, folder: f, routines: list.filter((r) => r.folderId === f.id) })),
    ];
  }, [routines, folders, pendingOrder]);

  const total = routines?.length ?? 0;
  useEffect(() => {
    if (reorder && total < 2) setReorder(false);
  }, [reorder, total]);

  const onReorderGroup = useCallback(
    (key: string, ids: string[]) => {
      if (!groups) return;
      const flat = flattenGroupOrder(
        groups.map((g) => ({ key: g.key, ids: g.routines.map((r) => r.id) })),
        key,
        ids,
      );
      setPendingOrder(flat);
      void attempt(() => reorderRoutines(flat), 'Could not save the new order');
    },
    [groups],
  );

  const toggleFolder = (g: Group) => {
    if (g.folder) void attempt(() => setFolderCollapsed(g.folder!.id, !g.folder!.collapsed), 'Could not update the folder');
    else setMineCollapsed(!mineCollapsed);
  };

  return (
    <Page tabBar>
      <TopBar title="Workout" large />
      <ActiveWorkoutCard />

      <SectionHeader>Quick Start</SectionHeader>
      <div className="px-4">
        <button
          type="button"
          onClick={() => void startEmpty()}
          className="flex w-full items-center gap-3 rounded-2xl bg-surface px-4 py-3.5 text-left transition-colors active:bg-surface-2"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Plus className="h-5 w-5" strokeWidth={2.6} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] font-semibold">Start Empty Workout</span>
            <span className="block text-[13px] text-muted">Add exercises as you go</span>
          </span>
        </button>
      </div>

      <SectionHeader
        right={
          total >= 2 ? (
            <button
              type="button"
              onClick={() => setReorder((r) => !r)}
              className="-my-2 flex h-9 items-center rounded-lg px-2 text-[15px] font-semibold text-accent active:bg-surface-2"
            >
              {reorder ? 'Done' : 'Reorder'}
            </button>
          ) : null
        }
      >
        Routines
      </SectionHeader>

      {!reorder ? (
        <div className="grid grid-cols-2 gap-3 px-4">
          <Button variant="secondary" icon={<ClipboardList className="h-[18px] w-[18px]" />} onClick={() => nav('/routines/new')}>
            New Routine
          </Button>
          <Button variant="secondary" icon={<FolderPlus className="h-[18px] w-[18px]" />} onClick={() => void promptNewFolder()}>
            New Folder
          </Button>
        </div>
      ) : null}

      {!groups ? (
        <Loading />
      ) : reorder ? (
        <ReorderView groups={groups} onReorder={onReorderGroup} />
      ) : (
        <>
          {total === 0 ? <FirstRunCard /> : null}
          {groups.map((g) => {
            // "My Routines" only shows when it has something in it (first run shows the intro card instead).
            if (!g.folder && g.routines.length === 0) return null;
            const collapsed = g.folder ? !!g.folder.collapsed : mineCollapsed;
            return (
              <FolderSection
                key={g.key}
                title={g.title}
                count={g.routines.length}
                collapsed={collapsed}
                onToggle={() => toggleFolder(g)}
                folder={g.folder}
              >
                {g.routines.map((r) => (
                  <RoutineCard
                    key={r.id}
                    routine={r}
                    lastPerformedAt={lastPerformed ? lastPerformed.get(r.id) ?? null : r.lastPerformedAt}
                  />
                ))}
              </FolderSection>
            );
          })}
        </>
      )}
    </Page>
  );
}

/** Reorder mode: every group expanded, rows draggable within their folder. */
function ReorderView({ groups, onReorder }: { groups: Group[]; onReorder: (key: string, ids: string[]) => void }) {
  const { get } = useExercises();
  return (
    <div className="px-4">
      <p className="pt-1 pb-1 text-[13px] text-muted">Press and hold a routine, then drag it. Use “Move To Folder” to change folders.</p>
      {groups
        .filter((g) => g.routines.length > 0)
        .map((g) => (
          <section key={g.key} className="mt-4">
            <h3 className="px-1 pb-2 text-[15px] font-semibold">
              {g.title} <span className="font-normal text-muted tabular-nums">({g.routines.length})</span>
            </h3>
            <SortableList
              className="space-y-2"
              items={g.routines}
              onReorder={(ids) => onReorder(g.key, ids)}
              renderItem={(r, dragging) => (
                <ReorderRow dragging={dragging}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[16px] font-semibold">{r.name}</div>
                    <div className="truncate text-[13px] text-muted">
                      {r.exercises.length
                        ? r.exercises.map((e) => get(e.exerciseId).name).join(', ')
                        : 'No exercises'}
                    </div>
                  </div>
                </ReorderRow>
              )}
            />
          </section>
        ))}
    </div>
  );
}

/** First run (no routines yet): explain routines, create one, or add a Push/Pull/Legs starter set. */
function FirstRunCard() {
  const nav = useNavigate();
  const { list } = useExercises();
  const [adding, setAdding] = useState(false);
  // A ref, not just state: two quick taps both run before a re-render and would add the set twice.
  const addingRef = useRef(false);

  const addStarter = async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    const n = await attempt(() => addStarterRoutines(list), 'Could not add the starter routines');
    addingRef.current = false;
    setAdding(false);
    if (n === undefined) return;
    if (n > 0) toast(`Added ${n} starter routines`, 'success');
    else toast('Could not find the starter exercises in your library', 'error');
  };

  return (
    <div className="mx-4 mt-4 rounded-2xl bg-surface p-5 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        <ClipboardList className="h-7 w-7" />
      </div>
      <div className="mt-3 text-[18px] font-bold">Build your first routine</div>
      <p className="mx-auto mt-1.5 max-w-xs text-[14px] leading-snug text-muted">
        A routine is a saved workout plan — your exercises, sets and target reps. Start it with one tap and Heft
        pre-fills every set for you.
      </p>
      <div className="mt-5 space-y-2.5">
        <Button block size="lg" icon={<Plus className="h-5 w-5" />} onClick={() => nav('/routines/new')}>
          Create Routine
        </Button>
        <Button block size="lg" variant="soft" disabled={adding} icon={<Sparkles className="h-5 w-5" />} onClick={() => void addStarter()}>
          {adding ? 'Adding…' : 'Add starter routines'}
        </Button>
        <div className="text-[12px] text-faint">Push · Pull · Legs — 6 exercises each, 3 sets of 6–15 reps</div>
      </div>
    </div>
  );
}
