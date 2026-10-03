import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, Heart } from 'lucide-react';
import type { Workout } from '../../types';
import { db } from '../../db';
import { confirm } from '../../components/ui';
import { cx } from '../../components/ui/Button';
import { activeCalories, isAppleMobile, sendWorkoutToHealth } from '../../lib/appleHealth';
import { formatDuration } from '../../lib/units';

const BASE =
  'flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left transition-colors active:bg-surface-2';

/**
 * "Send to Apple Health" on a finished workout (hands it to the "Heft to Health" Shortcut). Before the
 * Shortcut is set up it is a "Connect Apple Health" link to the setup guide. Only on iPhone/iPad, where the
 * Shortcuts app exists. The caller sets the width (w-full or a calc with margins).
 */
export function SendToHealthButton({ workout, className }: { workout: Workout; className?: string }) {
  const navigate = useNavigate();
  // Read the settings row directly: undefined while IndexedDB answers, so the button doesn't flash
  // "Connect" before switching to "Send" (useSettings returns defaults until then).
  const row = useLiveQuery(() => db.settings.get('settings').then((s) => s ?? null), []);
  const busy = useRef(false);

  if (!isAppleMobile() || row === undefined) return null;

  if (!row?.appleHealth) {
    return (
      <button type="button" onClick={() => navigate('/settings/apple-health')} className={cx(BASE, className)}>
        <HeartBadge />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold">Connect Apple Health</span>
          <span className="block truncate text-[13px] text-muted">Send workouts to Health and your rings</span>
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
      </button>
    );
  }

  const sent = workout.healthSentAt;
  const send = async () => {
    // One send per tap: the "sent" stamp lands a moment after the Shortcuts app opens.
    if (busy.current) return;
    busy.current = true;
    setTimeout(() => (busy.current = false), 2000);
    if (sent) {
      const again = await confirm({
        title: 'Send again?',
        message: 'This workout was already sent to Apple Health. Sending it again adds a second copy there.',
        confirmLabel: 'Send Again',
      });
      if (!again) return;
    }
    await sendWorkoutToHealth(workout);
  };

  return (
    <button type="button" onClick={() => void send()} className={cx(BASE, className)}>
      <HeartBadge />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold">{sent ? 'Sent to Apple Health' : 'Send to Apple Health'}</span>
        <span className="block truncate text-[13px] text-muted tabular-nums">
          {sent
            ? `${new Date(sent).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · tap to send again`
            : `${formatDuration(workout.durationSec)} · ${activeCalories(workout).toLocaleString()} active kcal`}
        </span>
      </span>
      <ChevronRight className="h-5 w-5 shrink-0 text-faint" />
    </button>
  );
}

function HeartBadge() {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
      <Heart className="h-5 w-5" fill="currentColor" />
    </span>
  );
}
