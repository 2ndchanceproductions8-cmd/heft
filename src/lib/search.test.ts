import { describe, expect, it } from 'vitest';
import { buildExerciseIndex, searchExercises } from './exercises';

const idx = buildExerciseIndex([], []);
const top = (q: string, n = 3) =>
  searchExercises(idx.list, q)
    .slice(0, n)
    .map((e) => e.name);

describe('searchExercises', () => {
  it('matches word starts only', () => {
    expect(searchExercises(idx.list, 'rdl').some((e) => /hurdle/i.test(e.name))).toBe(false);
  });
  it('ranks canonical equipment first', () => {
    expect(top('bench press', 1)[0]).toBe('Bench Press (Barbell)');
    expect(top('lat pulldown', 3)).toContain('Lat Pulldown (Cable)');
  });
  it('honours aliases', () => {
    expect(top('rdl', 5).some((n) => /Romanian Deadlift/.test(n))).toBe(true);
    expect(top('pec deck', 1)[0]).toMatch(/Pec Deck/);
  });
  it('finds smith machine exercises', () => {
    expect(searchExercises(idx.list, 'smith squat').some((e) => e.name === 'Squat (Smith Machine)')).toBe(true);
  });
});
