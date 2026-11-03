import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowRight, ArrowUp, Equal, Sparkles, Target } from 'lucide-react';
import type { Workout } from '../../types';
import { cx } from '../../components/ui';
import { db } from '../../db';
import { useExercises } from '../../lib/ExerciseProvider';
import { useSettings } from '../../lib/settings';
import { coachReview, type CoachStatus, type CoachTone } from './coach';

const TONE: Record<CoachTone, string> = {
  great: 'bg-success-soft text-success',
  good: 'bg-success-soft text-success',
  steady: 'bg-surface-2 text-muted',
  caution: 'bg-warn-soft text-warn',
  baseline: 'bg-accent-soft text-accent',
};

const STATUS: Record<CoachStatus, { label: string; cls: string }> = {
  first: { label: 'New', cls: 'bg-accent-soft text-accent' },
  up: { label: 'Up', cls: 'bg-success-soft text-success' },
  same: { label: 'Same', cls: 'bg-surface-2 text-muted' },
  mixed: { label: 'More work', cls: 'bg-surface-2 text-fg' },
  down: { label: 'Down', cls: 'bg-danger-soft text-danger' },
};

function StatusIcon({ status }: { status: CoachStatus }) {
  const c = 'h-3.5 w-3.5';
  if (status === 'up') return <ArrowUp className={c} strokeWidth={3} />;
  if (status === 'down') return <ArrowDown className={c} strokeWidth={3} />;
  if (status === 'same' || status === 'mixed') return <Equal className={c} strokeWidth={3} />;
  return <Sparkles className={c} />;
}

/**
 * "Coach review": how this session compares with the last time you did each exercise, and what to do next
 * (features/history/coach.ts). Shown right after finishing and on the saved workout. An exercise gets a "next
 * time" target only while no later workout contains it.
 */
export function CoachCard({ workout }: { workout: Workout }) {
  const index = useExercises();
  const units = useSettings();
  const data = useLiveQuery(async () => {
    const before = await db.workouts.where('startedAt').below(workout.startedAt).reverse().toArray();
    const laterIds = new Set<string>();
    await db.workouts
      .where('startedAt')
      .above(workout.startedAt)
      .each((w) => w.exercises.forEach((e) => laterIds.add(e.exerciseId)));
    return { before, laterIds };
  }, [workout.id, workout.startedAt]);
  if (!data) return null;

  const review = coachReview(workout, data.before, data.laterIds, (id) => index.get(id), units);
  if (!review.exercises.length) return null;

  return (
    <section className="mx-4 mt-4 rounded-2xl bg-surface p-4" aria-label="Coach review">
      <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-muted uppercase">
        <Target className="h-4 w-4 text-accent" />
        Coach review
      </div>
      <p className={cx('mt-2 rounded-xl px-3 py-2.5 text-[15px] leading-snug font-semibold', TONE[review.tone])}>{review.headline}</p>

      {review.notes.length ? (
        <ul className="mt-3 space-y-1.5 text-[14px] leading-snug text-muted">
          {review.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-4 divide-y divide-line/70">
        {review.exercises.map((e) => (
          <li key={e.exerciseId} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[16px] font-semibold">{e.name}</div>
                <div className="text-[13px] text-muted tabular-nums">
                  This workout {e.today}
                  {e.previous ? <> · Last {e.previous}</> : null}
                </div>
              </div>
              <span className={cx('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold', STATUS[e.status].cls)}>
                <StatusIcon status={e.status} />
                {e.change && (e.status === 'up' || e.status === 'down') ? e.change : STATUS[e.status].label}
              </span>
            </div>
            {e.status === 'mixed' && e.workChangePct != null ? (
              <p className="mt-1 text-[13px] text-muted">Lighter top set, but {e.workChangePct}% more total work than last time.</p>
            ) : null}
            {e.sideNote ? <p className="mt-1 text-[13px] leading-snug text-warn">{e.sideNote}</p> : null}
            {e.next ? (
              <p className="mt-1.5 flex gap-1.5 text-[14px] leading-snug">
                <ArrowRight className="mt-[3px] h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={3} />
                <span>
                  <span className="font-semibold text-accent">Next time: </span>
                  {e.next}
                </span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
