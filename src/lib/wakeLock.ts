import { useEffect } from 'react';

/** Minimal typing for the Screen Wake Lock API (not in every TS DOM lib version). */
interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', cb: () => void): void;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/**
 * Keeps the screen awake while `enabled` (e.g. while logging a workout). The browser drops the lock
 * whenever the page is hidden, so it is re-acquired when the page becomes visible again, and released on
 * unmount. Silently does nothing where the API is unsupported (older iOS) or denied.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined') return;
    const wl = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!wl) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    let pending = false;

    const acquire = async () => {
      if (disposed || pending || document.visibilityState !== 'visible') return;
      if (sentinel && !sentinel.released) return;
      pending = true;
      try {
        const s = await wl.request('screen');
        if (disposed) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
      } catch {
        /* denied (battery saver, not visible...) — try again on the next visibility change */
      } finally {
        pending = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
      sentinel = null;
    };
  }, [enabled]);
}
