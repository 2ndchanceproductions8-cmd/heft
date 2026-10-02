import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ChevronRight, History, Trophy } from 'lucide-react';
import type { Exercise, SetType, Workout } from '../../types';
import { Card, EmptyState, cx } from '../../components/ui';
import { exerciseSessions, type ExerciseSession } from '../../lib/calc';
import { useSettings } from '../../lib/settings';
import { IncrementalList } from './ExerciseList';
import { formatEstWeight, formatSetValue, setLabels } from './format';

const BADGE_TONE: Record<SetType, string> = {
  normal: 'text-muted',
  warmup: 'text-warn',
  failure: 'text-danger',
  drop: 'text-drop',
};

/** One card per session (newest first) with every set; PR sets get a gold trophy. */
export function HistoryTab({ exercise, workouts }: { exercise: Exercise; workouts: Workout[] }) {
  const nav = useNavigate();
  const { unit, distanceUnit } = useSettings();

  const sessions = useMemo(
    () => exerciseSessions(workouts, exercise.id, exercise.type).reverse(),
    [workouts, exercise.id, exercise.type],
  );
  const extras = useMemo(() => {
    const m = new Map<string, { prSets: Set<string>; notes: string[] }>();
    for (const w of workouts) {
      m.set(w.id, {
        prSets: new Set((w.prs ?? []).filter((p) => p.exerciseId === exercise.id).map((p) => p.setId)),
        notes: w.exercises
          .filter((e) => e.exerciseId === exercise.id && e.notes?.trim())
          .map((e) => e.notes!.trim()),
      });
    }
    return m;
  }, [workouts, exercise.id]);

  if (!sessions.length) {
    return (
      <EmptyState
        icon={<History className="h-7 w-7" />}
        title="No history yet"
        message="Every workout you log with this exercise shows up here, with all your sets."
      />
    );
  }

  const showE1RM = exercise.type === 'weight_reps';

  const renderSession = (s: ExerciseSession) => {
    const ext = extras.get(s.workoutId);
    const labels = setLabels(s.sets);
    return (
      <Card key={s.workoutId} className="overflow-hidden">
        <button
          type="button"
          onClick={() => nav(`/history/${s.workoutId}`)}
          className="flex w-full items-center gap-2 px-4 pt-3.5 pb-2 text-left transition-colors active:bg-surface-2"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[16px] font-semibold">{s.workoutName}</span>
            <span className="block text-[13px] text-muted">
              {format(s.date, 'EEEE, MMM d, yyyy')} · {format(s.date, 'h:mm a')}
            </span>
          </span>
          <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
        </button>
        {ext?.notes.length ? (
          <p className="px-4 pb-1 text-[14px] leading-snug text-muted italic">{ext.notes.join(' · ')}</p>
        ) : null}
        <div className="px-4 pt-1 pb-3">
          <div className="flex items-center pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
            <span className="w-8">Set</span>
            <span className="flex-1">Performed</span>
          </div>
          {s.sets.map((set, i) => {
            const pr = ext?.prSets.has(set.id);
            return (
              <div key={set.id} className="flex h-8 items-center text-[15px] tabular-nums">
                <span className={cx('w-8 font-semibold', BADGE_TONE[set.type])}>{labels[i]}</span>
                <span className="flex-1 truncate">{formatSetValue(set, exercise.type, unit, distanceUnit)}</span>
                {pr ? (
                  <span className="flex items-center gap-1 rounded-full bg-gold-soft px-2 py-0.5 text-[12px] font-semibold text-gold">
                    <Trophy className="h-3.5 w-3.5" aria-label="Personal record" />
                    PR
                  </span>
                ) : null}
              </div>
            );
          })}
          {showE1RM && s.best1RM > 0 ? (
            <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-[13px]">
              <span className="text-muted">Best est. 1RM</span>
              <span className="font-semibold tabular-nums">{formatEstWeight(s.best1RM, unit)}</span>
            </div>
          ) : null}
        </div>
      </Card>
    );
  };

  return (
    <div className="space-y-3 px-4 pt-4">
      <IncrementalList items={sessions} resetKey={exercise.id} initial={20} renderItem={renderSession} />
    </div>
  );
}
