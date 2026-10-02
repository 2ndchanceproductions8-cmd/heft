import { Timer } from 'lucide-react';
import { useRestTimer, unlockAudio } from '../../lib/restTimer';
import { useSettings } from '../../lib/settings';
import { formatClock } from '../../lib/units';
import { useWorkoutStore } from '../../lib/workoutStore';

/**
 * Fixed countdown bar shown while resting between sets. Timestamp-based (see lib/restTimer.ts), so it stays
 * correct after the phone was locked; the alert when it hits 0 is fired by useRestTimer.
 */
export function RestTimerBar() {
  const { remainingSec, totalSec } = useRestTimer();
  const adjustRest = useWorkoutStore((s) => s.adjustRest);
  const stopRest = useWorkoutStore((s) => s.stopRest);
  const { restTimerSound } = useSettings();
  if (remainingSec == null) return null;
  const unlock = () => {
    if (restTimerSound) unlockAudio();
  };
  const pct = totalSec > 0 ? Math.min(100, Math.max(0, (remainingSec / totalSec) * 100)) : 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 animate-sheet-up">
      <div className="mx-auto max-w-xl border-t border-line bg-surface-2/95 pb-safe shadow-2xl backdrop-blur-xl">
        <div className="h-1 w-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={totalSec} aria-valuenow={remainingSec}>
          <div className="h-full bg-accent transition-[width] duration-300 ease-linear" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wide text-muted uppercase">
              <Timer className="h-3.5 w-3.5" />
              Rest
            </div>
            <div className="text-[34px] leading-none font-bold tabular-nums" aria-live="off">
              {formatClock(remainingSec)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              unlock();
              adjustRest(-15);
            }}
            className="h-11 w-14 rounded-xl bg-surface-3 text-[15px] font-semibold tabular-nums active:brightness-110"
          >
            -15s
          </button>
          <button
            type="button"
            onClick={() => {
              unlock();
              adjustRest(15);
            }}
            className="h-11 w-14 rounded-xl bg-surface-3 text-[15px] font-semibold tabular-nums active:brightness-110"
          >
            +15s
          </button>
          <button
            type="button"
            onClick={stopRest}
            className="h-11 rounded-xl bg-accent px-4 text-[15px] font-semibold text-on-accent active:brightness-90"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
