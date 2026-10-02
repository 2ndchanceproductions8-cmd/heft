import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import { Button } from '../../components/ui';
import { formatClock } from '../../lib/units';
import { useWorkoutStore } from '../../lib/workoutStore';
import { useNow } from './routineActions';

/** Prominent "Workout in progress" card at the top of the Workout tab (live elapsed time + Resume). */
export function ActiveWorkoutCard() {
  const nav = useNavigate();
  const active = useWorkoutStore((s) => s.active);
  const hydrated = useWorkoutStore((s) => s.hydrated);
  const now = useNow(1000, hydrated && !!active);
  if (!hydrated || !active) return null;

  const elapsed = Math.max(0, (now - active.startedAt) / 1000);
  const exerciseCount = active.exercises.length;
  const doneSets = active.exercises.reduce((n, e) => n + e.sets.filter((s) => s.done).length, 0);

  return (
    <div className="mx-4 mt-3 rounded-2xl border border-accent/35 bg-accent-soft p-4">
      <div className="flex items-center gap-2 text-[12px] font-semibold tracking-wide text-accent uppercase">
        <span className="relative flex h-2.5 w-2.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
        Workout in progress
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[18px] font-bold">{active.name || 'Workout'}</div>
          <div className="text-[14px] text-muted tabular-nums">
            {exerciseCount} {exerciseCount === 1 ? 'exercise' : 'exercises'} · {doneSets} {doneSets === 1 ? 'set' : 'sets'} done
          </div>
        </div>
        <div className="shrink-0 text-[26px] leading-none font-bold tabular-nums" aria-label="Elapsed time">
          {formatClock(elapsed)}
        </div>
      </div>
      <Button block size="lg" className="mt-3" icon={<Play className="h-4 w-4 fill-current" />} onClick={() => nav('/workout/active')}>
        Resume
      </Button>
    </div>
  );
}
