import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Clock, Dumbbell, Flame, Heart, Plus, Trophy, Weight } from 'lucide-react';
import type { Unit, Workout } from '../../../types';
import { Button, cx } from '../../../components/ui';
import { activeCalories } from '../../../lib/appleHealth';
import { formatDuration, formatVolume } from '../../../lib/units';
import { ProgressCard } from '../../progress/components/shared';
import { relativeDay } from '../../progress/format';
import { buildTraining, elapsedLabel, plural, weekSummary, workoutName, type HealthNudge } from './model';

/*
 * The Training card's look, from plain props (no IndexedDB): the live card (../TrainingCard.tsx) reads the data.
 * Mirrors the Progress tab cards (ProgressCard title row, ThisWeekCard's streak chip, list rows like ListCards).
 */

export interface ActiveInfo {
  name: string;
  startedAt: number;
}

export interface TrainingCardViewProps {
  /** Saved workouts (any order). */
  workouts: Workout[];
  /** Local day key yyyy-MM-dd. */
  today: string;
  /** Epoch ms, stable between renders (the week math and "3d ago" labels use it). */
  now: number;
  unit: Unit;
  weekStartsOn: 0 | 1;
  /** The workout running now, or null. */
  active: ActiveInfo | null;
  /** "N workouts not sent to Apple Health" (null = hidden: not an iPhone, Shortcut not set up, or all sent). */
  nudge: HealthNudge | null;
  onStartEmpty: () => void;
}

const titleIcon = <Dumbbell className="h-[18px] w-[18px] text-accent" />;
const historyPath = (id: string) => `/history/${encodeURIComponent(id)}`;
const ROW = '-mx-2 flex items-center gap-3 rounded-xl px-2 transition-colors active:bg-surface-2';
const LINK_BUTTON =
  'inline-flex h-11 shrink-0 items-center justify-center rounded-xl px-4 text-[15px] font-semibold transition-[filter,background-color] select-none';

export function TrainingCardView({ workouts, today, now, unit, weekStartsOn, active, nudge, onStartEmpty }: TrainingCardViewProps) {
  const m = useMemo(() => buildTraining(workouts, today, now, weekStartsOn), [workouts, today, now, weekStartsOn]);

  let body: ReactNode = null;
  if (m.todays.length > 0) {
    body = <TodayList workouts={m.todays} totals={m.todayTotals} unit={unit} />;
  } else if (!active) {
    if (m.last) body = <RestDay last={m.last} now={now} />;
    else if (!m.trained) body = <p className="text-[15px] leading-snug text-muted">Log your first workout and it shows up here.</p>;
    else body = <p className="text-[15px] font-semibold">Rest day so far</p>;
  }

  return (
    <ProgressCard title="Training" icon={titleIcon} right={<StreakChip streak={m.streak} />}>
      <div className="space-y-3">
        {active ? <ActiveLine active={active} now={now} /> : null}
        {body}
        {m.trained ? (
          <Link to="/progress" className="flex items-center gap-2 rounded-xl bg-surface-2 py-2.5 pr-2 pl-3 transition-colors active:bg-surface-3">
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="font-medium text-muted">This week</span>
                <span className="truncate text-faint tabular-nums">{`Last week · ${plural(m.lastWeek.workouts, 'workout', 'workouts')}`}</span>
              </span>
              {/* Wraps between parts (never inside "31,250 lb") instead of cutting off a heavy week's numbers. */}
              <span className="mt-0.5 block text-[15px] leading-snug font-semibold tabular-nums">
                {weekSummary(m.thisWeek, unit)
                  .split(' · ')
                  .map((part, i) => (
                    <Fragment key={i}>
                      {i > 0 ? ' · ' : null}
                      <span className="whitespace-nowrap">{part}</span>
                    </Fragment>
                  ))}
              </span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
          </Link>
        ) : null}
        {nudge ? (
          <Link to={historyPath(nudge.workoutId)} className={cx(ROW, 'min-h-11 py-1.5')}>
            <Heart className="h-4 w-4 shrink-0 text-danger" fill="currentColor" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium tabular-nums">
              {plural(nudge.count, 'workout', 'workouts')} not sent to Apple Health
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
          </Link>
        ) : null}
        {active ? null : (
          <div className="flex gap-2">
            <Button
              className="min-w-0 flex-1 px-3"
              icon={<Plus className="h-[18px] w-[18px] shrink-0" strokeWidth={2.5} />}
              onClick={onStartEmpty}
            >
              <span className="truncate">Start empty workout</span>
            </Button>
            <Link to="/workout" className={cx(LINK_BUTTON, 'bg-surface-2 text-fg active:bg-surface-3')}>
              Routines
            </Link>
          </div>
        )}
      </div>
    </ProgressCard>
  );
}

/** Same chip as Progress' This Week card. */
function StreakChip({ streak }: { streak: number }) {
  return (
    <div
      className={cx(
        'flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold tabular-nums',
        streak > 0 ? 'bg-gold-soft text-gold' : 'bg-surface-2 text-muted',
      )}
      title="Consecutive weeks with at least one workout"
    >
      <Flame className="h-4 w-4" fill={streak > 0 ? 'currentColor' : 'none'} strokeWidth={2} />
      {streak > 0 ? `${streak.toLocaleString()}-week streak` : 'No streak yet'}
    </div>
  );
}

/**
 * Epoch ms that moves on every `intervalMs` (and when the app comes back to the foreground), never earlier than
 * `base`. Starts at `base`, so a server render shows the given time.
 */
function useTicking(base: number, intervalMs: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const update = () => setTick(Date.now());
    const t = window.setInterval(update, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') update();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return Math.max(base, tick);
}

/**
 * The running workout + Resume. Name on top and "In progress · 23min" under it, like the mini workout bar (one line
 * left a long name a few letters wide next to the button on a 375px phone). The mini bar has the running clock; this
 * stays to the minute.
 */
function ActiveLine({ active, now }: { active: ActiveInfo; now: number }) {
  const clock = useTicking(now, 10_000);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-accent-soft py-1.5 pr-1.5 pl-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">{workoutName(active.name)}</span>
        <span className="flex items-center gap-1.5 text-[13px] tabular-nums">
          <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
          <span className="truncate">
            <span className="font-semibold text-accent">In progress</span>
            <span className="text-muted"> · {elapsedLabel(active.startedAt, clock)}</span>
          </span>
        </span>
      </span>
      <Link to="/workout/active" className={cx(LINK_BUTTON, 'h-10 bg-accent text-on-accent active:brightness-90')}>
        Resume
      </Link>
    </div>
  );
}

function Meta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      {children}
    </span>
  );
}

function TodayList({
  workouts,
  totals,
  unit,
}: {
  workouts: Workout[];
  totals: { durationSec: number; activeKcal: number };
  unit: Unit;
}) {
  const many = workouts.length > 1;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span className="shrink-0 font-medium text-muted">Today</span>
        {many ? (
          <span className="truncate text-faint tabular-nums">
            {formatDuration(totals.durationSec)} · {totals.activeKcal.toLocaleString()} kcal active
          </span>
        ) : null}
      </div>
      <div className="mt-0.5">
        {workouts.map((w) => (
          <TodayRow key={w.id} workout={w} unit={unit} />
        ))}
      </div>
    </div>
  );
}

function TodayRow({ workout: w, unit }: { workout: Workout; unit: Unit }) {
  const prs = w.prs?.length ?? 0;
  const kcal = activeCalories(w);
  return (
    <Link to={historyPath(w.id)} className={cx(ROW, 'min-h-12 py-2')}>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[15px] font-semibold text-accent">{workoutName(w.name)}</span>
          {prs > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gold-soft px-2 py-0.5 text-[12px] font-semibold text-gold tabular-nums">
              <Trophy className="h-3 w-3" strokeWidth={2.5} />
              {plural(prs, 'PR', 'PRs')}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-muted tabular-nums">
          <Meta icon={<Clock />}>{formatDuration(w.durationSec)}</Meta>
          {w.volumeKg > 0 ? <Meta icon={<Weight />}>{formatVolume(w.volumeKg, unit)}</Meta> : null}
          {kcal > 0 ? <Meta icon={<Flame />}>{kcal.toLocaleString()} kcal active</Meta> : null}
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
    </Link>
  );
}

/** "Rest day so far" + the last workout (one tap to it). */
function RestDay({ last, now }: { last: Workout; now: number }) {
  return (
    <Link to={historyPath(last.id)} className={cx(ROW, 'min-h-12 py-1.5')}>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold">Rest day so far</span>
        <span className="flex min-w-0 items-baseline text-[13px] text-muted tabular-nums">
          <span className="shrink-0 whitespace-pre">Last: </span>
          <span className="min-w-0 truncate font-medium text-accent">{workoutName(last.name)}</span>
          <span className="shrink-0 whitespace-pre">
            {' · '}
            {relativeDay(last.startedAt, now)} · {formatDuration(last.durationSec)}
          </span>
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
    </Link>
  );
}

/** Loading: the card's usual height, so the page doesn't jump when the data lands. */
export function TrainingCardSkeleton() {
  return (
    <ProgressCard title="Training" icon={titleIcon}>
      <div className="space-y-3" aria-busy="true" aria-label="Loading training">
        <div className="h-[52px] animate-pulse rounded-xl bg-surface-2" />
        <div className="h-[60px] animate-pulse rounded-xl bg-surface-2" />
        <div className="h-11 animate-pulse rounded-xl bg-surface-2" />
      </div>
    </ProgressCard>
  );
}
