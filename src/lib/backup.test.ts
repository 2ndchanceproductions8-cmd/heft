import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import type {
  ActiveWorkout,
  CustomExercise,
  Exercise,
  Measurement,
  Routine,
  RoutineFolder,
  SetEntry,
  Settings,
  Workout,
} from '../types';
import {
  base64ToBytes,
  bytesToBase64,
  csvCell,
  dataUrlToBlob,
  exportBackup,
  exportCsv,
  importBackup,
  parseBackup,
} from './backup';
import { DEFAULT_SETTINGS } from './settings';

const set = (id: string, weightKg: number, reps: number, p: Partial<SetEntry> = {}): SetEntry => ({
  id,
  type: 'normal',
  done: true,
  weightKg,
  reps,
  ...p,
});

function workout(id: string, startedAt: number, sets: SetEntry[], name = 'Push Day'): Workout {
  return {
    id,
    name,
    startedAt,
    endedAt: startedAt + 3_600_000,
    durationSec: 3600,
    exercises: [{ id: id + '_we', exerciseId: 'c_press', sets }],
    exerciseIds: ['c_press'],
    photoIds: ['m_photo'],
    calories: 320,
    volumeKg: sets.reduce((v, s) => v + (s.weightKg ?? 0) * (s.reps ?? 0), 0),
    setCount: sets.length,
    prs: [],
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

const T0 = new Date(2026, 8, 1, 9, 30).getTime();
const BYTES = new Uint8Array([0, 1, 2, 3, 127, 128, 200, 255]);

async function seed() {
  const custom: CustomExercise = {
    id: 'c_press',
    name: 'Chest Press – Hammer Strength',
    equipment: 'machine',
    primary: 'chest',
    secondary: ['triceps'],
    type: 'weight_reps',
    variantOf: 'Machine_Chest_Press',
    brand: 'Hammer Strength',
    photoIds: [],
    createdAt: T0,
  };
  const routine: Routine = {
    id: 'r1',
    name: 'Push',
    folderId: 'f1',
    order: 0,
    exercises: [{ id: 're1', exerciseId: 'c_press', sets: [{ id: 'rs1', type: 'normal', weightKg: 50, reps: 10 }] }],
    createdAt: T0,
    updatedAt: T0,
  };
  const folder: RoutineFolder = { id: 'f1', name: 'Split', order: 0 };
  const measurement: Measurement = { id: 'meas1', date: T0, bodyweightKg: 82.5, waistCm: 84, photoIds: ['m_photo'] };
  const settings: Settings = { ...DEFAULT_SETTINGS, unit: 'kg', bodyweightKg: 82.5 };
  const active: ActiveWorkout = {
    id: 'a1',
    name: 'Evening Workout',
    startedAt: T0 + 86_400_000 * 10,
    exercises: [{ id: 'awe', exerciseId: 'c_press', sets: [set('as1', 70, 5, { done: false })] }],
    rest: null,
  };
  await db.transaction('rw', db.tables, async () => {
    await db.customExercises.put(custom);
    await db.overrides.put({ id: 'Barbell_Squat', name: 'Back Squat', restSec: 180 });
    await db.routines.put(routine);
    await db.folders.put(folder);
    await db.measurements.put(measurement);
    await db.settings.put(settings);
    await db.active.put({ id: 'current', workout: active });
    await db.media.put({ id: 'm_photo', blob: new Blob([BYTES], { type: 'image/jpeg' }), type: 'image/jpeg', createdAt: T0, width: 4, height: 2 });
    // Second workout is heavier → it should get PRs once imported (PRs are recomputed on import).
    await db.workouts.bulkPut([
      workout('w1', T0, [set('a', 60, 8), set('b', 60, 8)]),
      workout('w2', T0 + 86_400_000 * 3, [set('c', 65, 8), set('d', 62.5, 8, { type: 'warmup' })]),
    ]);
  });
}

async function snapshot() {
  return {
    workouts: await db.workouts.orderBy('startedAt').toArray(),
    routines: await db.routines.toArray(),
    folders: await db.folders.toArray(),
    customExercises: await db.customExercises.toArray(),
    overrides: await db.overrides.toArray(),
    measurements: await db.measurements.toArray(),
    settings: await db.settings.get('settings'),
    active: await db.active.get('current'),
  };
}

beforeEach(async () => {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
});

describe('base64 helpers', () => {
  it('round-trips bytes and data URLs', async () => {
    expect(base64ToBytes(bytesToBase64(BYTES))).toEqual(BYTES);
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
    const blob = dataUrlToBlob('data:image/png;base64,' + bytesToBase64(BYTES));
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(BYTES);
  });
});

describe('exportBackup → importBackup', () => {
  it('restores every table, including photos, settings and the active workout', async () => {
    await seed();
    const before = await snapshot();
    const blob = await exportBackup();
    expect(blob.type).toBe('application/json');
    const text = await blob.text();

    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ app: 'heft', version: 2 });
    expect(typeof parsed.exportedAt).toBe('number');
    expect(parsed.data.media[0].dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(parsed.data.media[0].blob).toBeUndefined();

    // Wipe and change things, then restore.
    await db.transaction('rw', db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
      await db.workouts.put(workout('stray', T0, [set('x', 1, 1)]));
    });

    const counts = await importBackup(text);
    expect(counts).toEqual({
      workouts: 2,
      routines: 1,
      folders: 1,
      customExercises: 1,
      overrides: 1,
      measurements: 1,
      media: 1,
      settings: true,
      active: true,
      meals: 0,
      foods: 0,
    });

    const after = await snapshot();
    expect(after.routines).toEqual(before.routines);
    expect(after.folders).toEqual(before.folders);
    expect(after.customExercises).toEqual(before.customExercises);
    expect(after.overrides).toEqual(before.overrides);
    expect(after.measurements).toEqual(before.measurements);
    expect(after.settings).toEqual(before.settings);
    expect(after.active).toEqual(before.active);
    expect(await db.workouts.get('stray')).toBeUndefined();
    expect(after.workouts.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(after.workouts[0].exercises).toEqual(before.workouts[0].exercises);

    // PRs were recomputed: w2 beats w1 on heaviest weight, e1RM and set volume (warm-up ignored).
    expect(after.workouts[0].prs).toEqual([]);
    expect(after.workouts[1].prs.map((p) => p.kind).sort()).toEqual(['best_1rm', 'best_set_volume', 'heaviest_weight']);
    expect(after.workouts[1].prs.every((p) => p.setId === 'c')).toBe(true);

    const media = await db.media.get('m_photo');
    expect(media).toMatchObject({ id: 'm_photo', type: 'image/jpeg', width: 4, height: 2, createdAt: T0 });
    expect(new Uint8Array(await media!.blob.arrayBuffer())).toEqual(BYTES);
  });

  it('round-trips an empty database', async () => {
    const text = await (await exportBackup()).text();
    await seed();
    const counts = await importBackup(text);
    expect(counts.workouts).toBe(0);
    expect(counts.settings).toBe(false);
    expect(counts.active).toBe(false);
    expect(await db.workouts.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
    expect(await db.media.count()).toBe(0);
  });
});

describe('importBackup validation', () => {
  const valid = () => ({ app: 'heft', version: 1, exportedAt: Date.now(), data: { workouts: [], routines: [] } });

  it('rejects bad files without touching the database', async () => {
    await seed();
    await expect(importBackup('not json')).rejects.toThrow(/valid JSON/);
    await expect(importBackup(JSON.stringify({ app: 'hevy', version: 1, data: {} }))).rejects.toThrow(/isn't a Heft backup/);
    await expect(importBackup(JSON.stringify({ ...valid(), version: 99 }))).rejects.toThrow(/newer version/);
    await expect(importBackup(JSON.stringify({ ...valid(), version: 'x' }))).rejects.toThrow(/format version/);
    await expect(importBackup(JSON.stringify({ ...valid(), data: { workouts: {} } }))).rejects.toThrow(/workouts is not a list/);
    await expect(importBackup(JSON.stringify({ ...valid(), data: { workouts: [{ name: 'x' }] } }))).rejects.toThrow(/workout #1 has no id/);
    await expect(
      importBackup(JSON.stringify({ ...valid(), data: { workouts: [{ id: 'w', exercises: [] }] } })),
    ).rejects.toThrow(/workout #1 is incomplete/);
    await expect(
      importBackup(JSON.stringify({ ...valid(), data: { media: [{ id: 'm', dataUrl: 'nope' }] } })),
    ).rejects.toThrow(/photo #1/);
    expect(await db.workouts.count()).toBe(2);
    expect(await db.media.count()).toBe(1);
  });

  it('fills missing optional fields', () => {
    const file = parseBackup(
      JSON.stringify({
        ...valid(),
        data: { workouts: [{ id: 'w', startedAt: 1, exercises: [{ id: 'e', exerciseId: 'x', sets: [] }] }] },
      }),
    );
    expect(file.data.workouts[0]).toMatchObject({ exerciseIds: ['x'], prs: [], photoIds: [], volumeKg: 0, setCount: 0 });
    expect(file.data.folders).toEqual([]);
    expect(file.data.settings).toBeNull();
  });
});

describe('exportCsv', () => {
  const names: Record<string, string> = { c_press: 'Chest Press, "Hammer"', run: 'Treadmill' };
  const getExercise = (id: string) => ({ id, name: names[id] ?? id }) as Exercise;

  it('writes one row per done set with converted units and proper quoting', () => {
    const w1 = workout('w1', T0, [set('a', 100, 5), set('b', 100, 5, { done: false }), set('c', 50, 12, { type: 'warmup', rpe: 7 })], 'Push, heavy');
    const w2: Workout = {
      ...workout('w2', T0 - 86_400_000, [], 'Cardio'),
      exercises: [{ id: 'r', exerciseId: 'run', sets: [{ id: 'r1', type: 'normal', done: true, durationSec: 1500, distanceM: 5000 }] }],
    };
    const csv = exportCsv([w1, w2], getExercise, 'lb', 'km');
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('Date,Workout,Exercise,Set,Type,Weight (lb),Reps,Duration (s),Distance,Distance Unit,RPE,Side');
    expect(lines).toHaveLength(4);
    // oldest first
    expect(lines[1]).toMatch(/^2026-08-31 09:30,Cardio,Treadmill,1,Normal,,,1500,5,km,,$/);
    expect(lines[2]).toBe('2026-09-01 09:30,"Push, heavy","Chest Press, ""Hammer""",1,Normal,220.46,5,,,,,');
    expect(lines[3]).toBe('2026-09-01 09:30,"Push, heavy","Chest Press, ""Hammer""",2,Warm-up,110.23,12,,,,7,');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('writes a per-side set as a Left and a Right row with the same set number', () => {
    const w = workout('w', T0, [
      { ...set('a', 20, 10), sides: { left: { weightKg: 20, reps: 10 }, right: { weightKg: 20, reps: 8 } }, rpe: 8 },
      set('b', 20, 9),
    ]);
    const lines = exportCsv([w], getExercise, 'kg', 'km').trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1].split(',').slice(-9)).toEqual(['1', 'Normal', '20', '10', '', '', '', '8', 'Left']);
    expect(lines[2].split(',').slice(-9)).toEqual(['1', 'Normal', '20', '8', '', '', '', '8', 'Right']);
    expect(lines[3].split(',').slice(-9)).toEqual(['2', 'Normal', '20', '9', '', '', '', '', '']);
  });

  it('exports carries in yards/meters, not rounded-away miles/km', () => {
    const typed: Record<string, Exercise['type']> = { walk: 'weight_distance', run: 'distance_duration' };
    const get = (id: string) => ({ id, name: id, type: typed[id] }) as Exercise;
    const w: Workout = {
      ...workout('w', T0, [], 'Carries'),
      exercises: [
        { id: 'f', exerciseId: 'walk', sets: [{ id: 'f1', type: 'normal', done: true, weightKg: 40, distanceM: 36.576 }] },
        { id: 'r', exerciseId: 'run', sets: [{ id: 'r1', type: 'normal', done: true, distanceM: 5000 }] },
      ],
    };
    const cells = (csv: string, row: number) => csv.trimEnd().split('\r\n')[row].split(',').slice(8, 10).join(',');
    const mi = exportCsv([w], get, 'lb', 'mi');
    expect(cells(mi, 1)).toBe('40,yd');
    expect(cells(mi, 2)).toBe('3.11,mi');
    const km = exportCsv([w], get, 'kg', 'km');
    expect(cells(km, 1)).toBe('36.6,m'); // carries keep 0.1 m / yd (displayDistanceAny)
    expect(cells(km, 2)).toBe('5,km');
  });

  it('quotes cells only when needed', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(' padded')).toBe('" padded"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });
});
