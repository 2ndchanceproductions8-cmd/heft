import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { isSameMonth } from 'date-fns';
import { CalendarDays, Dumbbell, Flame, List, Plus } from 'lucide-react';
import type { DistanceUnit, Unit, Workout } from '../../types';
import { Button, EmptyState, IconButton, Loading, Page, SectionHeader, TopBar } from '../../components/ui';
import { useSettings } from '../../lib/settings';
import { useWorkouts } from '../../lib/workouts';
import { beginWorkout } from '../../lib/startWorkout';
import { CalendarView } from './CalendarView';
import { HistoryErrorBoundary } from './HistoryErrorBoundary';
import { WorkoutCard } from './WorkoutCard';
import { dayKey, formatTotalTime, groupByMonth, plural, weeklyStreak } from './historyUtils';
import { useScrollMemory } from './useScrollMemory';
import { useWakeNow } from '../../lib/useWakeNow';

type View = 'list' | 'calendar';
const VIEW_KEY = 'heft.history.view';
const LIMIT_KEY = 'heft.history.limit';
/** Lists longer than this render incrementally. */
const INCREMENTAL_THRESHOLD = 50;
const PAGE_SIZE = 30;

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

export function HistoryPage() {
  return (
    <HistoryErrorBoundary title="History">
      <HistoryScreen />
    </HistoryErrorBoundary>
  );
}

function HistoryScreen() {
  const workouts = useWorkouts();
  const settings = useSettings();
  const navigate = useNavigate();
  const [view, setView] = useState<View>(readView);
  // Refreshed when the app returns to the foreground, so "This month", the streak and "Today" don't go stale.
  const now = useWakeNow();
  // Back from a workout (POP) — or arriving after deleting one — returns to the same month / list length
  // (and, on Back, scroll offset); arriving from the tab bar (PUSH) starts fresh on the current month.
  const navType = useNavigationType();
  const location = useLocation();
  const restore = navType === 'POP' || !!(location.state as { restoreView?: boolean } | null)?.restoreView;
  useScrollMemory(workouts !== undefined);

  const toggleView = () => {
    const next: View = view === 'list' ? 'calendar' : 'list';
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* storage unavailable — the choice just isn't remembered */
    }
  };

  const hasWorkouts = !!workouts?.length;

  return (
    <Page tabBar>
      <TopBar
        title="History"
        large
        right={
          hasWorkouts ? (
            <IconButton label={view === 'list' ? 'Show calendar' : 'Show list'} tone="accent" onClick={toggleView}>
              {view === 'list' ? <CalendarDays className="h-6 w-6" /> : <List className="h-6 w-6" />}
            </IconButton>
          ) : null
        }
      />
      {workouts === undefined ? (
        <Loading />
      ) : workouts.length === 0 ? (
        <EmptyState
          className="pt-20"
          icon={<Dumbbell className="h-7 w-7" />}
          title="No workouts yet"
          message="Finished workouts show up here with their time, volume, calories and records."
          action={
            <Button icon={<Plus className="h-5 w-5" />} onClick={() => void beginWorkout({ type: 'empty' }, navigate)}>
              Start Workout
            </Button>
          }
        />
      ) : (
        <>
          <SummaryStrip workouts={workouts} weekStartsOn={settings.weekStartsOn} now={now} />
          {view === 'calendar' ? (
            <CalendarView
              workouts={workouts}
              weekStartsOn={settings.weekStartsOn}
              unit={settings.unit}
              distanceUnit={settings.distanceUnit}
              restore={restore}
              now={now}
            />
          ) : (
            <WorkoutList
              workouts={workouts}
              unit={settings.unit}
              distanceUnit={settings.distanceUnit}
              restore={restore}
              today={dayKey(now)}
            />
          )}
        </>
      )}
    </Page>
  );
}

function SummaryStrip({ workouts, weekStartsOn, now }: { workouts: Workout[]; weekStartsOn: 0 | 1; now: number }) {
  const s = useMemo(() => {
    let thisMonth = 0;
    let totalSec = 0;
    for (const w of workouts) {
      if (isSameMonth(w.startedAt, now)) thisMonth++;
      totalSec += w.durationSec || 0;
    }
    return {
      total: workouts.length,
      thisMonth,
      streak: weeklyStreak(
        workouts.map((w) => w.startedAt),
        weekStartsOn,
        now,
      ),
      totalSec,
    };
  }, [workouts, weekStartsOn, now]);

  return (
    <div className="mx-4 mt-2 grid grid-cols-4 rounded-2xl bg-surface py-3">
      <Tile label="Workouts" value={s.total.toLocaleString()} />
      <Tile label="This month" value={s.thisMonth.toLocaleString()} />
      <Tile
        label="Week streak"
        value={
          <span className="inline-flex items-center gap-0.5">
            {s.streak > 0 ? <Flame className="h-4 w-4 text-gold" strokeWidth={2.4} /> : null}
            {s.streak}
          </span>
        }
      />
      <Tile label="Total time" value={formatTotalTime(s.totalSec)} />
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-center border-l border-line px-1 first:border-l-0">
      <div className="max-w-full truncate text-[18px] leading-tight font-bold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] font-medium whitespace-nowrap text-muted">{label}</div>
    </div>
  );
}

function readLimit(): number {
  try {
    const n = Number(sessionStorage.getItem(LIMIT_KEY));
    return Number.isFinite(n) && n > PAGE_SIZE ? n : PAGE_SIZE;
  } catch {
    return PAGE_SIZE;
  }
}

function WorkoutList({
  workouts,
  unit,
  distanceUnit,
  restore,
  today,
}: {
  workouts: Workout[];
  unit: Unit;
  distanceUnit: DistanceUnit;
  /** Re-open with as many workouts loaded as before (returning with Back). */
  restore: boolean;
  /** Today's day key, for the cards' "Today" / "Yesterday" labels. */
  today: string;
}) {
  const incremental = workouts.length > INCREMENTAL_THRESHOLD;
  const [limit, setLimit] = useState(() => (restore ? readLimit() : PAGE_SIZE));
  const visible = useMemo(() => (incremental ? workouts.slice(0, limit) : workouts), [workouts, incremental, limit]);
  const groups = useMemo(() => groupByMonth(visible), [visible]);
  // Month header counts come from the whole history, not just the rendered slice.
  const monthCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groupByMonth(workouts)) m.set(g.key, g.workouts.length);
    return m;
  }, [workouts]);
  const remaining = workouts.length - visible.length;

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (remaining <= 0) return;
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE_SIZE);
    }, { rootMargin: '0px 0px 900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [remaining, limit]);

  useEffect(() => {
    try {
      sessionStorage.setItem(LIMIT_KEY, String(limit));
    } catch {
      /* not critical */
    }
  }, [limit]);

  return (
    <div>
      {groups.map((g) => (
        <section key={g.key}>
          <SectionHeader right={<span className="text-[13px] text-muted">{plural(monthCounts.get(g.key) ?? g.workouts.length, 'workout')}</span>}>
            {g.label}
          </SectionHeader>
          <div className="space-y-3 px-4">
            {g.workouts.map((w) => (
              <WorkoutCard key={w.id} workout={w} unit={unit} distanceUnit={distanceUnit} today={today} />
            ))}
          </div>
        </section>
      ))}
      {remaining > 0 ? (
        <div ref={sentinel} className="flex justify-center px-4 pt-5">
          <Button variant="secondary" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, remaining)} more
          </Button>
        </div>
      ) : (
        <p className="pt-6 text-center text-[13px] text-faint">
          {plural(workouts.length, 'workout')} logged
        </p>
      )}
    </div>
  );
}
