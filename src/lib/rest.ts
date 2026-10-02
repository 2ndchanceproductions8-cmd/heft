import { formatClock } from './units';

/*
 * The ONE rest-timer vocabulary: the same choices and the same labels in the workout logger, the routine
 * editor and detail page, the exercise page's default rest timer and Settings. (The running countdown is a
 * clock, formatClock, and is not a setting.)
 */

/** Rest timer choices in seconds: Off, 5s … 45s, 1:00 … 5:00. */
export const REST_OPTIONS: readonly number[] = [0, 5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300];

/** A rest value as shown everywhere: 0 -> "Off", 45 -> "45s", 90 -> "1:30", 300 -> "5:00". */
export function restOptionLabel(sec: number): string {
  if (!(sec > 0)) return 'Off';
  const s = Math.round(sec);
  return s < 60 ? `${s}s` : formatClock(s);
}

/**
 * Label for a rest SETTING that can be left on "Default" (null/undefined = the exercise default, else the
 * Settings default, passed as `defaultSec`): "Default (1:30)", "Off", "2:00".
 */
export function restSettingLabel(sec: number | null | undefined, defaultSec: number): string {
  return sec == null ? `Default (${restOptionLabel(defaultSec)})` : restOptionLabel(sec);
}

/** REST_OPTIONS plus `current` when it was set to something off the list (so the picker can show it as chosen). */
export function restOptionsWith(current?: number | null): number[] {
  if (current == null || REST_OPTIONS.includes(current)) return [...REST_OPTIONS];
  return [...REST_OPTIONS, current].sort((a, b) => a - b);
}
