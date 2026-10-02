import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  parse,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { CalendarX2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { DistanceUnit, Unit, Workout } from '../../types';
import { EmptyState, IconButton, cx } from '../../components/ui';
import { formatVolume } from '../../lib/units';
import { WorkoutCard } from './WorkoutCard';
import { dayKey, formatTotalTime, plural, totals, workoutsByDay } from './historyUtils';

// Session-scoped so coming back from a workout's detail page keeps the month and day you were looking at.
const MONTH_KEY = 'heft.history.calMonth';
const DAY_KEY = 'heft.history.calDay';

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string | null) {
  try {
    if (value == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode) — not critical */
  }
}

function savedMonth(): Date | null {
  const saved = readSession(MONTH_KEY);
  if (saved && /^\d{4}-\d{2}$/.test(saved)) {
    const d = parse(saved, 'yyyy-MM', new Date());
    if (!Number.isNaN(d.getTime())) return startOfMonth(d);
  }
  return null;
}

export function CalendarView({
  workouts,
  weekStartsOn,
  unit,
  distanceUnit,
  restore = false,
  now,
}: {
  /** Newest first. */
  workouts: Workout[];
  weekStartsOn: 0 | 1;
  unit: Unit;
  distanceUnit: DistanceUnit;
  /** Re-open on the month/day viewed last (returning with Back); otherwise start on the current month. */
  restore?: boolean;
  /** The current time, refreshed when the app wakes (drives "Today", the current month and the nav bounds). */
  now: number;
}) {
  const [month, setMonth] = useState<Date>(() => (restore && savedMonth()) || startOfMonth(now));
  const [selected, setSelected] = useState<string | null>(() => {
    if (!restore) return null;
    const d = readSession(DAY_KEY);
    const m = savedMonth();
    return d && m && d.startsWith(format(m, 'yyyy-MM')) ? d : null;
  });

  useEffect(() => writeSession(MONTH_KEY, format(month, 'yyyy-MM')), [month]);
  useEffect(() => writeSession(DAY_KEY, selected), [selected]);

  const byDay = useMemo(() => workoutsByDay(workouts), [workouts]);
  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(startOfMonth(month), { weekStartsOn }),
        end: endOfWeek(endOfMonth(month), { weekStartsOn }),
      }),
    [month, weekStartsOn],
  );
  const monthWorkouts = useMemo(() => workouts.filter((w) => isSameMonth(w.startedAt, month)), [workouts, month]);
  const stats = useMemo(() => totals(monthWorkouts), [monthWorkouts]);

  // Navigation bounds: from the month of the oldest workout up to this month (or a later logged workout).
  const thisMonth = startOfMonth(now);
  const newest = workouts[0]?.startedAt ?? now;
  const oldest = workouts[workouts.length - 1]?.startedAt ?? now;
  const lastMonth = startOfMonth(Math.max(newest, thisMonth.getTime()));
  const firstMonth = startOfMonth(Math.min(oldest, thisMonth.getTime()));
  const canPrev = month.getTime() > firstMonth.getTime();
  const canNext = month.getTime() < lastMonth.getTime();
  const onCurrentMonth = month.getTime() === thisMonth.getTime();

  // Woke up in a new month while looking at the (old) current month with no day picked: follow "today".
  // Adjusted during render (React's pattern for reacting to a changed prop) so there's no stale frame.
  const [seenThisMonth, setSeenThisMonth] = useState(thisMonth.getTime());
  if (seenThisMonth !== thisMonth.getTime()) {
    setSeenThisMonth(thisMonth.getTime());
    if (month.getTime() === seenThisMonth && selected == null) setMonth(thisMonth);
  }

  const go = (dir: -1 | 1) => {
    if ((dir < 0 && !canPrev) || (dir > 0 && !canNext)) return;
    setMonth((m) => (dir < 0 ? subMonths(m, 1) : addMonths(m, 1)));
    setSelected(null);
  };
  const goToday = () => {
    setMonth(thisMonth);
    setSelected(null);
  };

  // Horizontal swipe on the grid changes month; vertical scrolling is left to the browser (touch-action: pan-y).
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    swipe.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const todayKey = dayKey(now);
  const listed = selected ? byDay.get(selected) ?? [] : monthWorkouts;

  return (
    <div>
      <div className="mx-4 mt-4 rounded-2xl bg-surface px-3 pt-2 pb-3">
        <div className="flex items-center gap-2 pl-1">
          <h2 className="text-[17px] font-semibold" aria-live="polite">
            {format(month, 'MMMM yyyy')}
          </h2>
          {!onCurrentMonth ? (
            // 40px-tall hit area around a compact pill.
            <button type="button" onClick={goToday} className="flex h-10 items-center px-1 active:opacity-70">
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-accent">Today</span>
            </button>
          ) : null}
          <div className="ml-auto flex items-center">
            <IconButton label="Previous month" tone="accent" disabled={!canPrev} onClick={() => go(-1)}>
              <ChevronLeft className="h-6 w-6" />
            </IconButton>
            <IconButton label="Next month" tone="accent" disabled={!canNext} onClick={() => go(1)}>
              <ChevronRight className="h-6 w-6" />
            </IconButton>
          </div>
        </div>

        <div className="mt-1 grid grid-cols-7 text-center text-[12px] font-semibold text-faint" aria-hidden>
          {days.slice(0, 7).map((d) => (
            <div key={d.getDay()} className="py-1.5">
              {format(d, 'EEEEE')}
            </div>
          ))}
        </div>

        <div
          className="grid touch-pan-y grid-cols-7 gap-y-1"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (swipe.current = null)}
        >
          {days.map((d) => {
            const k = dayKey(d);
            if (!isSameMonth(d, month)) return <div key={k} aria-hidden />;
            const count = byDay.get(k)?.length ?? 0;
            const filled = count > 0;
            const isToday = k === todayKey;
            const isSel = k === selected;
            return (
              <div key={k} className="flex justify-center">
                <button
                  type="button"
                  aria-pressed={isSel}
                  aria-label={`${format(d, 'EEEE, MMMM d')}${count ? `, ${plural(count, 'workout')}` : ''}`}
                  onClick={() => setSelected(isSel ? null : k)}
                  className={cx(
                    'relative flex h-10 w-10 items-center justify-center rounded-full text-[15px] tabular-nums transition-[background-color,box-shadow]',
                    filled
                      ? 'bg-accent font-semibold text-on-accent active:brightness-90'
                      : isToday
                        ? 'font-semibold text-accent ring-2 ring-accent ring-inset active:bg-surface-3'
                        : 'text-fg active:bg-surface-3',
                    filled && isToday && !isSel && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
                    isSel && filled && 'ring-2 ring-fg ring-offset-2 ring-offset-surface',
                    isSel && !filled && 'bg-surface-3',
                  )}
                >
                  {format(d, 'd')}
                  {count > 1 ? (
                    <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-fg px-1 text-[10px] font-bold text-bg ring-2 ring-surface">
                      {count}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 border-t border-line pt-3 text-[13px] text-muted tabular-nums">
          <span>
            <span className="font-semibold text-fg">{stats.count}</span> {stats.count === 1 ? 'workout' : 'workouts'}
          </span>
          <span aria-hidden>·</span>
          <span>
            <span className="font-semibold text-fg">{formatTotalTime(stats.durationSec)}</span>
          </span>
          <span aria-hidden>·</span>
          <span>
            <span className="font-semibold text-fg">{formatVolume(stats.volumeKg, unit)}</span>
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between px-4 pt-6 pb-2">
        <h3 className="text-[13px] font-semibold tracking-wide text-muted uppercase">
          {selected ? format(parse(selected, 'yyyy-MM-dd', new Date()), 'EEEE, MMM d') : format(month, 'MMMM yyyy')}
        </h3>
        {selected ? (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="-my-2.5 -mr-2 py-2.5 pr-2 pl-3 text-[14px] font-semibold text-accent active:opacity-60"
          >
            Whole month
          </button>
        ) : (
          <span className="text-[13px] text-muted">{plural(monthWorkouts.length, 'workout')}</span>
        )}
      </div>

      {listed.length ? (
        <div className="space-y-3 px-4">
          {listed.map((w) => (
            <WorkoutCard key={w.id} workout={w} unit={unit} distanceUnit={distanceUnit} today={todayKey} />
          ))}
        </div>
      ) : (
        <EmptyState
          className="py-8"
          icon={<CalendarX2 className="h-7 w-7" />}
          title={selected ? (selected > todayKey ? 'No workouts yet' : 'Rest day') : `No workouts in ${format(month, 'MMMM')}`}
          message={selected ? 'Nothing logged on this day.' : 'Use the arrows or swipe the calendar to browse other months.'}
        />
      )}
    </div>
  );
}
