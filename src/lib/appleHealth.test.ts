import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workout } from '../types';
import { activeCalories, healthPayload, shortcutDate, shortcutUrl, SHORTCUT_NAME } from './appleHealth';

const base: Workout = {
  id: 'w1',
  name: 'Push Day',
  startedAt: new Date(2026, 9, 2, 18, 5).getTime(),
  endedAt: new Date(2026, 9, 2, 19, 5).getTime(),
  durationSec: 3600,
  exercises: [],
  exerciseIds: [],
  photoIds: [],
  bodyweightKg: 80,
  calories: 400,
  caloriesManual: false,
  volumeKg: 0,
  setCount: 0,
  prs: [],
  createdAt: 0,
  updatedAt: 0,
};

describe('apple health payload', () => {
  it('removes the resting share from estimated calories', () => {
    // 400 total − 1 MET × 80 kg × 1 h = 320 active
    expect(activeCalories(base)).toBe(320);
  });
  it('sends typed-in calories unchanged', () => {
    expect(activeCalories({ ...base, calories: 250, caloriesManual: true })).toBe(250);
  });
  it('never sends negative calories and tolerates a missing estimate', () => {
    expect(activeCalories({ ...base, calories: 10 })).toBe(0);
    expect(activeCalories({ ...base, calories: null })).toBe(0);
  });
  it('formats the start date the way Shortcuts reads dates', () => {
    expect(shortcutDate(base.startedAt)).toBe('October 2, 2026 at 6:05 PM');
  });
  it('builds a run-shortcut URL whose text is the JSON payload', () => {
    const p = healthPayload(base);
    expect(p).toMatchObject({ minutes: 60, kcal: 320, name: 'Push Day', start: 'October 2, 2026 at 6:05 PM' });
    const url = shortcutUrl(p);
    expect(url.startsWith('shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT_NAME) + '&input=text&text=')).toBe(true);
    const text = decodeURIComponent(url.split('&text=')[1]);
    expect(JSON.parse(text)).toEqual(p);
  });
});

import { plainSpaces } from './appleHealth';
describe('plainSpaces', () => {
  it('turns ICU narrow and no-break spaces into plain spaces', () => {
    const narrow = String.fromCharCode(0x202f);
    const nbsp = String.fromCharCode(0x00a0);
    expect(plainSpaces(`6:05${narrow}PM${nbsp}x`)).toBe('6:05 PM x');
  });
});

import { inSafariTab } from './appleHealth';
describe('inSafariTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 };
  const withDisplayMode = (standalone: boolean) => ({ matchMedia: () => ({ matches: standalone }) });

  it('is false outside a browser (Node)', () => {
    expect(inSafariTab()).toBe(false);
  });
  it('is true in an iPhone Safari tab, false in the installed app', () => {
    vi.stubGlobal('navigator', iphone);
    vi.stubGlobal('window', withDisplayMode(false));
    expect(inSafariTab()).toBe(true);
    vi.stubGlobal('window', withDisplayMode(true));
    expect(inSafariTab()).toBe(false);
    vi.stubGlobal('navigator', { ...iphone, standalone: true });
    vi.stubGlobal('window', withDisplayMode(false));
    expect(inSafariTab()).toBe(false);
  });
  it('is false off Apple mobile, and when matchMedia throws', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32', maxTouchPoints: 0 });
    vi.stubGlobal('window', withDisplayMode(false));
    expect(inSafariTab()).toBe(false);
    vi.stubGlobal('navigator', iphone);
    vi.stubGlobal('window', {
      matchMedia: () => {
        throw new Error('no matchMedia');
      },
    });
    expect(inSafariTab()).toBe(false);
  });
});
