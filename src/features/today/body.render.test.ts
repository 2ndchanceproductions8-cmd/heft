// Server-render tests for the Today Body card (no DOM library: effects don't run and live queries return undefined,
// so the card is rendered through its pure view with plain props).
import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Measurement, Unit } from '../../types';
import { clearBusy, isBusy } from '../../lib/busy';
import { bodySummary, goalRateKgPerWeek, type BodySummary } from '../../lib/today';
import { kgToUnit, unitToKg } from '../../lib/units';
import { BodyCard, BodyCardView, type BodyCardViewProps } from './BodyCard';
import { weightChartModel } from './body/chart';
import {
  bodyFatChange,
  fixed1,
  formatGoal,
  formatRate,
  goalKind,
  onTrack,
  staleNudge,
  syncedLabel,
  weighInWhen,
  weightText,
} from './body/format';
import { HUME_GUIDE, HumeSyncRowView } from './body/HumeSync';
import { HealthImportCard } from '../progress/components/HealthImportCard';
import { HEALTH_BUSY, useHealthImport, type HealthImport } from '../progress/components/useHealthImport';

/** Visible text of the rendered markup (tags stripped), plus the raw HTML for attribute checks. */
function render(el: ReactElement, url = '/today'): string {
  const html = renderToString(h(MemoryRouter, { initialEntries: [url] }, el));
  const text = html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
  return `${text}\n${html}`;
}

const TODAY = '2026-10-06';
const NOW = new Date(2026, 9, 6, 9, 30).getTime();
const MINUS = '−';

/** Local time on a day key. */
function at(day: string, hh = 7, mm = 2): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}
function dayOffset(n: number): string {
  const d = new Date(2026, 9, 6 + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const row = (day: string, kg: number | null, p: Partial<Measurement> = {}): Measurement => ({
  id: `m_${day}`,
  date: at(day),
  bodyweightKg: kg,
  photoIds: [],
  ...p,
});

/** A weigh-in every day for the last 30 days, drifting `perDayKg` with a little water noise. */
function series(perDayKg: number, opts: { fat?: boolean; source?: 'health' | 'manual'; start?: number } = {}): Measurement[] {
  const out: Measurement[] = [];
  for (let i = 29; i >= 0; i--) {
    const k = 29 - i;
    const kg = (opts.start ?? 84) + perDayKg * k + (k % 3 === 0 ? 0.3 : -0.1);
    out.push(
      row(dayOffset(-i), kg, {
        source: opts.source ?? 'manual',
        bodyFatPct: opts.fat ? 20 - 0.03 * k : undefined,
      }),
    );
  }
  return out;
}

/** Lose (steady): −400 kcal a day. */
const LOSE = goalRateKgPerWeek({ kcal: 2100, tdee: 2500 });
const GAIN = goalRateKgPerWeek({ kcal: 2750, tdee: 2500 });
const MAINTAIN = goalRateKgPerWeek({ kcal: 2500, tdee: 2500 });

function view(p: Partial<BodyCardViewProps> & { rows?: Measurement[] }): string {
  const { rows, ...rest } = p;
  const summary: BodySummary | undefined = rows ? bodySummary(rows, TODAY) : rest.summary;
  return render(
    h(BodyCardView, { today: TODAY, now: NOW, unit: 'lb', profileKg: null, goalRateKg: null, ...rest, summary }),
  );
}

describe('Body card states', () => {
  it('loading: a fixed placeholder, no empty-state copy', () => {
    const out = view({ summary: undefined });
    expect(out).toContain('data-state="loading"');
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toContain('Add your weight');
    expect(out).not.toContain('Not enough weigh-ins');
  });

  it('the live card renders its loading state before IndexedDB answers', () => {
    const out = render(h(BodyCard, { today: TODAY, now: NOW }));
    expect(out).toContain('data-state="loading"');
  });

  it('brand new user: one line and the one action', () => {
    const out = view({ rows: [] });
    expect(out).toContain('data-state="empty"');
    expect(out).toContain('Weigh in to start your trend.');
    expect(out).toContain('Add your weight');
    expect(out).toContain('href="/progress/measurements"');
    // The action opens the new-entry sheet on arrival.
    expect(out).toContain('href="/progress/measurements?add=1"');
    expect(out).not.toContain('From your profile');
  });

  it('no weigh-ins but a profile weight: shows it as the profile’s, with Log a weigh-in', () => {
    const out = view({ rows: [], profileKg: unitToKg(184, 'lb') });
    expect(out).toContain('data-state="profile"');
    expect(out).toContain('184.0');
    expect(out).toContain('From your profile');
    expect(out).toContain('Log a weigh-in');
    expect(out).not.toContain('Add your weight');
  });

  it('a body-fat-only row is not a weigh-in', () => {
    const out = view({ rows: [row(TODAY, null, { bodyFatPct: 18 })] });
    expect(out).toContain('data-state="empty"');
  });

  it('one weigh-in: the number, when, and hints instead of a trend or chart', () => {
    const out = view({ rows: [row(TODAY, unitToKg(184.2, 'lb'))] });
    expect(out).toContain('data-state="normal"');
    expect(out).toContain('184.2');
    expect(out).toContain('Today, 7:02 AM');
    expect(out).toContain('Not enough weigh-ins yet');
    expect(out).toContain('Weigh in again to start the 30-day chart.');
    expect(out).not.toContain('data-chart');
    expect(out).not.toContain('Trend weight');
    expect(out).not.toContain('Body fat');
    expect(out).not.toContain('data-nudge');
  });

  it('a normal 30-day series in lb: weight, trend, pace, chart labels', () => {
    const rows = series(-0.1);
    const s = bodySummary(rows, TODAY);
    const out = view({ rows, goalRateKg: LOSE });
    expect(s.rateKgPerWeek).not.toBeNull();
    // The big number is the latest weigh-in (which differs from the trend here, so the check can tell them apart).
    expect(fixed1(kgToUnit(s.latest!.kg, 'lb'))).not.toBe(fixed1(kgToUnit(s.trendKg!, 'lb')));
    expect(out).toMatch(new RegExp(`data-weight[^>]*>${fixed1(kgToUnit(s.latest!.kg, 'lb')).replace('.', '\\.')}<`));
    expect(out).toContain('Today, 7:02 AM');
    expect(out).toContain(formatRate(s.rateKgPerWeek!, 'lb'));
    expect(formatRate(s.rateKgPerWeek!, 'lb')).toMatch(new RegExp(`^${MINUS}\\d\\.\\d lb/wk$`));
    expect(out).toContain(`goal ${MINUS}0.8 lb/wk`);
    expect(out).toContain('Trend weight');
    expect(out).toContain(weightText(s.trendKg!, 'lb'));
    // Chart: min / max labels in lb, the window's first day and today.
    const model = weightChartModel(s, TODAY, 'lb')!;
    expect(out).toContain('data-chart="weight-30d"');
    expect(out).toContain(`>${fixed1(model.hi)}<`);
    expect(out).toContain(`>${fixed1(model.lo)}<`);
    expect(out).toContain('>Sep 7<');
    expect(out).toContain('>Today<');
    expect(out).toContain('vector-effect="non-scaling-stroke"');
    // Thirty dots, the newest one filled.
    expect(out.match(/rounded-full h-1\.5 w-1\.5/g)?.length).toBe(29);
    expect(out.match(/h-2\.5 w-2\.5 bg-accent/g)?.length).toBe(1);
    expect(out).not.toContain('data-nudge');
  });

  it('the same series in kg', () => {
    const rows = series(-0.1);
    const s = bodySummary(rows, TODAY);
    const out = view({ rows, unit: 'kg', goalRateKg: LOSE });
    expect(fixed1(s.latest!.kg)).not.toBe(fixed1(s.trendKg!));
    expect(out).toMatch(new RegExp(`data-weight[^>]*>${fixed1(s.latest!.kg).replace('.', '\\.')}<`));
    expect(out).toContain(formatRate(s.rateKgPerWeek!, 'kg'));
    expect(out).toContain('kg/wk');
    expect(out).not.toContain('lb/wk');
    expect(out).toContain(`goal ${MINUS}0.4 kg/wk`);
    expect(out).toContain(weightText(s.trendKg!, 'kg'));
    const model = weightChartModel(s, TODAY, 'kg')!;
    expect(out).toContain(`>${fixed1(model.hi)}<`);
  });

  it('tags a weigh-in that came from Apple Health (the Hume scale)', () => {
    expect(view({ rows: series(-0.1, { source: 'health' }) })).toContain('Hume · Health');
    expect(view({ rows: series(-0.1, { source: 'manual' }) })).not.toContain('Hume · Health');
    // Only the latest weigh-in's source counts.
    const mixed = [...series(-0.1, { source: 'health' }).slice(0, -1), row(TODAY, 80)];
    expect(view({ rows: mixed })).not.toContain('data-tag="health"');
  });

  it('a stale weigh-in is a gentle nudge, never an alarm', () => {
    const rows = [row(dayOffset(-20), 83), row(dayOffset(-16), 82.8), row(dayOffset(-12), 82.5)];
    const out = view({ rows });
    expect(out).toContain('12 days ago');
    expect(out).toContain('No weigh-in for 12 days. Step on the scale when you can.');
    const nudge = /<p[^>]*data-nudge="stale"[^>]*>/.exec(out)?.[0] ?? '';
    expect(nudge).toContain('text-muted');
    expect(nudge).not.toMatch(/danger|warn/);
    // Still inside the 30-day window: the chart stays.
    expect(out).toContain('data-chart="weight-30d"');
  });

  it('long gone: the nudge replaces the chart hint', () => {
    const out = view({ rows: [row(dayOffset(-60), 83), row(dayOffset(-45), 82)] });
    expect(out).toContain('No weigh-in for 45 days');
    expect(out).not.toContain('data-chart');
    expect(out).not.toContain('Weigh in again');
  });

  it('goal alignment: losing and falling is success-coloured, losing and rising is neutral', () => {
    const falling = view({ rows: series(-0.1), goalRateKg: LOSE });
    expect(falling).toContain('data-on-track="true"');
    expect(falling).toContain('bg-success-soft text-success');

    const rising = view({ rows: series(0.1), goalRateKg: LOSE });
    expect(rising).toContain('data-on-track="false"');
    expect(rising).not.toContain('bg-success-soft');
    expect(rising).not.toContain('danger-soft'); // a scale trend is never an error
    expect(formatRate(bodySummary(series(0.1), TODAY).rateKgPerWeek!, 'lb')).toMatch(/^\+\d\.\d lb\/wk$/);

    expect(view({ rows: series(0.1), goalRateKg: GAIN })).toContain('data-on-track="true"');
    expect(view({ rows: series(0), goalRateKg: MAINTAIN })).toContain('data-on-track="true"');
    expect(view({ rows: series(0), goalRateKg: MAINTAIN })).toContain('goal: hold steady');
    expect(view({ rows: series(-0.1), goalRateKg: MAINTAIN })).toContain('data-on-track="false"');
  });

  it('without targets: no goal line and a neutral pace', () => {
    const out = view({ rows: series(-0.1), goalRateKg: null });
    expect(out).not.toContain('goal');
    expect(out).toContain('data-on-track="false"');
  });

  it('body fat: the latest % and its 4-week change; the row is omitted without readings', () => {
    const rows = series(-0.1, { fat: true });
    const s = bodySummary(rows, TODAY);
    const out = view({ rows });
    expect(out).toContain('Body fat');
    expect(out).toContain(`${fixed1(s.bodyFat!.pct)}%`);
    expect(out).toContain(bodyFatChange(s.bodyFatRatePerWeek!));
    expect(bodyFatChange(s.bodyFatRatePerWeek!)).toMatch(new RegExp(`^${MINUS}0\\.\\d% in 4 wk$`));

    expect(view({ rows: series(-0.1) })).not.toContain('Body fat');
  });

  it('an older body fat reading says when', () => {
    const rows = [row(dayOffset(-10), 83, { bodyFatPct: 19 }), row(TODAY, 82.5)];
    const out = view({ rows });
    expect(out).toContain('19.0%');
    expect(out).toContain('1w ago');
  });

  it('a body fat reading older than the latest weigh-in says when, even with a 4-week rate', () => {
    // Weight daily through today, body fat through day −5 (manual weigh-ins carry none), over 21+ days of the window.
    const rows = series(-0.1, { fat: true }).map((r, k) => (k > 24 ? { ...r, bodyFatPct: undefined } : r));
    const s = bodySummary(rows, TODAY);
    expect(s.bodyFatRatePerWeek).not.toBeNull();
    const out = view({ rows });
    expect(out).toContain('5d ago');
    expect(out).not.toContain('in 4 wk');
  });

  it('the Hume row renders under every state (it is how weigh-ins arrive)', () => {
    const sync = h(HumeSyncRowView, {
      importedAt: null,
      neverImported: true,
      returned: false,
      now: NOW,
      onGet: () => {},
      onPaste: () => {},
    });
    expect(view({ rows: [], sync })).toContain('Not synced yet');
    expect(view({ summary: undefined, sync })).toContain('Not synced yet');
    expect(view({ rows: series(-0.1), sync })).toContain('Not synced yet');
  });
});

describe('Hume sync row', () => {
  const noop = () => {};
  it('never imported: the buttons (the first sync works from Today) plus a Set up link to the Shortcut guide', () => {
    const out = render(h(HumeSyncRowView, { importedAt: null, neverImported: true, returned: false, now: NOW, onGet: noop, onPaste: noop }));
    expect(out).toContain('Hume scale · Not synced yet');
    expect(out).toContain(`href="${HUME_GUIDE}"`);
    expect(out).toContain('>Set up<');
    expect(HUME_GUIDE).toBe('/settings/apple-health?to=weigh-ins');
    expect(out).toContain('Get from Health');
    expect(out).toContain('>Paste<');
  });

  it('imported before: last sync time and the two buttons', () => {
    const out = render(
      h(HumeSyncRowView, { importedAt: NOW - 2 * 3_600_000, neverImported: false, returned: false, now: NOW, onGet: noop, onPaste: noop }),
    );
    expect(out).toContain('Hume scale · Synced 2h ago');
    expect(out).toContain('Get from Health');
    expect(out).toContain('>Paste<');
    expect(out).not.toContain('>Set up<');
  });

  it('while settings load: holds the buttons row’s height, hidden (no flash of Set up)', () => {
    const out = render(h(HumeSyncRowView, { loading: true, importedAt: null, neverImported: true, returned: false, now: NOW, onGet: noop, onPaste: noop }));
    expect(out).toContain('data-state="sync-loading"');
    expect(out).toContain('class="invisible"');
    expect(out).not.toContain('>Set up<');
  });

  it('back from Shortcuts: Paste becomes the primary button', () => {
    const out = render(h(HumeSyncRowView, { importedAt: NOW - 60_000, neverImported: false, returned: true, now: NOW, onGet: noop, onPaste: noop }));
    expect(out).toContain('Back from Shortcuts? Tap Paste.');
    expect(out).toMatch(/bg-accent text-on-accent[^"]*"[^>]*>Paste</);
  });
});

describe('HealthImportCard (uses the shared hook)', () => {
  it('renders the Measurements card as before', () => {
    for (const unit of ['lb', 'kg'] as Unit[]) {
      const out = render(h(HealthImportCard, { unit }));
      expect(out).toContain('Import from Apple Health');
      expect(out).toContain('Weight & body fat from your scale');
      expect(out).toContain('Get from Health');
      expect(out).toContain('Paste from Health');
      expect(out).toContain('Set up the Shortcut');
      expect(out).not.toContain('Back from Shortcuts');
    }
  });
});

describe('Get from Health (shared hook)', () => {
  it('marks Heft busy before it hides behind Shortcuts, so a waiting app update can’t reload it', () => {
    const got: { health?: HealthImport } = {};
    function Probe() {
      got.health = useHealthImport('lb');
      return null;
    }
    render(h(Probe));
    const busyWhenLeaving: boolean[] = [];
    vi.stubGlobal('window', {
      location: {
        set href(_url: string) {
          busyWhenLeaving.push(isBusy());
        },
      },
    });
    try {
      expect(isBusy()).toBe(false);
      got.health!.getFromHealth();
    } finally {
      vi.unstubAllGlobals();
      clearBusy(HEALTH_BUSY);
    }
    expect(busyWhenLeaving).toEqual([true]);
  });
});

describe('Body card copy', () => {
  it('formats the weekly pace by what is shown', () => {
    expect(formatRate(unitToKg(-0.6, 'lb'), 'lb')).toBe(`${MINUS}0.6 lb/wk`);
    expect(formatRate(0.3, 'kg')).toBe('+0.3 kg/wk');
    expect(formatRate(-0.01, 'lb')).toBe('0.0 lb/wk');
    expect(formatRate(-0.01, 'kg')).toBe('0.0 kg/wk');
  });

  it('reads the goal from the target pace', () => {
    expect(goalKind(LOSE)).toBe('lose');
    expect(goalKind(GAIN)).toBe('gain');
    expect(goalKind(MAINTAIN)).toBe('maintain');
    expect(goalKind(-0.05)).toBe('maintain');
    expect(formatGoal(LOSE, 'lb')).toBe(`goal ${MINUS}0.8 lb/wk`);
    expect(formatGoal(GAIN, 'lb')).toBe('goal +0.5 lb/wk');
    expect(formatGoal(MAINTAIN, 'kg')).toBe('goal: hold steady');
  });

  it('on track only when the shown direction matches the goal', () => {
    expect(onTrack(-0.3, LOSE, 'lb')).toBe(true);
    expect(onTrack(0.3, LOSE, 'lb')).toBe(false);
    expect(onTrack(-0.01, LOSE, 'lb')).toBe(false); // shows 0.0: not falling
    expect(onTrack(0.2, GAIN, 'kg')).toBe(true);
    expect(onTrack(0.1, MAINTAIN, 'lb')).toBe(true);
    expect(onTrack(-0.2, MAINTAIN, 'lb')).toBe(false);
    // Maintenance: the same shown pace gets the same colour ("+0.1 kg/wk", "+0.2 lb/wk").
    expect(onTrack(0.104, MAINTAIN, 'kg')).toBe(onTrack(0.115, MAINTAIN, 'kg'));
    expect(onTrack(0.109, MAINTAIN, 'lb')).toBe(onTrack(0.111, MAINTAIN, 'lb'));
    expect(onTrack(null, LOSE, 'lb')).toBe(false);
    expect(onTrack(-0.3, null, 'lb')).toBe(false);
  });

  it('says when the weigh-in was', () => {
    const today = at(TODAY, 7, 2);
    expect(weighInWhen(today, 0, NOW)).toBe('Today, 7:02 AM');
    expect(weighInWhen(at(dayOffset(-1)), 1, NOW)).toBe('Yesterday');
    expect(weighInWhen(at(dayOffset(-4)), 4, NOW)).toBe('4 days ago');
    expect(weighInWhen(at(dayOffset(-13)), 13, NOW)).toBe('13 days ago');
    expect(weighInWhen(at(dayOffset(-20)), 20, NOW)).toBe('2w ago');
    expect(weighInWhen(at(dayOffset(-60)), 60, NOW)).toBe('Aug 7');
    expect(staleNudge(7)).toBeNull();
    expect(staleNudge(null)).toBeNull();
    expect(staleNudge(8)).toContain('8 days');
  });

  it('says when the last sync was', () => {
    expect(syncedLabel(NOW + 5_000, NOW)).toBe('Synced just now');
    expect(syncedLabel(NOW - 30_000, NOW)).toBe('Synced just now');
    expect(syncedLabel(NOW - 12 * 60_000, NOW)).toBe('Synced 12 min ago');
    expect(syncedLabel(NOW - 2 * 3_600_000, NOW)).toBe('Synced 2h ago');
    expect(syncedLabel(at(dayOffset(-1), 6, 0), NOW)).toBe('Synced yesterday');
    expect(syncedLabel(at(dayOffset(-3)), NOW)).toBe('Synced 3 days ago');
    expect(syncedLabel(at(dayOffset(-15)), NOW)).toBe('Synced 2w ago');
  });

  it('body fat change over 4 weeks', () => {
    expect(bodyFatChange(-0.075)).toBe(`${MINUS}0.3% in 4 wk`);
    expect(bodyFatChange(0.05)).toBe('+0.2% in 4 wk');
    expect(bodyFatChange(0.001)).toBe('No change in 4 wk');
  });
});

describe('30-day chart geometry', () => {
  it('needs two weigh-ins inside the window', () => {
    const s = bodySummary([row(dayOffset(-40), 80), row(TODAY, 81)], TODAY);
    expect(weightChartModel(s, TODAY, 'lb')).toBeNull();
    const two = bodySummary([row(dayOffset(-29), 80), row(TODAY, 81)], TODAY);
    const m = weightChartModel(two, TODAY, 'lb')!;
    expect(m.dots.map((d) => d.x)).toEqual([0, 1]);
    expect(m.dots.map((d) => d.latest)).toEqual([false, true]);
    expect(m.startDay).toBe('2026-09-07');
    expect(m.endDay).toBe(TODAY);
  });

  it('keeps a small wobble from filling the chart', () => {
    const s = bodySummary([row(dayOffset(-2), 80), row(dayOffset(-1), 80.1), row(TODAY, 80)], TODAY);
    const m = weightChartModel(s, TODAY, 'kg')!;
    // 0.1 kg of range on a 1 kg minimum span: the points sit near the middle.
    expect(m.yLo - m.yHi).toBeCloseTo(0.1, 5);
    for (const d of m.dots) {
      expect(d.y).toBeGreaterThan(0.4);
      expect(d.y).toBeLessThan(0.6);
    }
  });

  it('speaks the weigh-ins’ range, not the trend’s (on a cut the trend starts above every reading)', () => {
    // 60 days of a steady cut: history before the window, so the trend lags ~1.4 lb above the readings.
    const rows = Array.from({ length: 60 }, (_, k) => row(dayOffset(k - 59), 90 - 0.07 * k));
    const s = bodySummary(rows, TODAY);
    const m = weightChartModel(s, TODAY, 'lb')!;
    const inWindow = rows.filter((r) => r.date >= at(m.startDay)).map((r) => kgToUnit(r.bodyweightKg!, 'lb'));
    const maxReading = Math.max(...inWindow);
    const minReading = Math.min(...inWindow);
    expect(m.readingHi).toBeCloseTo(maxReading, 9);
    expect(m.readingLo).toBeCloseTo(minReading, 9);
    expect(fixed1(maxReading)).not.toBe(fixed1(m.hi));
    const out = view({ rows });
    const spoken = /aria-label="Last 30 days: 30 weigh-ins, ([^ ]+) to ([^ ]+) lb"/.exec(out);
    expect(spoken?.[1]).toBe(fixed1(minReading));
    expect(spoken?.[2]).toBe(fixed1(maxReading));
    // The axis label still marks the top of what is drawn (the trend).
    expect(out).toContain(`>${fixed1(m.hi)}<`);
  });

  it('spans the full height for a real change, y measured from the top', () => {
    const s = bodySummary(series(-0.1), TODAY);
    const m = weightChartModel(s, TODAY, 'lb')!;
    expect(m.yHi).toBeCloseTo(0, 5);
    expect(m.yLo).toBeCloseTo(1, 5);
    expect(m.dots).toHaveLength(30);
    expect(m.line).toHaveLength(30);
    // Falling: the first dot sits higher (smaller y) than the last.
    expect(m.dots[0].y).toBeLessThan(m.dots[29].y);
  });
});
