import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, Trophy, Weight } from 'lucide-react';
import type { PRRecord, Settings, Workout } from '../../../types';
import { db } from '../../../db';
import { ExerciseThumb } from '../../../components/ExerciseImage';
import { Card } from '../../../components/ui';
import { useExercises } from '../../../lib/ExerciseProvider';
import { PR_LABEL } from '../../../lib/calc';
import { EXERCISE_TYPE_LABEL } from '../../../lib/exerciseMeta';
import { formatWeight } from '../../../lib/units';
import { exerciseTrend, recentPRs, topExercises } from '../../../lib/stats';
import { METRIC_LABEL, PR_PRIORITY, formatMetric, formatPRValue, relativeDay } from '../format';
import { ProgressCard, Sparkline } from './shared';

const exercisePath = (id: string) => `/exercises/${encodeURIComponent(id)}`;

// ------------------------------------------------------------------ Recent records

interface RecordRow {
  key: string;
  workout: Workout;
  exerciseId: string;
  prs: PRRecord[];
}

export function RecentRecordsCard({ workouts, settings, now }: { workouts: Workout[]; settings: Settings; now: number }) {
  const navigate = useNavigate();
  const { get } = useExercises();
  // Group records set on the same exercise in the same workout into one row.
  const rows = useMemo(() => {
    const out: RecordRow[] = [];
    const byKey = new Map<string, RecordRow>();
    for (const { workout, pr } of recentPRs(workouts, 60)) {
      const key = `${workout.id}:${pr.exerciseId}`;
      let row = byKey.get(key);
      if (!row) {
        if (out.length >= 8) continue;
        row = { key, workout, exerciseId: pr.exerciseId, prs: [] };
        byKey.set(key, row);
        out.push(row);
      }
      row.prs.push(pr);
    }
    for (const r of out) r.prs.sort((a, b) => PR_PRIORITY.indexOf(a.kind) - PR_PRIORITY.indexOf(b.kind));
    return out;
  }, [workouts]);

  return (
    <ProgressCard title="Recent Records" icon={<Trophy className="h-[18px] w-[18px] text-gold" />}>
      {rows.length === 0 ? (
        <div className="rounded-xl bg-surface-2 px-4 py-5 text-center text-[14px] leading-snug text-muted">
          Beat one of your previous bests — heavier weight, more reps, a better estimated 1RM — and it shows up here.
        </div>
      ) : (
        <div className="-mx-2">
          {rows.map((r) => {
            const ex = get(r.exerciseId);
            const top = r.prs[0];
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => navigate(exercisePath(r.exerciseId))}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors active:bg-surface-2"
              >
                <div className="relative">
                  <ExerciseThumb exercise={ex} size={42} />
                  <span className="absolute -right-0.5 -bottom-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-surface bg-gold text-on-accent">
                    <Trophy className="h-2.5 w-2.5" strokeWidth={3} />
                  </span>
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{ex.name}</span>
                  <span className="block truncate text-[13px] text-muted">
                    {PR_LABEL[top.kind]} ·{' '}
                    <span className="font-semibold text-fg tabular-nums">
                      {formatPRValue(top.kind, top.value, ex.type, settings.unit, settings.distanceUnit)}
                    </span>
                    {r.prs.length > 1 ? <span className="text-gold"> +{r.prs.length - 1} more</span> : null}
                  </span>
                </span>
                <span className="shrink-0 text-[12px] text-faint">{relativeDay(r.workout.startedAt, now)}</span>
              </button>
            );
          })}
        </div>
      )}
    </ProgressCard>
  );
}

// ------------------------------------------------------------------ Top exercises

export function TopExercisesCard({ workouts, settings }: { workouts: Workout[]; settings: Settings }) {
  const navigate = useNavigate();
  const { get } = useExercises();
  const rows = useMemo(
    () =>
      topExercises(workouts, 6).map((t) => {
        const ex = get(t.exerciseId);
        const trend = exerciseTrend(workouts, t.exerciseId, ex.type);
        return { ...t, ex, trend };
      }),
    [workouts, get],
  );

  return (
    <ProgressCard title="Top Exercises">
      {rows.length === 0 ? (
        <div className="rounded-xl bg-surface-2 px-4 py-5 text-center text-[14px] text-muted">
          Exercises you do most often will show up here.
        </div>
      ) : (
        <div className="-mx-2">
          {rows.map((r) => {
            const values = r.trend.points.slice(-12).map((p) => p.value);
            return (
              <button
                key={r.exerciseId}
                type="button"
                onClick={() => navigate(exercisePath(r.exerciseId))}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors active:bg-surface-2"
              >
                <ExerciseThumb exercise={r.ex} size={42} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{r.ex.name}</span>
                  <span className="block truncate text-[13px] text-muted tabular-nums">
                    {r.trend.best > 0 ? (
                      <>
                        {METRIC_LABEL[r.trend.metric]}{' '}
                        <span className="font-semibold text-fg">
                          {formatMetric(r.trend.metric, r.trend.best, r.ex.type, settings.unit, settings.distanceUnit)}
                        </span>
                      </>
                    ) : (
                      EXERCISE_TYPE_LABEL[r.ex.type]
                    )}
                  </span>
                </span>
                <span className="flex w-[64px] shrink-0 flex-col items-end gap-0.5">
                  {values.length > 1 ? <Sparkline values={values} width={60} height={22} /> : null}
                  <span className="text-[11px] whitespace-nowrap text-faint tabular-nums">
                    {r.sessions} {r.sessions === 1 ? 'session' : 'sessions'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </ProgressCard>
  );
}

// ------------------------------------------------------------------ Body

export function BodyCard({ settings, now }: { settings: Settings; now: number }) {
  const navigate = useNavigate();
  // undefined while loading, [] when there are no weigh-ins.
  const weighIns = useLiveQuery(
    async () => (await db.measurements.orderBy('date').reverse().filter((m) => !!m.bodyweightKg).limit(12).toArray()).reverse(),
    [],
  );
  const entryCount = useLiveQuery(() => db.measurements.count(), []);
  const latest = weighIns?.[weighIns.length - 1];
  const loading = weighIns === undefined;

  let value: string | null = null;
  let sub: string;
  if (latest?.bodyweightKg) {
    value = formatWeight(latest.bodyweightKg, settings.unit);
    const when = relativeDay(latest.date, now);
    sub = `Logged ${when === 'Today' || when === 'Yesterday' ? when.toLowerCase() : when}`;
  } else if (settings.bodyweightKg) {
    value = formatWeight(settings.bodyweightKg, settings.unit);
    sub = 'From your profile · tap to log a weigh-in';
  } else {
    sub = 'Add your weight for accurate calories';
  }

  return (
    <Card onClick={() => navigate('/progress/measurements')} className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Weight className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-muted">Body</span>
          {loading ? (
            <span className="block h-6" />
          ) : value ? (
            <span className="block text-[20px] leading-tight font-bold tabular-nums">{value}</span>
          ) : (
            <span className="block text-[17px] font-semibold text-accent">Add your weight</span>
          )}
          <span className="block truncate text-[12px] text-muted">
            {loading ? ' ' : sub}
            {entryCount ? ` · ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}` : ''}
          </span>
        </span>
        {weighIns && weighIns.length > 1 ? (
          <Sparkline values={weighIns.map((m) => m.bodyweightKg!)} width={72} height={30} />
        ) : null}
        <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
      </div>
    </Card>
  );
}
