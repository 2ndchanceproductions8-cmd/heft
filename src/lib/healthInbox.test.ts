import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db';
import { DEFAULT_SETTINGS } from './settings';
import { KG_PER_LB } from './units';
import {
  checkInboxNow,
  clearInboxToken,
  getInboxStatus,
  getInboxToken,
  inboxImportMessage,
  onInboxResult,
  resetInboxForTests,
  setInboxToken,
  subscribeInbox,
  testInboxToken,
  type InboxState,
} from './healthInbox';

/*
 * The automatic Hume inbox (lib/healthInbox.ts) against a fake GitHub: fetch is stubbed with a tiny in-memory
 * issue-comments server, localStorage with a Map, Dexie with fake-indexeddb. The repo is PUBLIC: tokens here are
 * obvious fakes and the comments carry no user objects.
 */

/** A comment body the parser throws on (the real parser, wrapped), to prove one odd post never stalls a check. */
const PARSER_THROWS = vi.hoisted(() => 'heft-health (parser throws on this one)');
vi.mock('./healthImport', async (importOriginal) => {
  const real = await importOriginal<typeof import('./healthImport')>();
  return {
    ...real,
    parseHealthText: (...args: Parameters<typeof real.parseHealthText>) => {
      if (args[0] === PARSER_THROWS) throw new RangeError('Maximum call stack size exceeded');
      return real.parseHealthText(...args);
    },
  };
});

const TOKEN = 'github_pat_TEST';
const REPO = 'https://api.github.com/repos/2ndchanceproductions8-cmd/heft-inbox';
const ISSUE = `${REPO}/issues/1`;
const COMMENTS = `${ISSUE}/comments`;
const commentUrl = (id: number) => `${REPO}/issues/comments/${id}`;
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

const NOW = Date.parse('2026-10-06T20:00:00Z');
const T1 = Date.parse('2026-10-06T07:02:11-07:00');
const T2 = Date.parse('2026-10-05T07:01:03-07:00');

/** What the "Health to Heft" Shortcut posts (two weigh-ins: list variables put one value per line). */
const BODY = [
  'heft-health',
  'weight: 184.2 lb',
  '183.9 lb',
  'weight date: 2026-10-06T07:02:11-07:00',
  '2026-10-05T07:01:03-07:00',
  'body fat: 19.4%',
  '19.6%',
  'body fat date: 2026-10-06T07:02:11-07:00',
  '2026-10-05T07:01:03-07:00',
].join('\n');
/** An older post: only the Oct 5 weigh-in (overlaps BODY). */
const BODY_OCT5 = ['heft-health', 'weight: 183.9 lb', 'weight date: 2026-10-05T07:01:03-07:00', 'body fat: 19.6%', 'body fat date: 2026-10-05T07:01:03-07:00'].join('\n');

interface Comment {
  id: number;
  created_at: string;
  updated_at: string;
  body: string;
}
const comment = (id: number, body: string, created = '2026-10-06T16:08:13Z'): Comment => ({ id, created_at: created, updated_at: created, body });

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
  dump() {
    return Object.fromEntries(this.m);
  }
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  cache?: string;
  /** The request body (POST only). */
  body?: string;
}
type Handler = (url: string, method: string, init: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      calls.push({
        url,
        method,
        headers: { ...(init.headers as Record<string, string>) },
        cache: init.cache,
        body: typeof init.body === 'string' ? init.body : undefined,
      });
      return handler(url, method, init);
    }),
  );
  return calls;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

/** The id the fake inbox gives the first comment POSTed to it (then 1001, …). */
const FIRST_POSTED_ID = 1000;

/**
 * A fake issue-comments API: GET pages, POST to the comments URL adds a comment (201 {id}), DELETE removes (or
 * answers `deleteAnswer()` / `deleteStatus`, or throws when 'network').
 */
function inbox(initial: Comment[], opts: { deleteStatus?: number | 'network'; deleteAnswer?: () => Response } = {}) {
  let comments = [...initial];
  let nextId = FIRST_POSTED_ID;
  const rowsAtDelete: number[] = [];
  const calls = mockFetch(async (url, method, init) => {
    if (method === 'DELETE') {
      rowsAtDelete.push(await db.measurements.count());
      if (opts.deleteStatus === 'network') throw new TypeError('Load failed');
      if (opts.deleteAnswer) return opts.deleteAnswer();
      if (opts.deleteStatus) return json({ message: 'Server Error' }, opts.deleteStatus);
      const id = Number(url.split('/').pop());
      comments = comments.filter((c) => c.id !== id);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url === COMMENTS) {
      const posted = comment(nextId++, (JSON.parse(String(init.body)) as { body: string }).body, new Date().toISOString());
      comments.push(posted);
      return json(posted, 201);
    }
    if (url.startsWith(COMMENTS + '?')) {
      const q = new URL(url).searchParams;
      const per = Number(q.get('per_page'));
      const page = Number(q.get('page'));
      return json(comments.slice((page - 1) * per, page * per));
    }
    if (url === ISSUE) return json({ number: 1, title: 'inbox', state: 'open' });
    return json({ message: 'Not Found' }, 404);
  });
  return {
    calls,
    rowsAtDelete,
    get comments() {
      return comments;
    },
    deletes: () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
    gets: () => calls.filter((c) => c.method === 'GET').map((c) => c.url),
  };
}

let storage: MemoryStorage;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  resetInboxForTests();
  await Promise.all([db.measurements.clear(), db.settings.clear(), db.media.clear()]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkInboxNow: importing', () => {
  it('imports both weigh-ins of a post, THEN deletes exactly that comment (with the token headers)', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(101, BODY)]);
    const r = await checkInboxNow();
    expect(r).toMatchObject({ state: 'ok', added: 2, updated: 0 });

    const rows = await db.measurements.orderBy('date').toArray();
    expect(rows.map((m) => m.id)).toEqual([`hk_${T2}`, `hk_${T1}`]);
    expect(rows[1]).toMatchObject({ source: 'health', healthAt: T1, date: T1, bodyFatPct: 19.4 });
    expect(rows[1].bodyweightKg).toBeCloseTo(184.2 * KG_PER_LB, 6);
    expect(rows[0]).toMatchObject({ source: 'health', healthAt: T2, bodyFatPct: 19.6 });
    expect(rows[0].bodyweightKg).toBeCloseTo(183.9 * KG_PER_LB, 6);

    expect(box.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(box.calls[0]).toEqual({ url: `${COMMENTS}?per_page=100&page=1`, method: 'GET', headers: HEADERS, cache: 'no-store' });
    expect(box.calls[1]).toEqual({ url: commentUrl(101), method: 'DELETE', headers: HEADERS, cache: 'no-store' });
    expect(box.rowsAtDelete).toEqual([2]); // the import had committed before the delete went out
    expect(box.comments).toEqual([]);

    expect(getInboxStatus()).toEqual({
      configured: true,
      state: 'ok',
      checkedAt: NOW,
      lastImport: { at: NOW, added: 2, updated: 0 },
      lastPostAt: Date.parse('2026-10-06T16:08:13Z'),
    });
    expect(inboxImportMessage(r, 'lb')).toBe('From Hume: 2 weigh-ins');
  });

  it('a note that is not heft-health text is ignored and left on the issue', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(7, 'Calibrate the scale on Sunday'), comment(8, 'Fat: 12 g\nProtein: 30 g'), comment(101, BODY)]);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.deletes()).toEqual([commentUrl(101)]);
    expect(box.comments.map((c) => c.id)).toEqual([7, 8]);

    // Nothing of ours left: a check imports and deletes nothing, and still counts as an answer.
    vi.setSystemTime(NOW + 60_000);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 0, updated: 0 });
    expect(box.deletes()).toEqual([commentUrl(101)]);
    expect(getInboxStatus()).toMatchObject({ checkedAt: NOW + 60_000, lastImport: { at: NOW, added: 2, updated: 0 } });
  });

  it('reads every page (100 per page) until a short one', async () => {
    setInboxToken(TOKEN);
    const junk = Array.from({ length: 100 }, (_, i) => comment(i + 1, `note ${i + 1}`, '2026-10-01T00:00:00Z'));
    const box = inbox([...junk, comment(500, BODY)]);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.gets()).toEqual([`${COMMENTS}?per_page=100&page=1`, `${COMMENTS}?per_page=100&page=2`]);
    expect(box.deletes()).toEqual([commentUrl(500)]);
  });

  it('overlapping posts (each one is the last 30 days) make each weigh-in once, and all of them are cleared', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(100, BODY_OCT5, '2026-10-05T14:05:00Z'), comment(101, BODY)]);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2, updated: 0 });
    expect(await db.measurements.count()).toBe(2);
    expect(box.deletes()).toEqual([commentUrl(100), commentUrl(101)]);
  });

  it('one new weigh-in carries its row for the toast', async () => {
    setInboxToken(TOKEN);
    inbox([comment(100, BODY_OCT5)]);
    const r = await checkInboxNow();
    expect(r.added).toBe(1);
    expect(r.addedRows).toHaveLength(1);
    expect(inboxImportMessage(r, 'lb')).toBe('From Hume: 183.9 lb · 19.6% body fat');
  });

  it('a failed DELETE still reports the import; the next read of the same comment adds nothing', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(101, BODY)], { deleteStatus: 500 });
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2, updated: 0 });
    expect(box.comments).toHaveLength(1);

    vi.setSystemTime(NOW + 60_000);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 0, updated: 0 });
    expect(await db.measurements.count()).toBe(2);
    expect(getInboxStatus().lastImport).toEqual({ at: NOW, added: 2, updated: 0 });
  });

  it('a DELETE that fails on the network still reports the import', async () => {
    setInboxToken(TOKEN);
    inbox([comment(101, BODY)], { deleteStatus: 'network' });
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
  });

  it("a token that can read but not delete: import kept, one DELETE tried, and Settings is told why", async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(100, BODY_OCT5), comment(101, BODY)], { deleteStatus: 403 });
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.deletes()).toHaveLength(1);
    expect(getInboxStatus().message).toMatch(/Read and write/);
  });

  it('a DELETE stopped by a secondary rate limit (403 + retry-after) is a pause, not a missing permission', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(100, BODY_OCT5), comment(101, BODY)], {
      deleteAnswer: () =>
        json({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, 403, {
          'x-ratelimit-remaining': '4990',
          'retry-after': '60',
        }),
    });
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.deletes()).toHaveLength(1);
    expect(getInboxStatus().message ?? '').not.toMatch(/Read and write/);
  });

  it('a weigh-in deleted in Heft (tombstoned) is not brought back by the inbox', async () => {
    await db.settings.put({ ...DEFAULT_SETTINGS, healthDeleted: [T1] });
    setInboxToken(TOKEN);
    const box = inbox([comment(101, BODY)]);
    const r = await checkInboxNow();
    expect(r).toMatchObject({ state: 'ok', added: 1 });
    expect((await db.measurements.toArray()).map((m) => m.id)).toEqual([`hk_${T2}`]);
    expect(r.addedRows?.map((m) => m.id)).toEqual([`hk_${T2}`]);
    expect(box.deletes()).toEqual([commentUrl(101)]);
  });

  it('weigh-ins whose body fat came back empty still import, with a hint about the Shortcut', async () => {
    setInboxToken(TOKEN);
    const noFat = ['heft-health', 'weight: 184.2 lb', 'weight date: 2026-10-06T07:02:11-07:00', 'body fat: ', 'body fat date: '].join('\n');
    inbox([comment(101, noFat)]);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 1 });
    expect(getInboxStatus().message).toMatch(/Body fat came back empty/);
  });

  it("heft-health text Heft can't read is kept (to look at) and reported, until a readable post arrives", async () => {
    setInboxToken(TOKEN);
    const bad = ['heft-health', 'weight: 184.2 lb', 'weight date: sometime soon'].join('\n');
    const box = inbox([comment(90, bad, '2026-10-04T10:00:00Z')]);
    expect(await checkInboxNow()).toMatchObject({ state: 'unreadable', added: 0 });
    expect(getInboxStatus().message).toMatch(/couldn't read what the Shortcut sent/i);
    expect(box.deletes()).toEqual([]);

    box.comments.push(comment(101, BODY));
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.deletes()).toEqual([commentUrl(101), commentUrl(90)]); // what was imported goes first
    expect(getInboxStatus().message).toBeUndefined();
  });

  it('a post where the Shortcut found nothing is kept, and the status says no weigh-ins came (not "up to date")', async () => {
    setInboxToken(TOKEN);
    const empty = ['heft-health', 'weight: ', 'weight date: ', 'body fat: ', 'body fat date: '].join('\n');
    const box = inbox([comment(95, empty)]);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 0 });
    expect(box.deletes()).toEqual([]);
    expect(box.comments.map((c) => c.id)).toEqual([95]);
    expect(getInboxStatus()).toMatchObject({ state: 'ok', message: expect.stringMatching(/No weigh-ins in what the Shortcut sent/) });
  });

  it('a post with a good weight and an unreadable body fat date imports the weight, is cleared, and says what was skipped', async () => {
    setInboxToken(TOKEN);
    const partly = [
      'heft-health',
      'weight: 184.2 lb',
      'weight date: 2026-10-06T07:02:11-07:00',
      'body fat: 19.4%',
      'body fat date: garbage',
    ].join('\n');
    const box = inbox([comment(102, partly)]);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 1 });
    expect((await db.measurements.toArray()).map((m) => m.id)).toEqual([`hk_${T1}`]);
    expect(box.deletes()).toEqual([commentUrl(102)]);
    expect(getInboxStatus().message).toMatch(/skipped/);
  });

  it('an undated weigh-in is never imported as "now": kept, and reported as unreadable on every check', async () => {
    setInboxToken(TOKEN);
    const undated = ['heft-health', 'weight: 184.2 lb', 'weight date: '].join('\n');
    const box = inbox([comment(103, undated)]);
    for (const at of [NOW, NOW + 60_000]) {
      vi.setSystemTime(at);
      expect(await checkInboxNow()).toMatchObject({ state: 'unreadable', added: 0 });
      expect(await db.measurements.count()).toBe(0);
      expect(box.deletes()).toEqual([]);
      expect(getInboxStatus().message).toMatch(/has no date/);
    }
  });

  it('a deeply nested JSON comment does not stall the inbox: the valid post still imports and both are cleared', async () => {
    setInboxToken(TOKEN);
    // Built at runtime: an array nested this deep would overflow the stack of a recursive reader.
    const depth = 200_000;
    const nested = `{"weight": ${'['.repeat(depth)}${']'.repeat(depth)}}`;
    const box = inbox([comment(98, nested, '2026-10-06T15:00:00Z'), comment(101, BODY)]);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.deletes()).toEqual([commentUrl(101), commentUrl(98)]); // what was imported goes first
    expect(box.comments).toEqual([]);
  });

  it('a comment the parser throws on is unreadable, never stalls the check, and goes once weigh-ins import', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(97, PARSER_THROWS, '2026-10-06T15:00:00Z')]);
    expect(await checkInboxNow()).toMatchObject({ state: 'unreadable', added: 0 });
    expect(getInboxStatus().message).toMatch(/isn't in the Shortcut's format/);
    expect(box.deletes()).toEqual([]);

    box.comments.push(comment(101, BODY));
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.deletes()).toEqual([commentUrl(101), commentUrl(97)]);
    expect(box.comments).toEqual([]);
    expect(getInboxStatus().message).toBeUndefined();
  });

  it('a post that brings nothing new still records when the Shortcut last reached GitHub', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(101, BODY)]);
    expect(await checkInboxNow()).toMatchObject({ added: 2 });
    expect(getInboxStatus().lastPostAt).toBe(Date.parse('2026-10-06T16:08:13Z'));

    // The next Shortcut run resends the same 30 days: nothing to add, but the post is seen.
    box.comments.push(comment(102, BODY, '2026-10-06T19:30:00Z'));
    vi.setSystemTime(NOW + 60_000);
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 0, updated: 0 });
    expect(getInboxStatus().lastPostAt).toBe(Date.parse('2026-10-06T19:30:00Z'));
    expect(box.deletes()).toEqual([commentUrl(101), commentUrl(102)]);

    // A check with nothing in the inbox keeps the last one.
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 0 });
    expect(getInboxStatus().lastPostAt).toBe(Date.parse('2026-10-06T19:30:00Z'));
  });

  it('walks the states: checking, then the result', async () => {
    setInboxToken(TOKEN);
    inbox([comment(101, BODY)]);
    const seen: InboxState[] = [];
    const off = subscribeInbox(() => seen.push(getInboxStatus().state));
    await checkInboxNow();
    off();
    expect(seen).toEqual(['checking', 'ok']);
  });
});

describe('checkInboxNow: failures', () => {
  const cases: [string, () => Response | Promise<Response>, InboxState][] = [
    ['401 Bad credentials', () => json({ message: 'Bad credentials' }, 401), 'token_rejected'],
    ['403 no Issues permission', () => json({ message: 'Resource not accessible by personal access token' }, 403), 'no_permission'],
    ['404 (no token / no repo access)', () => json({ message: 'Not Found' }, 404), 'not_found'],
    ['403 out of requests', () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }), 'error'],
    ['403 with retry-after (secondary limit)', () => json({ message: 'Forbidden' }, 403, { 'retry-after': '60' }), 'error'],
    ['502', () => json({ message: 'Bad Gateway' }, 502), 'error'],
    ['a body that is not a list', () => json({ message: 'odd' }), 'error'],
    [
      'a network error',
      () => {
        throw new TypeError('Load failed');
      },
      'offline',
    ],
  ];
  for (const [name, answer, state] of cases) {
    it(`${name} → ${state}, nothing imported or deleted`, async () => {
      setInboxToken(TOKEN);
      const calls = mockFetch(answer);
      expect(await checkInboxNow()).toEqual({ state, added: 0, updated: 0 });
      expect(calls.map((c) => c.method)).toEqual(['GET']);
      expect(await db.measurements.count()).toBe(0);
      const s = getInboxStatus();
      expect(s).toMatchObject({ configured: true, state, checkedAt: null });
      expect(s.message).toBeTruthy();
    });
  }

  it('gives up on a silent GitHub after 15 s (offline)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: NOW });
    setInboxToken(TOKEN);
    mockFetch(
      (_url, _method, init) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    );
    const p = checkInboxNow();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(getInboxStatus().state).toBe('checking');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toMatchObject({ state: 'offline' });
  });

  it('no token → off, and nothing is fetched', async () => {
    const calls = mockFetch(() => json([]));
    expect(await checkInboxNow()).toEqual({ state: 'off', added: 0, updated: 0 });
    expect(calls).toHaveLength(0);
    expect(getInboxStatus()).toMatchObject({ configured: false, state: 'off' });
  });

  it('offline (navigator.onLine false) → offline, and nothing is fetched', async () => {
    setInboxToken(TOKEN);
    vi.stubGlobal('navigator', { onLine: false });
    const calls = mockFetch(() => json([]));
    expect(await checkInboxNow()).toMatchObject({ state: 'offline' });
    expect(calls).toHaveLength(0);
  });
});

describe('checkInboxNow: single flight', () => {
  it('a second call while one runs joins it (one request, one result event)', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(101, BODY)]);
    const events: number[] = [];
    const off = onInboxResult((r) => events.push(r.added));
    const a = checkInboxNow();
    const b = checkInboxNow();
    expect(b).toBe(a);
    expect(await a).toMatchObject({ added: 2 });
    expect(box.gets()).toHaveLength(1);
    expect(events).toEqual([2]);

    // Once it finished, the next call runs again.
    await checkInboxNow();
    expect(box.gets()).toHaveLength(2);
    expect(events).toEqual([2, 0]);
    off();
  });

  it('a token replaced mid-check: the old check imports nothing and the next call runs with the new token', async () => {
    setInboxToken(TOKEN);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = mockFetch(async () => {
      await gate;
      return json([comment(101, BODY)]);
    });
    const events: string[] = [];
    const off = onInboxResult((r) => events.push(r.state));
    const old = checkInboxNow();
    setInboxToken('github_pat_OTHER');
    const next = checkInboxNow();
    expect(next).not.toBe(old);
    release();
    expect(await old).toMatchObject({ added: 0 });
    expect(await next).toMatchObject({ state: 'ok', added: 2 });
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.headers.Authorization)).toEqual([
      `Bearer ${TOKEN}`,
      'Bearer github_pat_OTHER',
    ]);
    expect(events).toEqual(['ok']); // only the current token's check reports
    off();
  });
});

describe('token and status storage', () => {
  it('the token lives in localStorage only, trimmed; configured follows it; clearing forgets the history', async () => {
    expect(getInboxStatus()).toMatchObject({ configured: false, state: 'off' });
    setInboxToken(`  ${TOKEN}\n`);
    expect(getInboxToken()).toBe(TOKEN);
    expect(storage.getItem('heft-key:github-inbox')).toBe(TOKEN);
    expect(getInboxStatus()).toMatchObject({ configured: true, state: 'idle' });

    inbox([comment(101, BODY)]);
    await checkInboxNow();
    expect(storage.getItem('heft-inbox:status')).toBeTruthy();

    clearInboxToken();
    expect(getInboxToken()).toBeNull();
    expect(storage.dump()).toEqual({});
    expect(getInboxStatus()).toEqual({ configured: false, state: 'off', checkedAt: null, lastImport: null, lastPostAt: null });

    setInboxToken('   ');
    expect(getInboxToken()).toBeNull();
  });

  it('a pasted "Bearer …", "token …" or quoted key is reduced to the bare key', async () => {
    setInboxToken(`Bearer ${TOKEN}`);
    expect(getInboxToken()).toBe(TOKEN);
    const calls = mockFetch(() => json([]));
    await checkInboxNow();
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);

    setInboxToken(`"${TOKEN}"`);
    expect(getInboxToken()).toBe(TOKEN);
    setInboxToken('token ghp_abc');
    expect(getInboxToken()).toBe('ghp_abc');
    setInboxToken(`bearer '${TOKEN}'`);
    expect(getInboxToken()).toBe(TOKEN);

    // A key saved with the prefix before this fix is repaired on read.
    storage.setItem('heft-key:github-inbox', `Bearer${TOKEN}`);
    expect(getInboxToken()).toBe(TOKEN);
  });

  it('"checked 2 min ago", the last import and the last post survive a reload', async () => {
    setInboxToken(TOKEN);
    inbox([comment(101, BODY)]);
    await checkInboxNow();
    resetInboxForTests(); // a reload: memory gone, localStorage kept
    expect(getInboxStatus()).toEqual({
      configured: true,
      state: 'idle',
      checkedAt: NOW,
      lastImport: { at: NOW, added: 2, updated: 0 },
      lastPostAt: Date.parse('2026-10-06T16:08:13Z'),
    });
  });

  it('blocked storage never throws: no token, nothing remembered', async () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 });
    resetInboxForTests();
    expect(() => setInboxToken(TOKEN)).not.toThrow();
    expect(getInboxToken()).toBeNull();
    expect(() => clearInboxToken()).not.toThrow();
    expect(await checkInboxNow()).toMatchObject({ state: 'off' });
  });
});

describe('testInboxToken', () => {
  it('reads the issue, then posts a test comment and deletes it; imports nothing and leaves the status alone', async () => {
    const box = inbox([comment(101, BODY)]);
    expect(await testInboxToken(` ${TOKEN} `)).toBe('ok');
    expect(box.calls).toEqual([
      { url: ISSUE, method: 'GET', headers: HEADERS, cache: 'no-store' },
      {
        url: COMMENTS,
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ body: 'Heft key test (safe to delete)' }),
      },
      { url: commentUrl(FIRST_POSTED_ID), method: 'DELETE', headers: HEADERS, cache: 'no-store' },
    ]);
    expect(box.comments.map((c) => c.id)).toEqual([101]); // no probe left behind
    expect(await db.measurements.count()).toBe(0);
    expect(getInboxStatus()).toMatchObject({ configured: false, state: 'off' });
  });

  it('a key that can read but not write (Issues read-only) is not "Connected"', async () => {
    const calls = mockFetch((_url, method) =>
      method === 'GET' ? json({ number: 1 }) : json({ message: 'Resource not accessible by personal access token' }, 403),
    );
    expect(await testInboxToken(TOKEN)).toBe('no_permission');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });

  it('a rate-limited write is a pause (error), not a missing permission', async () => {
    mockFetch((_url, method) =>
      method === 'GET' ? json({ number: 1 }) : json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
    );
    expect(await testInboxToken(TOKEN)).toBe('error');
  });

  it("the probe's delete: a 403 means no_permission; a network failure still passes the key", async () => {
    inbox([], { deleteAnswer: () => json({ message: 'Resource not accessible by personal access token' }, 403) });
    expect(await testInboxToken(TOKEN)).toBe('no_permission');
    const box = inbox([], { deleteStatus: 'network' });
    expect(await testInboxToken(TOKEN)).toBe('ok');
    expect(box.comments.map((c) => c.body)).toEqual(['Heft key test (safe to delete)']);
  });

  it('a probe comment left on the issue is ignored by checks (not heft-health text)', async () => {
    setInboxToken(TOKEN);
    const box = inbox([comment(101, BODY)], { deleteStatus: 'network' });
    expect(await testInboxToken(TOKEN)).toBe('ok');
    box.calls.length = 0;
    // Deletes keep failing on the network here, so only the import is checked.
    expect(await checkInboxNow()).toMatchObject({ state: 'ok', added: 2 });
    expect(box.deletes()).toEqual([commentUrl(101)]);
  });

  it('maps the answers', async () => {
    const answers: [() => Response, InboxState][] = [
      [() => json({ message: 'Bad credentials' }, 401), 'token_rejected'],
      [() => json({ message: 'Forbidden' }, 403), 'no_permission'],
      [() => json({ message: 'Not Found' }, 404), 'not_found'],
      [() => json({ message: 'oops' }, 500), 'error'],
      [
        () => {
          throw new TypeError('Load failed');
        },
        'offline',
      ],
    ];
    for (const [answer, state] of answers) {
      mockFetch(answer);
      expect(await testInboxToken(TOKEN)).toBe(state);
    }
    const calls = mockFetch(() => json({}));
    expect(await testInboxToken('  ')).toBe('token_rejected');
    expect(calls).toHaveLength(0);
  });
});

describe('the token stays secret', () => {
  it('rides only in the Authorization header: never in a URL, a log, the status, or the database', async () => {
    const logs: unknown[][] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }
    setInboxToken(TOKEN);
    const box = inbox([comment(101, BODY)]);
    await checkInboxNow();
    await testInboxToken(TOKEN);
    const rejected = mockFetch(() => json({ message: 'Bad credentials' }, 401));
    await checkInboxNow();
    mockFetch(() => {
      throw new TypeError('Load failed');
    });
    await checkInboxNow();

    const all = [...box.calls, ...rejected];
    expect(all.length).toBeGreaterThan(2);
    for (const c of all) {
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.url).not.toContain(TOKEN);
    }
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(JSON.stringify(getInboxStatus())).not.toContain(TOKEN);
    const stored = storage.dump();
    expect(Object.entries(stored).filter(([, v]) => v.includes(TOKEN)).map(([k]) => k)).toEqual(['heft-key:github-inbox']);
    const dbDump = JSON.stringify([await db.measurements.toArray(), await db.settings.toArray()]);
    expect(dbDump).not.toContain(TOKEN);
  });
});

describe('inboxImportMessage', () => {
  const row = { id: 'hk_1', date: T1, bodyweightKg: 184.2 * KG_PER_LB, bodyFatPct: 19.4 };
  it('one weigh-in shows its values in the user unit; several show a count; none is silent', () => {
    expect(inboxImportMessage({ added: 1, addedRows: [row] }, 'lb')).toBe('From Hume: 184.2 lb · 19.4% body fat');
    expect(inboxImportMessage({ added: 1, addedRows: [row] }, 'kg')).toBe('From Hume: 83.6 kg · 19.4% body fat');
    expect(inboxImportMessage({ added: 1, addedRows: [{ ...row, bodyFatPct: null }] }, 'lb')).toBe('From Hume: 184.2 lb');
    expect(inboxImportMessage({ added: 1, addedRows: [{ ...row, bodyweightKg: null }] }, 'lb')).toBe('From Hume: 19.4% body fat');
    expect(inboxImportMessage({ added: 3 }, 'lb')).toBe('From Hume: 3 weigh-ins');
    expect(inboxImportMessage({ added: 0 }, 'lb')).toBeNull();
  });
});
