import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { dayKey, dayStart, shiftDay } from '../../../lib/nutrition/math';
import { useWakeNow } from '../../../lib/useWakeNow';

/*
 * Day handling for the Diary: which day ?d= points at, what to call it, and a "today" that rolls over at
 * midnight (useWakeNow covers the app coming back from the background; the timer covers an open screen).
 */

/** A real calendar day key ('2026-02-31' and junk are rejected). */
export function isDayKey(v: string | null | undefined): v is string {
  if (!v) return false;
  const ms = dayStart(v);
  return Number.isFinite(ms) && dayKey(ms) === v;
}

/** The day ?d= asks for: a valid day key not after today, else today. */
export function parseDiaryDay(param: string | null | undefined, today: string): string {
  if (!isDayKey(param)) return today;
  return param > today ? today : param;
}

/** 'Today', 'Yesterday', 'Mon, Sep 29' (plus the year when it isn't this year's). */
export function dayLabel(day: string, today: string): string {
  if (day === today) return 'Today';
  if (day === shiftDay(today, -1)) return 'Yesterday';
  const ms = dayStart(day);
  if (!Number.isFinite(ms)) return day;
  return day.slice(0, 4) === today.slice(0, 4) ? format(ms, 'EEE, MMM d') : format(ms, 'EEE, MMM d, yyyy');
}

/** Mid-sentence form: 'today', 'yesterday', 'Mon, Sep 29'. */
export function dayPhrase(day: string, today: string): string {
  const l = dayLabel(day, today);
  return l === 'Today' || l === 'Yesterday' ? l.toLowerCase() : l;
}

/** Large page title: 'Food' on today, else the day's label. */
export function diaryTitle(day: string, today: string): string {
  return day === today ? 'Food' : dayLabel(day, today);
}

/** Query string for a diary-relative link: '' for today, '?d=<day>' otherwise. */
export function dayQuery(day: string, today: string): string {
  return day === today ? '' : `?d=${day}`;
}

/** Today's day key; re-renders when the app wakes and at local midnight while the screen stays open. */
export function useTodayKey(): string {
  const wake = useWakeNow();
  const [tick, setTick] = useState(wake);
  const now = Math.max(wake, tick);
  const today = dayKey(now);
  useEffect(() => {
    const nextMidnight = dayStart(shiftDay(today, 1));
    const wait = Math.max(1000, Math.min(nextMidnight - Date.now() + 1000, 24 * 3600 * 1000));
    const t = setTimeout(() => setTick(Date.now()), wait);
    return () => clearTimeout(t);
  }, [today]);
  return today;
}
