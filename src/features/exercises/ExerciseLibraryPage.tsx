import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EyeOff, Plus, SearchX, Sparkles } from 'lucide-react';
import type { Equipment, Exercise, Muscle } from '../../types';
import { Button, EmptyState, IconButton, ListGroup, ListRow, Page, Segmented, Toggle, TopBar } from '../../components/ui';
import { useExercises } from '../../lib/ExerciseProvider';
import { searchExercises } from '../../lib/exercises';
import { ExerciseActions } from './ExerciseActions';
import { IncrementalList } from './ExerciseList';
import { ExerciseRow } from './ExerciseRow';
import { FilterBar, SearchField } from './FilterSheets';
import { useExerciseUsage } from './hooks';

type Tab = 'all' | 'mine';

/** Survives navigating into an exercise and back (scroll position is restored by the router). */
const memory = {
  query: '',
  equipment: null as Equipment | null,
  muscle: null as Muscle | null,
  tab: 'all' as Tab,
  showHidden: false,
  count: 60,
};

/** Custom exercises, gym/brand variants, and anything the owner renamed or photographed. */
const isMine = (ex: Exercise) => ex.source === 'custom' || ex.name !== ex.originalName || ex.photoIds.length > 0;

export function ExerciseLibraryPage() {
  const index = useExercises();
  const nav = useNavigate();
  const usage = useExerciseUsage();

  const [query, setQuery] = useState(memory.query);
  const [equipment, setEquipment] = useState(memory.equipment);
  const [muscle, setMuscle] = useState(memory.muscle);
  const [tab, setTab] = useState<Tab>(memory.tab);
  const [showHidden, setShowHidden] = useState(memory.showHidden);
  const [actionsFor, setActionsFor] = useState<Exercise | null>(null);
  const q = useDeferredValue(query);

  useEffect(() => {
    Object.assign(memory, { query, equipment, muscle, tab, showHidden });
  }, [query, equipment, muscle, tab, showHidden]);

  // New search / filter → start at the top of the results (searching while scrolled deep into the list would
  // otherwise leave the page clamped somewhere past the short result list). Skipped on mount so the router can
  // restore the scroll position when coming back from an exercise.
  const searchKey = `${q}|${equipment}|${muscle}`;
  const lastSearchKey = useRef(searchKey);
  useEffect(() => {
    if (lastSearchKey.current === searchKey) return;
    lastSearchKey.current = searchKey;
    window.scrollTo({ top: 0 });
  }, [searchKey]);

  const items = useMemo(() => {
    const list = searchExercises(index.list, q, { equipment, muscle, includeHidden: showHidden });
    return tab === 'mine' ? list.filter(isMine) : list;
  }, [index.list, q, equipment, muscle, showHidden, tab]);

  const hiddenCount = useMemo(() => index.list.filter((e) => e.hidden).length, [index.list]);
  const hiddenMatches = useMemo(() => {
    if (showHidden || !hiddenCount || (!q.trim() && !equipment && !muscle)) return 0;
    return searchExercises(index.list, q, { equipment, muscle, includeHidden: true }).filter(
      (e) => e.hidden && (tab === 'all' || isMine(e)),
    ).length;
  }, [showHidden, hiddenCount, index.list, q, equipment, muscle, tab]);
  const mineCount = useMemo(() => index.list.filter((e) => isMine(e) && !e.hidden).length, [index.list]);

  const open = useCallback((ex: Exercise) => nav(`/exercises/${ex.id}`), [nav]);
  const openActions = useCallback((ex: Exercise) => setActionsFor(ex), []);
  const rememberCount = useCallback((n: number) => {
    memory.count = n;
  }, []);

  const filtersActive = !!(equipment || muscle);
  const resetKey = `${q}|${equipment}|${muscle}|${tab}|${showHidden}`;

  return (
    <Page tabBar>
      <TopBar
        title="Exercises"
        large
        right={
          <IconButton label="Create exercise" tone="accent" onClick={() => nav('/exercises/new')}>
            <Plus className="h-6 w-6" strokeWidth={2.2} />
          </IconButton>
        }
      >
        <div className="space-y-2.5 px-4 pb-3">
          <SearchField value={query} onChange={setQuery} />
          <FilterBar equipment={equipment} muscle={muscle} onEquipment={setEquipment} onMuscle={setMuscle} />
        </div>
      </TopBar>

      <div className="px-4 pt-3 pb-1">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: mineCount ? `My Exercises (${mineCount})` : 'My Exercises' },
          ]}
        />
      </div>

      {items.length ? (
        <>
          <div className="flex items-center justify-between px-4 pt-3 pb-1 text-[13px] text-muted">
            <span className="tabular-nums">
              {items.length.toLocaleString()} {items.length === 1 ? 'exercise' : 'exercises'}
            </span>
            {filtersActive ? (
              <button
                type="button"
                className="font-semibold text-accent active:opacity-60"
                onClick={() => {
                  setEquipment(null);
                  setMuscle(null);
                }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
          <div>
            <IncrementalList
              items={items}
              resetKey={resetKey}
              startAt={memory.count}
              onCountChange={rememberCount}
              renderItem={(ex) => (
                <ExerciseRow
                  key={ex.id}
                  exercise={ex}
                  count={usage?.byId.get(ex.id)?.count}
                  onPress={open}
                  onMore={openActions}
                />
              )}
            />
          </div>
        </>
      ) : tab === 'mine' && !q.trim() && !filtersActive ? (
        <EmptyState
          icon={<Sparkles className="h-7 w-7" />}
          title="No custom exercises yet"
          message="Create your own exercises, add a gym/brand variant of a machine, or rename any exercise — they all show up here."
          action={
            <Button icon={<Plus className="h-5 w-5" />} onClick={() => nav('/exercises/new')}>
              Create Exercise
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<SearchX className="h-7 w-7" />}
          title="No exercises found"
          message={
            q.trim()
              ? `Nothing matches “${q.trim()}”${filtersActive ? ' with these filters' : ''}.`
              : 'No exercises match these filters.'
          }
          action={
            <div className="flex flex-col items-center gap-2">
              <Button icon={<Plus className="h-5 w-5" />} onClick={() => nav('/exercises/new')}>
                Create Exercise
              </Button>
              {filtersActive ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEquipment(null);
                    setMuscle(null);
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          }
        />
      )}

      {hiddenMatches > 0 ? (
        <button
          type="button"
          onClick={() => setShowHidden(true)}
          className="mx-auto mt-4 flex items-center gap-1.5 rounded-full bg-surface-2 px-4 py-2 text-[14px] font-medium text-muted active:bg-surface-3"
        >
          <EyeOff className="h-4 w-4" />
          {hiddenMatches} hidden {hiddenMatches === 1 ? 'exercise matches' : 'exercises match'} — show
        </button>
      ) : null}

      {hiddenCount > 0 || showHidden ? (
        <ListGroup className="mt-6">
          <ListRow
            icon={<EyeOff className="h-5 w-5" />}
            title="Show hidden"
            subtitle={`${hiddenCount} hidden ${hiddenCount === 1 ? 'exercise' : 'exercises'}`}
            right={<Toggle checked={showHidden} onChange={setShowHidden} label="Show hidden exercises" />}
          />
        </ListGroup>
      ) : null}

      <ExerciseActions
        exercise={actionsFor}
        onClose={() => setActionsFor(null)}
        onVariantCreated={(id) => nav(`/exercises/${id}`)}
      />
    </Page>
  );
}
