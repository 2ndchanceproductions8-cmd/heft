import { describe, expect, it } from 'vitest';
import type { CustomExercise, ExerciseOverride } from '../../types';
import { CATALOG, buildExerciseIndex, isMine, searchExercises } from '../../lib/exercises';
import { pickerTabs } from './selection';

/*
 * The Add-Exercise picker's "Created" tab: your own exercises and gym/brand variants (and renamed ones), shown only
 * once you have made at least one.
 */

const custom = (p: Partial<CustomExercise> = {}): CustomExercise => ({
  id: 'c_1',
  name: 'Cable Lat Pulldown (Gym A)',
  equipment: 'cable',
  primary: 'lats',
  secondary: [],
  type: 'weight_reps',
  photoIds: [],
  createdAt: 1,
  ...p,
});
const mineOf = (c: CustomExercise[], o: ExerciseOverride[] = []) => buildExerciseIndex(c, o).list.filter((e) => isMine(e) && !e.hidden && !e.missing);

describe('pickerTabs: Created only exists once you made something', () => {
  const labels = (o: Parameters<typeof pickerTabs>[0]) => pickerTabs(o).map((t) => t.label);

  it('nothing created → All, Routines, Recent (no Created tab)', () => {
    expect(labels({ hasCreated: false })).toEqual(['All', 'Routines', 'Recent']);
  });
  it('something created → Created is added, last', () => {
    expect(labels({ hasCreated: true })).toEqual(['All', 'Routines', 'Recent', 'Created']);
    expect(pickerTabs({ hasCreated: true }).at(-1)?.value).toBe('mine');
  });
  it("Routines stays out where it never applies, and Created doesn't depend on it", () => {
    expect(labels({ hideRoutines: true, hasCreated: false })).toEqual(['All', 'Recent']);
    expect(labels({ hideRoutines: true, hasCreated: true })).toEqual(['All', 'Recent', 'Created']);
  });
});

describe('what counts as created', () => {
  it('a fresh user has none of the ~800 catalog exercises marked as theirs', () => {
    expect(CATALOG.length).toBeGreaterThan(500);
    expect(mineOf([])).toEqual([]);
  });
  it('a created exercise is yours', () => {
    expect(mineOf([custom()]).map((e) => e.name)).toEqual(['Cable Lat Pulldown (Gym A)']);
  });
  it('a gym/brand variant of a catalog exercise is yours, and keeps its brand', () => {
    const base = CATALOG.find((e) => /^Lat Pulldown \(Cable\)$/.test(e.name))!;
    const v = mineOf([custom({ id: 'c_v', name: 'Lat Pulldown (Cable)', variantOf: base.id, brand: 'Hammer Strength' })]);
    expect(v).toHaveLength(1);
    expect(v[0].brand).toBe('Hammer Strength');
  });
  it('a renamed catalog exercise is yours; an untouched one is not', () => {
    const target = CATALOG[0];
    const list = mineOf([], [{ id: target.id, name: 'My Own Name' }]);
    expect(list.map((e) => e.id)).toEqual([target.id]);
  });
  it('a hidden or archived exercise is not offered', () => {
    expect(mineOf([custom()], [{ id: 'c_1', hidden: true }])).toEqual([]);
    expect(mineOf([custom({ archived: true })])).toEqual([]);
  });
});

describe('searching inside Created', () => {
  const list = mineOf([custom(), custom({ id: 'c_2', name: 'Sled Push (Gym B)', equipment: 'machine', primary: 'quadriceps' })]);

  it('finds yours by name and ignores the rest of the library', () => {
    expect(searchExercises(list, 'sled').map((e) => e.name)).toEqual(['Sled Push (Gym B)']);
    expect(searchExercises(list, 'bench')).toEqual([]);
  });
  it('the equipment and muscle filters apply', () => {
    expect(searchExercises(list, '', { equipment: 'cable' }).map((e) => e.name)).toEqual(['Cable Lat Pulldown (Gym A)']);
    expect(searchExercises(list, '', { muscle: 'quadriceps' }).map((e) => e.name)).toEqual(['Sled Push (Gym B)']);
  });
});
