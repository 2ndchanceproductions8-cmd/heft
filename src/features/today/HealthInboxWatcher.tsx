import { useEffect } from 'react';
import { toast } from '../../components/ui';
import { inSafariTab } from '../../lib/appleHealth';
import {
  checkInboxNow,
  getInboxToken,
  inboxImportMessage,
  inboxMessage,
  onInboxResult,
  useInboxStatus,
  type InboxState,
  type InboxSyncResult,
} from '../../lib/healthInbox';
import { getSettings } from '../../lib/settings';
import type { Unit } from '../../types';

/*
 * Automatic Hume sync (lib/healthInbox.ts). Mounted once in AppShell's RootLayout. When a token is saved on this
 * device it checks the inbox on launch, whenever Heft comes back to the foreground (visibilitychange / pageshow) and
 * when the connection returns: at most once per 15 s, never while offline. A freshly saved token is checked at once.
 *
 * The owner's flow is weigh in → close Hume → open Heft, and the Shortcut posts when Hume closes, so the post can land
 * a few seconds AFTER Heft's wake-up check. Each wake therefore also schedules two follow-up checks (16 s and 45 s
 * later) while Heft stays on screen, dropped when Heft is hidden or the key stops working. Not on an import: that may
 * have been an older post, with the new one still on its way.
 *
 * Automatic checks never run in a Safari tab: only the installed app takes the posts (a tab holding the key would
 * import into its own storage and delete them first). A manual Check now still works there.
 *
 * It announces EVERY finished check (onInboxResult), including ones a page started with checkInboxNow: weigh-ins
 * that came in ("From Hume: 184.2 lb · 19.4% body fat" / "From Hume: 3 weigh-ins"), and one error toast when the
 * inbox turns token_rejected, not_found, no_permission or unreadable (not again on every check, until a check
 * succeeds or the token changes). Never throws, never blocks rendering, renders nothing.
 */

const AUTO_GAP_MS = 15_000;
const FOLLOW_UPS_MS = [16_000, 45_000];

// Module-level, so React's StrictMode double mount (and any remount) can't double-check or double-toast.
let lastAutoAt = 0;
/** The error state the owner was already told about. */
let told: InboxState | null = null;
let followUps: ReturnType<typeof setTimeout>[] = [];

function cancelFollowUps(): void {
  for (const t of followUps) clearTimeout(t);
  followUps = [];
}

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

async function report(r: InboxSyncResult): Promise<void> {
  try {
    // The key stopped working: follow-ups would fail the same way. Not on 'unreadable': a fixed Shortcut's post can
    // land seconds later.
    if (r.state === 'token_rejected' || r.state === 'not_found' || r.state === 'no_permission') cancelFollowUps();
    if (r.state === 'token_rejected' || r.state === 'not_found' || r.state === 'no_permission' || r.state === 'unreadable') {
      if (told !== r.state) toast(`Hume sync paused. ${inboxMessage(r.state)}`, 'error', 6000);
      told = r.state;
    } else if (r.state === 'ok') told = null;
    if (r.added > 0) {
      let unit: Unit = 'lb';
      try {
        unit = (await getSettings()).unit;
      } catch {
        /* the default unit */
      }
      const msg = inboxImportMessage(r, unit);
      if (msg) toast(msg, 'success', 3500);
    }
  } catch {
    /* a toast problem never surfaces */
  }
}

/**
 * One automatic check, unless there's no token, Heft is offline, it's a Safari tab, or the last one was under 15 s
 * ago.
 */
function autoCheck(force: boolean): void {
  try {
    if (!getInboxToken() || !online() || inSafariTab()) return;
    const now = Date.now();
    if (!force && now - lastAutoAt < AUTO_GAP_MS) return;
    lastAutoAt = now;
    // Single-flight: a check already running with this token is joined, not repeated.
    void checkInboxNow();
  } catch {
    /* checkInboxNow never throws */
  }
}

/** Heft is on screen again (or just launched): check now, then follow up in case the Shortcut's post is late. */
function wake(force: boolean): void {
  cancelFollowUps();
  if (!getInboxToken() || !visible() || inSafariTab()) return;
  autoCheck(force);
  followUps = FOLLOW_UPS_MS.map((ms) =>
    setTimeout(() => {
      if (visible()) autoCheck(false);
    }, ms),
  );
}

export function HealthInboxWatcher() {
  const { configured, state } = useInboxStatus();
  // 'idle' = a token is saved but not checked yet: on launch, or right after a new token is saved.
  const fresh = configured && state === 'idle';

  useEffect(() => onInboxResult((r) => void report(r)), []);

  useEffect(() => {
    if (!fresh) return;
    told = null;
    wake(true);
  }, [fresh]);

  useEffect(() => {
    if (!configured) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') wake(false);
      else cancelFollowUps();
    };
    const onShow = () => wake(false);
    const onOnline = () => autoCheck(false);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onShow);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onShow);
      window.removeEventListener('online', onOnline);
      cancelFollowUps();
    };
  }, [configured]);

  return null;
}

/** Tests only: the watcher's steps without a DOM, and a reset of its module-level memory. */
export const watcherForTests = {
  report,
  wake,
  reset(): void {
    cancelFollowUps();
    lastAutoAt = 0;
    told = null;
  },
};
