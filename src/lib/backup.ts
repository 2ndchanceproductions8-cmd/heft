import { format } from 'date-fns';
import { db } from '../db';
import type {
  ActiveWorkout,
  CustomExercise,
  DistanceUnit,
  Exercise,
  ExerciseOverride,
  Measurement,
  Media,
  Routine,
  RoutineFolder,
  SetType,
  Settings,
  Unit,
  Workout,
} from '../types';
import { displayDistanceAny, displayWeight, distanceUnitForType } from './units';
import { recomputeAllPRs } from './workouts';

/*
 * Full-device backup (JSON) and a flat CSV export of every logged set.
 *
 * Backup format: { app: "heft", version: 1, exportedAt, data: { workouts, routines, folders, customExercises,
 * overrides, measurements, settings, active, media: [{ id, type, createdAt, width, height, dataUrl }] } }.
 * Photos are embedded as base64 data URLs so one file restores everything on a new phone.
 */

export const BACKUP_APP = 'heft';
export const BACKUP_VERSION = 1;

export interface BackupMedia extends Omit<Media, 'blob'> {
  dataUrl: string;
}

export interface BackupData {
  workouts: Workout[];
  routines: Routine[];
  folders: RoutineFolder[];
  customExercises: CustomExercise[];
  overrides: ExerciseOverride[];
  measurements: Measurement[];
  settings: Settings | null;
  active: ActiveWorkout | null;
  media: BackupMedia[];
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  version: number;
  /** Epoch ms. */
  exportedAt: number;
  data: BackupData;
}

export interface BackupCounts {
  workouts: number;
  routines: number;
  folders: number;
  customExercises: number;
  overrides: number;
  measurements: number;
  media: number;
  settings: boolean;
  active: boolean;
}

// ------------------------------------------------------------------ base64 helpers (browser + node)

type BufferLike = { from(data: Uint8Array | string, enc?: string): Uint8Array & { toString(enc: string): string } };
const NodeBuffer = (globalThis as unknown as { Buffer?: BufferLike }).Buffer;

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }
  if (NodeBuffer) return NodeBuffer.from(bytes).toString('base64');
  throw new Error('No base64 encoder available');
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (NodeBuffer) return new Uint8Array(NodeBuffer.from(b64, 'base64'));
  throw new Error('No base64 decoder available');
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Invalid photo data in backup');
  const type = m[1] || 'application/octet-stream';
  const bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return new Blob([bytes as BlobPart], { type });
}

// ------------------------------------------------------------------ export

/** Snapshot of every table (read in one transaction so it is consistent). */
export async function buildBackup(): Promise<BackupFile> {
  const snap = await db.transaction(
    'r',
    [db.workouts, db.routines, db.folders, db.customExercises, db.overrides, db.measurements, db.settings, db.active, db.media],
    async () => ({
      workouts: await db.workouts.orderBy('startedAt').toArray(),
      routines: await db.routines.toArray(),
      folders: await db.folders.toArray(),
      customExercises: await db.customExercises.toArray(),
      overrides: await db.overrides.toArray(),
      measurements: await db.measurements.orderBy('date').toArray(),
      settings: (await db.settings.get('settings')) ?? null,
      active: (await db.active.get('current'))?.workout ?? null,
      media: await db.media.toArray(),
    }),
  );
  const media: BackupMedia[] = [];
  for (const m of snap.media) {
    const { blob, ...meta } = m;
    media.push({ ...meta, type: meta.type || blob.type, dataUrl: await blobToDataUrl(blob) });
  }
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    data: { ...snap, media },
  };
}

/** Whole-device backup as a JSON blob. */
export async function exportBackup(): Promise<Blob> {
  const backup = await buildBackup();
  return new Blob([JSON.stringify(backup)], { type: 'application/json' });
}

/** Save a blob as a file (anchor download; iOS shows its download / share UI). */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ------------------------------------------------------------------ import

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasId = (v: unknown): v is { id: string } & Record<string, unknown> => isObj(v) && typeof v.id === 'string' && !!v.id;

const ARRAY_KEYS = ['workouts', 'routines', 'folders', 'customExercises', 'overrides', 'measurements', 'media'] as const;
const LABEL: Record<(typeof ARRAY_KEYS)[number], string> = {
  workouts: 'workout',
  routines: 'routine',
  folders: 'folder',
  customExercises: 'custom exercise',
  overrides: 'exercise setting',
  measurements: 'measurement',
  media: 'photo',
};

/** Checks the shape of a parsed backup and returns it normalized. Throws an Error with a readable message. */
export function validateBackup(raw: unknown): BackupFile {
  if (!isObj(raw) || raw.app !== BACKUP_APP) throw new Error("This file isn't a Heft backup.");
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('This backup has an unknown format version.');
  }
  if (version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of Heft. Update the app first.');
  if (!isObj(raw.data)) throw new Error('This backup is damaged (no data).');
  const data = raw.data;

  const lists = {} as Record<(typeof ARRAY_KEYS)[number], Record<string, unknown>[]>;
  for (const key of ARRAY_KEYS) {
    const v = data[key] ?? [];
    if (!Array.isArray(v)) throw new Error(`This backup is damaged (${key} is not a list).`);
    v.forEach((item, i) => {
      if (!hasId(item)) throw new Error(`This backup is damaged (${LABEL[key]} #${i + 1} has no id).`);
    });
    lists[key] = v as Record<string, unknown>[];
  }

  lists.workouts.forEach((w, i) => {
    if (typeof w.startedAt !== 'number' || !Array.isArray(w.exercises)) {
      throw new Error(`This backup is damaged (workout #${i + 1} is incomplete).`);
    }
  });
  lists.routines.forEach((r, i) => {
    if (!Array.isArray(r.exercises)) throw new Error(`This backup is damaged (routine #${i + 1} is incomplete).`);
  });
  lists.measurements.forEach((m, i) => {
    if (typeof m.date !== 'number') throw new Error(`This backup is damaged (measurement #${i + 1} has no date).`);
  });
  lists.media.forEach((m, i) => {
    if (typeof m.dataUrl !== 'string' || !m.dataUrl.startsWith('data:')) {
      throw new Error(`This backup is damaged (photo #${i + 1} has no image data).`);
    }
  });

  const settings = data.settings == null ? null : data.settings;
  if (settings !== null && !isObj(settings)) throw new Error('This backup is damaged (settings).');
  const active = data.active == null ? null : data.active;
  if (active !== null && (!hasId(active) || !Array.isArray(active.exercises) || typeof active.startedAt !== 'number')) {
    throw new Error('This backup is damaged (workout in progress).');
  }

  const workouts = (lists.workouts as unknown as Workout[]).map((w) => ({
    ...w,
    exercises: w.exercises.map((we) => ({ ...we, sets: Array.isArray(we.sets) ? we.sets : [] })),
    exerciseIds: Array.isArray(w.exerciseIds) ? w.exerciseIds : [...new Set(w.exercises.map((e) => e.exerciseId))],
    photoIds: Array.isArray(w.photoIds) ? w.photoIds : [],
    prs: Array.isArray(w.prs) ? w.prs : [],
    volumeKg: typeof w.volumeKg === 'number' ? w.volumeKg : 0,
    setCount: typeof w.setCount === 'number' ? w.setCount : 0,
  }));
  const measurements = (lists.measurements as unknown as Measurement[]).map((m) => ({
    ...m,
    photoIds: Array.isArray(m.photoIds) ? m.photoIds : [],
  }));
  const customExercises = (lists.customExercises as unknown as CustomExercise[]).map((c) => ({
    ...c,
    secondary: Array.isArray(c.secondary) ? c.secondary : [],
    photoIds: Array.isArray(c.photoIds) ? c.photoIds : [],
  }));

  return {
    app: BACKUP_APP,
    version,
    exportedAt: typeof raw.exportedAt === 'number' ? raw.exportedAt : Date.parse(String(raw.exportedAt)) || 0,
    data: {
      workouts,
      routines: lists.routines as unknown as Routine[],
      folders: lists.folders as unknown as RoutineFolder[],
      customExercises,
      overrides: lists.overrides as unknown as ExerciseOverride[],
      measurements,
      settings: settings ? ({ ...(settings as object), id: 'settings' } as Settings) : null,
      active: active as ActiveWorkout | null,
      media: lists.media as unknown as BackupMedia[],
    },
  };
}

/** Parse + validate a backup file's text without touching the database (for a confirmation preview). */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This file isn't valid JSON — pick a Heft backup (.json).");
  }
  return validateBackup(raw);
}

/**
 * Replace ALL data on this device with the backup (one read-write transaction: nothing changes if it
 * fails), then rebuild PR badges. Returns what was restored.
 */
export async function importBackup(text: string): Promise<BackupCounts> {
  const { data } = parseBackup(text);
  // Decode photos before opening the transaction (no non-Dexie async work inside it).
  const media: Media[] = data.media.map(({ dataUrl, ...meta }) => {
    const blob = dataUrlToBlob(dataUrl);
    return { ...meta, type: meta.type || blob.type, createdAt: meta.createdAt ?? Date.now(), blob };
  });

  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
    await db.workouts.bulkPut(data.workouts);
    await db.routines.bulkPut(data.routines);
    await db.folders.bulkPut(data.folders);
    await db.customExercises.bulkPut(data.customExercises);
    await db.overrides.bulkPut(data.overrides);
    await db.measurements.bulkPut(data.measurements);
    await db.media.bulkPut(media);
    if (data.settings) await db.settings.put(data.settings);
    if (data.active) await db.active.put({ id: 'current', workout: data.active });
  });
  await recomputeAllPRs();

  return {
    workouts: data.workouts.length,
    routines: data.routines.length,
    folders: data.folders.length,
    customExercises: data.customExercises.length,
    overrides: data.overrides.length,
    measurements: data.measurements.length,
    media: media.length,
    settings: !!data.settings,
    active: !!data.active,
  };
}

// ------------------------------------------------------------------ CSV

const CSV_SET_TYPE: Record<SetType, string> = { normal: 'Normal', warmup: 'Warm-up', failure: 'Failure', drop: 'Drop' };

/** RFC 4180 cell: quote when it contains a comma, quote, line break or edge whitespace. */
export function csvCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const num = (n: number | null | undefined) => (n == null || Number.isNaN(n) ? '' : String(n));

/**
 * One row per completed set, oldest workout first. Weights in the user's unit; distances in the unit the app shows
 * for that exercise type (km/mi for runs, m/yd for carries and sleds), with that unit in its own column.
 */
export function exportCsv(
  workouts: Workout[],
  getExercise: (id: string) => Exercise,
  unit: Unit,
  distanceUnit: DistanceUnit,
): string {
  const rows: string[][] = [
    ['Date', 'Workout', 'Exercise', 'Set', 'Type', `Weight (${unit})`, 'Reps', 'Duration (s)', 'Distance', 'Distance Unit', 'RPE'],
  ];
  const sorted = [...workouts].sort((a, b) => a.startedAt - b.startedAt);
  for (const w of sorted) {
    const date = format(w.startedAt, 'yyyy-MM-dd HH:mm');
    for (const we of w.exercises) {
      const ex = getExercise(we.exerciseId);
      const name = ex.name;
      const du = distanceUnitForType(ex.type, distanceUnit);
      let n = 0;
      for (const s of we.sets) {
        if (!s.done) continue;
        n++;
        rows.push([
          date,
          w.name,
          name,
          String(n),
          CSV_SET_TYPE[s.type] ?? s.type,
          num(displayWeight(s.weightKg, unit)),
          num(s.reps),
          num(s.durationSec),
          num(displayDistanceAny(s.distanceM, du)),
          s.distanceM == null ? '' : du,
          num(s.rpe),
        ]);
      }
    }
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
