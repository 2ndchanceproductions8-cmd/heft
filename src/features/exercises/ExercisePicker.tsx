import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, History, Plus, SearchX } from 'lucide-react';
import type { Equipment, Exercise, Muscle, Routine, RoutineExercise } from '../../types';
import type { PickedExercise } from '../../lib/workoutStore';
import { Button, Chip, EmptyState, Loading, Segmented, Sheet, cx } from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import { searchExercises } from '../../lib/exercises';
import { useFolders, useRoutines } from '../../lib/routines';
import { useSettings } from '../../lib/settings';
import { ExerciseActions } from './ExerciseActions';
import { ExerciseCreateSheet } from './ExerciseForm';
import { IncrementalList } from './ExerciseList';
import { ExerciseRow } from './ExerciseRow';
import { FilterBar, SearchField } from './FilterSheets';
import { formatSetValue, relativeDay, routineSetsSummary } from './format';
import { hasFinePointer, scrollParent, useExerciseUsage } from './hooks';
import { HeaderButton } from './parts';
import { browseRoutineId, exKey, rtKey, selectCreated, type PickerSelection } from './selection';
import { readPref, writePref } from '../progress/format';
import { bestSet } from './stats';

export interface ExercisePickerProps {
  open: boolean;
  onClose: () => void;
  /** Called with the selection; `superset` true when the user chose "Add as superset". */
  onAdd: (picked: PickedExercise[], opts: { superset: boolean }) => void;
  /** Single-select mode (e.g. "Replace exercise"): tapping a row immediately returns it. */
  single?: boolean;
  /** Title override (default "Add Exercise"). */
  title?: string;
  /** Hide the "From Routines" tab (e.g. inside the routine editor itself). */
  hideRoutinesTab?: boolean;
  /** Leave one routine out of the Routines tab (the routine currently being edited). */
  excludeRoutineId?: string | null;
  /** The routine this workout was started from: the Routines tab opens on a different one. */
  currentRoutineId?: string | null;
}

/**
 * The Add-Exercise sheet: search the library, pick from one of your routines (bringing its planned sets),
 * or from recently performed exercises. Multi-select with "Add N exercises" / "Add as Superset".
 * The Routines tab shows one routine at a time, with a chip per routine to flip between them (a search there
 * looks through every routine at once). The tab last used for adding is remembered on this device.
 */
export function ExercisePicker(props: ExercisePickerProps) {
  // Mount only while open: state resets on every open and nothing (workout history...) loads while hidden.
  if (!props.open) return null;
  return <PickerSheet {...props} />;
}

type Tab = 'all' | 'routines' | 'recent';
const TABS: readonly Tab[] = ['all', 'routines', 'recent'];
/** localStorage (heft.<key>): the tab the add picker opens on. */
const TAB_PREF = 'picker.tab';

type Selection = PickerSelection;

const routinePick = (r: Routine, re: RoutineExercise): Selection => ({
  key: rtKey(r.id, re.id),
  pick: { exerciseId: re.exerciseId, fromRoutine: { routineId: r.id, routineExerciseId: re.id } },
});

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function ListLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-4 pt-5 pb-1.5">
      <span className="text-[13px] font-semibold tracking-wide text-muted uppercase">{children}</span>
      {right}
    </div>
  );
}

function PickerSheet({
  onClose,
  onAdd,
  single,
  title = 'Add Exercise',
  hideRoutinesTab,
  excludeRoutineId,
  currentRoutineId,
}: ExercisePickerProps) {
  const index = useExercises();
  const nav = useNavigate();
  const { unit, distanceUnit } = useSettings();
  const usage = useExerciseUsage();
  const routines = useRoutines();
  const folders = useFolders();

  const [query, setQuery] = useState('');
  const q = useDeferredValue(query);
  // Replace (single) always starts on All; adding reopens on the tab used last (e.g. Routines).
  const [tab, setTabState] = useState<Tab>(() => {
    if (single) return 'all';
    const t = readPref(TAB_PREF, TABS, 'all');
    return t === 'routines' && hideRoutinesTab ? 'all' : t;
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    if (!single) writePref(TAB_PREF, t);
  };
  const [pickedRoutineId, setPickedRoutineId] = useState<string | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [muscle, setMuscle] = useState<Muscle | null>(null);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [actionsFor, setActionsFor] = useState<Exercise | null>(null);
  const [creating, setCreating] = useState(false);
  const [autoFocus] = useState(hasFinePointer);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedKeys = useMemo(() => new Set(selected.map((s) => s.key)), [selected]);

  // Consumers pass inline callbacks; keep `commit` (and with it every memoized row's onPress) stable so a
  // re-render of the parent (e.g. the active workout's ticking clock) doesn't re-render ~60-700 rows.
  const callbacks = useRef({ onAdd, onClose });
  callbacks.current = { onAdd, onClose };

  // ---- selection
  const commit = useCallback((picks: PickedExercise[], superset: boolean) => {
    if (!picks.length) return;
    callbacks.current.onAdd(picks, { superset });
    setSelected([]);
    callbacks.current.onClose();
  }, []);

  const toggle = useCallback(
    (sel: Selection) => {
      if (single) {
        commit([sel.pick], false);
        return;
      }
      setSelected((cur) => (cur.some((s) => s.key === sel.key) ? cur.filter((s) => s.key !== sel.key) : [...cur, sel]));
    },
    [single, commit],
  );

  const pressExercise = useCallback((ex: Exercise) => toggle({ key: exKey(ex.id), pick: { exerciseId: ex.id } }), [toggle]);
  const openActions = useCallback((ex: Exercise) => setActionsFor(ex), []);

  /**
   * A just-created exercise / variant becomes selected (and visible via the search). A new machine/brand
   * variant takes the place of its base exercise in the selection — whether the base was picked from the
   * library or from a routine — so the order the user built is kept. A routine pick's plan (sets, reps,
   * rest, notes) carries over to the variant.
   */
  const selectNew = (id: string, name: string, replaces?: Exercise) => {
    if (single) {
      commit([{ exerciseId: id }], false);
      return;
    }
    setSelected((cur) => selectCreated(cur, id, replaces?.id));
    setTab('all');
    setEquipment(null);
    setMuscle(null);
    setQuery(name);
  };

  const addAllFromRoutine = (r: Routine, usable: RoutineExercise[]) => {
    const items = usable.map((re) => routinePick(r, re));
    setSelected((cur) => {
      const keys = new Set(cur.map((s) => s.key));
      if (items.every((i) => keys.has(i.key))) return cur.filter((s) => !items.some((i) => i.key === s.key));
      return [...cur, ...items.filter((i) => !keys.has(i.key))];
    });
  };

  // ---- data
  const matchesFilters = useCallback(
    (ex: Exercise) =>
      (!equipment || ex.equipment === equipment) && (!muscle || ex.primary === muscle || ex.secondary.includes(muscle)),
    [equipment, muscle],
  );

  const results = useMemo(() => searchExercises(index.list, q, { equipment, muscle }), [index.list, q, equipment, muscle]);

  const recent = useMemo(() => {
    if (!usage) return undefined;
    const out: Exercise[] = [];
    for (const id of usage.recentIds) {
      const ex = index.byId.get(id);
      if (!ex || ex.hidden || ex.missing || !matchesFilters(ex)) continue;
      out.push(ex);
    }
    return out;
  }, [usage, index, matchesFilters]);

  const recentFiltered = useMemo(() => {
    if (!recent || !q.trim()) return recent;
    const hit = new Set(searchExercises(recent, q).map((e) => e.id));
    return recent.filter((e) => hit.has(e.id));
  }, [recent, q]);

  /** Every routine that has exercises, in the Workout tab's order (folders, then each folder's order). */
  const routineBook = useMemo(() => {
    if (!routines || !folders) return undefined;
    const folderIdx = new Map(folders.map((f, i) => [f.id, i]));
    const folderName = new Map(folders.map((f) => [f.id, f.name]));
    const rank = (r: Routine) => (r.folderId && folderIdx.has(r.folderId) ? folderIdx.get(r.folderId)! : -1);
    const sorted = routines.filter((r) => r.id !== excludeRoutineId).sort((a, b) => rank(a) - rank(b) || a.order - b.order);
    return sorted
      .map((r) => ({
        routine: r,
        folder: (r.folderId && folderName.get(r.folderId)) || 'My Routines',
        // Skip exercises that no longer exist (deleted custom exercises).
        usable: r.exercises.filter((re) => !index.get(re.exerciseId).missing),
      }))
      .filter((b) => b.usable.length);
  }, [routines, folders, index, excludeRoutineId]);

  const browsing = !q.trim();
  const shownRoutineId = useMemo(
    () => (routineBook ? browseRoutineId(routineBook.map((b) => b.routine.id), pickedRoutineId, currentRoutineId) : null),
    [routineBook, pickedRoutineId, currentRoutineId],
  );

  /** Browsing: the one routine its chip picked. Searching: the matches from every routine. */
  const routineSections = useMemo(() => {
    if (!routineBook) return undefined;
    const term = norm(q);
    if (!term) return routineBook.filter((b) => b.routine.id === shownRoutineId).map((b) => ({ ...b, items: b.usable }));
    return routineBook
      .map(({ routine: r, folder, usable }) => {
        let items = usable;
        if (!norm(r.name).includes(term)) {
          const hits = new Set(
            searchExercises(
              usable.map((re) => index.get(re.exerciseId)),
              q,
              { includeHidden: true },
            ).map((e) => e.id),
          );
          items = usable.filter((re) => hits.has(re.exerciseId));
        }
        return { routine: r, folder, usable, items };
      })
      .filter((s) => s.items.length);
  }, [routineBook, q, index, shownRoutineId]);

  /** Picks per routine, for the count on its chip (picks from several routines are added in one go). */
  const pickedPerRoutine = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of selected) {
      const id = s.pick.fromRoutine?.routineId;
      if (id) m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [selected]);

  // Jump back to the top when the list changes underneath the user.
  useEffect(() => {
    const sp = scrollParent(bodyRef.current);
    if (sp) sp.scrollTop = 0;
  }, [q, equipment, muscle, tab, shownRoutineId]);

  // The chip row starts scrolled to the routine it shows (it can be off to the right).
  useEffect(() => {
    if (tab !== 'routines') return;
    chipsRef.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [tab, browsing, routineBook]);

  const blurSearch = () => {
    if (document.activeElement === searchRef.current) searchRef.current?.blur();
  };

  const filtersActive = !!(equipment || muscle);
  const clearFilters = () => {
    setEquipment(null);
    setMuscle(null);
  };

  const row = (ex: Exercise) => (
    <ExerciseRow
      key={ex.id}
      exercise={ex}
      count={usage?.byId.get(ex.id)?.count}
      selected={selectedKeys.has(exKey(ex.id))}
      onPress={pressExercise}
      onMore={openActions}
    />
  );

  // ---- tabs
  let content: React.ReactNode;
  if (tab === 'all') {
    const showRecent = !q.trim() && recent && recent.length > 0;
    content = (
      <>
        {showRecent ? (
          <>
            <ListLabel>Recent</ListLabel>
            {recent.slice(0, 8).map(row)}
          </>
        ) : null}
        {results.length ? (
          <>
            <ListLabel
              right={<span className="text-[12px] text-faint tabular-nums">{results.length.toLocaleString()}</span>}
            >
              {q.trim() ? 'Results' : filtersActive ? 'Exercises' : 'All Exercises'}
            </ListLabel>
            <IncrementalList items={results} resetKey={`${q}|${equipment}|${muscle}`} renderItem={row} />
          </>
        ) : (
          <EmptyState
            icon={<SearchX className="h-7 w-7" />}
            title="No exercises found"
            message={
              q.trim()
                ? `Nothing matches “${q.trim()}”${filtersActive ? ' with these filters' : ''}. Create it as your own exercise.`
                : 'No exercises match these filters.'
            }
            action={
              <div className="flex flex-col items-center gap-2">
                <Button icon={<Plus className="h-5 w-5" />} onClick={() => setCreating(true)}>
                  {q.trim() ? `Create “${q.trim()}”` : 'Create Exercise'}
                </Button>
                {filtersActive ? (
                  <Button variant="ghost" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </div>
            }
          />
        )}
      </>
    );
  } else if (tab === 'recent') {
    if (!recentFiltered) content = <Loading />;
    else if (!recentFiltered.length)
      content = (
        <EmptyState
          icon={<History className="h-7 w-7" />}
          title={recent?.length ? 'No matches' : 'No recent exercises'}
          message={
            recent?.length
              ? 'None of your recent exercises match.'
              : 'Exercises you log in a workout show up here, newest first.'
          }
          action={
            filtersActive ? (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      );
    else
      content = (
        <>
          <ListLabel>Recently performed</ListLabel>
          <IncrementalList
            items={recentFiltered}
            resetKey={`${q}|${equipment}|${muscle}`}
            renderItem={(ex) => {
              const u = usage?.byId.get(ex.id);
              const best = u ? bestSet(u.lastSets, ex.type) : null;
              const sub = u
                ? `Last: ${relativeDay(u.lastAt)}${best ? ` · ${formatSetValue(best, ex.type, unit, distanceUnit)}` : ''}`
                : undefined;
              return (
                <ExerciseRow
                  key={ex.id}
                  exercise={ex}
                  subtitle={sub}
                  count={u?.count}
                  selected={selectedKeys.has(exKey(ex.id))}
                  onPress={pressExercise}
                  onMore={openActions}
                />
              );
            }}
          />
        </>
      );
  } else {
    if (!routineSections) content = <Loading />;
    else if (!routineSections.length)
      content = (
        <EmptyState
          icon={<ClipboardList className="h-7 w-7" />}
          title={routineBook?.length ? 'No matches' : 'No routines yet'}
          message={
            routineBook?.length
              ? 'No routine exercise matches your search.'
              : 'Create a routine on the Workout tab — its exercises (with their planned sets) show up here so you can pull them into any workout.'
          }
          action={
            routineBook?.length && !browsing ? (
              <Button variant="ghost" onClick={() => setTab('all')}>
                Search all exercises
              </Button>
            ) : undefined
          }
        />
      );
    else
      content = routineSections.map(({ routine: r, folder, usable, items }) => {
        const all = usable.every((re) => selectedKeys.has(rtKey(r.id, re.id)));
        return (
          <section key={r.id} className="pb-1">
            <div className="flex items-end gap-3 px-4 pt-5 pb-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-semibold tracking-wide text-faint uppercase">{folder}</div>
                <div className="truncate text-[17px] font-semibold">{r.name}</div>
              </div>
              {!single ? (
                <button
                  type="button"
                  onClick={() => addAllFromRoutine(r, usable)}
                  className={cx(
                    'h-9 shrink-0 rounded-full px-3.5 text-[14px] font-semibold transition-colors',
                    all ? 'bg-surface-2 text-muted active:bg-surface-3' : 'bg-accent-soft text-accent active:brightness-110',
                  )}
                >
                  {all ? 'Remove all' : `Add all (${usable.length})`}
                </button>
              ) : null}
            </div>
            {items.map((re) => {
              const ex = index.get(re.exerciseId);
              const sel = routinePick(r, re);
              return (
                <ExerciseRow
                  key={re.id}
                  exercise={ex}
                  subtitle={routineSetsSummary(re.sets, ex.type, unit, distanceUnit)}
                  selected={selectedKeys.has(sel.key)}
                  onPress={() => toggle(sel)}
                  onMore={openActions}
                />
              );
            })}
          </section>
        );
      });
  }

  const n = selected.length;
  const picks = selected.map((s) => s.pick);
  const tabs: { value: Tab; label: string }[] = [
    { value: 'all', label: 'All' },
    ...(hideRoutinesTab ? [] : [{ value: 'routines' as Tab, label: 'Routines' }]),
    { value: 'recent', label: 'Recent' },
  ];

  return (
    <>
      <Sheet
        open
        // While a nested sheet covers the picker, only Escape can reach this — let the top sheet handle it
        // (the Create sheet asks before discarding) instead of tearing the whole picker down.
        onClose={() => {
          if (creating || actionsFor) return;
          onClose();
        }}
        size="full"
        title={title}
        left={<HeaderButton onClick={onClose}>Cancel</HeaderButton>}
        right={
          <HeaderButton bold onClick={() => setCreating(true)}>
            Create
          </HeaderButton>
        }
        footer={
          !single && n > 0 ? (
            <div className="flex gap-2">
              {n >= 2 ? (
                <Button variant="secondary" size="lg" className="flex-1" onClick={() => commit(picks, true)}>
                  Add as Superset
                </Button>
              ) : null}
              <Button size="lg" className="flex-1" onClick={() => commit(picks, false)}>
                Add {n} exercise{n === 1 ? '' : 's'}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div ref={bodyRef}>
          <div className="sticky top-0 z-10 space-y-2.5 border-b border-line/60 bg-surface/95 px-4 pt-1 pb-3 backdrop-blur-xl">
            <SearchField value={query} onChange={setQuery} autoFocus={autoFocus} inputRef={searchRef} />
            <Segmented value={tab} onChange={setTab} options={tabs} />
            {tab !== 'routines' ? (
              <FilterBar equipment={equipment} muscle={muscle} onEquipment={setEquipment} onMuscle={setMuscle} />
            ) : browsing && routineBook && routineBook.length > 1 ? (
              <div
                ref={chipsRef}
                className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4"
                role="group"
                aria-label="Routine"
                data-part="routine-chips"
              >
                {routineBook.map(({ routine: r }) => {
                  const active = r.id === shownRoutineId;
                  const n = pickedPerRoutine.get(r.id) ?? 0;
                  return (
                    <Chip key={r.id} active={active} onClick={() => setPickedRoutineId(r.id)} className="max-w-[70%]">
                      <span className="min-w-0 truncate">{r.name}</span>
                      {n ? (
                        <span
                          className={cx(
                            'ml-0.5 min-w-[18px] rounded-full px-1.5 text-center text-[12px] leading-[18px] font-semibold tabular-nums',
                            active ? 'bg-on-accent text-accent' : 'bg-accent text-on-accent',
                          )}
                        >
                          {n}
                          <span className="sr-only"> picked</span>
                        </span>
                      ) : null}
                    </Chip>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div onTouchStart={blurSearch} className="pb-6">
            {content}
          </div>
        </div>
      </Sheet>

      <ExerciseActions
        exercise={actionsFor}
        onClose={() => setActionsFor(null)}
        onViewDetails={(ex) => {
          onClose();
          nav(`/exercises/${ex.id}`);
        }}
        onVariantCreated={(id, name, from) => selectNew(id, name, from)}
      />

      <ExerciseCreateSheet
        open={creating}
        onClose={() => setCreating(false)}
        initialName={query}
        onCreated={(id, name) => {
          setCreating(false);
          selectNew(id, name);
        }}
      />
    </>
  );
}
