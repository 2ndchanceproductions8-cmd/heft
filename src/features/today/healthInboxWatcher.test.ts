import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxSyncResult } from '../../lib/healthInbox';
import { watcherForTests as w } from './HealthInboxWatcher';

/*
 * HealthInboxWatcher's steps (wake → check + follow-ups, report → toasts) without a DOM: the inbox, the toast, the
 * Safari-tab test and the settings are stubbed. Tokens here are obvious fakes (the repo is public).
 */

const stubs = vi.hoisted(() => ({
  checkInboxNow: vi.fn(),
  token: 'github_pat_TEST' as string | null,
  safariTab: false,
  toast: vi.fn(),
}));
vi.mock('../../lib/healthInbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/healthInbox')>()),
  checkInboxNow: stubs.checkInboxNow,
  getInboxToken: () => stubs.token,
}));
vi.mock('../../lib/appleHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/appleHealth')>()),
  inSafariTab: () => stubs.safariTab,
}));
vi.mock('../../components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/ui')>()),
  toast: stubs.toast,
}));
vi.mock('../../lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/settings')>()),
  getSettings: async () => ({ unit: 'lb' }),
}));

const result = (state: InboxSyncResult['state'], added = 0): InboxSyncResult => ({ state, added, updated: 0 });
const checks = () => stubs.checkInboxNow.mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-06T14:00:00Z') });
  stubs.checkInboxNow.mockReset().mockResolvedValue(result('ok'));
  stubs.toast.mockReset();
  stubs.token = 'github_pat_TEST';
  stubs.safariTab = false;
  w.reset();
});

afterEach(() => {
  w.reset();
  vi.useRealTimers();
});

describe('wake and its follow-ups', () => {
  it('checks at once, then 16 s and 45 s later', async () => {
    w.wake(true);
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(checks()).toBe(2);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(checks()).toBe(3);
  });

  it('an import (maybe an older post) keeps the follow-ups: the post for this weigh-in can still land', async () => {
    w.wake(true);
    await w.report(result('ok', 1));
    expect(stubs.toast).toHaveBeenCalledWith(expect.stringMatching(/^From Hume/), 'success', 3500);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(checks()).toBe(2);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(checks()).toBe(3);
  });

  it('never checks automatically in a Safari tab (only the installed app takes the posts)', async () => {
    stubs.safariTab = true;
    w.wake(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checks()).toBe(0);
  });
});

describe('report', () => {
  for (const state of ['token_rejected', 'not_found', 'no_permission'] as const) {
    it(`${state}: one "Hume sync paused" toast, and the follow-ups stop (they would fail the same way)`, async () => {
      w.wake(true);
      await w.report(result(state));
      await w.report(result(state));
      expect(stubs.toast).toHaveBeenCalledTimes(1);
      expect(stubs.toast).toHaveBeenCalledWith(expect.stringMatching(/^Hume sync paused\. /), 'error', 6000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(checks()).toBe(1);
    });
  }

  it('no_permission tells the owner to give the key Issues Read and write', async () => {
    await w.report(result('no_permission'));
    expect(stubs.toast.mock.calls[0][0]).toMatch(/Read and write/);
  });

  it("unreadable: one toast, but the follow-ups stay (a fixed Shortcut's post can land seconds later)", async () => {
    w.wake(true);
    await w.report(result('unreadable'));
    await w.report(result('unreadable'));
    expect(stubs.toast).toHaveBeenCalledTimes(1);
    expect(stubs.toast).toHaveBeenCalledWith(expect.stringMatching(/^Hume sync paused\. Heft couldn't read/), 'error', 6000);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(checks()).toBe(2);
  });

  it('a check that succeeds re-arms the toast', async () => {
    await w.report(result('unreadable'));
    await w.report(result('ok'));
    await w.report(result('unreadable'));
    expect(stubs.toast).toHaveBeenCalledTimes(2);
  });
});
