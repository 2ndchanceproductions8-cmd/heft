import { useNavigate } from 'react-router-dom';
import { ChevronUp, Timer } from 'lucide-react';
import { useRestTimer } from '../../lib/restTimer';
import { formatClock } from '../../lib/units';
import { useWorkoutStore } from '../../lib/workoutStore';
import { useNow } from './LoggerContext';

/**
 * "Workout in progress" bar shown above the tab bar (rendered by AppShell) while a workout runs.
 * Tapping it reopens the logger. Also keeps the rest timer alert working while the logger is minimized.
 */
export function MiniWorkoutBar() {
  const hydrated = useWorkoutStore((s) => s.hydrated);
  const active = useWorkoutStore((s) => s.active);
  if (!hydrated || !active) return null;
  return <Bar name={active.name.trim() || 'Workout'} startedAt={active.startedAt} />;
}

function Bar({ name, startedAt }: { name: string; startedAt: number }) {
  const navigate = useNavigate();
  const now = useNow(1000);
  const { remainingSec } = useRestTimer();
  const elapsed = Math.max(0, (now - startedAt) / 1000);

  return (
    <button
      type="button"
      onClick={() => navigate('/workout/active')}
      aria-label={`Workout in progress: ${name}. Open logger`}
      className="flex h-[52px] w-full items-center gap-3 border-t border-line bg-surface-2/95 px-4 text-left backdrop-blur-xl active:bg-surface-3"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold">{name}</span>
        <span className="block text-[12px] font-medium text-muted tabular-nums">
          {remainingSec != null ? (
            <span className="inline-flex items-center gap-1 text-accent">
              <Timer className="h-3 w-3" />
              Rest {formatClock(remainingSec)}
            </span>
          ) : (
            'Workout in progress'
          )}
        </span>
      </span>
      <span className="text-[17px] font-semibold text-accent tabular-nums">{formatClock(elapsed)}</span>
      <ChevronUp className="h-5 w-5 shrink-0 text-faint" />
    </button>
  );
}
