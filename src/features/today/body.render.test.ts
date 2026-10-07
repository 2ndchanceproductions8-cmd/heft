// Server-render tests for the Today Body card (no DOM library: effects don't run and live queries return undefined,
// so the card is rendered through its pure view with plain props).
import 'fake-indexeddb/auto';
import { createElement as h, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Measurement, Unit } from '../../types';
import type { InboxState, InboxStatus } from '../../lib/healthInbox';
import { db } from '../../db';
import { clearBusy, isBusy } from '../../lib/busy';
import { getSettings } from '../../lib/settings';
import { bodySummary, goalRateKgPerWeek, type BodySummary } from '../../lib/today';
import { kgToUnit, unitToKg } from '../../lib/units';
import { BodyCard, BodyCardView, type BodyCardViewProps } from './BodyCard';
import { weightChartModel } from './body/chart';
import {
  agoText,
  bodyFatChange,
  fixed1,
  formatGoal,
  formatRate,
  goalKind,
  inboxLine,
  onTrack,
  readingText,
  readingWhen,
  staleNudge,
  syncedLabel,
  weighInWhen,
  weightText,
} from './body/format';
import { checkNowToast, HUME_AUTO_SETUP, HUME_GUIDE, HumeAutoRowView, HumeSync, HumeSyncRowView } from './body/HumeSync';
import { deleteWeighIn, WeighInsList } from './body/WeighInsSheet';
import { alsoDeleted, deleteWeighInConfirm, showsCountsMarker, weighInList, type WeighInItem } from './body/weighIns';
import { HealthImportCard } from '../progress/components/HealthImportCard';
import { HEALTH_BUSY, useHealthImport, type HealthImport } from '../progress/components/useHealthImport';

// The inbox status is the inbox builder's live store: tests set what useInboxStatus() answers.
const inbox = vi.hoisted(() => ({
  status: { configured: false, state: 'off', checkedAt: null, lastImport: null, lastPostAt: null } as InboxStatus,
}));
vi.mock('../../lib/healthInbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/healthInbox')>()),
  useInboxStatus: () => inbox.status,
}));
// confirm() / toast() resolve through the app's DialogHost; the delete flow's tests answer them here.
const dialogs = vi.hoisted(() => ({ confirm: vi.fn(), toast: vi.fn() }));
vi.mock('../../components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/ui')>()),
  confirm: dialogs.confirm,
  toast: dialogs.toast,
}));
const NOT_CONFIGURED: InboxStatus = { configured: false, state: 'off', checkedAt: null, lastImport: null, lastPostAt: null };

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

describe('Hume sync row, not automatic yet (by hand)', () => {
  const noop = () => {};
  it('never imported: the buttons (the first sync works from Today), a Set up link to the Shortcut guide, and Make it automatic', () => {
    const out = render(h(HumeSyncRowView, { importedAt: null, neverImported: true, returned: false, now: NOW, onGet: noop, onPaste: noop }));
    expect(out).toContain('Hume scale · Not synced yet');
    expect(out).toContain(`href="${HUME_GUIDE}"`);
    expect(out).toContain('>Set up<');
    expect(HUME_GUIDE).toBe('/settings/apple-health?to=weigh-ins');
    expect(out).toContain('Get from Health');
    expect(out).toContain('>Paste<');
    expect(out).toMatch(/<a[^>]*href="\/settings\/apple-health\?to=auto"[^>]*>(?:(?!<\/a>)[\s\S])*Make it automatic<\/a>/);
    expect(HUME_AUTO_SETUP).toBe('/settings/apple-health?to=auto');
    expect(out).not.toContain('auto sync');
  });

  it('imported before: last sync time, the two buttons and Make it automatic', () => {
    const out = render(
      h(HumeSyncRowView, { importedAt: NOW - 2 * 3_600_000, neverImported: false, returned: false, now: NOW, onGet: noop, onPaste: noop }),
    );
    expect(out).toContain('Hume scale · Synced 2h ago');
    expect(out).toContain('Get from Health');
    expect(out).toContain('>Paste<');
    expect(out).not.toContain('>Set up<');
    expect(out).toContain(`href="${HUME_AUTO_SETUP}"`);
    expect(out).toContain('Make it automatic');
  });

  it('the Make it automatic link is a 40px tap target', () => {
    const out = render(h(HumeSyncRowView, { importedAt: null, neverImported: false, returned: false, now: NOW, onGet: noop, onPaste: noop }));
    const link = /<a[^>]*data-action="make-automatic"[^>]*>/.exec(out)?.[0] ?? '';
    expect(link).toContain('h-10');
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

describe('Hume sync row, automatic', () => {
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const status = (state: InboxState, p: Partial<InboxStatus> = {}): InboxStatus => ({
    configured: true,
    state,
    checkedAt: NOW - 5 * MIN,
    lastImport: null,
    lastPostAt: null,
    ...p,
  });
  const auto = (s: InboxStatus, checking = false) => render(h(HumeAutoRowView, { status: s, now: NOW, checking, onCheck: () => {} }));
  /** The Check now <button> tag. */
  const checkButton = (out: string) => /<button[^>]*>(?:(?!<\/button>)[\s\S])*Check now<\/button>/.exec(out)?.[0] ?? '';

  it('every state: the title, a status line, and Check now (40px+, disabled only while checking)', () => {
    const expected: Record<InboxState, string> = {
      off: 'Checked 5 min ago',
      idle: 'Checked 5 min ago',
      checking: 'Checking…',
      ok: 'Checked 5 min ago',
      offline: "Offline. Heft checks again when you're back online",
      token_rejected: 'GitHub key rejected',
      not_found: "Can't reach the inbox",
      no_permission: "GitHub key can't use Issues",
      unreadable: "Can't read what the Shortcut sent",
      error: "Couldn't check",
    };
    for (const [state, line] of Object.entries(expected) as [InboxState, string][]) {
      const out = auto(status(state));
      expect(out, state).toContain('Hume · auto sync');
      expect(out, state).toContain(line);
      expect(out, state).toContain(`data-inbox="${state}"`);
      const button = checkButton(out);
      expect(button, state).toContain('h-10!');
      if (state === 'checking') {
        expect(button).toContain('disabled=""');
        expect(button).toContain('animate-spin');
      } else {
        expect(button, state).not.toContain('disabled=""');
        expect(button, state).not.toContain('animate-spin');
      }
      expect(out, state).not.toContain('Get from Health');
      expect(out, state).not.toContain('Make it automatic');
    }
  });

  it('what only the owner can fix (key, inbox, permission, an unreadable Shortcut): danger colour and Fix in Settings', () => {
    for (const state of ['token_rejected', 'not_found', 'no_permission', 'unreadable'] as const) {
      const out = auto(status(state));
      expect(out, state).toMatch(/<a[^>]*href="\/settings\/apple-health\?to=auto"[^>]*>Fix in Settings<\/a>/);
      expect(out, state).toMatch(
        /<p class="[^"]*text-danger[^"]*"[^>]*>(GitHub key rejected|Can&#x27;t reach the inbox|GitHub key can&#x27;t use Issues|Can&#x27;t read what the Shortcut sent)<\/p>/,
      );
      expect(/<a[^>]*>Fix in Settings/.exec(out)?.[0], state).toContain('min-h-10');
    }
    for (const state of ['ok', 'idle', 'offline', 'error', 'checking'] as const) {
      const out = auto(status(state));
      expect(out, state).not.toContain('Fix in Settings');
      // The status line stays muted.
      const line = /<p class="([^"]*)"[^>]*data-line="inbox"/.exec(out)?.[1] ?? '';
      expect(line, state).toContain('text-muted');
      expect(line, state).not.toContain('text-danger');
      // It ticks every minute and flips to Checking… on every wake: not a live region (real news is a toast).
      expect(out, state).not.toContain('aria-live');
    }
  });

  it('the Check now call running shows Checking… and disables the button, whatever the last state', () => {
    const out = auto(status('ok'), true);
    expect(out).toContain('Checking…');
    expect(out).toContain('data-inbox="checking"');
    expect(checkButton(out)).toContain('disabled=""');
  });

  it('a recent import is the news; an older one gives way to the last check', () => {
    const fresh = { at: NOW - 20_000, added: 1, updated: 0 };
    expect(auto(status('ok', { checkedAt: NOW - 20_000, lastImport: fresh }))).toContain('1 new weigh-in just now');
    expect(auto(status('ok', { checkedAt: NOW - 20_000, lastImport: fresh }))).not.toContain('checked');
    const earlier = { at: NOW - 2 * HOUR, added: 3, updated: 0 };
    expect(auto(status('ok', { checkedAt: NOW - 30_000, lastImport: earlier }))).toContain('3 new weigh-ins 2h ago · checked just now');
    const updatedOnly = { at: NOW - 10 * MIN, added: 0, updated: 2 };
    expect(auto(status('ok', { checkedAt: NOW - 10 * MIN, lastImport: updatedOnly }))).toContain('2 weigh-ins updated 10 min ago');
    const old = { at: NOW - 13 * HOUR, added: 1, updated: 0 };
    const out = auto(status('ok', { checkedAt: NOW - 3 * MIN, lastImport: old }));
    expect(out).toContain('Checked 3 min ago');
    expect(out).not.toContain('new weigh-in');
  });

  it('a token saved but never checked', () => {
    expect(auto(status('idle', { checkedAt: null }))).toContain('Not checked yet');
  });

  it('a plain check says when the iPhone last sent, so a Shortcut that stopped reads differently from a quiet one', () => {
    expect(auto(status('ok'))).toContain('Checked 5 min ago · nothing from iPhone yet');
    expect(auto(status('ok', { lastPostAt: NOW - 3 * HOUR }))).toContain('Checked 5 min ago · iPhone sent 3h ago');
    expect(auto(status('idle', { checkedAt: null, lastPostAt: NOW - 3 * HOUR }))).toContain('Not checked yet');
    expect(auto(status('idle', { checkedAt: null, lastPostAt: NOW - 3 * HOUR }))).not.toContain('iPhone sent');
  });

  it('inboxLine: the words, and which states need the owner', () => {
    const base = { checkedAt: NOW - 2 * HOUR, lastImport: null, lastPostAt: null };
    expect(inboxLine({ state: 'ok', ...base }, NOW)).toEqual({ text: 'Checked 2h ago · nothing from iPhone yet', fix: false });
    expect(inboxLine({ state: 'ok', checkedAt: NOW - 2 * HOUR, lastImport: null, lastPostAt: NOW - 2 * HOUR }, NOW)).toEqual({
      text: 'Checked 2h ago · iPhone sent 2h ago',
      fix: false,
    });
    expect(inboxLine({ state: 'ok', ...base }, NOW, true)).toEqual({ text: 'Checking…', fix: false });
    expect(inboxLine({ state: 'token_rejected', ...base }, NOW)).toEqual({ text: 'GitHub key rejected', fix: true });
    expect(inboxLine({ state: 'not_found', ...base }, NOW)).toEqual({ text: "Can't reach the inbox", fix: true });
    expect(inboxLine({ state: 'no_permission', ...base }, NOW)).toEqual({ text: "GitHub key can't use Issues", fix: true });
    expect(inboxLine({ state: 'unreadable', ...base }, NOW)).toEqual({ text: "Can't read what the Shortcut sent", fix: true });
    expect(inboxLine({ state: 'offline', ...base }, NOW).fix).toBe(false);
    expect(inboxLine({ state: 'error', ...base }, NOW)).toEqual({ text: "Couldn't check", fix: false });
    expect(inboxLine({ state: 'ok', checkedAt: at(dayOffset(-1), 6), lastImport: null, lastPostAt: null }, NOW).text).toBe(
      'Checked yesterday · nothing from iPhone yet',
    );
  });

  it('Check now only toasts what the watcher stays quiet about', () => {
    expect(checkNowToast({ state: 'ok', added: 0, updated: 0 })).toEqual(['No new weigh-ins', 'info']);
    expect(checkNowToast({ state: 'ok', added: 0, updated: 1 })).toEqual(['1 weigh-in updated', 'success']);
    // New weigh-ins: HealthInboxWatcher's "From Hume: …" toast. Problems: the status line (and the watcher).
    expect(checkNowToast({ state: 'ok', added: 2, updated: 0 })).toBeNull();
    for (const state of ['offline', 'token_rejected', 'not_found', 'no_permission', 'unreadable', 'error', 'off'] as const) {
      expect(checkNowToast({ state, added: 0, updated: 0 })).toBeNull();
    }
  });

  it('agoText', () => {
    expect(agoText(NOW - 59_000, NOW)).toBe('just now');
    expect(agoText(NOW - 12 * MIN, NOW)).toBe('12 min ago');
    expect(agoText(NOW - 5 * HOUR, NOW)).toBe('5h ago');
    expect(agoText(at(dayOffset(-3)), NOW)).toBe('3 days ago');
  });
});

describe('Hume row on the live card', () => {
  beforeEach(() => {
    inbox.status = NOT_CONFIGURED;
  });

  it('automatic sync set up: the automatic row, even off iPhone (it works on any device)', () => {
    inbox.status = { configured: true, state: 'ok', checkedAt: Date.now() - 60_000, lastImport: null, lastPostAt: null };
    const out = render(h(BodyCard, { today: TODAY, now: NOW }));
    expect(out).toContain('Hume · auto sync');
    expect(out).toContain('Check now');
    expect(out).not.toContain('Get from Health');
  });

  it('not set up, off iPhone: no Hume row (Shortcuts only exists on iPhone / iPad)', () => {
    const out = render(h(BodyCard, { today: TODAY, now: NOW }));
    expect(out).not.toContain('Hume ·');
    expect(out).not.toContain('Hume scale');
    expect(out).not.toContain('Make it automatic');
  });

  it('HumeSync picks the row by the inbox status', () => {
    const configured = render(h(HumeSync, { unit: 'lb', now: NOW, inbox: { ...NOT_CONFIGURED, configured: true, state: 'idle' } }));
    expect(configured).toContain('data-state="sync-auto"');
    expect(configured).toContain('Hume · auto sync');

    const manual = render(h(HumeSync, { unit: 'lb', now: NOW, inbox: NOT_CONFIGURED }));
    expect(manual).toContain('data-state="sync-manual"');
    expect(manual).toContain('Get from Health');
    expect(manual).toContain('>Paste<');
    expect(manual).toContain('Make it automatic');
    expect(manual).toContain(`href="${HUME_AUTO_SETUP}"`);
    expect(manual).not.toContain('auto sync');
  });
});

// ------------------------------------------------------------------ weigh-ins sheet

/** Local time on a day, as a Hume (Apple Health) reading: id "hk_<ms>", healthAt = the sample time. */
function hume(day: string, hh: number, mm: number, lb: number | null, fat: number | null = null): Measurement {
  const t = at(day, hh, mm);
  return {
    id: `hk_${t}`,
    date: t,
    bodyweightKg: lb == null ? null : unitToKg(lb, 'lb'),
    bodyFatPct: fat,
    photoIds: [],
    source: 'health',
    healthAt: t,
  };
}

describe('Weigh-ins sheet', () => {
  const Y = dayOffset(-1); // Mon Oct 5
  const reweigh = hume(TODAY, 7, 5, 183.9, 19.6); // the day's latest Hume reading: counts
  const bad = hume(TODAY, 7, 2, 184.2, 19.4);
  const humeY = hume(Y, 6, 58, 184.8, 19.8);
  const typedY: Measurement = { id: 'm_typed', date: at(Y, 6, 30), bodyweightKg: unitToKg(184.5, 'lb'), photoIds: [], source: 'manual' };
  // An imported row the owner edited: theirs now (no Hume tag) but still from Apple Health.
  const edited: Measurement = { ...hume(dayOffset(-2), 7, 10, 184.0), source: 'manual' };
  const fatOnly = hume(dayOffset(-3), 7, 0, null, 19.6);
  const firstDay = hume(dayOffset(-13), 7, 0, 185.0);
  const tooOld = hume(dayOffset(-14), 7, 0, 185.2);
  const waistOnly: Measurement = { id: 'm_waist', date: at(TODAY, 8), bodyweightKg: null, waistCm: 85, photoIds: [] };
  const ROWS = [tooOld, firstDay, fatOnly, edited, typedY, humeY, bad, reweigh, waistOnly];

  const items = () => weighInList(ROWS, TODAY);
  const byId = (id: string) => items().find((i) => i.id === id)!;
  const list = (unit: Unit = 'lb', list: WeighInItem[] = items()) =>
    render(h(WeighInsList, { items: list, unit, today: TODAY, onDelete: () => {} }));
  /** Each <li> of the rendered list, keyed by its row id. */
  function lis(out: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const x of out.matchAll(/<li[^>]*data-reading="([^"]+)"[^>]*>[\s\S]*?<\/li>/g)) m.set(x[1], x[0]);
    return m;
  }

  it('the last 14 days of readings with a weight or body fat, newest first', () => {
    expect(items().map((i) => i.id)).toEqual([reweigh.id, bad.id, humeY.id, typedY.id, edited.id, fatOnly.id, firstDay.id]);
    expect(weighInList([], TODAY)).toEqual([]);
  });

  it('a latest weigh-in older than two weeks is still listed (the card shows it and opens this sheet)', () => {
    const old = hume(dayOffset(-20), 7, 0, 185.0);
    const list20 = weighInList([old], TODAY);
    expect(list20).toHaveLength(1);
    expect(list20[0]).toMatchObject({ id: old.id, counts: true, day: dayOffset(-20) });
    // Back to the latest weigh-in's day, no further; a later fat-only reading rides along.
    const older = hume(dayOffset(-25), 7, 0, 186.0);
    const fat = hume(dayOffset(-18), 7, 0, null, 19.9);
    expect(weighInList([older, old, fat], TODAY).map((i) => i.id)).toEqual([fat.id, old.id]);
    // The card's number is the same reading.
    expect(bodySummary([older, old, fat], TODAY).latest?.id).toBe(old.id);
  });

  it('which reading counts for its day (the trend’s rule), and when that is worth saying', () => {
    expect(byId(reweigh.id)).toMatchObject({ counts: true, sameDayCount: 2, hume: true, fromHealth: true });
    expect(byId(bad.id)).toMatchObject({ counts: false, sameDayCount: 2 });
    // A typed weigh-in beats the scale's, earlier or not.
    expect(byId(typedY.id)).toMatchObject({ counts: true, hume: false, fromHealth: false });
    expect(byId(humeY.id)).toMatchObject({ counts: false });
    expect(byId(edited.id)).toMatchObject({ counts: true, sameDayCount: 1, hume: false, fromHealth: true });
    expect(byId(fatOnly.id)).toMatchObject({ counts: false, kg: null, bodyFatPct: 19.6, hume: true });
    expect(items().filter(showsCountsMarker).map((i) => i.id)).toEqual([reweigh.id, typedY.id]);
  });

  it('renders each row: value, body fat, day and time, the Hume tag, the counts marker', () => {
    const out = list();
    expect([...out.matchAll(/data-reading="([^"]+)"/g)].map((m) => m[1])).toEqual(items().map((i) => i.id));
    const li = lis(out);
    expect(li.size).toBe(7);
    expect(li.get(reweigh.id)).toContain('>183.9 lb<');
    expect(li.get(reweigh.id)).toContain('>19.6% body fat<');
    expect(li.get(reweigh.id)).toContain('>Today, 7:05 AM<');
    expect(li.get(bad.id)).toContain('>Today, 7:02 AM<');
    expect(li.get(humeY.id)).toContain('>Yesterday, 6:58 AM<');
    expect(li.get(edited.id)).toContain('>Sun, Oct 4, 7:10 AM<');
    expect(li.get(firstDay.id)).toContain('>Wed, Sep 23, 7:00 AM<');
    // Body fat only: it is the row's value.
    expect(li.get(fatOnly.id)).toMatch(/text-\[16px\] font-semibold">19\.6% body fat</);
    expect(li.get(fatOnly.id)).not.toContain(' lb<');

    const tagged = [...li].filter(([, html]) => html.includes('data-tag="hume"')).map(([id]) => id);
    expect(tagged).toEqual([reweigh.id, bad.id, humeY.id, fatOnly.id, firstDay.id]);
    const marked = [...li].filter(([, html]) => html.includes('data-marker="counts"')).map(([id]) => id);
    expect(marked).toEqual([reweigh.id, typedY.id]);
    expect(li.get(reweigh.id)).toContain('Counts for the day');
  });

  it('every row has its own Delete button, named for the reading, 40px', () => {
    const out = list();
    const labels = [...out.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*>/g)].map((m) => m[1]);
    expect(labels).toEqual([
      'Delete 183.9 lb · Oct 6, 7:05 AM',
      'Delete 184.2 lb · Oct 6, 7:02 AM',
      'Delete 184.8 lb · Oct 5, 6:58 AM',
      'Delete 184.5 lb · Oct 5, 6:30 AM',
      'Delete 184.0 lb · Oct 4, 7:10 AM',
      'Delete 19.6% body fat · Oct 3, 7:00 AM',
      'Delete 185.0 lb · Sep 23, 7:00 AM',
    ]);
    for (const b of out.match(/<button[^>]*aria-label="Delete[^>]*>/g)!) {
      expect(b).toContain('h-10 w-10');
      expect(b).toContain('text-danger');
      expect(b).not.toContain('disabled=""');
    }
    // While a delete is being confirmed, the others wait.
    const busy = render(h(WeighInsList, { items: items(), unit: 'lb', today: TODAY, busy: true, onDelete: () => {} }));
    expect(busy.match(/<button[^>]*aria-label="Delete[^>]*disabled=""/g)?.length).toBe(7);
  });

  it('in kg', () => {
    const out = list('kg');
    expect(out).toContain(weightText(reweigh.bodyweightKg!, 'kg'));
    expect(out).toContain('Delete 83.4 kg · Oct 6, 7:05 AM');
    expect(out).not.toContain(' lb');
  });

  it('nothing in two weeks: says so', () => {
    const out = list('lb', []);
    expect(out).toContain('No weigh-ins in the last 14 days.');
    expect(out).not.toContain('<ul');
  });

  it('the Delete confirmation: the reading, and for Hume readings that it won’t come back', () => {
    expect(deleteWeighInConfirm(byId(bad.id), 'lb')).toEqual({
      title: 'Delete this weigh-in?',
      message: "184.2 lb · Oct 6, 7:02 AM. It won't come back from Hume.",
      danger: true,
      confirmLabel: 'Delete',
    });
    expect(deleteWeighInConfirm(byId(typedY.id), 'lb').message).toBe('184.5 lb · Oct 5, 6:30 AM.');
    // An edited Hume reading is still remembered as deleted, so the sentence holds.
    expect(deleteWeighInConfirm(byId(edited.id), 'lb').message).toBe("184.0 lb · Oct 4, 7:10 AM. It won't come back from Hume.");
    expect(deleteWeighInConfirm(byId(fatOnly.id), 'kg').message).toBe("19.6% body fat · Oct 3, 7:00 AM. It won't come back from Hume.");
    expect(deleteWeighInConfirm(byId(bad.id), 'kg').message).toBe("83.6 kg · Oct 6, 7:02 AM. It won't come back from Hume.");
  });

  it('a typed check-in: what else deleting its row loses, on the row and in the confirmation', () => {
    const checkin: Measurement = { ...typedY, id: 'm_checkin', photoIds: ['p1', 'p2'], waistCm: 85, notes: 'x' };
    const item = weighInList([checkin], TODAY)[0];
    expect(alsoDeleted(checkin)).toEqual(['2 photos', 'waist measurement', 'note']);
    expect(deleteWeighInConfirm(item, 'lb')).toEqual({
      title: 'Delete this weigh-in?',
      message: '184.5 lb · Oct 5, 6:30 AM. Its 2 photos, waist measurement and note will be deleted too.',
      danger: true,
      confirmLabel: 'Delete all',
    });
    // An edited Hume reading with a photo: both sentences.
    const editedPhoto = weighInList([{ ...edited, photoIds: ['p1'] }], TODAY)[0];
    expect(deleteWeighInConfirm(editedPhoto, 'lb')).toMatchObject({
      message: "184.0 lb · Oct 4, 7:10 AM. It won't come back from Hume. Its 1 photo will be deleted too.",
      confirmLabel: 'Delete all',
    });
    // Tape words; blank notes, zero and junk values don't count.
    expect(alsoDeleted({ photoIds: [], waistCm: 85, chestCm: 100, neckCm: 0, armCm: Number.NaN, notes: '  ' })).toEqual([
      'waist and chest measurements',
    ]);
    expect(alsoDeleted({ photoIds: [], thighCm: 60, hipsCm: 98, armCm: 35 })).toEqual(['arm, thigh and hips measurements']);
    expect(alsoDeleted(typedY)).toEqual([]);
    // The list row doesn't look like a bare reading.
    const li = lis(list('lb', [item, byId(typedY.id), byId(reweigh.id)]));
    expect(li.get(checkin.id)).toContain('data-marker="extras"');
    expect(li.get(checkin.id)).toContain('2 photos + more');
    expect(li.get(typedY.id)).not.toContain('data-marker="extras"');
    expect(li.get(reweigh.id)).not.toContain('data-marker="extras"');
    const onePhoto = lis(list('lb', [weighInList([{ ...typedY, photoIds: ['p1'] }], TODAY)[0]]));
    expect(onePhoto.get(typedY.id)).toMatch(/data-marker="extras"[^>]*><svg[\s\S]*?<\/svg>1 photo<\/span>/);
  });

  it('reading words', () => {
    expect(readingWhen(at(TODAY, 19, 45), TODAY)).toBe('Today, 7:45 PM');
    expect(readingWhen(at(dayOffset(-1), 6, 5), TODAY)).toBe('Yesterday, 6:05 AM');
    expect(readingWhen(at(dayOffset(-5), 7, 0), TODAY)).toBe('Thu, Oct 1, 7:00 AM');
    expect(readingText({ at: at(TODAY, 7, 2), kg: unitToKg(184.2, 'lb'), bodyFatPct: 19.4 }, 'lb')).toBe('184.2 lb · Oct 6, 7:02 AM');
  });
});

describe('Body card: the big number opens the weigh-ins', () => {
  const rows = [row(dayOffset(-1), unitToKg(185, 'lb')), row(TODAY, unitToKg(184.2, 'lb'), { source: 'health' })];

  it('the number area is a button that opens the sheet; the rest of the card still opens Measurements', () => {
    const out = view({ rows, onShowWeighIns: () => {} });
    const button = /<button[^>]*data-action="weigh-ins"[^>]*>[\s\S]*?<\/button>/.exec(out)?.[0] ?? '';
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toMatch(/data-weight[^>]*>184\.2</);
    expect(button).toContain('Today, 7:02 AM');
    expect(button).toContain('Show weigh-ins');
    // Title, pace and details: still links to Measurements.
    expect(out.match(/href="\/progress\/measurements"/g)?.length).toBe(3);
    expect(out).toContain('data-state="normal"');
  });

  it('no button inside a link, no link inside a button', () => {
    const out = view({ rows: series(-0.1, { fat: true }), goalRateKg: LOSE, onShowWeighIns: () => {} });
    const links = [...out.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const inner of links) expect(inner).not.toMatch(/<(button|a)\b/);
    const buttons = [...out.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
    expect(buttons).toHaveLength(1);
    for (const inner of buttons) expect(inner).not.toMatch(/<(button|a)\b/);
  });

  it('without the handler the number is plain text', () => {
    const out = view({ rows });
    expect(out).not.toContain('data-action="weigh-ins"');
    expect(out).not.toContain('<button');
    expect(out).toMatch(/data-weight[^>]*>184\.2</);
  });

  it('the empty and profile states have no weigh-ins to list', () => {
    expect(view({ rows: [], onShowWeighIns: () => {} })).not.toContain('data-action="weigh-ins"');
    expect(view({ rows: [], profileKg: 80, onShowWeighIns: () => {} })).not.toContain('data-action="weigh-ins"');
  });
});

describe('Deleting a weigh-in from Today', () => {
  beforeEach(async () => {
    await db.measurements.clear();
    await db.settings.clear();
    dialogs.confirm.mockReset();
    dialogs.toast.mockReset();
  });

  it('asks first; Delete removes it and remembers the Hume reading so a sync never brings it back', async () => {
    const bad = hume(TODAY, 7, 2, 184.2, 19.4);
    const good = hume(TODAY, 7, 5, 183.9, 19.6);
    await db.measurements.bulkPut([bad, good]);
    const item = weighInList(await db.measurements.toArray(), TODAY).find((i) => i.id === bad.id)!;

    dialogs.confirm.mockResolvedValueOnce(false);
    expect(await deleteWeighIn(item, 'lb')).toBe(false);
    expect(dialogs.confirm).toHaveBeenCalledWith({
      title: 'Delete this weigh-in?',
      message: "184.2 lb · Oct 6, 7:02 AM. It won't come back from Hume.",
      danger: true,
      confirmLabel: 'Delete',
    });
    expect(await db.measurements.get(bad.id)).toBeDefined();
    expect(dialogs.toast).not.toHaveBeenCalled();

    dialogs.confirm.mockResolvedValueOnce(true);
    expect(await deleteWeighIn(item, 'lb')).toBe(true);
    expect(await db.measurements.get(bad.id)).toBeUndefined();
    expect(await db.measurements.get(good.id)).toBeDefined();
    expect((await getSettings()).healthDeleted).toEqual([bad.healthAt]);
    expect(dialogs.toast).toHaveBeenCalledWith('Weigh-in deleted', 'success');
  });

  it('a typed check-in: the confirmation says its photos, tape and note go too; Cancel keeps all of it', async () => {
    const checkin: Measurement = {
      id: 'm_c',
      date: at(TODAY, 6, 30),
      bodyweightKg: 83.5,
      waistCm: 85,
      photoIds: ['p1', 'p2'],
      notes: 'Week 4',
      source: 'manual',
    };
    await db.measurements.put(checkin);
    dialogs.confirm.mockResolvedValueOnce(false);
    expect(await deleteWeighIn(weighInList([checkin], TODAY)[0], 'kg')).toBe(false);
    expect(dialogs.confirm).toHaveBeenCalledWith({
      title: 'Delete this weigh-in?',
      message: '83.5 kg · Oct 6, 6:30 AM. Its 2 photos, waist measurement and note will be deleted too.',
      danger: true,
      confirmLabel: 'Delete all',
    });
    expect(await db.measurements.get(checkin.id)).toEqual(checkin);
  });

  it('a typed weigh-in: deleted, nothing to remember', async () => {
    const typed: Measurement = { id: 'm_t', date: at(TODAY, 6, 30), bodyweightKg: 83.5, photoIds: [], source: 'manual' };
    await db.measurements.put(typed);
    dialogs.confirm.mockResolvedValueOnce(true);
    expect(await deleteWeighIn(weighInList([typed], TODAY)[0], 'kg')).toBe(true);
    expect(dialogs.confirm.mock.calls[0][0].message).toBe('83.5 kg · Oct 6, 6:30 AM.');
    expect(await db.measurements.count()).toBe(0);
    expect((await getSettings()).healthDeleted ?? []).toEqual([]);
    expect(dialogs.toast).toHaveBeenCalledWith('Weigh-in deleted', 'success');
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
