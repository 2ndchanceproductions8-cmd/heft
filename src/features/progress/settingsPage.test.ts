// Settings: the "Automatic Hume sync" row's subtitle and what Delete all data says about the Hume automation
// (no DOM: the helpers the page uses).
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { InboxStatus } from '../../lib/healthInbox';
import { DELETE_ALL_MESSAGE, humeSyncSubtitle } from './SettingsPage';

const status = (s: Partial<InboxStatus>): InboxStatus => ({
  configured: true,
  state: 'idle',
  checkedAt: null,
  lastImport: null,
  lastPostAt: null,
  ...s,
});

describe('Automatic Hume sync row', () => {
  it('warns about every key or Shortcut problem, not only a rejected or blind key', () => {
    expect(humeSyncSubtitle(status({ state: 'token_rejected' }))).toEqual({ text: 'GitHub rejected the key', warn: true });
    expect(humeSyncSubtitle(status({ state: 'not_found' }))).toEqual({ text: "The key can't see heft-inbox", warn: true });
    expect(humeSyncSubtitle(status({ state: 'no_permission' }))).toEqual({ text: "The key can't write Issues", warn: true });
    expect(humeSyncSubtitle(status({ state: 'unreadable' }))).toEqual({ text: "Heft can't read the Shortcut's posts", warn: true });
  });

  it('otherwise says what it does, or when the last weigh-in came in', () => {
    expect(humeSyncSubtitle(status({ configured: false, state: 'off' }))).toEqual({
      text: 'Weigh-ins arrive when you close the Hume app',
      warn: false,
    });
    const at = new Date(2026, 9, 6, 7, 5).getTime();
    expect(humeSyncSubtitle(status({ state: 'ok', lastImport: { at, added: 1, updated: 0 } }))).toEqual({
      text: 'Last weigh-in came in Oct 6, 7:05 AM',
      warn: false,
    });
  });
});

describe('Delete all data', () => {
  it('says the Hume automation keeps sending until it is removed in Shortcuts', () => {
    expect(DELETE_ALL_MESSAGE).toContain('forgets the Claude and USDA keys saved for the Food tab and the GitHub key for Hume sync.');
    expect(DELETE_ALL_MESSAGE).toContain(
      'The Hume Health automation in Shortcuts keeps sending weigh-ins to heft-inbox until you remove it there.',
    );
  });
});
