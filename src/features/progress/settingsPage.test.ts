// Settings: what Delete all data says, and forgetting the removed Hume sync's GitHub key (no DOM: the helpers the
// page and the app shell use).
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE_ALL_MESSAGE } from './SettingsPage';
import { forgetHumeSync, LEGACY_HUME_KEYS } from '../../lib/legacyHume';

describe('Delete all data', () => {
  it('names the Food keys and no longer mentions Hume', () => {
    expect(DELETE_ALL_MESSAGE).toContain('forgets the Claude and USDA keys saved for the Food tab.');
    expect(DELETE_ALL_MESSAGE).not.toMatch(/Hume|GitHub|heft-inbox/);
  });
});

describe('forgetHumeSync (the removed automatic Hume sync)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("removes the old GitHub key and sync status, and leaves everything else", () => {
    const store = new Map<string, string>([
      ['heft-key:github-inbox', 'github_pat_TEST'],
      ['heft-inbox:status', '{}'],
      ['heft.theme', 'dark'],
    ]);
    vi.stubGlobal('localStorage', { removeItem: (k: string) => store.delete(k) });
    forgetHumeSync();
    expect([...store.keys()]).toEqual(['heft.theme']);
    expect(LEGACY_HUME_KEYS).toEqual(['heft-key:github-inbox', 'heft-inbox:status']);
  });

  it('never throws when storage is blocked or missing', () => {
    vi.stubGlobal('localStorage', {
      removeItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(() => forgetHumeSync()).not.toThrow();
    vi.stubGlobal('localStorage', undefined);
    expect(() => forgetHumeSync()).not.toThrow();
  });
});
