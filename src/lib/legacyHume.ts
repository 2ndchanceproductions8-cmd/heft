/*
 * Automatic Hume sync (a GitHub inbox the iPhone posted weigh-ins to) was removed on 2026-10-10: weigh-ins are typed
 * in now. Its GitHub key and last status lived in this browser's localStorage, outside the database, so a phone that
 * had it set up would keep the key forever. The app forgets both on launch (and Delete all data does too).
 */

export const LEGACY_HUME_KEYS = ['heft-key:github-inbox', 'heft-inbox:status'] as const;

export function forgetHumeSync(): void {
  for (const key of LEGACY_HUME_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage blocked: nothing was saved either */
    }
  }
}
