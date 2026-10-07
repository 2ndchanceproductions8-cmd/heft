import { useSyncExternalStore } from 'react';
import { db } from '../db';
import type { Measurement, Unit } from '../types';
import { applyHealthImport, parseHealthText, planHealthImport, type HealthSample } from './healthImport';
import { getSettings } from './settings';
import { formatNumber, kgToUnit } from './units';

/*
 * Automatic Hume → Heft sync. When the Hume app closes, an iOS Shortcuts automation runs "Health to Heft", which
 * posts the last 30 days of Weight + Body Fat samples (the heft-health text) as a COMMENT on issue #1 of the owner's
 * PRIVATE GitHub repo heft-inbox. Heft reads the comments (fine-grained token, Issues read/write on that one repo,
 * kept in this browser's localStorage like the Claude key), imports them with planHealthImport/applyHealthImport,
 * then deletes the comments it imported.
 *
 * - The token lives ONLY in localStorage ('heft-key:github-inbox'): never in Dexie, never in a backup, never logged,
 *   never in a URL. Every storage access is wrapped (private mode / blocked site data throw).
 * - checkInboxNow() never throws and is single-flight: a second call while one runs joins it.
 * - A comment is deleted only AFTER its import committed. A failed delete is harmless: the next check reads the
 *   comment again and the import is idempotent (the planner skips what Heft already holds, and deleted weigh-ins
 *   stay deleted through Settings.healthDeleted).
 * - Comments that aren't heft-health text (a note typed on GitHub) are ignored and never deleted. Heft-health text
 *   with no weigh-ins in it (every value failed to read, or the Shortcut found no samples) is kept too (so the raw
 *   text can be inspected) until a post with weigh-ins arrives. A post that can't be parsed at all counts as
 *   unreadable.
 * - Requests: GET/POST/DELETE with Authorization: Bearer, Accept: application/vnd.github+json, X-GitHub-Api-Version
 *   2022-11-28 (measured 2026-10-06: these pass CORS from the browser; the preflight allows POST with Content-Type).
 *   401 = a bad key, 403 = the key lacks the Issues permission, 404 = no access to the repo.
 *   GitHub asks for one request at a time per token, so pages and deletes go serially.
 */

export const INBOX = { owner: '2ndchanceproductions8-cmd', repo: 'heft-inbox', issue: 1 } as const;

const API = 'https://api.github.com';
const REPO_URL = `${API}/repos/${INBOX.owner}/${INBOX.repo}`;
/** The issue the inbox lives on (testInboxToken reads it). */
export const INBOX_ISSUE_URL = `${REPO_URL}/issues/${INBOX.issue}`;
/** The Shortcut POSTs {"body": <heft-health text>} here; Heft GETs the comments from here. */
export const INBOX_COMMENTS_URL = `${INBOX_ISSUE_URL}/comments`;
const commentUrl = (id: number) => `${REPO_URL}/issues/comments/${id}`;

const TOKEN_KEY = 'heft-key:github-inbox';
const STATUS_KEY = 'heft-inbox:status';
const TIMEOUT_MS = 15_000;
const PER_PAGE = 100;
/** Safety stop for the page loop (3,000 comments: far more than undeleted posts could pile up to). */
const MAX_PAGES = 30;

export type InboxState =
  | 'off'
  | 'idle'
  | 'checking'
  | 'ok'
  | 'offline'
  | 'token_rejected'
  | 'not_found'
  | 'no_permission'
  | 'unreadable'
  | 'error';

export interface InboxStatus {
  /** A token is saved on this device. */
  configured: boolean;
  state: InboxState;
  /** Last time the inbox answered (epoch ms), null = never. */
  checkedAt: number | null;
  /** The last check that brought something in. */
  lastImport: { at: number; added: number; updated: number } | null;
  /** created_at of the newest Shortcut post Heft has read (epoch ms), null = none yet. */
  lastPostAt: number | null;
  /**
   * Human-readable detail for error states. An 'ok' check can carry a note too (the token can read but not clear
   * the inbox; the post had no weigh-ins; part of a post was skipped; body fat came back empty).
   */
  message?: string;
}

export interface InboxSyncResult {
  state: InboxState;
  added: number;
  updated: number;
  /** The rows this check added (for the "From Hume: 184.2 lb · 19.4% body fat" toast). */
  addedRows?: Pick<Measurement, 'id' | 'date' | 'bodyweightKg' | 'bodyFatPct'>[];
}

// ------------------------------------------------------------------ messages

const STATE_MESSAGE: Record<InboxState, string> = {
  off: 'Not set up on this device.',
  idle: 'Waiting for the first check.',
  checking: 'Checking the inbox…',
  ok: 'Up to date.',
  offline: "Offline. Heft checks again when you're back online.",
  token_rejected: "GitHub didn't accept the inbox token (it may have expired). Paste a new one in Settings → Apple Health.",
  not_found:
    "GitHub can't find the inbox with this token. It needs access to the heft-inbox repository: check it in Settings → Apple Health.",
  no_permission:
    "The inbox key can't use Issues on heft-inbox. On GitHub, set its Issues permission to Read and write (Settings → Apple Health).",
  unreadable: "Heft couldn't read what the Shortcut sent. Check its Text step in Settings → Apple Health.",
  error: "GitHub didn't answer properly. Heft will try again.",
};

/** A short, plain sentence for a state (Settings' status line, the watcher's error toast). */
export function inboxMessage(state: InboxState): string {
  return STATE_MESSAGE[state];
}

const RATE_LIMITED = 'GitHub is limiting requests right now. Heft will try again later.';
const CANT_CLEAR =
  "Weigh-ins came in, but the token can't clear the inbox: give it Issues “Read and write” access.";
const NO_BODY_FAT =
  'Body fat came back empty. If your scale measures it, check the Shortcut’s second Find Health Samples step.';
const NO_WEIGH_INS =
  'No weigh-ins in what the Shortcut sent. If you weighed in, check its Find Health Samples steps (Start Date, Health access).';

/**
 * The toast for a check that added weigh-ins: one → "From Hume: 184.2 lb · 19.4% body fat" (in the user's unit; body
 * fat only when the reading has it), several → "From Hume: 3 weigh-ins". null when nothing was added.
 */
export function inboxImportMessage(result: Pick<InboxSyncResult, 'added' | 'addedRows'>, unit: Unit): string | null {
  if (!(result.added > 0)) return null;
  if (result.added > 1) return `From Hume: ${result.added} weigh-ins`;
  const row = result.addedRows?.[0];
  const parts: string[] = [];
  if (row?.bodyweightKg) parts.push(`${formatNumber(kgToUnit(row.bodyweightKg, unit), 1)} ${unit}`);
  if (row?.bodyFatPct) parts.push(`${formatNumber(row.bodyFatPct, 1)}% body fat`);
  return parts.length ? `From Hume: ${parts.join(' · ')}` : 'From Hume: 1 weigh-in';
}

// ------------------------------------------------------------------ token (this device only)

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked: nothing is remembered */
  }
}

/**
 * A pasted token, cleaned: a GitHub token is plain printable ASCII with no spaces, so whitespace (a paste split
 * over lines) and invisible characters are dropped. A header value with anything else would make fetch throw.
 * A pasted "Bearer …" / "token …" (Heft's own "Copy Bearer + your key" puts that on the clipboard) or a quoted
 * value is reduced to the bare key. getInboxToken cleans on every read, so a key stored with the prefix is
 * repaired too.
 */
export function cleanToken(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[^\x21-\x7e]/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^(?:bearer|token)["'`]*(?=github_pat_|gh[pousr]_)/i, '');
}

export function getInboxToken(): string | null {
  const t = cleanToken(readStorage(TOKEN_KEY));
  return t || null;
}

/** Saves the token on this device (trimmed; an empty value clears it). */
export function setInboxToken(token: string): void {
  const t = cleanToken(token);
  if (!t) {
    clearInboxToken();
    return;
  }
  writeStorage(TOKEN_KEY, t);
  tokenChanged();
}

/** Forgets the token and the sync history on this device (Settings → "Delete all data" calls it). */
export function clearInboxToken(): void {
  writeStorage(TOKEN_KEY, null);
  tokenChanged();
  writeStorage(STATUS_KEY, null);
}

// ------------------------------------------------------------------ status store

type Persisted = Pick<InboxStatus, 'checkedAt' | 'lastImport' | 'lastPostAt'>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function loadPersisted(): Persisted {
  try {
    const raw = readStorage(STATUS_KEY);
    if (!raw) return { checkedAt: null, lastImport: null, lastPostAt: null };
    const p = JSON.parse(raw) as {
      checkedAt?: unknown;
      lastImport?: { at?: unknown; added?: unknown; updated?: unknown };
      lastPostAt?: unknown;
    };
    const li = p?.lastImport;
    return {
      checkedAt: isNum(p?.checkedAt) ? p.checkedAt : null,
      lastImport: li && isNum(li.at) && isNum(li.added) && isNum(li.updated) ? { at: li.at, added: li.added, updated: li.updated } : null,
      lastPostAt: isNum(p?.lastPostAt) ? p.lastPostAt : null,
    };
  } catch {
    return { checkedAt: null, lastImport: null, lastPostAt: null };
  }
}

const SERVER_STATUS: InboxStatus = { configured: false, state: 'off', checkedAt: null, lastImport: null, lastPostAt: null };

let status: InboxStatus | null = null;
const listeners = new Set<() => void>();
/** Bumped whenever the token is set or cleared: a check started with the old token keeps its hands off. */
let generation = 0;

function currentStatus(): InboxStatus {
  if (!status) {
    const configured = !!getInboxToken();
    status = { configured, state: configured ? 'idle' : 'off', ...loadPersisted() };
  }
  return status;
}

function sameStatus(a: InboxStatus, b: InboxStatus): boolean {
  return (
    a.configured === b.configured &&
    a.state === b.state &&
    a.checkedAt === b.checkedAt &&
    a.lastImport === b.lastImport &&
    a.lastPostAt === b.lastPostAt &&
    a.message === b.message
  );
}

function setStatus(patch: Partial<InboxStatus>): void {
  const prev = currentStatus();
  const next: InboxStatus = { ...prev, ...patch };
  if (next.message === undefined) delete next.message;
  if (sameStatus(prev, next)) return;
  status = next;
  if (prev.checkedAt !== next.checkedAt || prev.lastImport !== next.lastImport || prev.lastPostAt !== next.lastPostAt) {
    writeStorage(
      STATUS_KEY,
      JSON.stringify({ checkedAt: next.checkedAt, lastImport: next.lastImport, lastPostAt: next.lastPostAt }),
    );
  }
  for (const l of [...listeners]) l();
}

function tokenChanged(): void {
  generation++;
  if (getInboxToken()) setStatus({ configured: true, state: 'idle', message: undefined });
  else setStatus({ configured: false, state: 'off', checkedAt: null, lastImport: null, lastPostAt: null, message: undefined });
}

/** Another tab saved or cleared the token. */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== TOKEN_KEY) return;
  const configured = !!getInboxToken();
  if (configured !== currentStatus().configured) {
    generation++;
    setStatus(configured ? { configured, state: 'idle', message: undefined } : { configured, state: 'off', message: undefined });
  }
}

/** The status right now (non-React readers). */
export function getInboxStatus(): InboxStatus {
  return currentStatus();
}

/** Called on every status change; returns the unsubscribe. */
export function subscribeInbox(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(cb);
    if (!listeners.size && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/** Live inbox status: configured, state, "checked 2 min ago" (survives a reload), the last import. */
export function useInboxStatus(): InboxStatus {
  return useSyncExternalStore(subscribeInbox, currentStatus, () => SERVER_STATUS);
}

/** Tests only: forget the in-memory status and any running check (localStorage is left alone). */
export function resetInboxForTests(): void {
  status = null;
  inflight = null;
  generation++;
}

// ------------------------------------------------------------------ requests

interface Reply {
  status: number;
  ok: boolean;
  /** x-ratelimit-remaining ("0" = out of requests). */
  remaining: string | null;
  /** retry-after (GitHub sends it with a secondary rate limit). */
  retryAfter: string | null;
  text: string;
}

/**
 * One GitHub request, the body read inside the same 15 s budget (`json` is sent as a JSON body). Throws on a network
 * error or the timeout.
 */
async function gh(method: 'GET' | 'POST' | 'DELETE', url: string, token: string, json?: unknown): Promise<Reply> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      cache: 'no-store',
      signal: ctl.signal,
    });
    // A failed DELETE's body tells a rate limit from a missing permission; a POST's holds the new comment's id.
    const text = method !== 'DELETE' || !res.ok ? await res.text() : '';
    return {
      status: res.status,
      ok: res.ok,
      remaining: res.headers.get('x-ratelimit-remaining'),
      retryAfter: res.headers.get('retry-after'),
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

type Failure = { state: InboxState; message: string };

function failureOf(r: Reply): Failure | null {
  if (r.ok) return null;
  const limited =
    r.status === 429 || (r.status === 403 && (r.remaining === '0' || r.retryAfter != null || /rate limit/i.test(r.text)));
  if (limited) return { state: 'error', message: RATE_LIMITED };
  if (r.status === 401) return { state: 'token_rejected', message: STATE_MESSAGE.token_rejected };
  if (r.status === 403) return { state: 'no_permission', message: STATE_MESSAGE.no_permission };
  if (r.status === 404) return { state: 'not_found', message: STATE_MESSAGE.not_found };
  return { state: 'error', message: `GitHub answered with an error (HTTP ${r.status}). Heft will try again.` };
}

const OFFLINE: Failure = { state: 'offline', message: STATE_MESSAGE.offline };
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

interface InboxComment {
  id: number;
  createdAt: string;
  body: string;
}

/** Every comment on the inbox issue (page by page until a short page), or why not. */
async function listComments(token: string): Promise<{ comments: InboxComment[] } | Failure> {
  const byId = new Map<number, InboxComment>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    let r: Reply;
    try {
      r = await gh('GET', `${INBOX_COMMENTS_URL}?per_page=${PER_PAGE}&page=${page}`, token);
    } catch {
      return OFFLINE;
    }
    const fail = failureOf(r);
    if (fail) return fail;
    let data: unknown;
    try {
      data = JSON.parse(r.text);
    } catch {
      data = undefined;
    }
    if (!Array.isArray(data)) return { state: 'error', message: "GitHub's answer wasn't a list of comments. Heft will try again." };
    for (const c of data as { id?: unknown; created_at?: unknown; body?: unknown }[]) {
      if (!c || !Number.isSafeInteger(c.id)) continue;
      const id = c.id as number;
      byId.set(id, { id, createdAt: typeof c.created_at === 'string' ? c.created_at : '', body: typeof c.body === 'string' ? c.body : '' });
    }
    if (data.length < PER_PAGE) break;
  }
  // Oldest first, so a newer post's value for the same sample wins.
  return { comments: [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id)) };
}

// ------------------------------------------------------------------ the check

const syncResult = (state: InboxState, added = 0, updated = 0): InboxSyncResult => ({ state, added, updated });

async function runCheck(gen: number): Promise<InboxSyncResult> {
  const token = getInboxToken();
  if (!token) {
    setStatus({ configured: false, state: 'off', message: undefined });
    return syncResult('off');
  }
  if (isOffline()) {
    setStatus({ configured: true, ...OFFLINE });
    return syncResult('offline');
  }
  setStatus({ configured: true, state: 'checking', message: undefined });

  const stale = () => gen !== generation;
  const listed = await listComments(token);
  if (stale()) return syncResult(getInboxToken() ? 'idle' : 'off');
  if (!('comments' in listed)) {
    setStatus({ state: listed.state, message: listed.message });
    return syncResult(listed.state);
  }

  const settings = await getSettings();
  const readable: InboxComment[] = [];
  const unreadable: InboxComment[] = [];
  const samples = new Map<string, HealthSample>();
  let firstError: string | undefined;
  let partialError: string | undefined;
  let fatMissing = false;
  let fatSeen = false;
  for (const c of listed.comments) {
    let parsed: ReturnType<typeof parseHealthText>;
    try {
      parsed = parseHealthText(c.body, { unit: settings.unit });
    } catch {
      // One odd post never stalls the rest of the inbox.
      unreadable.push(c);
      firstError ??= "one post isn't in the Shortcut's format";
      continue;
    }
    if (!parsed.recognized) continue; // someone's note: not ours to delete
    if (!parsed.samples.length) {
      // Nothing to import (unreadable, or the Shortcut found no samples): kept as evidence until weigh-ins arrive.
      unreadable.push(c);
      firstError ??= parsed.errors[0];
      continue;
    }
    readable.push(c);
    partialError ??= parsed.errors[0];
    for (const s of parsed.samples) samples.set(`${s.kind}|${s.at}`, s); // the same sample in several posts counts once
    if (parsed.missing.includes('bodyFat')) fatMissing = true;
    if (parsed.samples.some((s) => s.kind === 'bodyFat')) fatSeen = true;
  }
  // Every Shortcut post counts as "it reached GitHub", even one that brings nothing new.
  const newestPost = Math.max(
    0,
    ...[...readable, ...unreadable].map((c) => Date.parse(c.createdAt)).filter(Number.isFinite),
  );

  let added = 0;
  let updated = 0;
  let addedRows: InboxSyncResult['addedRows'] = [];
  if (samples.size) {
    const existing = await db.measurements.toArray();
    const plan = planHealthImport(
      [...samples.values()].sort((a, b) => a.at - b.at),
      existing,
      settings,
    );
    if (stale()) return syncResult(getInboxToken() ? 'idle' : 'off');
    ({ added, updated } = await applyHealthImport(plan));
    // The rows that really landed (the save re-checks deletes made while it ran), for the toast.
    if (added > 0) {
      const stored = await db.measurements.bulkGet(plan.add.map((m) => m.id));
      addedRows = stored
        .filter((m): m is Measurement => !!m)
        .map((m) => ({ id: m.id, date: m.date, bodyweightKg: m.bodyweightKg, bodyFatPct: m.bodyFatPct }));
    }
  }

  // The import committed: clear what it read. Unreadable posts stay as evidence until a readable one comes in.
  const toDelete = samples.size ? [...readable, ...unreadable] : readable;
  let cantClear = false;
  for (const c of toDelete) {
    if (stale()) break;
    try {
      const r = await gh('DELETE', commentUrl(c.id), token);
      const fail = failureOf(r);
      if (fail?.state === 'token_rejected' || fail?.state === 'no_permission' || fail?.message === RATE_LIMITED) {
        // no_permission here = the token can read but not write. Either way the rest would fail the same way.
        cantClear = fail.state === 'no_permission';
        break;
      }
    } catch {
      break; // offline mid-way: the rest are read (and skipped as already imported) next time
    }
  }

  const out: InboxSyncResult = { ...syncResult('ok', added, updated), addedRows };
  if (stale()) return out;
  const now = Date.now();
  let state: InboxState = 'ok';
  let message: string | undefined;
  if (unreadable.length && !samples.size) {
    if (firstError) {
      state = 'unreadable';
      message = `Heft couldn't read what the Shortcut sent: ${firstError}.`;
    } else message = NO_WEIGH_INS; // the Shortcut ran but found nothing: state stays 'ok'
  } else if (cantClear) message = CANT_CLEAR;
  else if (partialError) message = `Part of what the Shortcut sent was skipped: ${partialError}.`;
  else if (fatMissing && !fatSeen && samples.size) message = NO_BODY_FAT;
  const lastPostAt = currentStatus().lastPostAt;
  setStatus({
    state,
    message,
    checkedAt: now,
    lastImport: added + updated > 0 ? { at: now, added, updated } : currentStatus().lastImport,
    lastPostAt: newestPost > (lastPostAt ?? 0) ? newestPost : lastPostAt,
  });
  return { ...out, state };
}

const resultListeners = new Set<(r: InboxSyncResult) => void>();

/**
 * Called once per finished check (whoever started it; joined calls don't repeat it, and a check whose token was
 * replaced mid-way reports nothing). HealthInboxWatcher toasts from here, so pages that call checkInboxNow don't
 * toast imports themselves. Returns the unsubscribe.
 */
export function onInboxResult(cb: (r: InboxSyncResult) => void): () => void {
  resultListeners.add(cb);
  return () => {
    resultListeners.delete(cb);
  };
}

function emitResult(r: InboxSyncResult): void {
  for (const l of [...resultListeners]) {
    try {
      l(r);
    } catch {
      /* a listener's problem never fails the check */
    }
  }
}

let inflight: { gen: number; promise: Promise<InboxSyncResult> } | null = null;

/**
 * Read the inbox, import every weigh-in in it, then delete the posts it imported. Never throws. A second call while
 * one runs (with the same token) joins it. → {state, added, updated}.
 */
export function checkInboxNow(): Promise<InboxSyncResult> {
  if (inflight && inflight.gen === generation) return inflight.promise;
  const gen = generation;
  const entry: { gen: number; promise: Promise<InboxSyncResult> } = { gen, promise: Promise.resolve(syncResult('idle')) };
  entry.promise = (async () => {
    let r: InboxSyncResult;
    try {
      r = await runCheck(gen);
    } catch {
      // The database or the import failed: nothing was deleted, so the next check tries again.
      if (gen === generation) setStatus({ state: 'error', message: "Heft couldn't save the weigh-ins. It will try again." });
      r = syncResult('error');
    } finally {
      if (inflight === entry) inflight = null;
    }
    if (gen === generation) emitResult(r);
    return r;
  })();
  inflight = entry;
  return entry.promise;
}

const PROBE_TEXT = 'Heft key test (safe to delete)';

/**
 * Try a token before saving it (no import, no status change): reads the inbox issue, then posts a test comment and
 * deletes it, because the Shortcut POSTs and Heft deletes (an Issues read-only key reads fine and answers 403 to the
 * write). A probe whose delete failed stays on the issue; it isn't heft-health text, so checks ignore it.
 * → 'ok' | 'token_rejected' | 'not_found' | 'no_permission' | 'offline' | 'error'.
 */
export async function testInboxToken(token: string): Promise<InboxState> {
  const t = cleanToken(token);
  if (!t) return 'token_rejected';
  if (isOffline()) return 'offline';
  let post: Reply;
  try {
    const r = await gh('GET', INBOX_ISSUE_URL, t);
    const fail = failureOf(r);
    if (fail) return fail.state;
    post = await gh('POST', INBOX_COMMENTS_URL, t, { body: PROBE_TEXT });
  } catch {
    return 'offline';
  }
  const postFail = failureOf(post);
  if (postFail) return postFail.state;
  let id: unknown;
  try {
    id = (JSON.parse(post.text) as { id?: unknown } | null)?.id;
  } catch {
    id = undefined;
  }
  if (Number.isSafeInteger(id)) {
    try {
      const d = await gh('DELETE', commentUrl(id as number), t);
      if (failureOf(d)?.state === 'no_permission') return 'no_permission';
    } catch {
      /* the probe stays; checks ignore it */
    }
  }
  return 'ok';
}
