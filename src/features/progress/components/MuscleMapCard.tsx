import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startOfDay, subDays, subMonths, subYears } from 'date-fns';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { Muscle, Workout } from '../../../types';
import { MuscleMap, HEAT_STEPS } from '../../../components/MuscleMap';
import { ExerciseThumb } from '../../../components/ExerciseImage';
import { Segmented, cx } from '../../../components/ui';
import { useExercises } from '../../../lib/ExerciseProvider';
import { MUSCLE_LABEL } from '../../../lib/exerciseMeta';
import { exercisesForMuscle, muscleSetCounts } from '../../../lib/stats';
import { formatSets, readPref, relativeDay, writePref } from '../format';
import { Meter, ProgressCard } from './shared';

type Range = '7d' | '30d' | '3m' | '1y';
const RANGES: readonly Range[] = ['7d', '30d', '3m', '1y'];
const LIST_LIMIT = 6;
const RANGE_TEXT: Record<Range, string> = {
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  '3m': 'the last 3 months',
  '1y': 'the last year',
};

function rangeStart(r: Range, now: number): number {
  switch (r) {
    case '7d':
      return startOfDay(subDays(now, 6)).getTime();
    case '30d':
      return startOfDay(subDays(now, 29)).getTime();
    case '3m':
      return startOfDay(subMonths(now, 3)).getTime();
    case '1y':
      return startOfDay(subYears(now, 1)).getTime();
  }
}

export function MuscleMapCard({ workouts, now }: { workouts: Workout[]; now: number }) {
  const { get } = useExercises();
  const [range, setRangeState] = useState<Range>(() => readPref('progress.muscleRange', RANGES, '30d'));
  const [selected, setSelected] = useState<Muscle | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rowRefs = useRef(new Map<Muscle, HTMLDivElement>());

  const setRange = (r: Range) => {
    setRangeState(r);
    writePref('progress.muscleRange', r);
  };

  const from = rangeStart(range, now);
  const values = useMemo(() => muscleSetCounts(workouts, from, get), [workouts, from, get]);
  const ranked = useMemo(
    () =>
      (Object.entries(values) as [Muscle, number][])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1] || MUSCLE_LABEL[a[0]].localeCompare(MUSCLE_LABEL[b[0]])),
    [values],
  );
  const workingSets = useMemo(() => {
    let n = 0;
    for (const w of workouts) {
      if (w.startedAt < from) continue;
      for (const we of w.exercises) for (const s of we.sets) if (s.done && s.type !== 'warmup') n++;
    }
    return n;
  }, [workouts, from]);
  const max = ranked[0]?.[1] ?? 0;
  const selectedCount = selected ? values[selected] ?? 0 : 0;
  const selectedRank = selected ? ranked.findIndex(([m]) => m === selected) : -1;
  // Top muscles only, unless expanded (or the tapped muscle is further down the ranking).
  const visible = showAll || selectedRank >= LIST_LIMIT ? ranked : ranked.slice(0, LIST_LIMIT);

  // Stable identity so the memoized MuscleMap doesn't redraw on every render of this card.
  const toggle = useCallback((m: Muscle) => setSelected((cur) => (cur === m ? null : m)), []);

  // Bring the expanded row into view when a muscle is tapped on the map.
  useEffect(() => {
    if (!selected) return;
    const el = rowRefs.current.get(selected);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);

  return (
    <ProgressCard
      title="Muscle Map"
      right={
        <span className="text-[13px] text-muted tabular-nums">
          {workingSets.toLocaleString()} {workingSets === 1 ? 'set' : 'sets'}
        </span>
      }
    >
      <Segmented<Range>
        value={range}
        onChange={(r) => {
          setRange(r);
        }}
        options={[
          { value: '7d', label: '7D' },
          { value: '30d', label: '30D' },
          { value: '3m', label: '3M' },
          { value: '1y', label: '1Y' },
        ]}
      />

      <div className="mx-auto mt-4 max-w-[340px]">
        <MuscleMap values={values} onSelect={toggle} selected={selected} />
      </div>

      <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-muted" aria-hidden>
        <span>Fewer sets</span>
        <span className="flex gap-0.5">
          {HEAT_STEPS.map((o) => (
            <span key={o} className="h-2.5 w-4 rounded-[3px] bg-accent" style={{ opacity: o }} />
          ))}
        </span>
        <span>More sets</span>
      </div>

      {selected && selectedCount === 0 ? (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-[14px]">
          <span className="min-w-0 flex-1 text-muted">
            <span className="font-semibold text-fg">{MUSCLE_LABEL[selected]}</span> — no sets in {RANGE_TEXT[range]}.
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setSelected(null)}
            className="-m-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted active:bg-surface-3"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {ranked.length === 0 ? (
        <div className="mt-3 rounded-xl bg-surface-2 px-4 py-5 text-center text-[14px] text-muted">
          No working sets logged in {RANGE_TEXT[range]}.
        </div>
      ) : (
        <div className="mt-3 -mx-1">
          {visible.map(([m, v]) => {
            const open = selected === m;
            return (
              <div
                key={m}
                ref={(el) => {
                  if (el) rowRefs.current.set(m, el);
                  else rowRefs.current.delete(m);
                }}
                className={cx('rounded-xl transition-colors', open && 'bg-surface-2')}
                // Keep the row clear of the sticky header and the fixed tab bar / workout bar when it is
                // scrolled into view after a tap on the map.
                style={{ scrollMarginTop: 72, scrollMarginBottom: 'calc(env(safe-area-inset-bottom) + 150px)' }}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggle(m)}
                  className="flex w-full items-center gap-3 rounded-xl px-1 py-2 text-left active:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 px-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[15px] font-medium">{MUSCLE_LABEL[m]}</span>
                      <span className="shrink-0 text-[13px] text-muted tabular-nums">{formatSets(v)}</span>
                    </span>
                    <Meter value={max ? v / max : 0} className="mt-1.5" />
                  </span>
                  <ChevronDown
                    className={cx('h-4 w-4 shrink-0 text-faint transition-transform', open && 'rotate-180')}
                  />
                </button>
                {open ? <MuscleExercises workouts={workouts} from={from} muscle={m} now={now} /> : null}
              </div>
            );
          })}
          {ranked.length > LIST_LIMIT ? (
            <button
              type="button"
              onClick={() => {
                if (visible.length > LIST_LIMIT) {
                  setShowAll(false);
                  if (selectedRank >= LIST_LIMIT) setSelected(null);
                } else setShowAll(true);
              }}
              className="mt-1 h-10 w-full rounded-xl text-[14px] font-semibold text-accent active:bg-surface-2"
            >
              {visible.length > LIST_LIMIT ? 'Show less' : `Show all ${ranked.length} muscles`}
            </button>
          ) : null}
        </div>
      )}
    </ProgressCard>
  );
}

function MuscleExercises({ workouts, from, muscle, now }: { workouts: Workout[]; from: number; muscle: Muscle; now: number }) {
  const navigate = useNavigate();
  const { get } = useExercises();
  const rows = useMemo(() => exercisesForMuscle(workouts, from, muscle, get), [workouts, from, muscle, get]);
  return (
    <div className="px-1 pb-2">
      {rows.map((r) => {
        const ex = get(r.exerciseId);
        return (
          <button
            key={r.exerciseId}
            type="button"
            onClick={() => navigate(`/exercises/${encodeURIComponent(r.exerciseId)}`)}
            className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left active:bg-surface-3"
          >
            <ExerciseThumb exercise={ex} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{ex.name}</span>
              <span className="block truncate text-[12px] text-muted tabular-nums">
                {r.role === 'primary' ? 'Primary' : 'Secondary'} · {formatSets(r.sets)} · {relativeDay(r.lastDate, now)}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-faint" />
          </button>
        );
      })}
    </div>
  );
}
