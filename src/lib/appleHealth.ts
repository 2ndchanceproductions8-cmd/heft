import { db } from '../db';
import type { Workout } from '../types';
import { DEFAULT_BODYWEIGHT_KG } from './calories';

/*
 * Apple Health bridge for the web app. A web page cannot talk to HealthKit, so a finished workout is handed to
 * an Apple Shortcut the user builds once ("Heft to Health"; steps on the Settings → Apple Health page) through
 * the shortcuts:// URL scheme. The Shortcut logs a Traditional Strength Training workout plus an Active Energy
 * sample so the calories count toward the Move ring. (Weigh-ins from Health into Heft were removed on 2026-10-10:
 * they're typed in.)
 *
 * A future native build (HealthKit) can reuse healthPayload().
 */

/** Must match the Shortcut's name exactly. */
export const SHORTCUT_NAME = 'Heft to Health';

/** What the Shortcut receives (as JSON text). Keys are the ones the setup guide tells the user to use. */
export interface HealthPayload {
  /** Start time, "October 2, 2026 at 6:05 PM" — the format Shortcuts reliably turns into a date. */
  start: string;
  /** Same instant in ISO 8601, for anyone building a fancier Shortcut. */
  startISO: string;
  /** Duration in minutes (1 decimal). */
  minutes: number;
  /** Active calories (kcal) — what the workout burned on top of resting, like Apple Watch "Active Calories". */
  kcal: number;
  name: string;
}

const RESTING_MET = 1.0;

/**
 * Active calories for Apple Health. Heft's estimate is a total (MET × kg × hours, which includes the 1 MET
 * the body burns at rest anyway); Apple's Move ring counts only active energy, so the resting part is taken
 * out. Numbers the user typed in themselves (e.g. a watch's Active Calories) are sent unchanged.
 */
export function activeCalories(w: Pick<Workout, 'calories' | 'caloriesManual' | 'durationSec' | 'bodyweightKg'>): number {
  const total = Math.max(0, w.calories ?? 0);
  if (w.caloriesManual) return Math.round(total);
  const kg = w.bodyweightKg || DEFAULT_BODYWEIGHT_KG;
  const resting = RESTING_MET * kg * (Math.max(0, w.durationSec) / 3600);
  return Math.max(0, Math.round(total - resting));
}

/** Newer ICU puts U+202F (narrow no-break space) before AM/PM and may use U+00A0; Shortcuts wants plain spaces. */
const ODD_SPACES = new RegExp("[" + String.fromCharCode(0x202f, 0x00a0) + "]", "g");
export const plainSpaces = (s: string): string => s.replace(ODD_SPACES, " ");

/** "October 2, 2026 at 6:05 PM" with plain spaces. */
export function shortcutDate(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return plainSpaces(`${date} at ${time}`);
}

export function healthPayload(w: Workout): HealthPayload {
  return {
    start: shortcutDate(w.startedAt),
    startISO: new Date(w.startedAt).toISOString(),
    minutes: Math.max(1, Math.round((w.durationSec / 60) * 10) / 10),
    kcal: activeCalories(w),
    name: w.name,
  };
}

export function shortcutUrl(payload: HealthPayload): string {
  return (
    'shortcuts://run-shortcut?name=' +
    encodeURIComponent(SHORTCUT_NAME) +
    '&input=text&text=' +
    encodeURIComponent(JSON.stringify(payload))
  );
}

/** iPhone / iPad (iPadOS reports itself as a Mac with touch). Shortcuts only exists on Apple devices. */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * The open Safari tab on an iPhone, not the installed app: its storage is separate, so a key saved here is lost and its
 * checks would take the inbox posts into the wrong database.
 */
export function inSafariTab(): boolean {
  if (typeof window === 'undefined' || !isAppleMobile()) return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return false;
  try {
    return !window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

/**
 * Open the Shortcut with this workout and remember that it was sent. Must be called from a tap handler
 * (iOS only follows app links that come from a user gesture).
 */
export async function sendWorkoutToHealth(w: Workout): Promise<void> {
  window.location.href = shortcutUrl(healthPayload(w));
  await db.workouts.update(w.id, { healthSentAt: Date.now() });
}
